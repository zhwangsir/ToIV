"""Studio lipsync 服务:优先 TOIV_LIPSYNC_URL agent,本地 studio 直读,失败边界。

覆盖:
  · lipsync_url 非空 → lipsync_via_agent(mock httpx),不走 Comfy pool.pick
  · lipsync_url 空 → 回退 Comfy 路径(pool.pick)
  · /api/studio/files/ 直读磁盘,不发 HTTP
  · 缺视频/配音 → LipsyncError
  · agent degraded → LipsyncError(不落假成片)
  · 非法路径(含 ..) → LipsyncError
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.models import StudioShot
from app.services.studio import lipsync as ls


@pytest.fixture(autouse=True)
def _skip_real_pad(monkeypatch):
    """单测用假字节非真媒体；pad/mux 探测会失败，默认旁路。"""
    async def _passthrough(video_bytes, voice_bytes):
        return voice_bytes
    async def _mux_passthrough(video_bytes, voice_bytes):
        return video_bytes  # 假 mp4 无法真 mux；单测只验证调用链
    monkeypatch.setattr(ls, "pad_audio_to_video_length", _passthrough)
    monkeypatch.setattr(ls, "mux_voice_into_clip", _mux_passthrough)



_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 80
_WAV = b"RIFF" + b"\x00" * 60


class _Settings:
    def __init__(self, lipsync_url: str = "", api_base_url: str = "http://api.test"):
        self.lipsync_url = lipsync_url
        self.api_base_url = api_base_url


def _shot(video="/api/studio/files/v.mp4", voice="/api/studio/files/a.wav") -> StudioShot:
    return StudioShot(
        project_id="p",
        idx=0,
        render_mode="video",
        video_url=video,
        voice_url=voice,
    )


def _seed_studio_files(tmp_path: Path, monkeypatch, *, video=_MP4, audio=_WAV):
    root = tmp_path / "drama"
    studio = root / "studio"
    studio.mkdir(parents=True)
    (studio / "v.mp4").write_bytes(video)
    (studio / "a.wav").write_bytes(audio)
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)
    return root


class _Resp:
    def __init__(self, status_code=200, payload=None, content=b""):
        self.status_code = status_code
        self._payload = payload or {}
        self.content = content

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "err", request=httpx.Request("GET", "http://x"), response=MagicMock()
            )


class _AgentClient:
    """按 URL 路由的 LatentSync agent 替身;类属性可预置。"""

    uploads: list = []
    submits: list = []
    status_payloads: list = [{"status": "succeeded", "degraded": False}]
    result_payload: dict = {"video_url": "/files/output/out.mp4"}
    result_bytes: bytes = _MP4
    upload_status: int = 200
    submit_status: int = 200
    get_fail: Exception | None = None

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    async def post(self, url: str, files=None, data=None, json=None):
        if url.endswith("/v1/video/upload"):
            typ = (data or {}).get("type", "")
            type(self).uploads.append(typ)
            name = "vid.mp4" if typ == "video" else "aud.wav"
            return _Resp(type(self).upload_status, {"filename": name})
        if url.endswith("/v1/lipsync/submit"):
            type(self).submits.append(json or {})
            return _Resp(type(self).submit_status, {"task_id": "task-1"})
        raise AssertionError(f"unexpected POST {url}")

    async def get(self, url: str, timeout=None):
        if type(self).get_fail is not None:
            raise type(self).get_fail
        if "/v1/lipsync/status/" in url:
            if not type(self).status_payloads:
                return _Resp(200, {"status": "running"})
            return _Resp(200, type(self).status_payloads.pop(0))
        if "/v1/lipsync/result/" in url:
            return _Resp(200, type(self).result_payload)
        if "/files/output/" in url:
            return _Resp(200, content=type(self).result_bytes)
        raise AssertionError(f"unexpected GET {url}")


@pytest.fixture(autouse=True)
def _reset_agent():
    _AgentClient.uploads = []
    _AgentClient.submits = []
    _AgentClient.status_payloads = [{"status": "succeeded", "degraded": False}]
    _AgentClient.result_payload = {"video_url": "/files/output/out.mp4"}
    _AgentClient.result_bytes = _MP4
    _AgentClient.upload_status = 200
    _AgentClient.submit_status = 200
    _AgentClient.get_fail = None
    yield


@pytest.mark.asyncio
async def test_lipsync_prefers_agent_when_url_set(tmp_path, monkeypatch):
    """lipsync_url 非空 → agent 路径;pool.pick 不被调用。"""
    _seed_studio_files(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "app.config.get_settings", lambda: _Settings("http://lipsync.test:9103")
    )
    monkeypatch.setattr(ls.httpx, "AsyncClient", lambda **kw: _AgentClient())
    monkeypatch.setattr(ls, "_save_clip", lambda data: "/api/studio/files/out.mp4")
    monkeypatch.setattr(ls, "_POLL_INTERVAL", 0.01)

    pool = MagicMock()
    pool.pick = AsyncMock(side_effect=AssertionError("Comfy path must not run"))

    url = await ls.lipsync_video(_shot(), pool)
    assert url == "/api/studio/files/out.mp4"
    assert _AgentClient.uploads == ["video", "audio"]
    assert _AgentClient.submits and _AgentClient.submits[0]["video"] == "vid.mp4"
    pool.pick.assert_not_called()


@pytest.mark.asyncio
async def test_lipsync_falls_back_comfy_when_url_empty(tmp_path, monkeypatch):
    """lipsync_url 空 → Comfy pool 路径。"""
    _seed_studio_files(tmp_path, monkeypatch)
    monkeypatch.setattr("app.config.get_settings", lambda: _Settings(""))

    calls: dict = {}

    class FakeClient:
        base_url = "http://fake:8188"

        async def upload_image(self, content, filename):
            calls.setdefault("uploads", []).append(filename)
            return filename

        async def queue_prompt(self, graph, client_id):
            calls["graph"] = graph
            return "pid-ls"

        async def get_result_files(self, prompt_id):
            return [{"filename": "out.mp4", "subfolder": "", "type": "output"}]

        async def get_image_bytes(self, filename, subfolder, type_):
            return b"lipsynced-mp4", "video/mp4"

    class FakePool:
        async def pick(self, required=(), required_nodes=()):
            calls["picked"] = True
            return FakeClient()

    monkeypatch.setattr(ls, "_save_clip", lambda data: "/api/studio/files/ls.mp4")
    monkeypatch.setattr(ls, "_POLL_INTERVAL", 0.01)

    url = await ls.lipsync_video(_shot(), FakePool())
    assert url == "/api/studio/files/ls.mp4"
    assert calls.get("picked") is True
    assert calls.get("graph")
    assert any("studio_ls_src" in f for f in calls["uploads"])


@pytest.mark.asyncio
async def test_local_studio_files_read_without_http(tmp_path, monkeypatch):
    """/api/studio/files/ 直读磁盘,httpx.get 不被调用。"""
    _seed_studio_files(tmp_path, monkeypatch)

    class BoomHttp:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, url):
            raise AssertionError(f"must not HTTP-get studio file: {url}")

    async with BoomHttp() as http:
        v = await ls._download(http, "/api/studio/files/v.mp4")
        a = await ls._download(http, "/api/studio/files/a.wav")
    assert v == _MP4
    assert a == _WAV

    # 绝对 URL 形式同样直读
    abs_url = "http://api.test/api/studio/files/v.mp4"
    async with BoomHttp() as http:
        assert await ls._download(http, abs_url) == _MP4


@pytest.mark.asyncio
async def test_lipsync_missing_video_or_voice_raises():
    with pytest.raises(ls.LipsyncError, match="先出视频并配音"):
        await ls.lipsync_video(_shot(video="", voice="/api/studio/files/a.wav"), pool=None)
    with pytest.raises(ls.LipsyncError, match="先出视频并配音"):
        await ls.lipsync_video(_shot(video="/api/studio/files/v.mp4", voice=""), pool=None)


@pytest.mark.asyncio
async def test_agent_degraded_raises(tmp_path, monkeypatch):
    """agent status=succeeded 且 degraded → 不落假成片。"""
    _seed_studio_files(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "app.config.get_settings", lambda: _Settings("http://lipsync.test:9103")
    )
    _AgentClient.status_payloads = [{"status": "succeeded", "degraded": True}]
    monkeypatch.setattr(ls.httpx, "AsyncClient", lambda **kw: _AgentClient())
    monkeypatch.setattr(ls, "_POLL_INTERVAL", 0.01)

    with pytest.raises(ls.LipsyncError, match="降级"):
        await ls.lipsync_video(_shot(), MagicMock())


@pytest.mark.asyncio
async def test_illegal_studio_path_raises(tmp_path, monkeypatch):
    _seed_studio_files(tmp_path, monkeypatch)
    with pytest.raises(ls.LipsyncError, match="非法 studio 文件路径"):
        ls._local_studio_bytes("/api/studio/files/../secret.mp4")
    with pytest.raises(ls.LipsyncError, match="非法 studio 文件路径"):
        ls._local_studio_bytes("/api/studio/files/sub/dir/x.mp4")


@pytest.mark.asyncio
async def test_agent_unconfigured_inside_via_agent():
    monkeypatch_settings = _Settings("")
    # 直接测 lipsync_via_agent 在空 URL 时
    import app.config as cfg

    # use pytest monkeypatch via fixture-less: patch get_settings
    from unittest.mock import patch

    with patch.object(cfg, "get_settings", lambda: monkeypatch_settings):
        with pytest.raises(ls.LipsyncError, match="未配置"):
            await ls.lipsync_via_agent(_shot())
