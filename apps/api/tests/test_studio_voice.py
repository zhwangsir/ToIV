"""配音与对口型测试:IndexTTS2 合成、参考音转发、LatentSync 流水线、路由容错。"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.studio import voice


# ── 服务层:voice.synth ──────────────────────────────────────────────────────


class _FakeSettings:
    tts_url = "http://tts:9200"
    tts_multilingual_url = ""


@pytest.mark.asyncio
async def test_synth_ok(monkeypatch):
    wav = b"RIFF" + b"\x00" * 100
    posted: dict[str, object] = {}

    class FakeResponse:
        status_code = 200
        content = wav

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            posted["url"] = url
            posted["data"] = data
            posted["files"] = files
            return FakeResponse()

    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice, "_save_wav", lambda data: "/api/studio/files/v.wav")
    monkeypatch.setattr(voice, "get_settings", lambda: _FakeSettings())

    url = await voice.synth("我回来了。", ref_audio_bytes=None)
    assert url == "/api/studio/files/v.wav"
    assert posted["url"] == "http://tts:9200/tts"
    assert posted["data"]["text"] == "我回来了。"
    assert posted["files"] is None  # 无参考音 → 纯表单


@pytest.mark.asyncio
async def test_synth_ref_forwarded(monkeypatch):
    """角色参考音以 multipart 文件转发给 TTS。"""
    posted: dict[str, object] = {}

    class FakeResponse:
        status_code = 200
        content = b"RIFFxxxx"

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            posted["files"] = files
            return FakeResponse()

    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice, "_save_wav", lambda data: "/api/studio/files/v.wav")
    monkeypatch.setattr(voice, "get_settings", lambda: _FakeSettings())

    await voice.synth("台词", ref_audio_bytes=b"RIFF-ref")
    assert posted["files"]["ref_audio"][1] == b"RIFF-ref"


@pytest.mark.asyncio
async def test_synth_tts_down(monkeypatch):
    class DownClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda **kw: DownClient())
    monkeypatch.setattr(voice, "get_settings", lambda: _FakeSettings())
    with pytest.raises(voice.VoiceError, match="不可达"):
        await voice.synth("x", ref_audio_bytes=None)


@pytest.mark.asyncio
async def test_synth_non_audio_response(monkeypatch):
    """TTS 返回 200 但非 wav → VoiceError(不落盘)。"""
    class FakeResponse:
        status_code = 200
        content = b'{"error":"oops"}'

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            return FakeResponse()

    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice, "get_settings", lambda: _FakeSettings())
    with pytest.raises(voice.VoiceError, match="合成失败"):
        await voice.synth("x", ref_audio_bytes=None)


@pytest.mark.asyncio
async def test_synth_unconfigured(monkeypatch):
    class NoTTS:
        tts_url = ""
        tts_multilingual_url = ""

    monkeypatch.setattr(voice, "get_settings", lambda: NoTTS())
    with pytest.raises(voice.VoiceError, match="未配置"):
        await voice.synth("x", ref_audio_bytes=None)


# ── 服务层:lipsync 流水线 ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lipsync_video_pipeline_mocked(monkeypatch):
    """全 mock:下载源 → 上传 worker → LatentSync 构图提交 → 轮询产物 → 落盘 URL。"""
    from app.models import StudioShot
    from app.services.studio import lipsync as ls

    calls: dict[str, object] = {}

    class FakeResp:
        def __init__(self, content: bytes):
            self.content = content

        def raise_for_status(self):
            return None

    class FakeHttp:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, url):
            calls.setdefault("gets", []).append(url)
            return FakeResp(b"video-bytes" if "v.mp4" in url else b"RIFF-audio")

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
            return FakeClient()

    monkeypatch.setattr(ls.httpx, "AsyncClient", lambda **kw: FakeHttp())
    monkeypatch.setattr(ls, "_save_clip", lambda data: "/api/studio/files/ls.mp4")

    shot = StudioShot(
        project_id="p", idx=0, render_mode="video",
        video_url="/api/studio/files/v.mp4", voice_url="/api/studio/files/v.wav",
    )
    url = await ls.lipsync_video(shot, FakePool())
    assert url == "/api/studio/files/ls.mp4"
    assert calls["graph"]  # LatentSync 构图已提交
    uploads = calls["uploads"]
    assert any("studio_ls_src" in f for f in uploads)
    assert any("studio_ls_voice" in f for f in uploads)


@pytest.mark.asyncio
async def test_lipsync_video_requires_media():
    from app.models import StudioShot
    from app.services.studio import lipsync as ls

    shot = StudioShot(project_id="p", idx=0, render_mode="video", video_url="", voice_url="")
    with pytest.raises(ls.LipsyncError, match="先出视频并配音"):
        await ls.lipsync_video(shot, pool=None)


@pytest.mark.asyncio
async def test_lipsync_worker_down(monkeypatch):
    from app.comfy.client import ComfyUIError
    from app.models import StudioShot
    from app.services.studio import lipsync as ls

    class DownPool:
        async def pick(self, required=(), required_nodes=()):
            raise ComfyUIError("no worker")

    shot = StudioShot(
        project_id="p", idx=0, render_mode="video",
        video_url="/api/studio/files/v.mp4", voice_url="/api/studio/files/v.wav",
    )
    with pytest.raises(ls.LipsyncError, match="worker 不可用"):
        await ls.lipsync_video(shot, DownPool())


# ── 路由层:voice / lipsync 端点 ─────────────────────────────────────────────


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="studio-voice")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="voice@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "雨夜"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mk_shot(client: TestClient, H: dict, pid: str, **over) -> dict:
    item = {"scene": "A", "prompt": "a", "render_mode": "video"}
    item.update(over)
    r = client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": [item]})
    assert r.status_code == 200, r.text
    return r.json()["shots"][0]


def test_voice_route_no_dialogue_422(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid)  # 无台词
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 422


def test_voice_route_ok_uses_speaker_character(ctx, monkeypatch):
    """说话人命中角色卡 → 角色随调用传入(参考音克隆在服务层处理)。"""
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "楚生", "visual_prompt": "1boy"},
    )
    shot = _mk_shot(client, H, pid, dialogue="我回来了。", speaker="楚生")

    seen: dict[str, object] = {}

    async def fake_synth_for_shot(session, shot, character):
        seen["character"] = character
        shot.voice_url = "/api/studio/files/v.wav"
        shot.status = "voiced"
        return shot.voice_url

    monkeypatch.setattr(
        "app.services.studio.voice.synth_for_shot", fake_synth_for_shot
    )
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["voice_url"].endswith("v.wav")
    assert r.json()["status"] == "voiced"
    assert seen["character"] is not None and seen["character"].name == "楚生"


def test_voice_route_tts_down_502(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid, dialogue="x")

    async def fake_synth_for_shot(session, shot, character):
        raise voice.VoiceError("TTS 服务不可达")

    monkeypatch.setattr(
        "app.services.studio.voice.synth_for_shot", fake_synth_for_shot
    )
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 502


def test_lipsync_rejects_image_motion(ctx):
    """image_motion 镜请求对口型 → 422。"""
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid, render_mode="image_motion")
    r = client.post(f"/api/studio/shots/{shot['id']}/lipsync", headers=H)
    assert r.status_code == 422
    assert "视频镜" in r.json()["detail"]


def test_lipsync_requires_media_422(ctx):
    """视频镜但未出片/未配音 → 422。"""
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid)  # video 但无 video_url/voice_url
    r = client.post(f"/api/studio/shots/{shot['id']}/lipsync", headers=H)
    assert r.status_code == 422


def test_lipsync_route_ok(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid, dialogue="x")

    async def fake_lipsync_for_shot(session, shot, pool=None):
        shot.final_clip_url = "/api/studio/files/ls.mp4"
        shot.status = "lipsynced"
        return shot.final_clip_url

    monkeypatch.setattr(
        "app.services.studio.lipsync.lipsync_for_shot", fake_lipsync_for_shot
    )
    # 直接落库 video_url/voice_url,绕过渲染/配音(本测试只验端点编排)
    with Session(app.dependency_overrides[get_session]().__next__().bind) as s:
        from app.models import StudioShot

        db_shot = s.get(StudioShot, shot["id"])
        db_shot.video_url = "/api/studio/files/v.mp4"
        db_shot.voice_url = "/api/studio/files/v.wav"
        db_shot.status = "voiced"
        s.add(db_shot)
        s.commit()
    r = client.post(f"/api/studio/shots/{shot['id']}/lipsync", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "lipsynced"
    assert r.json()["final_clip_url"].endswith("ls.mp4")


def test_lipsync_route_error_502(ctx, monkeypatch):
    from app.services.studio.lipsync import LipsyncError

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid, dialogue="x")

    async def fake_lipsync_for_shot(session, shot, pool=None):
        raise LipsyncError("对口型超时")

    monkeypatch.setattr(
        "app.services.studio.lipsync.lipsync_for_shot", fake_lipsync_for_shot
    )
    with Session(app.dependency_overrides[get_session]().__next__().bind) as s:
        from app.models import StudioShot

        db_shot = s.get(StudioShot, shot["id"])
        db_shot.video_url = "/api/studio/files/v.mp4"
        db_shot.voice_url = "/api/studio/files/v.wav"
        s.add(db_shot)
        s.commit()
    r = client.post(f"/api/studio/shots/{shot['id']}/lipsync", headers=H)
    assert r.status_code == 502
