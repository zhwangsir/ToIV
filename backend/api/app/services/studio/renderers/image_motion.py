"""图像运镜链:ComfyUI 出图(txt2img,角色视觉 token 注入)→ Ken Burns 运镜。

产出与视频链同规格 mp4(768x432@16fps),保证合成阶段无缝拼接。
静图 URL 作为副作用写入 shot.image_url,供前端分镜卡预览。
"""
from __future__ import annotations

import asyncio
import logging
import tempfile
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.comfy.client import ComfyUIError
from app.services.studio.ffmpeg_ops import FFmpegError, ensure_ffmpeg, run_ffmpeg
from app.services.studio.renderers.base import RenderError, RenderResult
from app.request_cancel import mark_prompt_canceled

if TYPE_CHECKING:
    from app.comfy.client import ComfyUIClient
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot

logger = logging.getLogger(__name__)

_WIDTH, _HEIGHT, _FPS = 768, 432, 16
_POLL_INTERVAL = 2.0  # 出图轮询间隔(秒);测试可 monkeypatch
_POLL_TIMEOUT = 300.0  # 出图最长等待(秒)


def _kenburns_filter(motion: str, frames: int, width: int, height: int, fps: int) -> str:
    """zoompan 表达式:先 2x 预放大降抖动,再 zoom/pan 到目标尺寸。"""
    z_map = {
        "zoom_in": "min(zoom+0.0015,1.5)",
        "zoom_out": "max(1.5-0.0015*on,1.0)",
        "pan_left": "1.2",
        "pan_right": "1.2",
    }
    z = z_map.get(motion, z_map["zoom_in"])
    if motion == "pan_left":
        x, y = "iw*(1-on/%d)*0.2" % frames, "(ih-ih/zoom)/2"
    elif motion == "pan_right":
        x, y = "iw*on/%d*0.2" % frames, "(ih-ih/zoom)/2"
    else:
        x, y = "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    return (
        f"scale={width * 2}:{height * 2},"
        f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps}"
    )


def _save_output(data: bytes, ext: str) -> str:
    """落盘到 Studio 输出目录(NAS 优先,降级本地),返回可访问 URL。"""
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


async def _wait_images(
    client: "ComfyUIClient", prompt_id: str, request: Any = None
) -> list[dict]:
    """轮询 ComfyUI history 直到出图;超时/出错抛 RenderError。"""
    waited = 0.0
    while waited < _POLL_TIMEOUT:
        if request is not None and await request.is_disconnected():
            try:
                await client.cancel_prompt(prompt_id)
            except Exception:  # noqa: BLE001
                logger.warning("studio image 中止: cancel_prompt 失败 prompt=%s", prompt_id)
            mark_prompt_canceled(prompt_id)
            raise RenderError("已中止")
        try:
            images = await client.get_images(prompt_id)
        except ComfyUIError:
            images = []  # worker 暂不可达/历史未就绪,下轮再试
        if images:
            return images
        await asyncio.sleep(_POLL_INTERVAL)
        waited += _POLL_INTERVAL
    raise RenderError(f"出图超时({ _POLL_TIMEOUT:.0f}s)")


class ImageMotionRenderer:
    """render_mode=image_motion:出图 → 静图运镜 mp4。"""

    name = "image_motion"

    async def _run_kenburns(
        self,
        image_path: Path,
        motion: str,
        out_path: Path,
        duration_sec: int,
        fps: int,
        width: int = _WIDTH,
        height: int = _HEIGHT,
    ) -> Path:
        frames = max(1, duration_sec * fps)
        vf = _kenburns_filter(motion, frames, width, height, fps)
        await run_ffmpeg(
            [
                "ffmpeg", "-y", "-loop", "1", "-i", image_path.as_posix(),
                "-vf", vf, "-t", str(duration_sec),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", out_path.as_posix(),
            ]
        )
        return out_path

    async def render(
        self,
        shot: "StudioShot",
        cast: list["StudioCharacter"],
        pool: "WorkerPool",
        **kw: Any,
    ) -> RenderResult:
        from app.config import get_settings
        from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

        ckpt = kw.get("ckpt_name") or get_settings().default_ckpt
        # 项目级产出规格(缺省回落模块常量;两链同规格是合成拼接前提)
        width = int(kw.get("width") or _WIDTH)
        height = int(kw.get("height") or _HEIGHT)
        fps = int(kw.get("fps") or _FPS)
        # 角色视觉 token 注入提示词,跨镜保一致
        cast_tokens = ", ".join(c.visual_prompt for c in cast if c.visual_prompt)
        positive = f"{cast_tokens}, {shot.prompt}" if cast_tokens else shot.prompt
        graph = build_txt2img_graph(
            Txt2ImgParams(
                positive=positive,
                negative=shot.negative,
                ckpt_name=ckpt,
                width=width,
                height=height,
                filename_prefix="ToIV_studio",
            )
        )
        try:
            client = await pool.pick(required={ckpt})
            prompt_id = await client.queue_prompt(graph, client_id=uuid.uuid4().hex)
        except ComfyUIError as e:
            raise RenderError(f"出图提交失败:{e}") from e
        images = await _wait_images(client, prompt_id, request=kw.get("request"))
        img = images[0]
        try:
            data, _ = await client.get_image_bytes(
                img["filename"], img.get("subfolder", ""), img.get("type", "output")
            )
        except ComfyUIError as e:
            raise RenderError(f"取图失败:{e}") from e
        image_url = _save_output(data, ".png")

        # Ken Burns 运镜 → mp4 片段
        try:
            ensure_ffmpeg()
            with tempfile.TemporaryDirectory() as td:
                src = Path(td) / "in.png"
                src.write_bytes(data)
                out = Path(td) / "out.mp4"
                await self._run_kenburns(
                    src, shot.camera or "zoom_in", out, shot.duration_sec, fps, width, height
                )
                clip_url = _save_output(out.read_bytes(), ".mp4")
        except FFmpegError as e:
            raise RenderError(f"运镜合成失败:{e}") from e
        # 静图 URL 供前端预览;运镜片段为该镜最终媒体
        shot.image_url = image_url
        return RenderResult(kind="video", url=clip_url)
