"""OpenAI 兼容 LLM 代理 /api/llm/v1 —— 鉴权、模型白名单、透传、SSE 流式、超时/不可达、限流、并发。

上游用 httpx.MockTransport 替身（不依赖 respx，CI 最小依赖集即可跑）。
"""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes import llm_proxy
from app.security import create_token, hash_password

UPSTREAM = "http://llm.internal.test:8000/v1"


class _LiveStream(httpx.AsyncByteStream):
    """未预读的异步响应体：Response(content=bytes) 会被立即读完，代理的 aiter_raw() 就会 StreamConsumed。"""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


class FakeUpstream:
    """记录发往上游的请求；按 mock(return_value=… | side_effect=…) 应答，只认 POST {UPSTREAM}/chat/completions。"""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self._reply = None

    def mock(self, return_value: httpx.Response | None = None, side_effect: Exception | None = None) -> "FakeUpstream":
        if side_effect is not None:
            def reply():
                raise side_effect
        else:
            proto = return_value
            body = proto.read()

            def reply():  # 每次请求返回新的 Response，按真实网络响应以流的形式交付
                return httpx.Response(proto.status_code, headers=proto.headers, stream=_LiveStream([body]))
        self._reply = reply
        return self

    @property
    def last(self) -> httpx.Request:
        return self.calls[-1]

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.method == "POST" and str(request.url) == f"{UPSTREAM}/chat/completions", request.url
        self.calls.append(request)
        assert self._reply is not None, "upstream not mocked"
        return self._reply()


@pytest.fixture
def upstream(monkeypatch):
    fake = FakeUpstream()
    real_async_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(fake.handler)
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(llm_proxy.httpx, "AsyncClient", client_factory)
    return fake


@pytest.fixture
def env(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="u1", hashed_password=hash_password("pw123456"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    settings = get_settings()
    monkeypatch.setattr(settings, "llm_proxy_base_url", UPSTREAM)
    monkeypatch.setattr(settings, "llm_proxy_api_key", "upstream-key")
    monkeypatch.setattr(settings, "llm_proxy_models", "deepseek-v4-flash-dspark,qwen3.8-27b,qwen3.6-uncensored,glm-5.3-flash")
    monkeypatch.setattr(settings, "llm_proxy_max_tokens", 1000)
    llm_proxy._inflight.clear()
    yield TestClient(app), {"Authorization": f"Bearer {create_token(uid)}"}
    app.dependency_overrides.clear()
    llm_proxy._inflight.clear()


def _chat(**extra):
    return {"model": "qwen3.8-27b", "messages": [{"role": "user", "content": "你好"}], **extra}


def test_requires_toiv_login(env):
    client, _ = env
    assert client.post("/api/llm/v1/chat/completions", json=_chat()).status_code == 401
    assert client.get("/api/llm/v1/models").status_code == 401
    bad = {"Authorization": "Bearer not-a-jwt"}
    assert client.post("/api/llm/v1/chat/completions", json=_chat(), headers=bad).status_code == 401


def test_models_lists_only_public_ids(env):
    client, auth = env
    r = client.get("/api/llm/v1/models", headers=auth)
    assert r.status_code == 200
    assert [m["id"] for m in r.json()["data"]] == ["deepseek-v4-flash-dspark", "qwen3.8-27b", "qwen3.6-uncensored", "glm-5.3-flash"]
    assert "llm.internal.test" not in r.text


def test_non_stream_passthrough_with_upstream_key_and_sanitized_body(env, upstream):
    client, auth = env
    route = upstream.mock(
        return_value=httpx.Response(200, json={"id": "c1", "choices": [{"message": {"role": "assistant", "content": "你好！"}}]})
    )
    r = client.post("/api/llm/v1/chat/completions", headers=auth,
                    json=_chat(max_tokens=99999, evil_field="x", temperature=0.2))
    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "你好！"
    sent = route.last
    assert sent.headers["authorization"] == "Bearer upstream-key"  # 用户 JWT 不会被转发
    body = json.loads(sent.content)
    assert body["max_tokens"] == 1000 and "evil_field" not in body and body["temperature"] == 0.2


def test_default_model_and_unknown_model(env, upstream):
    client, auth = env
    route = upstream.mock(return_value=httpx.Response(200, json={"choices": []}))
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json={"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 200 and json.loads(route.last.content)["model"] == "deepseek-v4-flash-dspark"
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat(model="gpt-4o"))
    assert r.status_code == 400 and r.json()["error"]["type"] == "invalid_request_error"
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json={"model": "qwen3.8-27b", "messages": []})
    assert r.status_code == 400


def test_stream_relays_sse(env, upstream):
    client, auth = env
    chunks = [
        b'data: {"choices":[{"delta":{"content":"\xe4\xbd\xa0"}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"\xe5\xa5\xbd"}}]}\n\n',
        b"data: [DONE]\n\n",
    ]
    upstream.mock(
        return_value=httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"".join(chunks))
    )
    with client.stream("POST", "/api/llm/v1/chat/completions", headers=auth, json=_chat(stream=True)) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        text = b"".join(r.iter_bytes()).decode()
    assert "你" in text and "好" in text and text.rstrip().endswith("data: [DONE]")
    assert llm_proxy._inflight == {}  # 并发槽已释放


def test_upstream_unreachable_and_timeout_hide_internal_address(env, upstream):
    client, auth = env
    upstream.mock(side_effect=httpx.ConnectError("boom"))
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat())
    assert r.status_code == 502 and "llm.internal.test" not in r.text
    upstream.mock(side_effect=httpx.ReadTimeout("slow"))
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat())
    assert r.status_code == 504
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat(stream=True))
    assert r.status_code == 504
    assert llm_proxy._inflight == {}


def test_upstream_errors(env, upstream):
    client, auth = env
    upstream.mock(return_value=httpx.Response(400, json={"error": {"message": "context too long"}}))
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat())
    assert r.status_code == 400 and r.json()["error"]["message"] == "context too long"
    upstream.mock(return_value=httpx.Response(500, text="internal trace at 10.9.8.7"))
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat())
    assert r.status_code == 502 and "10.9.8.7" not in r.text


def test_per_user_rate_limit(env, upstream, monkeypatch):
    client, auth = env
    from app import ratelimit
    monkeypatch.setitem(ratelimit._DEFAULT_SCOPES, "llm", (60.0, 2))
    upstream.mock(return_value=httpx.Response(200, json={"choices": []}))
    assert client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat()).status_code == 200
    assert client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat()).status_code == 200
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat())
    assert r.status_code == 429 and "retry-after" in {k.lower() for k in r.headers}


def test_concurrency_cap(env, monkeypatch):
    client, auth = env
    monkeypatch.setattr(get_settings(), "llm_proxy_max_concurrency", 1)
    from app.security import decode_token
    user_id = decode_token(auth["Authorization"].split(" ", 1)[1])
    llm_proxy._inflight[user_id] = 1  # 模拟一条进行中的流
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat())
    assert r.status_code == 429


def test_body_limits(env, monkeypatch):
    client, auth = env
    monkeypatch.setattr(get_settings(), "llm_proxy_max_body_bytes", 100)
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat(pad="x" * 200))
    assert r.status_code == 413
    monkeypatch.setattr(get_settings(), "llm_proxy_max_body_bytes", 2_000_000)
    r = client.post("/api/llm/v1/chat/completions", headers={**auth, "Content-Type": "application/json"}, content=b"{not json")
    assert r.status_code == 400


def test_spark_aliases_deepseek_and_glm_allowed(env, upstream):
    """Spark 四名白名单：deepseek / glm 放行；未知模型仍 400（回归样本 37726b14）。"""
    client, auth = env
    route = upstream.mock(return_value=httpx.Response(200, json={"choices": []}))
    for model in ("deepseek-v4-flash-dspark", "glm-5.3-flash", "qwen3.8-27b", "qwen3.6-uncensored"):
        r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat(model=model))
        assert r.status_code == 200, (model, r.status_code, r.text)
        assert json.loads(route.last.content)["model"] == model
    r = client.post("/api/llm/v1/chat/completions", headers=auth, json=_chat(model="not-a-served-model"))
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["type"] == "invalid_request_error"
    assert "不支持的模型：not-a-served-model" in err["message"]
    assert "deepseek-v4-flash-dspark" in err["message"]
    assert "glm-5.3-flash" in err["message"]
