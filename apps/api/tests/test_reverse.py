"""POST /api/reverse —— 反推提示词端点测试。

- 图像 → VLM JSON 路径:200 + prompt/negative 解析;系统提示带 NSFW 条款仅 X-NSFW 上下文。
- 图像 → 非 JSON 宽松降级:prompt=原始文本,不 502。
- 视频 → video_url 消息部件 + 六段式系统提示。
- 音频 → SenseVoice 转发 + text/emotion/events/language 组合 prompt 与 meta。
- 空文件 400 / 不支持类型 400 / 超限 413 / 上游异常 502 / 未登录 401。
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.nsfw_ctx import nsfw_intent_var
from app.routes import reverse
from app.security import create_token, hash_password

_PNG = b"\x89PNG\r\x80\x1a\n" + b"\x00" * 64
_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
_WAV = b"RIFF" + b"\x00" * 64


@pytest.fixture
def ctx(tmp_path, monkeypatch):
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
            email="rev@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    client = TestClient(app)
    yield client, create_token(uid)
    app.dependency_overrides.clear()


def _auth(token: str, **extra) -> dict:
    return {"Authorization": f"Bearer {token}", **extra}


def _post(client, token, data: bytes, filename: str, content_type: str, **headers):
    return client.post(
        "/api/reverse",
        files={"file": (filename, data, content_type)},
        headers=_auth(token, **headers),
    )


# ── 图像 ─────────────────────────────────────────────────────────────


def test_image_json_path(ctx, monkeypatch):
    calls = {}

    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        calls["system"] = system
        calls["part"] = part
        calls["base_url"] = base_url
        return '{"prompt": "a cinematic portrait", "negative": "blurry, watermark"}'

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    client, token = ctx
    r = _post(client, token, _PNG, "ref.png", "image/png")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "image"
    assert body["prompt"] == "a cinematic portrait"
    assert body["negative"] == "blurry, watermark"
    assert calls["part"]["type"] == "image_url"
    assert calls["part"]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "成人" not in calls["system"]  # 主站上下文不带 NSFW 条款
    assert "9303" in calls["base_url"]  # SFW 图像走 Qwen3-VL


def test_image_nsfw_clause(ctx, monkeypatch):
    calls = {}

    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        calls["system"] = system
        calls["base_url"] = base_url
        return '{"prompt": "x", "negative": ""}'

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    client, token = ctx
    nsfw_intent_var.set(True)
    try:
        r = _post(client, token, _PNG, "ref.png", "image/png", **{"X-NSFW": "1"})
    finally:
        nsfw_intent_var.set(False)
    assert r.status_code == 200, r.text
    assert "成人" in calls["system"]
    assert "9304" in calls["base_url"]  # NSFW 图像走 JoyCaption 专线
    assert r.json()["negative"] is None  # 空串归一为 None


def test_image_nsfw_fallback_when_joycaption_unset(ctx, monkeypatch):
    """joycaption_base_url 空串(专线未部署)时,NSFW 图像回退 Qwen3-VL。"""
    calls = {}

    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        calls["base_url"] = base_url
        return '{"prompt": "x", "negative": ""}'

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    settings = reverse.get_settings()
    monkeypatch.setattr(settings, "joycaption_base_url", "")
    client, token = ctx
    nsfw_intent_var.set(True)
    try:
        r = _post(client, token, _PNG, "ref.png", "image/png", **{"X-NSFW": "1"})
    finally:
        nsfw_intent_var.set(False)
    assert r.status_code == 200, r.text
    assert "9303" in calls["base_url"]


def test_image_non_json_fallback(ctx, monkeypatch):
    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        return "A woman standing in the rain, cinematic lighting"

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    client, token = ctx
    r = _post(client, token, _PNG, "ref.jpg", "image/jpeg")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt"].startswith("A woman")
    assert body["negative"] is None


# ── 视频 ─────────────────────────────────────────────────────────────


def test_video_path(ctx, monkeypatch):
    calls = {}

    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        calls["part"] = part
        calls["system"] = system
        calls["base_url"] = base_url
        return '{"prompt": "tracking shot of a runner at dawn"}'

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    client, token = ctx
    r = _post(client, token, _MP4, "clip.mp4", "video/mp4")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "video"
    assert "tracking shot" in body["prompt"]
    assert calls["part"]["type"] == "video_url"
    assert calls["part"]["video_url"]["url"].startswith("data:video/mp4;base64,")
    assert "镜头运动" in calls["system"]  # 六段式系统提示
    assert "9303" in calls["base_url"]  # 视频一律走 Qwen3-VL(JoyCaption 纯图像)


# ── 音频 ─────────────────────────────────────────────────────────────


def test_audio_path(ctx, monkeypatch):
    calls = {}

    async def fake_analyze(content: bytes, filename: str, mime: str) -> dict:
        calls["filename"] = filename
        return {
            "text": "你好世界",
            "emotion": "happy",
            "events": ["laughter", "bgm"],
            "language": "zh",
        }

    monkeypatch.setattr(reverse, "_sensevoice_analyze", fake_analyze)
    client, token = ctx
    r = _post(client, token, _WAV, "voice.wav", "audio/wav")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "audio"
    assert body["prompt"].startswith("你好世界")
    assert "happy" in body["prompt"] and "laughter" in body["prompt"]
    assert body["meta"] == {
        "text": "你好世界", "emotion": "happy",
        "events": ["laughter", "bgm"], "language": "zh",
    }
    assert calls["filename"] == "voice.wav"


def test_audio_empty_result(ctx, monkeypatch):
    async def fake_analyze(content: bytes, filename: str, mime: str) -> dict:
        return {"text": "", "emotion": "", "events": [], "language": ""}

    monkeypatch.setattr(reverse, "_sensevoice_analyze", fake_analyze)
    client, token = ctx
    r = _post(client, token, _WAV, "voice.wav", "audio/wav")
    assert r.status_code == 200, r.text
    assert r.json()["prompt"] == "未识别到语音内容"


# ── 入参校验 ─────────────────────────────────────────────────────────


def test_empty_file_400(ctx):
    client, token = ctx
    r = _post(client, token, b"", "ref.png", "image/png")
    assert r.status_code == 400


def test_unsupported_type_400(ctx):
    client, token = ctx
    r = _post(client, token, b"MZ" + b"\x00" * 32, "app.exe", "application/octet-stream")
    assert r.status_code == 400


def test_oversize_413(ctx, monkeypatch):
    monkeypatch.setattr(reverse, "_limit_for", lambda kind: 8)
    client, token = ctx
    r = _post(client, token, _PNG, "ref.png", "image/png")
    assert r.status_code == 413


def test_ext_fallback_when_mime_generic(ctx, monkeypatch):
    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        return '{"prompt": "x", "negative": "y"}'

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    client, token = ctx
    r = _post(client, token, _PNG, "ref.webp", "application/octet-stream")
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "image"


# ── 上游故障 ─────────────────────────────────────────────────────────


def test_vlm_upstream_502(ctx, monkeypatch):
    async def fake_chat(system: str, part: dict, base_url: str) -> str:
        raise HTTPException(status_code=502, detail="VLM 反推服务不可达")

    monkeypatch.setattr(reverse, "_chat_completion", fake_chat)
    client, token = ctx
    r = _post(client, token, _PNG, "ref.png", "image/png")
    assert r.status_code == 502


def test_sensevoice_upstream_502(ctx, monkeypatch):
    async def fake_analyze(content: bytes, filename: str, mime: str) -> dict:
        raise HTTPException(status_code=502, detail="音频反推服务不可达")

    monkeypatch.setattr(reverse, "_sensevoice_analyze", fake_analyze)
    client, token = ctx
    r = _post(client, token, _WAV, "voice.wav", "audio/wav")
    assert r.status_code == 502


def test_unauthenticated_401(ctx):
    client, _ = ctx
    r = client.post(
        "/api/reverse",
        files={"file": ("ref.png", _PNG, "image/png")},
    )
    assert r.status_code in (401, 403)
