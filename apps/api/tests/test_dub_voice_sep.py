"""译制参考音人声分离前置(dub_voice._separate_vocals / _run_voice_track 接线)测试。

- _separate_vocals 成功:POST /separate 返回 vocals wav。
- _separate_vocals 失败(不可达/非 200):返回 None,不抛异常。
- _run_voice_track 接线:audio_sep_url 非空时 vocals 作为 TTS 克隆参考音;
  分离失败时回退原始抽取参考音,译制不阻断。
"""

from __future__ import annotations

import io
import wave
from types import SimpleNamespace

import httpx
import pytest

from app.routes import dub_voice
from app.routes.dub_voice import VoiceSeg, VoiceTrackRequest


def _minimal_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 2400)  # 0.1s
    return buf.getvalue()


_MIN_WAV = _minimal_wav()
_VOCALS = b"RIFF-vocals-separated"


class _Resp:
    def __init__(self, status_code: int = 200, content: bytes = _VOCALS):
        self.status_code = status_code
        self.content = content


class _FakeClient:
    def __init__(self, calls: list, resp: _Resp | None = None, exc: Exception | None = None, **_kw):
        self._calls = calls
        self._resp = resp or _Resp()
        self._exc = exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url: str, **kwargs) -> _Resp:
        self._calls.append((url, kwargs))
        if self._exc:
            raise self._exc
        return self._resp


@pytest.mark.asyncio
async def test_separate_vocals_success(monkeypatch):
    calls: list = []
    monkeypatch.setattr(dub_voice.httpx, "AsyncClient", lambda **kw: _FakeClient(calls, **kw))
    vocals = await dub_voice._separate_vocals("http://sep:9220/", b"RIFF-raw-ref")
    assert vocals == _VOCALS
    url, kwargs = calls[0]
    assert url == "http://sep:9220/separate"
    assert kwargs["files"]["file"][1] == b"RIFF-raw-ref"


@pytest.mark.asyncio
async def test_separate_vocals_unreachable_returns_none(monkeypatch):
    monkeypatch.setattr(
        dub_voice.httpx, "AsyncClient",
        lambda **kw: _FakeClient([], exc=httpx.ConnectError("boom"), **kw),
    )
    assert await dub_voice._separate_vocals("http://sep:9220", b"RIFF-raw-ref") is None


@pytest.mark.asyncio
async def test_separate_vocals_bad_status_returns_none(monkeypatch):
    monkeypatch.setattr(
        dub_voice.httpx, "AsyncClient",
        lambda **kw: _FakeClient([], resp=_Resp(500, b"err"), **kw),
    )
    assert await dub_voice._separate_vocals("http://sep:9220", b"RIFF-raw-ref") is None


def _patch_pipeline(monkeypatch, tmp_path, vocals: bytes | None) -> dict:
    """接通 _run_voice_track 周边:ffmpeg 假写 wav、TTS 捕获参考音。返回捕获盒。"""
    box: dict = {"refs": []}

    async def _fake_ffmpeg(cmd: list[str]) -> None:
        (tmp_path / "out").mkdir(exist_ok=True)
        with open(cmd[-1], "wb") as f:
            f.write(_MIN_WAV)

    async def _fake_tts(client, base, text, emo_text, emo_alpha, ref):
        box["refs"].append(ref)
        return _MIN_WAV

    async def _fake_sep(base: str, audio: bytes) -> bytes | None:
        box["sep_called_with"] = audio
        return vocals

    monkeypatch.setattr(dub_voice, "_run_ffmpeg", _fake_ffmpeg)
    monkeypatch.setattr(dub_voice, "_tts", _fake_tts)
    monkeypatch.setattr(dub_voice, "_separate_vocals", _fake_sep)
    monkeypatch.setattr(
        dub_voice, "get_settings",
        lambda: SimpleNamespace(tts_url="http://tts:9200", audio_sep_url="http://sep:9220"),
    )
    return box


def _job() -> dict:
    return {
        "id": "j1", "status": "running", "error": None, "stage": "",
        "completed": 0, "failed": 0, "progress": 0, "elapsed": 0.0,
        "started": 0.0, "result": None,
    }


@pytest.mark.asyncio
async def test_voice_track_uses_separated_vocals(monkeypatch, tmp_path):
    box = _patch_pipeline(monkeypatch, tmp_path, _VOCALS)
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    body = VoiceTrackRequest(name="src", segments=[VoiceSeg(start=0.0, end=2.0, text="你好")])
    job = _job()
    await dub_voice._run_voice_track(job, src, body, 10.0)
    assert job["status"] == "done", job.get("error")
    assert box["sep_called_with"] == _MIN_WAV  # 分离收到的是原始抽取音
    assert box["refs"] == [_VOCALS]  # TTS 克隆用的是分离后的人声


@pytest.mark.asyncio
async def test_voice_track_sep_failure_falls_back(monkeypatch, tmp_path):
    box = _patch_pipeline(monkeypatch, tmp_path, None)
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    body = VoiceTrackRequest(name="src", segments=[VoiceSeg(start=0.0, end=2.0, text="你好")])
    job = _job()
    await dub_voice._run_voice_track(job, src, body, 10.0)
    assert job["status"] == "done", job.get("error")
    assert box["refs"] == [_MIN_WAV]  # 回退原始抽取参考音
