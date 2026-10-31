"""外部 ASR(dub_text._transcribe_external)/asr 404 → OpenAI 兼容回退测试。"""

from __future__ import annotations

import pytest

from app.routes import dub_text


class _Resp:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    """/asr 一律 404;/v1/audio/transcriptions 返回 verbose_json segments。"""

    def __init__(self, calls: list[str], **_kwargs):
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url: str, **_kwargs) -> _Resp:
        self._calls.append(url)
        if url.endswith("/asr"):
            return _Resp(404)
        assert url.endswith("/v1/audio/transcriptions")
        return _Resp(
            200,
            {"segments": [{"start": 0.0, "end": 1.5, "text": "你好"}, {"start": 1.5, "end": 3.0, "text": "世界"}]},
        )


@pytest.mark.asyncio
async def test_dub_text_external_asr_openai_fallback(monkeypatch, tmp_path):
    calls: list[str] = []
    monkeypatch.setattr(dub_text.httpx, "AsyncClient", lambda **kw: _FakeClient(calls, **kw))
    src = tmp_path / "a.mp4"
    src.write_bytes(b"fake")
    segs = await dub_text._transcribe_external("http://asr:9210", src, "a.mp4")
    assert calls[0].endswith("/asr") and calls[1].endswith("/v1/audio/transcriptions")
    assert [(s["start"], s["end"], s["text"]) for s in segs] == [
        (0.0, 1.5, "你好"),
        (1.5, 3.0, "世界"),
    ]
