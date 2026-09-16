"""画布 object_info 服务端缓存端点测试(2026-09-16 原生画布)。

不依赖真实 ComfyUI:替换 app.routes.canvas.httpx.AsyncClient 为支持 async with
与 .get() 的替身,断言:
- ?classes= 过滤只回请求的类;
- 服务端 TTL 缓存:第二次请求不再打上游;
- 上游不可达 → 502,detail 不带内网地址;
- 未认证 → 401。
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.canvas as canvas_mod
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password

_UPSTREAM_BASE = "http://canvas.test"

_PAYLOAD = {
    "KSampler": {"input": {"required": {"seed": ["INT", {"default": 0}]}}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE"]}}},
    "OtherNode": {"input": {"required": {"x": ["INT"]}}},
}


@pytest.fixture()
def client_token(monkeypatch):
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
        tenant = Tenant(name="cvoi")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="cvoi@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
            role="user",
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    # 模块级缓存/锁必须逐测试重置,避免用例间串味
    canvas_mod._OBJECT_INFO_CACHE["data"] = None
    canvas_mod._OBJECT_INFO_CACHE["at"] = 0.0
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()
    canvas_mod._OBJECT_INFO_CACHE["data"] = None
    canvas_mod._OBJECT_INFO_CACHE["at"] = 0.0


class _FakeResp:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _FakeObjClient:
    """async with + .get(url) 形态的替身(端点实现走 httpx.AsyncClient 上下文管理)。"""

    def __init__(self, captured: dict, payload: dict | None = None, error: Exception | None = None):
        self._captured = captured
        self._payload = payload
        self._error = error

    async def __aenter__(self) -> "_FakeObjClient":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def get(self, url: str) -> _FakeResp:
        self._captured["calls"] = self._captured.get("calls", 0) + 1
        self._captured["url"] = url
        if self._error is not None:
            raise self._error
        return _FakeResp(self._payload or {})


def _install(monkeypatch, fake: _FakeObjClient, base_url: str = _UPSTREAM_BASE) -> None:
    monkeypatch.setattr(
        canvas_mod,
        "get_settings",
        lambda: SimpleNamespace(canvas_comfy_url=base_url),
    )
    monkeypatch.setattr(canvas_mod.httpx, "AsyncClient", lambda *a, **k: fake)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_classes_filter_and_cache(client_token, monkeypatch):
    """过滤只回请求类;命中缓存后上游只打一次。"""
    captured: dict = {}
    _install(monkeypatch, _FakeObjClient(captured, dict(_PAYLOAD)))
    client, token = client_token

    r1 = client.get("/api/canvas/object_info?classes=KSampler,SaveImage", headers=_auth(token))
    assert r1.status_code == 200, r1.text
    body = r1.json()
    assert set(body.keys()) == {"KSampler", "SaveImage"}
    assert captured["url"].startswith(f"{_UPSTREAM_BASE}/object_info")
    assert captured["calls"] == 1

    r2 = client.get("/api/canvas/object_info?classes=SaveImage", headers=_auth(token))
    assert r2.status_code == 200
    assert r2.json().keys() == {"SaveImage"}
    assert captured["calls"] == 1, "TTL 缓存内第二次请求不应打上游"


def test_upstream_error_502_no_leak(client_token, monkeypatch):
    captured: dict = {}
    _install(monkeypatch, _FakeObjClient(captured, error=httpx.ConnectError("boom")))
    client, token = client_token
    r = client.get("/api/canvas/object_info?classes=KSampler", headers=_auth(token))
    assert r.status_code == 502
    assert "canvas.test" not in r.text
    assert "192.168" not in r.text


def test_requires_auth(client_token, monkeypatch):
    captured: dict = {}
    _install(monkeypatch, _FakeObjClient(captured, dict(_PAYLOAD)))
    client, _ = client_token
    r = client.get("/api/canvas/object_info?classes=KSampler")
    assert r.status_code == 401


# ---------- /canvas/workflow 读取 ----------


def test_workflow_read_encodes_path(client_token, monkeypatch):
    """path 服务端整段编码为 workflows%2Fxxx.json(框架解码问题由服务端绕开);非法路径 422。"""
    captured: dict = {}
    payload = {"nodes": [], "links": []}
    _install(monkeypatch, _FakeObjClient(captured, payload))
    client, token = client_token

    r = client.get("/api/canvas/workflow", params={"path": "txt2img-basic.json"}, headers=_auth(token))
    assert r.status_code == 200, r.text
    assert r.json() == payload
    assert captured["url"] == f"{_UPSTREAM_BASE}/api/userdata/workflows%2Ftxt2img-basic.json"

    r2 = client.get("/api/canvas/workflow", params={"path": "a/b.json"}, headers=_auth(token))
    assert r2.status_code == 200
    assert captured["url"] == f"{_UPSTREAM_BASE}/api/userdata/workflows%2Fa%2Fb.json"

    for bad in ["../etc/passwd", "a.txt", "", "x.json\\y"]:
        rr = client.get("/api/canvas/workflow", params={"path": bad}, headers=_auth(token))
        assert rr.status_code == 422, bad


def test_workflow_read_requires_auth(client_token, monkeypatch):
    captured: dict = {}
    _install(monkeypatch, _FakeObjClient(captured, {"nodes": []}))
    client, _ = client_token
    r = client.get("/api/canvas/workflow", params={"path": "x.json"})
    assert r.status_code == 401
