"""OpenTalking 反向代理:/speak_audio 语音输入 multipart 透传测试。

不依赖真实引擎:monkeypatch 替换 app.routes.opentalking.httpx.AsyncClient,
断言:
- multipart 的 file 与表单字段原样转发到上游 /sessions/{id}/speak_audio;
- 缺 file → 400,不触达上游;
- 引擎未启用 → 503。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


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
        tenant = Tenant(name="ot")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="ot@toiv.ai",
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


def _enable_engine(monkeypatch, base_url: str = "http://ot.test") -> None:
    monkeypatch.setattr(
        "app.routes.opentalking.get_settings",
        lambda: SimpleNamespace(opentalking_enabled=True, opentalking_base_url=base_url),
    )


class _FakeResp:
    def __init__(self, payload: dict, status: int = 200):
        self.status_code = status
        self.headers = {"content-type": "application/json"}
        self.content = json.dumps(payload).encode()


class _FakeClient:
    """替身 httpx.AsyncClient:记录 post 调用,返回预置响应。"""

    def __init__(self, captured: dict, resp: _FakeResp):
        self._captured = captured
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, files=None, data=None, json=None):  # noqa: ANN001, A002
        self._captured["url"] = url
        self._captured["files"] = files
        self._captured["data"] = data
        return self._resp


def test_speak_audio_forwards_multipart(client_token, monkeypatch):
    _enable_engine(monkeypatch)
    captured: dict = {}
    resp = _FakeResp({"session_id": "s1", "status": "queued", "text": "你好"})
    monkeypatch.setattr(
        "app.routes.opentalking.httpx.AsyncClient",
        lambda *a, **k: _FakeClient(captured, resp),
    )
    client, token = client_token
    r = client.post(
        "/api/opentalking/sessions/s1/speak_audio",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("speech.webm", b"fake-audio-bytes", "audio/webm")},
        data={"stt_provider": "sensevoice"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "你好"
    # 上游 URL + multipart 内容透传
    assert captured["url"] == "http://ot.test/sessions/s1/speak_audio"
    fname, fcontent, fctype = captured["files"]["file"]
    assert fname == "speech.webm"
    assert fcontent == b"fake-audio-bytes"
    assert fctype == "audio/webm"
    assert captured["data"] == {"stt_provider": "sensevoice"}


def test_speak_audio_missing_file_400(client_token, monkeypatch):
    _enable_engine(monkeypatch)
    called = {"n": 0}

    class _CountingClient(_FakeClient):
        async def post(self, *a, **k):  # noqa: ANN002, ANN003
            called["n"] += 1
            return self._resp

    monkeypatch.setattr(
        "app.routes.opentalking.httpx.AsyncClient",
        lambda *a, **k: _CountingClient({}, _FakeResp({})),
    )
    client, token = client_token
    r = client.post(
        "/api/opentalking/sessions/s1/speak_audio",
        headers={"Authorization": f"Bearer {token}"},
        data={"stt_provider": "sensevoice"},  # 无 file
    )
    assert r.status_code == 400
    assert called["n"] == 0  # 不触达上游


def test_speak_audio_engine_disabled_503(client_token, monkeypatch):
    monkeypatch.setattr(
        "app.routes.opentalking.get_settings",
        lambda: SimpleNamespace(opentalking_enabled=False, opentalking_base_url=""),
    )
    client, token = client_token
    r = client.post(
        "/api/opentalking/sessions/s1/speak_audio",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("speech.webm", b"x", "audio/webm")},
    )
    assert r.status_code == 503


# ---------- /opentalking/status 探活(T0 红线修复:需鉴权,防内部服务指纹外泄) ----------


def test_status_requires_auth(client_token):
    """未认证 → 401(修复前匿名可达,暴露引擎模型/tts_provider 指纹)。"""
    client, _ = client_token
    assert client.get("/api/opentalking/status").status_code == 401


def test_status_engine_disabled(client_token, monkeypatch):
    """认证后:引擎未启用 → enabled=False,不触达上游。"""
    monkeypatch.setattr(
        "app.routes.opentalking.get_settings",
        lambda: SimpleNamespace(opentalking_enabled=False, opentalking_base_url=""),
    )
    client, token = client_token
    r = client.get(
        "/api/opentalking/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "reachable": False}


def test_status_reachable_includes_fingerprint(client_token, monkeypatch):
    """认证后:引擎可达 → reachable=True 并透出 model/tts_provider(仅登录用户可见)。"""

    class _HealthResp:
        status_code = 200

        def json(self):
            return {"llm_model": "qwen-x", "tts_provider": "indextts"}

    class _GetClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url):
            assert url == "http://ot.test/health"
            return _HealthResp()

    _enable_engine(monkeypatch)
    monkeypatch.setattr(
        "app.routes.opentalking.httpx.AsyncClient",
        lambda *a, **k: _GetClient(),
    )
    client, token = client_token
    r = client.get(
        "/api/opentalking/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is True
    assert body["model"] == "qwen-x"
    assert body["tts_provider"] == "indextts"
