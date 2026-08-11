"""渲染策略层测试:render_mode 分发、结果契约、图像运镜链、视频链。"""
from __future__ import annotations

import pytest

from app.models import StudioCharacter, StudioShot
from app.services.studio.renderers import base, image_motion
from app.services.studio.renderers import video as video_mod
from app.services.studio.renderers.base import RenderResult


# ── 分发 ──────────────────────────────────────────────────────────────────


def test_get_renderer_dispatch():
    video_shot = StudioShot(project_id="p", idx=0, render_mode="video")
    image_shot = StudioShot(project_id="p", idx=1, render_mode="image_motion")
    assert base.get_renderer(video_shot).name == "video"
    assert base.get_renderer(image_shot).name == "image_motion"


def test_get_renderer_unknown_mode():
    shot = StudioShot(project_id="p", idx=0, render_mode="bogus")
    with pytest.raises(base.RenderError):
        base.get_renderer(shot)


def test_render_result_contract():
    r = RenderResult(kind="video", url="/api/studio/files/x.mp4")
    assert r.kind == "video" and r.url.endswith(".mp4")


# ── 图像运镜链 ─────────────────────────────────────────────────────────────


def test_kenburns_filter_zoom_in():
    vf = image_motion._kenburns_filter("zoom_in", frames=48, width=768, height=432, fps=16)
    assert "zoompan" in vf and "s=768x432" in vf and "fps=16" in vf


def test_kenburns_filter_pan_left():
    vf = image_motion._kenburns_filter("pan_left", frames=48, width=768, height=432, fps=16)
    assert "zoompan" in vf and "s=768x432" in vf


@pytest.mark.asyncio
async def test_image_motion_render_mocked(monkeypatch):
    """mock ComfyUI 与 ffmpeg:验证出图 → 运镜两段的调用与结果 URL。"""
    calls: dict[str, object] = {}

    class FakeClient:
        base_url = "http://fake:8188"

        async def queue_prompt(self, graph, client_id):
            calls["graph"] = graph
            return "pid-1"

        async def get_images(self, prompt_id):
            return [{"filename": "shot.png", "subfolder": "", "type": "output"}]

        async def get_image_bytes(self, filename, subfolder, type_):
            return b"\x89PNG-fake", "image/png"

    class FakePool:
        async def pick(self, required=(), required_nodes=()):
            return FakeClient()

    async def fake_kenburns(self, image_path, motion, out_path, duration_sec, fps, width=768, height=432):
        out_path.write_bytes(b"fake-mp4")
        return out_path

    saved: list[str] = []

    def fake_save(data: bytes, ext: str) -> str:
        saved.append(ext)
        return f"/api/studio/files/a{ext}"

    monkeypatch.setattr(image_motion.ImageMotionRenderer, "_run_kenburns", fake_kenburns)
    monkeypatch.setattr(image_motion, "_save_output", fake_save)

    shot = StudioShot(
        project_id="p", idx=0, render_mode="image_motion",
        prompt="1girl, rooftop", duration_sec=3, camera="zoom_in",
    )
    cast = [StudioCharacter(project_id="p", name="凛", visual_prompt="1girl")]
    r = await image_motion.ImageMotionRenderer().render(shot, cast, FakePool())
    assert r.kind == "video"  # 运镜后为 mp4 片段
    assert r.url.startswith("/api/studio/files/")
    assert calls["graph"]  # 构图已提交
    assert saved == [".png", ".mp4"]  # 先存静图再存运镜片段
    assert shot.image_url == "/api/studio/files/a.png"  # 静图 URL 副作用供预览


@pytest.mark.asyncio
async def test_image_motion_no_images(monkeypatch):
    """ComfyUI 始终无产出 → RenderError。"""

    class EmptyClient:
        base_url = "http://fake:8188"

        async def queue_prompt(self, graph, client_id):
            return "pid-1"

        async def get_images(self, prompt_id):
            return []

    class FakePool:
        async def pick(self, required=(), required_nodes=()):
            return EmptyClient()

    monkeypatch.setattr(image_motion, "_POLL_INTERVAL", 0.01)
    monkeypatch.setattr(image_motion, "_POLL_TIMEOUT", 0.05)

    shot = StudioShot(project_id="p", idx=0, render_mode="image_motion", prompt="x")
    with pytest.raises(base.RenderError):
        await image_motion.ImageMotionRenderer().render(shot, [], FakePool())


# ── 视频链 ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_video_render_delegates_to_generator(monkeypatch):
    """视频链封装 services/video_generators.get_generator(ltx),角色 token 注入。"""
    from app.services.video_generators import VideoGenResult

    seen: dict[str, object] = {}

    class FakeGen:
        async def generate(self, prompt, **kwargs):
            seen["prompt"] = prompt
            seen.update(kwargs)
            return VideoGenResult(success=True, video_url="/api/video/x.mp4", job_id="j1")

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool: FakeGen())
    shot = StudioShot(
        project_id="p", idx=0, render_mode="video",
        prompt="rainy alley, neon", duration_sec=6,
    )
    cast = [StudioCharacter(project_id="p", name="凛", visual_prompt="1girl, silver hair")]
    r = await video_mod.VideoRenderer().render(shot, cast, pool=None)
    assert r.kind == "video" and r.url.endswith(".mp4")
    assert "1girl, silver hair" in seen["prompt"]
    assert "rainy alley, neon" in seen["prompt"]
    assert seen["duration_sec"] == 6


@pytest.mark.asyncio
async def test_video_render_error_wrap(monkeypatch):
    class FailGen:
        async def generate(self, prompt, **kwargs):
            raise RuntimeError("worker 全忙")

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool: FailGen())
    shot = StudioShot(project_id="p", idx=0, render_mode="video", prompt="x")
    with pytest.raises(base.RenderError):
        await video_mod.VideoRenderer().render(shot, [], pool=None)


@pytest.mark.asyncio
async def test_video_render_unsuccess_result(monkeypatch):
    """生成器返回 success=False(非异常)→ 同样转 RenderError。"""
    from app.services.video_generators import VideoGenResult

    class StubGen:
        async def generate(self, prompt, **kwargs):
            return VideoGenResult(success=False, error="Seedance 生成器尚未接入")

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool: StubGen())
    shot = StudioShot(project_id="p", idx=0, render_mode="video", prompt="x")
    with pytest.raises(base.RenderError, match="尚未接入"):
        await video_mod.VideoRenderer().render(shot, [], pool=None)


@pytest.mark.asyncio
async def test_video_render_fire_and_forget_waits(monkeypatch):
    """ltx 提交后不直接返回 URL(success + job_id + raw.worker)→ 轮询 worker history。"""
    from app.services.video_generators import VideoGenResult

    class SubmitOnlyGen:
        async def generate(self, prompt, **kwargs):
            return VideoGenResult(
                success=True,
                job_id="pid-9",
                raw={"worker": "http://fake:8188", "prompt_id": "pid-9"},
            )

    class FakeClient:
        def __init__(self, base_url, timeout=30.0):
            self.base_url = base_url

        async def get_result_files(self, prompt_id):
            return [{"filename": "out.mp4", "subfolder": "", "type": "output"}]

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool: SubmitOnlyGen())
    monkeypatch.setattr(video_mod, "ComfyUIClient", FakeClient)
    monkeypatch.setattr(video_mod, "_POLL_INTERVAL", 0.01)

    shot = StudioShot(project_id="p", idx=0, render_mode="video", prompt="x")
    r = await video_mod.VideoRenderer().render(shot, [], pool=None)
    assert r.kind == "video"
    assert r.url.startswith("/api/images?")  # 代理 URL(tracker.image_url 格式)
    assert "out.mp4" in r.url


# ── 项目级产出规格(分辨率/帧率)贯通 ──────────────────────────────────────


@pytest.mark.asyncio
async def test_video_render_forwards_project_spec(monkeypatch):
    """项目 width/height/fps 经 kw 透传到视频生成器(缺省回落 768×384@16)。"""
    from app.services.video_generators import VideoGenResult

    seen: dict[str, object] = {}

    class FakeGen:
        async def generate(self, prompt, **kwargs):
            seen.update(kwargs)
            return VideoGenResult(success=True, video_url="/api/video/x.mp4", job_id="j1")

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool: FakeGen())
    shot = StudioShot(project_id="p", idx=0, render_mode="video", prompt="x", duration_sec=6)
    r = await video_mod.VideoRenderer().render(
        shot, [], pool=None, width=1280, height=720, fps=24
    )
    assert r.kind == "video"
    assert seen["width"] == 1280 and seen["height"] == 720
    assert seen["fps"] == 24 and seen["duration_sec"] == 6

    seen.clear()
    await video_mod.VideoRenderer().render(shot, [], pool=None)
    assert seen["width"] == 768 and seen["height"] == 384 and seen["fps"] == 16


@pytest.mark.asyncio
async def test_image_motion_render_project_spec(monkeypatch):
    """项目 width/height/fps 注入 txt2img 构图与 Ken Burns 运镜(缺省回落模块常量)。"""
    captured: dict[str, object] = {}

    class FakeClient:
        base_url = "http://fake:8188"

        async def queue_prompt(self, graph, client_id):
            captured["graph"] = graph
            return "pid-1"

        async def get_images(self, prompt_id):
            return [{"filename": "shot.png", "subfolder": "", "type": "output"}]

        async def get_image_bytes(self, filename, subfolder, type_):
            return b"\x89PNG-fake", "image/png"

    class FakePool:
        async def pick(self, required=(), required_nodes=()):
            return FakeClient()

    async def fake_kenburns(self, image_path, motion, out_path, duration_sec, fps, width, height):
        captured["kenburns"] = (width, height, fps)
        out_path.write_bytes(b"fake-mp4")
        return out_path

    monkeypatch.setattr(image_motion.ImageMotionRenderer, "_run_kenburns", fake_kenburns)
    monkeypatch.setattr(image_motion, "_save_output", lambda data, ext: f"/api/studio/files/a{ext}")

    shot = StudioShot(
        project_id="p", idx=0, render_mode="image_motion",
        prompt="1girl, rooftop", duration_sec=3, camera="zoom_in",
    )
    await image_motion.ImageMotionRenderer().render(
        shot, [], FakePool(), width=720, height=1280, fps=24
    )
    # txt2img 潜空间节点(width/height 在 EmptyLatentImage 类节点上)
    graph = captured["graph"]
    dims = {
        (n["inputs"].get("width"), n["inputs"].get("height"))
        for n in graph.values()
        if isinstance(n, dict) and "width" in n.get("inputs", {})
    }
    assert (720, 1280) in dims
    assert captured["kenburns"] == (720, 1280, 24)
