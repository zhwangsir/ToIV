"""ComfyUI 画布同源反向代理测试(2026-08-30 画布公网不可用根治)。

不依赖真实 ComfyUI:monkeypatch 替换 app.routes.canvas.httpx.AsyncClient,断言:
- GET 透传 200:上游 URL = 配置基址 + rest,body/状态码/安全头(允许同源 iframe)正确;
- POST 透传:body 原样转发;
- 上游不可达 → 502,detail 不带内网地址;
- 未认证 → 401(复用 deps.get_current_user);
- SSRF:请求带 target/host 参数或绝对 URL 形式 rest,上游仍只打配置基址。
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

_UPSTREAM_BASE = "http://canvas.test"


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
        tenant = Tenant(name="cv")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="cv@toiv.ai",
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


def _set_upstream(monkeypatch, base_url: str = _UPSTREAM_BASE) -> None:
    monkeypatch.setattr(
        "app.routes.canvas.get_settings",
        lambda: SimpleNamespace(canvas_comfy_url=base_url),
    )


class _FakeUpstream:
    """替身上游流式响应:aiter_raw 吐预置字节。"""

    def __init__(self, content: bytes, status: int = 200, content_type: str = "text/html"):
        self.status_code = status
        self.headers = {"content-type": content_type, "content-length": str(len(content))}
        self._content = content

    async def aiter_raw(self):
        yield self._content

    async def aclose(self):
        return None


class _FakeClient:
    """替身 httpx.AsyncClient:记录 build_request 入参,send 返回预置上游/抛错。"""

    def __init__(self, captured: dict, upstream: _FakeUpstream | None = None, error: Exception | None = None):
        self._captured = captured
        self._upstream = upstream
        self._error = error

    def build_request(self, method, url, headers=None, content=None):
        self._captured["method"] = method
        self._captured["url"] = url
        self._captured["headers"] = headers or {}
        self._captured["content"] = content
        return SimpleNamespace(method=method, url=url)

    async def send(self, req, stream=False):
        self._captured["stream"] = stream
        if self._error is not None:
            raise self._error
        return self._upstream

    async def aclose(self):
        return None


def _install(monkeypatch, fake: _FakeClient) -> None:
    monkeypatch.setattr(
        "app.routes.canvas.httpx.AsyncClient",
        lambda *a, **k: fake,
    )


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------- GET 透传 ----------


def test_get_passthrough_200(client_token, monkeypatch):
    """GET /canvas/proxy/system_stats → 配置基址 + /system_stats,状态/body/content-type 透传。"""
    _set_upstream(monkeypatch)
    captured: dict = {}
    upstream = _FakeUpstream(b'{"devices": []}', content_type="application/json")
    _install(monkeypatch, _FakeClient(captured, upstream))
    client, token = client_token
    r = client.get("/api/canvas/proxy/system_stats", headers=_auth(token))
    assert r.status_code == 200, r.text
    assert r.content == b'{"devices": []}'
    assert r.headers["content-type"].startswith("application/json")
    assert captured["method"] == "GET"
    assert captured["url"] == f"{_UPSTREAM_BASE}/system_stats"
    assert captured["stream"] is True
    # host 不原样透传(由 httpx 依上游重建);强制 identity 编码
    assert "host" not in captured["headers"]
    assert captured["headers"]["accept-encoding"] == "identity"


def test_get_root_maps_to_upstream_root(client_token, monkeypatch):
    """GET /canvas/proxy(无 rest,iframe 首页)→ 上游 /;query 透传。"""
    _set_upstream(monkeypatch)
    captured: dict = {}
    _install(monkeypatch, _FakeClient(captured, _FakeUpstream(b"<html></html>")))
    client, token = client_token
    r = client.get("/api/canvas/proxy", headers=_auth(token), params={"v": "1"})
    assert r.status_code == 200
    assert captured["url"] == f"{_UPSTREAM_BASE}/?v=1"


def test_frame_headers_allow_same_origin_iframe(client_token, monkeypatch):
    """代理响应允许本站 iframe 嵌入(覆写全局安全中间件默认 DENY/none)。"""
    _set_upstream(monkeypatch)
    _install(monkeypatch, _FakeClient({}, _FakeUpstream(b"<html></html>")))
    client, token = client_token
    r = client.get("/api/canvas/proxy", headers=_auth(token))
    assert r.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in r.headers["Content-Security-Policy"]


# ---------- POST 透传 ----------


def test_post_passthrough_body(client_token, monkeypatch):
    """POST /canvas/proxy/prompt:body 字节原样转发,上游 200 透传。"""
    _set_upstream(monkeypatch)
    captured: dict = {}
    upstream = _FakeUpstream(b'{"prompt_id": "p1"}', content_type="application/json")
    _install(monkeypatch, _FakeClient(captured, upstream))
    client, token = client_token
    r = client.post("/api/canvas/proxy/prompt", headers=_auth(token), json={"prompt": {}})
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "p1"
    assert captured["method"] == "POST"
    assert captured["url"] == f"{_UPSTREAM_BASE}/prompt"
    assert captured["content"] == b'{"prompt":{}}'


# ---------- 上游不可达 → 502 ----------


def test_upstream_unreachable_502(client_token, monkeypatch):
    """上游连接失败 → 502;detail 固定文案,不泄露内网地址。"""
    _set_upstream(monkeypatch)
    _install(
        monkeypatch,
        _FakeClient({}, error=httpx.ConnectError("connection refused")),
    )
    client, token = client_token
    r = client.get("/api/canvas/proxy/system_stats", headers=_auth(token))
    assert r.status_code == 502
    assert r.json()["detail"] == "画布服务不可达"
    assert "192.168" not in r.text and "100.68" not in r.text


# ---------- 鉴权 ----------


def test_requires_auth_401(client_token):
    """未认证 → 401,不触达上游。"""
    client, _ = client_token
    assert client.get("/api/canvas/proxy/system_stats").status_code == 401
    assert client.post("/api/canvas/proxy/prompt", json={}).status_code == 401


def test_query_token_auth(client_token, monkeypatch):
    """iframe 无法带请求头:?token= 查询参数鉴权(复用 get_current_user 既有通道)。"""
    _set_upstream(monkeypatch)
    _install(monkeypatch, _FakeClient({}, _FakeUpstream(b"ok", content_type="text/plain")))
    client, token = client_token
    r = client.get(f"/api/canvas/proxy?token={token}")
    assert r.status_code == 200


# ---------- SSRF 防护 ----------


def test_ssrf_target_param_ignored(client_token, monkeypatch):
    """请求带 target/host/url 参数:上游仍只打配置基址,参数仅作普通 query 透传。"""
    _set_upstream(monkeypatch)
    captured: dict = {}
    _install(monkeypatch, _FakeClient(captured, _FakeUpstream(b"ok")))
    client, token = client_token
    r = client.get(
        "/api/canvas/proxy/system_stats",
        headers=_auth(token),
        params={"target": "http://evil.example", "host": "evil.example"},
    )
    assert r.status_code == 200
    assert captured["url"].startswith(_UPSTREAM_BASE)
    assert "evil.example" not in captured["url"].split("?", 1)[0]


def test_ssrf_absolute_url_rest_stays_on_config_base(client_token, monkeypatch):
    """rest 形如 /http://evil.example/x:仅拼到配置基址路径下,host 不变。"""
    _set_upstream(monkeypatch)
    captured: dict = {}
    _install(monkeypatch, _FakeClient(captured, _FakeUpstream(b"ok")))
    client, token = client_token
    r = client.get("/api/canvas/proxy/http://evil.example/x", headers=_auth(token))
    assert r.status_code == 200
    parts = httpx.URL(captured["url"])
    assert parts.host == "canvas.test"


def test_invalid_config_500(client_token, monkeypatch):
    """配置非法(非 http/https)→ 500,不发起任何上游请求。"""
    _set_upstream(monkeypatch, "ftp://bad")
    called = {"n": 0}

    class _CountingClient(_FakeClient):
        def build_request(self, *a, **k):
            called["n"] += 1
            return super().build_request(*a, **k)

    _install(monkeypatch, _CountingClient({}, _FakeUpstream(b"")))
    client, token = client_token
    r = client.get("/api/canvas/proxy/system_stats", headers=_auth(token))
    assert r.status_code == 500
    assert called["n"] == 0
