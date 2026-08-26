"""i2L 风格 LoRA /api/train/i2l 单测(monkeypatch httpx,不触真实 agent)。

覆盖:
- TOIV_I2L_URL 未配置 → 503;
- 输入校验:lora_name 非法 400、缺 files 422、超 8 张 400、非图片 content-type 400、
  单张超 20MB 400(全部不触达上游);
- 成功链路:multipart(files[]/lora_name/demo_prompt)原样转发 {i2l_url}/i2l,
  响应字段 {ok, lora_name, size_mb, family=z_image, demo_png};
- agent 错误映射:409 → 409、400 → 400 透传 detail、500 → 502、超时 → 504。
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture()
def client_token():
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
    with Session(engine) as s:
        tenant = Tenant(name="i2l")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="i2l@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
            role="user",
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _enable_agent(monkeypatch, base_url: str = "http://i2l.test:9101") -> None:
    monkeypatch.setattr(
        "app.routes.train.get_settings",
        lambda: SimpleNamespace(i2l_url=base_url),
    )


class _FakeResp:
    def __init__(self, payload: dict, status: int = 200):
        self.status_code = status
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    """替身 httpx.AsyncClient:记录 post 调用,返回预置响应(或抛预置异常)。"""

    def __init__(self, captured: dict, resp: _FakeResp | None = None, fail: Exception | None = None):
        self._captured = captured
        self._resp = resp
        self._fail = fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, files=None, data=None):  # noqa: ANN001
        self._captured["url"] = url
        self._captured["files"] = files
        self._captured["data"] = data
        if self._fail is not None:
            raise self._fail
        return self._resp


def _patch_client(monkeypatch, client: _FakeClient) -> None:
    monkeypatch.setattr(
        "app.routes.train.httpx.AsyncClient",
        lambda *a, **k: client,
    )


def _png_file(name: str = "a.png") -> tuple:
    return ("files", (name, _PNG, "image/png"))


def test_i2l_not_configured_503(client_token, monkeypatch):
    _enable_agent(monkeypatch, base_url="")
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 503
    assert "TOIV_I2L_URL" in r.json()["detail"]


def test_i2l_invalid_lora_name_400(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    called = {"n": 0}

    class _CountingClient(_FakeClient):
        async def post(self, *a, **k):  # noqa: ANN002, ANN003
            called["n"] += 1
            return self._resp

    _patch_client(monkeypatch, _CountingClient({}, _FakeResp({})))
    client, token = client_token
    for bad in ("bad name!", "中文名", "a/b", "  "):
        r = client.post(
            "/api/train/i2l",
            headers={"Authorization": f"Bearer {token}"},
            files=[_png_file()],
            data={"lora_name": bad},
        )
        assert r.status_code == 400, bad
    assert called["n"] == 0  # 不触达上游


def test_i2l_missing_files_422(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        data={"lora_name": "mystyle"},  # 无 files
    )
    assert r.status_code == 422


def test_i2l_too_many_files_400(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file(f"{i}.png") for i in range(9)],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 400
    assert "8" in r.json()["detail"]


def test_i2l_non_image_400(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[("files", ("notes.txt", b"hello", "text/plain"))],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 400
    assert "不是图片" in r.json()["detail"]


def test_i2l_oversize_image_400(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    client, token = client_token
    big = b"\x00" * (20 * 1024 * 1024 + 1)
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[("files", ("big.png", big, "image/png"))],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 400
    assert "20MB" in r.json()["detail"]


def test_i2l_success_forwards_multipart(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    captured: dict = {}
    resp = _FakeResp({
        "ok": True,
        "lora_name": "mystyle.safetensors",
        "lora_path": "/nas/loras/mystyle.safetensors",
        "size_mb": 228.5,
        "demo_png": "/tmp/demo.png",
    })
    _patch_client(monkeypatch, _FakeClient(captured, resp))
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file("a.png"), _png_file("b.jpg")],
        data={"lora_name": "mystyle", "demo_prompt": "a girl in flat vector style"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "ok": True,
        "lora_name": "mystyle.safetensors",
        "size_mb": 228.5,
        "family": "z_image",
        "demo_png": "/tmp/demo.png",
    }
    # 上游 URL + multipart 内容透传
    assert captured["url"] == "http://i2l.test:9101/i2l"
    assert captured["data"] == {
        "lora_name": "mystyle",
        "demo_prompt": "a girl in flat vector style",
    }
    assert len(captured["files"]) == 2
    field, (fname, fcontent, fctype) = captured["files"][0]
    assert field == "files"
    assert fname == "img-000.png"
    assert fcontent == _PNG
    assert fctype == "image/png"


def test_i2l_success_without_demo_prompt(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    captured: dict = {}
    resp = _FakeResp({
        "ok": True,
        "lora_name": "mystyle.safetensors",
        "lora_path": "/nas/loras/mystyle.safetensors",
        "size_mb": 100.0,
        "demo_png": None,
    })
    _patch_client(monkeypatch, _FakeClient(captured, resp))
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["demo_png"] is None
    assert captured["data"] == {"lora_name": "mystyle"}  # 空 demo_prompt 不上送


def test_i2l_agent_busy_409(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    _patch_client(monkeypatch, _FakeClient({}, _FakeResp({"detail": "busy"}, status=409)))
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "busy"


def test_i2l_agent_400_passthrough(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    _patch_client(
        monkeypatch,
        _FakeClient({}, _FakeResp({"detail": "图片数量须为 1-8 张"}, status=400)),
    )
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "图片数量须为 1-8 张"


def test_i2l_agent_500_502(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    _patch_client(
        monkeypatch,
        _FakeClient({}, _FakeResp({"detail": "导出失败: CUDA OOM"}, status=500)),
    )
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 502
    assert "CUDA OOM" in r.json()["detail"]


def test_i2l_agent_timeout_504(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    _patch_client(
        monkeypatch,
        _FakeClient({}, fail=httpx.TimeoutException("read timed out")),
    )
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 504


def test_i2l_agent_unreachable_502(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    _patch_client(
        monkeypatch,
        _FakeClient({}, fail=httpx.ConnectError("connection refused")),
    )
    client, token = client_token
    r = client.post(
        "/api/train/i2l",
        headers={"Authorization": f"Bearer {token}"},
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 502


def test_i2l_requires_auth(client_token, monkeypatch):
    _enable_agent(monkeypatch)
    client, _ = client_token
    r = client.post(
        "/api/train/i2l",
        files=[_png_file()],
        data={"lora_name": "mystyle"},
    )
    assert r.status_code == 401
