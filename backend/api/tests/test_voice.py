"""漫剧配音 /api/manju/voice 多语言路由单测。

- 默认语言 zh 走 tts_url，请求不携带 language。
- ja/ko/yue 走 tts_multilingual_url，请求携带 language。
- 未配置多语言 TTS 时 ja 返回 503。
- 非法语言 422。
"""
import io
import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import Job, User
from app.routes.voice import VoiceRequest, synth_voice


def _session() -> Session:
    return Session(engine)


init_db()  # 本地 sqlite 可能是旧结构;迁移幂等,确保 job 表列齐全


def _minimal_wav() -> bytes:
    """构造一个合法的最小 WAV 文件供 fake TTS 返回。"""
    import io as _io
    import wave as _wave
    buf = _io.BytesIO()
    with _wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(24000)
        w.writeframes(b"\x00")
    return buf.getvalue()


_MIN_WAV = _minimal_wav()

class _FakeResponse:
    def __init__(self, status_code: int = 200, content: bytes = _MIN_WAV):
        self.status_code = status_code
        self.content = content

    def json(self) -> dict:
        return {}

    def raise_for_status(self) -> None:
        pass


class _FakeClient:
    def __init__(self):
        self.calls: list[tuple] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url: str):
        self.calls.append(("get", url))
        return _FakeResponse()

    async def post(self, url: str, data=None, files=None):
        self.calls.append(("post", url, data, files))
        return _FakeResponse()


def _user() -> User:
    return User(
        id="u1",
        tenant_id="t1",
        email="u@t.com",
        hashed_password="x",
    )


def _patch_settings(monkeypatch, multilingual_url: str = "http://tts.mul"):
    class _Settings:
        tts_url = "http://tts.zh"
        tts_multilingual_url = multilingual_url
        api_base_url = "http://127.0.0.1:8090"

    monkeypatch.setattr("app.routes.voice.get_settings", lambda: _Settings())


def _patch_ratelimit(monkeypatch):
    monkeypatch.setattr(
        "app.routes.voice.enforce_generation_rate_limit", lambda *a, **k: None
    )


async def test_zh_uses_default_tts_url_and_no_language(monkeypatch, tmp_path):
    _patch_settings(monkeypatch, "")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)

    fake = _FakeClient()
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: fake)

    result = await synth_voice(VoiceRequest(text="你好"), _user(), _session())

    assert len(fake.calls) == 1
    method, url, data, files = fake.calls[0]
    assert method == "post"
    assert url == "http://tts.zh/tts"
    assert data == {"text": "你好"}
    assert "language" not in data
    assert result.url.startswith("/api/manju/voice/")


async def test_ja_uses_multilingual_tts_url_and_language(monkeypatch, tmp_path):
    _patch_settings(monkeypatch, "http://tts.mul")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)

    fake = _FakeClient()
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: fake)

    result = await synth_voice(
        VoiceRequest(text="こんにちは", language="ja"), _user(), _session()
    )

    assert len(fake.calls) == 1
    method, url, data, files = fake.calls[0]
    assert method == "post"
    assert url == "http://tts.mul/tts"
    assert data == {"text": "こんにちは", "language": "ja"}
    assert result.url.startswith("/api/manju/voice/")


async def test_ja_without_multilingual_config_returns_503(monkeypatch, tmp_path):
    _patch_settings(monkeypatch, "")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)

    with pytest.raises(HTTPException) as exc:
        await synth_voice(
            VoiceRequest(text="こんにちは", language="ja"), _user(), _session()
        )
    assert exc.value.status_code == 503


async def test_invalid_language_returns_422(monkeypatch, tmp_path):
    _patch_settings(monkeypatch, "")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)

    with pytest.raises(HTTPException) as exc:
        await synth_voice(VoiceRequest(text="x", language="fr"), _user(), _session())
    assert exc.value.status_code == 422


async def test_synth_registers_job_for_library(monkeypatch, tmp_path):
    """TTS 产物建档:合成成功 → Job(kind=manju_voice, status=done) 落库,结果 URL 可回放。"""
    _patch_settings(monkeypatch, "")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)
    fake = _FakeClient()
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: fake)

    result = await synth_voice(VoiceRequest(text="建档测试台词"), _user(), _session())

    with _session() as s:
        job = s.exec(
            select(Job)
            .where(Job.kind == "manju_voice", Job.prompt == "建档测试台词")
            .order_by(Job.created_at.desc())  # 本地库可复用,同名历史行取最新
        ).first()
    assert job is not None
    assert job.status == "done"
    assert job.prompt == "建档测试台词"
    assert json.loads(job.result) == [result.url]
    assert job.prompt_id.startswith("tts-voice-")


async def test_synth_job_register_failure_does_not_break(monkeypatch, tmp_path):
    """建档失败不炸主流程:音频已落盘,响应照常返回。"""
    _patch_settings(monkeypatch, "")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)
    fake = _FakeClient()
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: fake)

    class _BadSession:
        def add(self, obj):
            raise RuntimeError("db down")

        def rollback(self):
            pass

    result = await synth_voice(VoiceRequest(text="容错"), _user(), _BadSession())
    assert result.url.startswith("/api/manju/voice/")
