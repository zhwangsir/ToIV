"""真人对口型 /manju/shot/lipsync 端点机械链路测试。"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.comfy.client import ComfyUIError
from app.models import User
from app.routes.lipsync import LipsyncRequest, lipsync_shot


class _User:
    @staticmethod
    def _make() -> User:
        return User(id="u1", tenant_id="t1", email="u@t.com", hashed_password="x")


class _FakeHttpClient:
    def __init__(self, *args, **kwargs):
        self._v = kwargs.pop("_v_content", b"video")
        self._a = kwargs.pop("_a_content", b"audio")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url: str):
        content = self._v if "video" in url or "src" in url else self._a
        resp = MagicMock()
        resp.status_code = 200
        resp.content = content
        resp.raise_for_status = lambda: None
        return resp


def _patch_ratelimit(monkeypatch):
    monkeypatch.setattr("app.routes.lipsync.enforce_generation_rate_limit", lambda *a, **k: None)


def _patch_settings(monkeypatch, worker_urls=None):
    urls = worker_urls or ["http://worker"]
    class _Settings:
        worker_urls = urls

    monkeypatch.setattr("app.routes.lipsync.get_settings", lambda: _Settings())


def _fake_pool():
    pool = MagicMock()
    client = AsyncMock()
    client.base_url = "http://worker"
    client.upload_image = AsyncMock(side_effect=["lipsync_src_abc.mp4", "lipsync_voice_abc.wav"])
    client.queue_prompt = AsyncMock(return_value="prompt-123")
    pool.pick = AsyncMock(return_value=client)
    return pool, client


def _fake_session():
    session = MagicMock()
    session.add = MagicMock()
    session.commit = MagicMock()
    return session


async def test_lipsync_shot_success_with_seed(monkeypatch):
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)
    monkeypatch.setattr("app.routes.lipsync.spawn_tracker", lambda *a, **k: None)
    monkeypatch.setattr("app.routes.lipsync.httpx.AsyncClient", _FakeHttpClient)
    pool, client = _fake_pool()
    session = _fake_session()

    req = LipsyncRequest(
        video_url="/api/video.mp4",
        voice_url="/api/voice.wav",
        seed=42,
    )
    resp = await lipsync_shot(req, pool, _User._make(), session)

    assert resp["prompt_id"] == "prompt-123"
    assert resp["mode"] == "manju_lipsync"
    assert resp["seed"] == 42
    assert resp["worker"] == "http://worker"
    pool.pick.assert_awaited_with(required=set())
    assert client.upload_image.await_count == 2
    client.queue_prompt.assert_awaited()
    session.add.assert_called_once()
    session.commit.assert_called_once()


async def test_lipsync_shot_whitelist_blocks_bad_url(monkeypatch):
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()
    session = _fake_session()

    with pytest.raises(HTTPException) as exc:
        await lipsync_shot(
            LipsyncRequest(video_url="https://evil.com/v.mp4", voice_url="/api/voice.wav"),
            pool, _User._make(), session,
        )
    assert exc.value.status_code == 400


async def test_lipsync_shot_worker_unavailable_returns_503(monkeypatch):
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)
    pool = MagicMock()
    pool.pick = AsyncMock(side_effect=ComfyUIError("无可用 worker"))
    session = _fake_session()

    with pytest.raises(HTTPException) as exc:
        await lipsync_shot(
            LipsyncRequest(video_url="/api/video.mp4", voice_url="/api/voice.wav"),
            pool, _User._make(), session,
        )
    assert exc.value.status_code == 503


async def test_lipsync_shot_download_failure_returns_502(monkeypatch):
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)

    class _BadClient(_FakeHttpClient):
        async def get(self, url: str):
            from httpx import HTTPError
            raise HTTPError("timeout")

    monkeypatch.setattr("app.routes.lipsync.httpx.AsyncClient", _BadClient)
    pool, _ = _fake_pool()
    session = _fake_session()

    with pytest.raises(HTTPException) as exc:
        await lipsync_shot(
            LipsyncRequest(video_url="/api/video.mp4", voice_url="/api/voice.wav"),
            pool, _User._make(), session,
        )
    assert exc.value.status_code == 502


async def test_lipsync_shot_empty_source_returns_502(monkeypatch):
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)
    monkeypatch.setattr(
        "app.routes.lipsync.httpx.AsyncClient",
        lambda *a, **k: _FakeHttpClient(*a, _v_content=b"", _a_content=b"", **k),
    )
    pool, _ = _fake_pool()
    session = _fake_session()

    with pytest.raises(HTTPException) as exc:
        await lipsync_shot(
            LipsyncRequest(video_url="/api/video.mp4", voice_url="/api/voice.wav"),
            pool, _User._make(), session,
        )
    assert exc.value.status_code == 502
