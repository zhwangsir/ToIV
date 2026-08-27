"""限流覆盖缺口补齐(P1-11):reverse / opentalking / nas.download 限流存在性测试。

- /api/reverse:scope="reverse"(60s/5 次);外部 VLM 依赖 mock 掉,只验证限流接线与 429。
- /api/opentalking 写端点:scope="opentalking"(60s/10 次);桶满 429 且不触达上游。
- /api/nas/download:scope="download"(60s/10 次);admin + NAS 就绪 mock 后验证 429。
upload 的 11 连发 429 用例在 tests/test_upload.py。
"""
from __future__ import annotations

import pytest
from fastapi.responses import Response
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app import ratelimit
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes import nas_models, opentalking, reverse
from app.security import create_token, hash_password

_PNG = b"\x89PNG\r\x80\x1a\n" + b"\x00" * 64


@pytest.fixture
def ctx():
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
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="rl@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
            role="admin",  # nas/download 需要 admin;reverse/opentalking 不区分角色
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), uid
    app.dependency_overrides.clear()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _fill_quota(uid: str, scope: str) -> None:
    """按该 scope 的真实配置刚好填满配额(预填超额会先 429 在预填步)。"""
    window_limit = ratelimit._DEFAULT_SCOPES.get(scope, ratelimit._DEFAULT_SCOPES["default"])
    ratelimit._enforce_subject(uid, scope, count=window_limit[1])


# ── /api/reverse ─────────────────────────────────────────────────────


def test_reverse_within_quota_passes(ctx, monkeypatch):
    """配额内正常放行(mock VLM),证明限流接线不影响正常链路。"""

    async def _fake_chat(system, part, base_url):
        return '{"prompt": "a cat", "negative": "blurry"}'

    monkeypatch.setattr(reverse, "_chat_completion", _fake_chat)
    client, token, _ = ctx
    r = client.post(
        "/api/reverse", files={"file": ("a.png", _PNG, "image/png")}, headers=_auth(token)
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt"] == "a cat"


def test_reverse_rate_limited_429(ctx, monkeypatch):
    """scope="reverse" 桶占满 → 下一次 429,不触达 VLM。"""

    async def _boom(*a, **k):  # 不应被调达
        raise AssertionError("限流后不应触达 VLM")

    monkeypatch.setattr(reverse, "_chat_completion", _boom)
    client, token, uid = ctx
    _fill_quota(uid, "reverse")
    r = client.post(
        "/api/reverse", files={"file": ("a.png", _PNG, "image/png")}, headers=_auth(token)
    )
    assert r.status_code == 429


# ── /api/opentalking 写端点 ──────────────────────────────────────────


def test_opentalking_write_calls_limiter_with_scope(ctx, monkeypatch):
    """POST /opentalking/sessions 调限流且 scope="opentalking";上游 mock 后正常放行。"""
    calls: list[str] = []
    monkeypatch.setattr(
        opentalking,
        "enforce_rate_limit",
        lambda user, scope: calls.append(scope),
    )

    async def _fake_proxy(url, body):
        return Response(content=b'{"session_id":"s1"}', media_type="application/json")

    monkeypatch.setattr(opentalking, "_proxy_post", _fake_proxy)
    client, token, _ = ctx
    r = client.post("/api/opentalking/sessions", json={}, headers=_auth(token))
    assert r.status_code == 200, r.text
    assert calls == ["opentalking"]


def test_opentalking_write_rate_limited_429(ctx, monkeypatch):
    """scope="opentalking" 桶占满 → 建会话 429,不触达上游。"""

    async def _boom(*a, **k):
        raise AssertionError("限流后不应触达上游")

    monkeypatch.setattr(opentalking, "_proxy_post", _boom)
    client, token, uid = ctx
    _fill_quota(uid, "opentalking")
    r = client.post("/api/opentalking/sessions", json={}, headers=_auth(token))
    assert r.status_code == 429


# ── /api/nas/download ────────────────────────────────────────────────


def test_nas_download_rate_limited_429(ctx, monkeypatch):
    """scope="download" 桶占满 → 429(NAS 就绪/管理员前置已 mock 满足)。"""
    monkeypatch.setattr(nas_models, "require_nas_ready", lambda: None)
    client, token, uid = ctx
    _fill_quota(uid, "download")
    r = client.post(
        "/api/nas/download",
        json={"source": "url", "url": "http://example.com/m.safetensors"},
        headers=_auth(token),
    )
    assert r.status_code == 429


# ── /api/train 写端点(T0 红线修复:LoRA 训练是平台最贵 GPU 操作,此前全部无限流) ──


def test_train_write_endpoints_call_limiter(ctx, monkeypatch):
    """train 五个写端点均接限流;/train/start 与 /train/i2l 按 3 倍配额计数。"""
    from types import SimpleNamespace

    from app.routes import train

    calls: list[int] = []
    monkeypatch.setattr(
        train,
        "enforce_generation_rate_limit",
        lambda user, count=1: calls.append(count),
    )
    # trainer/i2l 置未部署:限流放行后走 503/404 短路,不触达外部服务
    monkeypatch.setattr(
        train, "get_settings", lambda: SimpleNamespace(trainer_url="", i2l_url="")
    )
    client, token, _ = ctx
    r = client.post(
        "/api/train/dataset",
        headers=_auth(token),
        files=[("files", ("a.png", _PNG, "image/png"))],
    )
    assert r.status_code == 503  # 限流放行 → trainer 未部署
    r = client.post("/api/train/caption", json={"job_id": "nope"}, headers=_auth(token))
    assert r.status_code == 404  # 限流放行 → 作业不存在
    r = client.post(
        "/api/train/start",
        json={"job_id": "nope", "base_ckpt": "x.safetensors"},
        headers=_auth(token),
    )
    assert r.status_code == 404
    r = client.post("/api/train/nope/register", headers=_auth(token))
    assert r.status_code == 404
    r = client.post(
        "/api/train/i2l",
        headers=_auth(token),
        files=[("files", ("a.png", _PNG, "image/png"))],
        data={"lora_name": "x"},
    )
    assert r.status_code == 503  # 限流放行 → i2l 未部署
    # dataset/caption/register 用 generation 档(count=1);start/i2l 3 倍计数
    assert calls == [1, 1, 3, 1, 3]


def test_train_write_endpoints_rate_limited_429(ctx):
    """generation 桶占满 → train 全部写端点 429 不触达下游;读端点(状态查询)不限流。"""
    client, token, uid = ctx
    _fill_quota(uid, "generation")
    r = client.post(
        "/api/train/dataset",
        headers=_auth(token),
        files=[("files", ("a.png", _PNG, "image/png"))],
    )
    assert r.status_code == 429
    r = client.post("/api/train/caption", json={"job_id": "x"}, headers=_auth(token))
    assert r.status_code == 429
    r = client.post(
        "/api/train/start",
        json={"job_id": "x", "base_ckpt": "y"},
        headers=_auth(token),
    )
    assert r.status_code == 429
    r = client.post("/api/train/x/register", headers=_auth(token))
    assert r.status_code == 429
    r = client.post(
        "/api/train/i2l",
        headers=_auth(token),
        files=[("files", ("a.png", _PNG, "image/png"))],
        data={"lora_name": "x"},
    )
    assert r.status_code == 429
    # 读端点(状态查询)不加限流
    r = client.get("/api/train/jobs", headers=_auth(token))
    assert r.status_code == 200
