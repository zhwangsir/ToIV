"""听写作业:cancelJob 后 Whisper 循环 / _run_transcribe 提前退出,不落 done。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.routes import dub_text


def test_whisper_loop_stops_when_canceled(monkeypatch):
    segs = [
        SimpleNamespace(text="a", start=0.0, end=1.0),
        SimpleNamespace(text="b", start=1.0, end=2.0),
    ]

    class _Info:
        duration = 2.0

    class _Model:
        def transcribe(self, path, **kwargs):
            return iter(segs), _Info()

    calls = {"n": 0}

    def _canceled(_prompt_id: str) -> bool:
        calls["n"] += 1
        return True  # 第一段即中止,结果丢弃

    monkeypatch.setattr(dub_text, "db_job_is_canceled", _canceled)
    job = {
        "id": "j1",
        "status": "running",
        "error": None,
        "progress": 0,
        "started": 0.0,
        "elapsed": 0.0,
    }
    out = dub_text._whisper_transcribe_sync(_Model(), "x.wav", job)
    assert job["status"] == "canceled"
    assert job["error"] == "已中止"
    assert out == []


@pytest.mark.asyncio
async def test_run_transcribe_skips_result_if_canceled_after_whisper(monkeypatch):
    monkeypatch.setattr(dub_text, "get_settings", lambda: SimpleNamespace(whisper_url=""))

    async def _model():
        return object()

    monkeypatch.setattr(dub_text, "_get_whisper_model", _model)
    monkeypatch.setattr(
        dub_text,
        "_whisper_transcribe_sync",
        lambda *a, **k: [{"start": 0, "end": 1, "text": "hi"}],
    )
    n = {"c": 0}

    def _canceled(_id: str) -> bool:
        n["c"] += 1
        return n["c"] > 1  # 入口放行,whisper 后拦截

    monkeypatch.setattr(dub_text, "db_job_is_canceled", _canceled)
    job = {
        "id": "j2",
        "status": "running",
        "error": None,
        "stage": "",
        "segments": [],
        "count": 0,
        "progress": 0,
        "started": 0.0,
        "elapsed": 0.0,
    }
    await dub_text._run_transcribe(job, "src", "a.wav")
    assert job["status"] == "canceled"
    assert job["segments"] == []
