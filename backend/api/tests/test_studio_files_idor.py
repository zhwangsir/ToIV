"""P-1 IDOR: /api/studio/files/{name} 必须归属校验(鉴权≠授权)。

证明:用户 A 的产物,用户 B 即使登录也读不到(统一 404,不泄露存在性);
合法属主可读;admin 直通;可选 sig=HMAC 签名即能力。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override

    root = tmp_path / "drama"
    (root / "studio").mkdir(parents=True)
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)

    with Session(engine) as s:
        t = Tenant(name="idor-t")
        s.add(t)
        s.commit()
        s.refresh(t)
        a = User(
            id="user-a",
            email="a@idor.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="user",
        )
        b = User(
            id="user-b",
            email="b@idor.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="user",
        )
        admin = User(
            id="user-admin",
            email="admin@idor.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="admin",
        )
        s.add(a)
        s.add(b)
        s.add(admin)
        s.commit()
        tenant_id = t.id

    yield {
        "client": TestClient(app),
        "engine": engine,
        "root": root,
        "ha": {"Authorization": "Bearer " + create_token("user-a")},
        "hb": {"Authorization": "Bearer " + create_token("user-b")},
        "hadmin": {"Authorization": "Bearer " + create_token("user-admin")},
        "tenant_id": tenant_id,
    }
    app.dependency_overrides.clear()


def _plant(root, name: str, body: bytes = b"secret-bytes") -> None:
    (root / "studio" / name).write_bytes(body)


def _link_final(engine, *, user_id: str, tenant_id: str, name: str) -> str:
    with Session(engine) as s:
        p = StudioProject(
            tenant_id=tenant_id,
            user_id=user_id,
            title="idor",
            final_url=f"/api/studio/files/{name}",
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        return p.id


def test_studio_file_other_user_404(ctx):
    """用户 B 不能读用户 A 已归属的 studio 产物(IDOR 主断言)。"""
    name = "final-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4"
    _plant(ctx["root"], name)
    _link_final(ctx["engine"], user_id="user-a", tenant_id=ctx["tenant_id"], name=name)

    client = ctx["client"]
    # 属主可读
    r_ok = client.get(f"/api/studio/files/{name}", headers=ctx["ha"])
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.content == b"secret-bytes"
    # 同租户其他用户 → 404(不泄露存在性;绝非 200/403)
    r_deny = client.get(f"/api/studio/files/{name}", headers=ctx["hb"])
    assert r_deny.status_code == 404, (r_deny.status_code, r_deny.text)
    assert "不存在" in r_deny.json().get("detail", "")


def test_studio_file_orphan_denied_for_non_admin(ctx):
    """盘上有文件但无任何 DB 归属 → 普通用户 404(fail-closed)。"""
    name = "orphan-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4"
    _plant(ctx["root"], name)
    client = ctx["client"]
    assert client.get(f"/api/studio/files/{name}", headers=ctx["ha"]).status_code == 404
    # admin 直通(运维取证)
    r = client.get(f"/api/studio/files/{name}", headers=ctx["hadmin"])
    assert r.status_code == 200
    assert r.content == b"secret-bytes"


def test_studio_file_sig_grants_access_without_db_row(ctx):
    """可选 sig=HMAC:签名即能力(对齐 /api/images),无 DB 行也可取。"""
    from app.services.studio_file_access import studio_file_sig

    name = "sig-cccccccccccccccccccccccccccccccc.mp4"
    _plant(ctx["root"], name, b"via-sig")
    sig = studio_file_sig(name)
    client = ctx["client"]
    # 无归属无 sig → 404
    assert client.get(f"/api/studio/files/{name}", headers=ctx["hb"]).status_code == 404
    # 坏 sig → 404
    assert (
        client.get(f"/api/studio/files/{name}?sig=deadbeef", headers=ctx["hb"]).status_code
        == 404
    )
    # 正确 sig → 任意登录用户可取(能力 URL)
    r = client.get(f"/api/studio/files/{name}?sig={sig}", headers=ctx["hb"])
    assert r.status_code == 200, r.text
    assert r.content == b"via-sig"


def test_studio_file_still_requires_auth(ctx):
    name = "need-auth.mp4"
    _plant(ctx["root"], name)
    assert ctx["client"].get(f"/api/studio/files/{name}").status_code == 401
