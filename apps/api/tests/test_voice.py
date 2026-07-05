"""漫剧配音 /api/manju/voice 多语言路由单测。

- 默认语言 zh 走 tts_url，请求不携带 language。
- ja/ko/yue 走 tts_multilingual_url，请求携带 language。
- 未配置多语言 TTS 时 ja 返回 503。
- 非法语言 422。
"""
import io
import pytest
from fastapi import HTTPException

from app.models import User
from app.routes.voice import VoiceRequest, synth_voice


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

    result = await synth_voice(VoiceRequest(text="你好"), _user())

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
        VoiceRequest(text="こんにちは", language="ja"), _user()
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
            VoiceRequest(text="こんにちは", language="ja"), _user()
        )
    assert exc.value.status_code == 503


async def test_invalid_language_returns_422(monkeypatch, tmp_path):
    _patch_settings(monkeypatch, "")
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.voice._VOICE_DIR", tmp_path)

    with pytest.raises(HTTPException) as exc:
        await synth_voice(VoiceRequest(text="x", language="fr"), _user())
    assert exc.value.status_code == 422
