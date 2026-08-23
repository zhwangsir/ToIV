"""音频编排层 /api/audio/orchestrate 单测(mock HTTP,不触真实引擎)。

覆盖:
- 多角色 TTS 对白链:顺序执行、role→voices 映射、ffmpeg 拼接产物
- ffmpeg 缺失:不硬拼,返回分段 + note
- 失败中断:第二步 TTS 500 → 502 带步骤序号,不建档
- 引擎不可达 → 502
- 人声分离链(separate vocals/accompaniment,白名单拦截)
- mix/sfx/variant 占位 → 501
- 建档:Job(kind=audio_orchestrate, status=done),result URL 可回放
"""
import io
import json
import wave

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import Job, User
from app.routes.audio_orchestrate import (
    ConcatStep,
    OrchestrateRequest,
    SeparateStep,
    TtsStep,
    VoiceSpec,
    audio_orchestrate,
)

init_db()  # 本地 sqlite 可能是旧结构;迁移幂等


def _session() -> Session:
    return Session(engine)


def _minimal_wav(text_marker: bytes = b"\x00") -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(24000)
        w.writeframes(text_marker * 2400)  # ~0.1s,拼接结果可验证时长
    return buf.getvalue()


_MIN_WAV = _minimal_wav()


class _FakeResponse:
    def __init__(self, status_code: int = 200, content: bytes = _MIN_WAV):
        self.status_code = status_code
        self.content = content
        self.text = content.decode("utf-8", "replace") if status_code != 200 else ""

    def json(self) -> dict:
        return {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("err", request=None, response=None)


class _FakeClient:
    """按调用顺序返回预置响应;记录调用供断言。"""

    def __init__(self, post_responses: list | None = None, fail_post: Exception | None = None):
        self.calls: list[tuple] = []
        self._post_responses = post_responses or []
        self._fail_post = fail_post

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url: str):
        self.calls.append(("get", url))
        return _FakeResponse()

    async def post(self, url: str, data=None, files=None):
        self.calls.append(("post", url, data, files))
        if self._fail_post is not None:
            raise self._fail_post
        if self._post_responses:
            return self._post_responses.pop(0)
        return _FakeResponse()


def _user() -> User:
    return User(id="u1", tenant_id="t1", email="u@t.com", hashed_password="x")


def _patch_common(monkeypatch, tmp_path, fake_client):
    class _Settings:
        tts_url = "http://tts.zh"
        tts_multilingual_url = "http://tts.mul"
        api_base_url = "http://127.0.0.1:8090"
        worker_urls: list = []

    monkeypatch.setattr("app.routes.audio_orchestrate.get_settings", lambda: _Settings())
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.enforce_generation_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.audio_output_root", lambda: tmp_path / "nas_audio"
    )
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.content_subdir", lambda sub: tmp_path / sub
    )
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: fake_client)


async def test_dialogue_chain_order_concat_and_register(monkeypatch, tmp_path):
    """多角色对白链:两段 tts 顺序合成 → concat 拼接 → 建档,结果 URL 可回放。"""
    fake = _FakeClient()
    _patch_common(monkeypatch, tmp_path, fake)

    body = OrchestrateRequest(
        title="测试对白",
        voices={"甲": VoiceSpec(ref_audio_url="/api/manju/voice/voiceref-x.wav")},
        steps=[
            TtsStep(type="tts", role="甲", text="第一句"),
            TtsStep(type="tts", text="第二句", emo_text="开心"),
            ConcatStep(type="concat"),
        ],
    )
    result = await audio_orchestrate(body, _user(), _session())

    # 顺序:第一段带 ref(get 参考音 + post),第二段只 post,均在 concat 之前
    post_calls = [c for c in fake.calls if c[0] == "post"]
    assert len(post_calls) == 2
    assert post_calls[0][2] == {"text": "第一句"}
    assert post_calls[0][3] is not None  # role=甲 命中 voices 映射,带参考音文件
    assert post_calls[1][2] == {"text": "第二句", "emo_text": "开心", "emo_alpha": "0.6"}

    assert result["kind"] == "audio_orchestrate"
    assert result["note"] is None
    final_url = result["url"]
    assert final_url and final_url.startswith("/api/audio/orch/files/audioorch-")
    arts = result["artifacts"]
    assert [a["type"] for a in arts] == ["tts", "tts", "concat"]
    # 拼接产物时长 ≈ 两段之和(real ffmpeg)
    concat_art = arts[-1]
    assert concat_art["duration_sec"] == pytest.approx(
        arts[0]["duration_sec"] + arts[1]["duration_sec"], abs=0.05
    )

    # 建档:kind=audio_orchestrate,拼接 URL 在 result 首位
    with _session() as s:
        job = s.exec(
            select(Job)
            .where(Job.kind == "audio_orchestrate", Job.prompt == "测试对白")
            .order_by(Job.created_at.desc())
        ).first()
    assert job is not None and job.status == "done"
    urls = json.loads(job.result)
    assert urls[0] == final_url
    assert len(urls) == 3  # 拼接 + 两分段
    assert job.prompt_id.startswith("orch-")


async def test_concat_without_ffmpeg_returns_segments_with_note(monkeypatch, tmp_path):
    """ffmpeg 缺失:不硬拼,分段产物照常交付 + note 标注。"""
    fake = _FakeClient()
    _patch_common(monkeypatch, tmp_path, fake)
    monkeypatch.setattr("app.routes.audio_orchestrate.shutil.which", lambda name: None)

    body = OrchestrateRequest(
        steps=[TtsStep(type="tts", text="甲"), TtsStep(type="tts", text="乙"),
               ConcatStep(type="concat")],
    )
    result = await audio_orchestrate(body, _user(), _session())

    assert result["url"] is None
    assert result["note"] and "ffmpeg" in result["note"]
    assert [a["type"] for a in result["artifacts"]] == ["tts", "tts"]


async def test_failure_aborts_chain_and_no_job(monkeypatch, tmp_path):
    """第二步 TTS 500 → 502 中断,detail 带步骤序号;不建档。"""
    fake = _FakeClient(post_responses=[_FakeResponse(), _FakeResponse(status_code=500)])
    _patch_common(monkeypatch, tmp_path, fake)

    body = OrchestrateRequest(
        title="中断测试",
        steps=[TtsStep(type="tts", text="好"), TtsStep(type="tts", text="坏"),
               ConcatStep(type="concat")],
    )
    with pytest.raises(HTTPException) as exc:
        await audio_orchestrate(body, _user(), _session())
    assert exc.value.status_code == 502
    assert "步骤 1(tts) 失败" in exc.value.detail

    with _session() as s:
        jobs = s.exec(
            select(Job).where(Job.kind == "audio_orchestrate", Job.prompt == "中断测试")
        ).all()
    assert jobs == []


async def test_tts_unreachable_returns_502(monkeypatch, tmp_path):
    import httpx

    fake = _FakeClient(fail_post=httpx.ConnectError("conn refused"))
    _patch_common(monkeypatch, tmp_path, fake)

    body = OrchestrateRequest(steps=[TtsStep(type="tts", text="x")])
    with pytest.raises(HTTPException) as exc:
        await audio_orchestrate(body, _user(), _session())
    assert exc.value.status_code == 502
    assert "TTS 服务不可达" in exc.value.detail


async def test_separate_step_vocals(monkeypatch, tmp_path):
    """分离链:下载源 → separate_vocals → 产物建档 URL。"""
    fake = _FakeClient()
    _patch_common(monkeypatch, tmp_path, fake)
    calls: list[tuple] = []

    async def _fake_sep(audio: bytes, filename: str = "audio"):
        calls.append((audio, filename))
        return _MIN_WAV

    monkeypatch.setattr("app.routes.audio_orchestrate.separate_vocals", _fake_sep)

    body = OrchestrateRequest(
        steps=[SeparateStep(type="separate", source_url="/api/audio/files/audiosep-x.wav")],
    )
    result = await audio_orchestrate(body, _user(), _session())

    assert len(calls) == 1
    assert calls[0][1] == "audiosep-x.wav"
    art = result["artifacts"][0]
    assert art["type"] == "separate" and art["stem"] == "vocals"
    assert art["url"].startswith("/api/audio/orch/files/")


async def test_separate_step_rejects_non_whitelist_url(monkeypatch, tmp_path):
    fake = _FakeClient()
    _patch_common(monkeypatch, tmp_path, fake)

    body = OrchestrateRequest(
        steps=[SeparateStep(type="separate", source_url="http://evil.example.com/a.wav")],
    )
    with pytest.raises(HTTPException) as exc:
        await audio_orchestrate(body, _user(), _session())
    assert exc.value.status_code == 400
    assert "白名单" in exc.value.detail


async def test_placeholder_step_returns_501(monkeypatch, tmp_path):
    fake = _FakeClient()
    _patch_common(monkeypatch, tmp_path, fake)

    body = OrchestrateRequest.model_validate(
        {"steps": [{"type": "mix", "text": "x"}]}
    )
    with pytest.raises(HTTPException) as exc:
        await audio_orchestrate(body, _user(), _session())
    assert exc.value.status_code == 501
    assert "暂未实现" in exc.value.detail
