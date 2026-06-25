"""模型市场安装落地(POST /api/marketplace/install)测试。

ComfyUI 不可达,全用 mock:
- 受理成功路径(现代 install_model 端点入队 + start)
- 端点回退(老 /model/install 命中,跳过 404 的候选)
- url 白名单拒绝(非白名单主机 → 400)
- type 枚举校验(未知类型 → 400)
- HuggingFace (source,id,filename) 组装路径
- 端点存在但拒绝 → 真实响应透传成 502(不静默吞错)
- 进度查询转发 /manager/queue/status
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.marketplace as marketplace_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# fixtures / fakes
# --------------------------------------------------------------------------- #


@pytest.fixture
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
        tenant = Tenant(name="mkt")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="mkt@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


class _FakeWorker:
    def __init__(self, base_url: str = "http://fake-worker:8002") -> None:
        self.base_url = base_url


class _FakePool:
    def __init__(self, base_url: str = "http://fake-worker:8002") -> None:
        self._w = _FakeWorker(base_url)

    @property
    def clients(self) -> list:
        return [self._w]

    async def pick(self, required=()):  # noqa: ANN001
        return self._w


class _FakeResponse:
    def __init__(self, status_code: int, json_body=None, text: str = "") -> None:
        self.status_code = status_code
        self._json = json_body
        self.text = text if text else (str(json_body) if json_body is not None else "")

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class _FakeAsyncClient:
    """替身 httpx.AsyncClient:据 (method, path) 查路由表返回预置响应,并记录调用。

    routes: {(method, path): _FakeResponse}  缺省的 POST 路径返回 404(端点不存在)。
    """

    last_calls: list[tuple[str, str, dict | None]] = []

    def __init__(self, routes: dict, *args, **kwargs) -> None:
        self._routes = routes

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):  # noqa: ANN002
        return False

    def _resolve(self, method: str, url: str) -> _FakeResponse:
        # 从完整 url 里提取 path 部分用于匹配
        path = url.split("fake-worker:8002", 1)[-1] if "fake-worker:8002" in url else url
        key = (method, path)
        if key in self._routes:
            return self._routes[key]
        # 缺省:POST 视为端点不存在(404),GET 状态端点亦然
        return _FakeResponse(404, {"error": "not found"})

    async def post(self, url: str, json: dict | None = None, **kwargs):  # noqa: A002
        _FakeAsyncClient.last_calls.append(("POST", url, json))
        return self._resolve("POST", url)

    async def get(self, url: str, **kwargs):
        _FakeAsyncClient.last_calls.append(("GET", url, None))
        return self._resolve("GET", url)


def _patch_httpx(monkeypatch, routes: dict) -> None:
    """把 marketplace 模块里用到的 httpx.AsyncClient 换成据 routes 应答的替身。"""
    _FakeAsyncClient.last_calls = []  # 每个用例开头清空,避免跨用例串扰

    def factory(*args, **kwargs):
        return _FakeAsyncClient(routes, *args, **kwargs)

    monkeypatch.setattr(marketplace_route.httpx, "AsyncClient", factory)


def _use_pool() -> None:
    app.dependency_overrides[get_pool] = lambda: _FakePool()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- #
# 1) 受理成功(现代 install_model 端点入队 + start)
# --------------------------------------------------------------------------- #


def test_install_accepted_modern_queue(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    # 老端点 404 回退,直到 install_model 受理;start 也 200。
    routes = {
        ("POST", "/manager/queue/install_model"): _FakeResponse(200, {"result": True}),
        ("POST", "/manager/queue/start"): _FakeResponse(200, {"ok": True}),
    }
    _patch_httpx(monkeypatch, routes)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={
            "type": "lora",
            "url": "https://civitai.red/api/download/models/12345",
            "filename": "cool_style.safetensors",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accepted"] is True
    assert body["endpoint"] == "/manager/queue/install_model"
    assert body["worker"] == "http://fake-worker:8002"
    assert body["model"]["filename"] == "cool_style.safetensors"
    assert body["model"]["type"] == "lora"
    assert body["model"]["save_path"] == "loras"
    # 队列式端点入队后应触发 start
    posted = [u for (m, u, _) in _FakeAsyncClient.last_calls if m == "POST"]
    assert any("/manager/queue/start" in u for u in posted)


# --------------------------------------------------------------------------- #
# 2) 端点回退(老 /model/install 命中)
# --------------------------------------------------------------------------- #


def test_install_endpoint_fallback_to_legacy(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    # 首选 /model/install 直接受理(非队列端点,不应触发 start)。
    routes = {
        ("POST", "/model/install"): _FakeResponse(200, {"result": True}),
    }
    _patch_httpx(monkeypatch, routes)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={
            "type": "checkpoint",
            "url": "https://huggingface.co/foo/bar/resolve/main/model.safetensors",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["endpoint"] == "/model/install"
    posted = [u for (m, u, _) in _FakeAsyncClient.last_calls if m == "POST"]
    # 非队列端点:不应调用 start
    assert not any("/manager/queue/start" in u for u in posted)


def test_install_skips_absent_endpoints_then_succeeds(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    # 前两个候选 404/405(端点不存在)→ 回退到 /externalmodel/install 受理。
    routes = {
        ("POST", "/model/install"): _FakeResponse(404),
        ("POST", "/manager/queue/install"): _FakeResponse(405),
        ("POST", "/externalmodel/install"): _FakeResponse(200, {"result": True}),
    }
    _patch_httpx(monkeypatch, routes)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "vae", "url": "https://civitai.com/x/v.safetensors"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["endpoint"] == "/externalmodel/install"


# --------------------------------------------------------------------------- #
# 3) url 白名单拒绝
# --------------------------------------------------------------------------- #


def test_install_rejects_non_whitelisted_host(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    # 不该走到 httpx;但仍 patch 一个会爆炸的路由表确保没发起请求。
    _patch_httpx(monkeypatch, {})
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://evil.example.com/payload.safetensors"},
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]
    # 校验失败应在挑 worker / 发请求前短路
    assert _FakeAsyncClient.last_calls == []


def test_install_rejects_non_http_scheme(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    _patch_httpx(monkeypatch, {})
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "file:///etc/passwd"},
    )
    assert r.status_code == 400
    assert "http" in r.json()["detail"].lower()


def test_install_allows_civitai_subdomain(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    routes = {("POST", "/model/install"): _FakeResponse(200, {"result": True})}
    _patch_httpx(monkeypatch, routes)
    # cdn.civitai.com 是 civitai.com 的子域 → 应放行
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://cdn.civitai.com/a/b.safetensors"},
    )
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- #
# 4) type 枚举校验
# --------------------------------------------------------------------------- #


def test_install_rejects_unknown_type(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    _patch_httpx(monkeypatch, {})
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "malware", "url": "https://civitai.red/x.safetensors"},
    )
    assert r.status_code == 400
    assert "未知模型类型" in r.json()["detail"]
    assert _FakeAsyncClient.last_calls == []


# --------------------------------------------------------------------------- #
# 5) HuggingFace (source,id,filename) 组装
# --------------------------------------------------------------------------- #


def test_install_huggingface_source_builds_resolve_url(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    routes = {("POST", "/model/install"): _FakeResponse(200, {"result": True})}
    _patch_httpx(monkeypatch, routes)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={
            "type": "checkpoint",
            "source": "huggingface",
            "id": "stabilityai/sdxl",
            "filename": "sd_xl_base.safetensors",
        },
    )
    assert r.status_code == 200, r.text
    item = r.json()["model"]
    assert item["url"] == (
        "https://huggingface.co/stabilityai/sdxl/resolve/main/sd_xl_base.safetensors"
    )
    assert item["filename"] == "sd_xl_base.safetensors"


def test_install_requires_url_or_source_id(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    _patch_httpx(monkeypatch, {})
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora"},
    )
    assert r.status_code == 400
    assert _FakeAsyncClient.last_calls == []


# --------------------------------------------------------------------------- #
# 6) 端点存在但拒绝 → 真实响应透传(不静默吞错)
# --------------------------------------------------------------------------- #


def test_install_surfaces_manager_rejection(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    # /model/install 返回 403(安全级别不允许)→ 应原样透传成 502 且不回退。
    routes = {
        ("POST", "/model/install"): _FakeResponse(
            403, {"error": "security level forbids download"}
        ),
    }
    _patch_httpx(monkeypatch, routes)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://civitai.red/x.safetensors"},
    )
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert "/model/install" in detail
    assert "security level" in detail
    # 端点存在但拒绝 → 不应继续探测后续候选
    posted = [u for (m, u, _) in _FakeAsyncClient.last_calls if m == "POST"]
    assert not any("install_model" in u for u in posted)


def test_install_all_endpoints_absent_returns_502(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    # 全部端点 404 → 汇总探测记录报 502
    _patch_httpx(monkeypatch, {})  # 缺省全 404
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://civitai.red/x.safetensors"},
    )
    assert r.status_code == 502
    assert "未提供可用安装端点" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# 7) 鉴权
# --------------------------------------------------------------------------- #


def test_install_requires_auth(client_token, monkeypatch):
    c, _ = client_token
    _use_pool()
    _patch_httpx(monkeypatch, {})
    r = c.post(
        "/api/marketplace/install",
        json={"type": "lora", "url": "https://civitai.red/x.safetensors"},
    )
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# 8) 进度查询转发
# --------------------------------------------------------------------------- #


def test_install_status_forwards_manager_queue_status(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    routes = {
        ("GET", "/manager/queue/status"): _FakeResponse(
            200,
            {
                "total_count": 3,
                "done_count": 1,
                "in_progress_count": 1,
                "is_processing": True,
            },
        ),
    }
    _patch_httpx(monkeypatch, routes)
    r = c.get("/api/marketplace/install/status", headers=_auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["worker"] == "http://fake-worker:8002"
    assert body["status"]["total_count"] == 3
    assert body["status"]["is_processing"] is True


def test_install_status_501_when_endpoint_absent(client_token, monkeypatch):
    c, token = client_token
    _use_pool()
    _patch_httpx(monkeypatch, {})  # status 端点缺省 404
    r = c.get("/api/marketplace/install/status", headers=_auth(token))
    assert r.status_code == 501
