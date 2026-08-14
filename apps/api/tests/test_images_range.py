"""/api/images 的 HTTP Range 返回:视频 <video> 必须拿 206+Accept-Ranges 才能播。

回归:此前代理无视 Range 一律 200 无 Accept-Ranges → 浏览器媒体元素报 error 4
(SRC_NOT_SUPPORTED),作品库所有视频加载失败。现在 range 请求返回 206 切片。

另含 IDOR 归属防护集成测试(签名 URL + 旧 URL 归属回退)。
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.images as images_mod
from app.comfy.tracker import image_url
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Job, Tenant, User
from app.routes.images import _ranged_response
from app.security import create_token, hash_password

_DATA = bytes(range(256)) * 8  # 2048 字节


def test_no_range_returns_200_with_accept_ranges():
    r = _ranged_response(_DATA, "video/mp4", None)
    assert r.status_code == 200
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.body == _DATA


def test_range_returns_206_sliced():
    r = _ranged_response(_DATA, "video/mp4", "bytes=0-1023")
    assert r.status_code == 206
    assert r.headers["Content-Range"] == f"bytes 0-1023/{len(_DATA)}"
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.body == _DATA[:1024]


def test_open_ended_range_to_eof():
    r = _ranged_response(_DATA, "video/mp4", "bytes=2000-")
    assert r.status_code == 206
    assert r.body == _DATA[2000:]
    assert r.headers["Content-Range"] == f"bytes 2000-{len(_DATA) - 1}/{len(_DATA)}"


def test_unsatisfiable_range_416():
    r = _ranged_response(_DATA, "video/mp4", "bytes=99999-")
    assert r.status_code == 416
    assert r.headers["Content-Range"] == f"bytes */{len(_DATA)}"


def test_malformed_range_falls_back_to_full():
    r = _ranged_response(_DATA, "video/mp4", "bytes=abc-def")
    assert r.status_code == 206  # 解析失败 → 退化为 0..total-1 的 206
    assert r.body == _DATA


# ────────────────────────────────
# IDOR 归属防护:签名 URL 直接放行;无 sig 旧 URL 走 DB 归属回退
# ────────────────────────────────

_WORKER = "http://192.168.71.127:8189"  # 默认白名单 worker(deps.get_pool 已被替身覆盖)


class _FakeWorker:
    """假 worker:直接返回内存字节,不走网络。"""

    base_url = _WORKER

    async def get_image_bytes(self, filename, subfolder, type_):
        return _DATA, "image/png"


@pytest.fixture
def ctx(monkeypatch):
    """两类租户用户 + admin + 假 worker/pool;返回 (client, tokens)。"""
    from types import SimpleNamespace

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake_worker = _FakeWorker()
    app.dependency_overrides[get_pool] = lambda: SimpleNamespace(clients=[fake_worker])
    # resolve_worker 走白名单/网络无关的替身,直接返回假 worker
    monkeypatch.setattr(images_mod, "resolve_worker", lambda w: fake_worker)

    with Session(engine) as s:
        t1 = Tenant(name="t1")
        t2 = Tenant(name="t2")
        s.add_all([t1, t2])
        s.commit()
        s.refresh(t1)
        s.refresh(t2)
        owner = User(email="owner", hashed_password=hash_password("x"), tenant_id=t1.id)
        mate = User(email="mate", hashed_password=hash_password("x"), tenant_id=t1.id)
        outsider = User(email="outsider", hashed_password=hash_password("x"), tenant_id=t2.id)
        admin = User(
            email="admin", hashed_password=hash_password("x"), tenant_id=t2.id, role="admin"
        )
        s.add_all([owner, mate, outsider, admin])
        s.commit()
        s.refresh(owner)
        s.refresh(mate)
        s.refresh(outsider)
        s.refresh(admin)
        # owner 的产物 Job:result 含旧格式(无 sig)产物 URL
        s.add(
            Job(
                tenant_id=t1.id,
                user_id=owner.id,
                prompt_id="p-own",
                worker=_WORKER,
                kind="txt2img",
                status="done",
                prompt="x",
                seed=1,
                result=f'["/api/images?filename=own.png&subfolder=&type=output&worker={_WORKER}"]',
            )
        )
        s.commit()
        tokens = {
            "owner": create_token(owner.id),
            "mate": create_token(mate.id),
            "outsider": create_token(outsider.id),
            "admin": create_token(admin.id),
        }
    yield TestClient(app), tokens
    app.dependency_overrides.clear()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _unsigned_url(filename: str) -> str:
    return f"/api/images?filename={filename}&subfolder=&type=output&worker={_WORKER}"


class TestImageOwnership:
    def test_signed_url_any_user_200(self, ctx):
        """带 sig 的 URL:任意登录用户放行(签名即能力,无 DB 往返)。"""
        client, tokens = ctx
        url = image_url(_WORKER, {"filename": "other-tenant.png", "subfolder": "", "type": "output"})
        assert "sig=" in url
        r = client.get(url, headers=_h(tokens["outsider"]))
        assert r.status_code == 200
        assert r.content == _DATA
        assert r.headers["Cache-Control"].startswith("private")

    def test_unsigned_owner_200(self, ctx):
        """无 sig 旧 URL:Job 属主本人放行(DB 归属回退)。"""
        client, tokens = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["owner"]))
        assert r.status_code == 200

    def test_unsigned_same_tenant_200(self, ctx):
        """无 sig 旧 URL:同租户成员放行。"""
        client, tokens = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["mate"]))
        assert r.status_code == 200

    def test_unsigned_other_tenant_404(self, ctx):
        """无 sig 旧 URL:他人(异租户)产物 → 404,不泄露存在性。"""
        client, tokens = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["outsider"]))
        assert r.status_code == 404

    def test_unsigned_admin_200(self, ctx):
        """无 sig 旧 URL:admin 直接放行。"""
        client, tokens = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["admin"]))
        assert r.status_code == 200

    def test_forged_sig_404(self, ctx):
        """伪造 sig → 404。"""
        client, tokens = ctx
        url = _unsigned_url("own.png") + "&sig=" + "0" * 24
        r = client.get(url, headers=_h(tokens["outsider"]))
        assert r.status_code == 404

    def test_sig_tampered_filename_404(self, ctx):
        """sig 覆盖 filename:改文件名后原签名失效。"""
        client, tokens = ctx
        url = image_url(_WORKER, {"filename": "own.png", "subfolder": "", "type": "output"})
        tampered = url.replace("filename=own.png", "filename=victim.png")
        r = client.get(tampered, headers=_h(tokens["owner"]))
        assert r.status_code == 404

    def test_unsigned_no_matching_job_404(self, ctx):
        """无 sig 且库里无任何匹配 Job → 404。"""
        client, tokens = ctx
        r = client.get(_unsigned_url("nonexistent.png"), headers=_h(tokens["owner"]))
        assert r.status_code == 404
