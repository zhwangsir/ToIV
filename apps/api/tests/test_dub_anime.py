"""动漫对口型 /dub/anime-lipsync 端点测试。"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models import User
from app.routes import dub_anime


def _user() -> User:
    return User(id="u1", tenant_id="t1", email="u@t.com", hashed_password="x")


def _patch_ratelimit(monkeypatch):
    monkeypatch.setattr(
        "app.routes.dub_anime.enforce_generation_rate_limit", lambda *a, **k: None
    )


def _valid_dub_name() -> str:
    return f"dub-{uuid.uuid4().hex}.mp4"


def _valid_anime_name() -> str:
    return f"dubanime-{uuid.uuid4().hex}.mp4"


def _fake_session_empty():
    """DB 无记录的 session:exec().first() 恒 None,让 status 走内存兜底。

    why:anime-lipsync 迁移到 DB Job 后,status 端点先查 DB;测试用内存 job 验证
    实时进度路径,需让 DB 查询返回空以落入内存 fallback 分支。
    """
    session = MagicMock()
    session.exec.return_value.first.return_value = None
    return session


async def test_dub_anime_lipsync_503_when_cv2_missing(monkeypatch):
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.dub_anime.cv2", None)
    monkeypatch.setattr("app.routes.dub_anime.np", None)
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_lipsync(
            dub_anime.AnimeLipsyncRequest(name=_valid_dub_name()),
            _user(),
            _fake_session_empty(),
        )
    assert exc.value.status_code == 503


async def test_dub_anime_lipsync_invalid_name(monkeypatch):
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.dub_anime.cv2", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime.np", MagicMock())
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_lipsync(
            dub_anime.AnimeLipsyncRequest(name="bad.mp4"),
            _user(),
            _fake_session_empty(),
        )
    assert exc.value.status_code == 400


async def test_dub_anime_lipsync_source_not_found(monkeypatch, tmp_path):
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.dub_anime.cv2", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime.np", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime._DUB_DIR", tmp_path)
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_lipsync(
            dub_anime.AnimeLipsyncRequest(name=_valid_dub_name()),
            _user(),
            _fake_session_empty(),
        )
    assert exc.value.status_code == 404


async def test_dub_anime_lipsync_invalid_audio_name(monkeypatch, tmp_path):
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.dub_anime.cv2", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime.np", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime._DUB_DIR", tmp_path)
    src = tmp_path / _valid_dub_name()
    src.write_bytes(b"fake")
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_lipsync(
            dub_anime.AnimeLipsyncRequest(name=src.name, audio_name="bad.wav"),
            _user(),
            _fake_session_empty(),
        )
    assert exc.value.status_code == 400


async def test_dub_anime_lipsync_success(monkeypatch, tmp_path):
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.dub_anime._DUB_DIR", tmp_path)
    monkeypatch.setattr("app.routes.dub_anime.cv2", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime.np", MagicMock())
    monkeypatch.setattr("app.routes.dub_anime._run_anime_lipsync", AsyncMock())
    src = tmp_path / _valid_dub_name()
    src.write_bytes(b"fake")
    resp = await dub_anime.dub_anime_lipsync(
        dub_anime.AnimeLipsyncRequest(name=src.name),
        _user(),
        _fake_session_empty(),
    )
    assert "job_id" in resp
    assert resp["job_id"] in dub_anime._anime_jobs
    dub_anime._anime_jobs.pop(resp["job_id"], None)


async def test_dub_anime_status(monkeypatch):
    _patch_ratelimit(monkeypatch)
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "status": "running", "stage": "排队", "progress": 0,
        "frames": 0, "faces_detected": 0, "url": None, "error": None,
        "elapsed": 0.0,
    }
    dub_anime._anime_jobs[job_id] = job
    try:
        resp = await dub_anime.dub_anime_status(job_id, _user(), _fake_session_empty())
        assert resp["status"] == "running"
    finally:
        dub_anime._anime_jobs.pop(job_id, None)


async def test_dub_anime_status_not_found(monkeypatch):
    _patch_ratelimit(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_status("missing", _user(), _fake_session_empty())
    assert exc.value.status_code == 404


async def test_dub_anime_output_invalid_name(monkeypatch):
    _patch_ratelimit(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_output("bad.mp4", _user())
    assert exc.value.status_code == 400


async def test_dub_anime_output_not_found(monkeypatch, tmp_path):
    _patch_ratelimit(monkeypatch)
    monkeypatch.setattr("app.routes.dub_anime._DUB_DIR", tmp_path)
    with pytest.raises(HTTPException) as exc:
        await dub_anime.dub_anime_output(_valid_anime_name(), _user())
    assert exc.value.status_code == 404
