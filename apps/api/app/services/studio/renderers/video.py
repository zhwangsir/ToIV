"""视频链:封装 services/video_generators(默认 ltx;后续可按项目扩展 h3/liveact)。

角色一致性:视觉 token 注入 prompt(PuLID 首帧在 video_generators 次世代场景接入,
本层不重复实现)。

LTX 等 ComfyUI 系生成器为 fire-and-forget:generate() 只提交返回 job_id,
产物 URL 需轮询 worker history(raw.worker + job_id → get_result_files → 代理 URL)。
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import image_url
from app.services.studio.renderers.base import RenderError, RenderResult
from app.services.video_generators import get_generator

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 3.0  # 视频轮询间隔(秒);测试可 monkeypatch
_POLL_TIMEOUT = 900.0  # 视频最长等待(秒),与 drama_studio autorun 对齐


async def _wait_video_url(worker: str, prompt_id: str) -> str:
    """轮询 worker history 取首个产物文件,返回 /api/images 代理 URL。"""
    client = ComfyUIClient(worker)
    waited = 0.0
    while waited < _POLL_TIMEOUT:
        try:
            files = await client.get_result_files(prompt_id)
        except ComfyUIError:
            files = []  # worker 暂不可达/历史未就绪,下轮再试
        if files:
            return image_url(client.base_url, files[0])
        await asyncio.sleep(_POLL_INTERVAL)
        waited += _POLL_INTERVAL
    raise RenderError(f"视频生成超时({_POLL_TIMEOUT:.0f}s)")


class VideoRenderer:
    """render_mode=video:ComfyUI 视频工作流出片。"""

    name = "video"

    async def render(
        self,
        shot: "StudioShot",
        cast: list["StudioCharacter"],
        pool: "WorkerPool",
        **kw: Any,
    ) -> RenderResult:
        cast_tokens = ", ".join(c.visual_prompt for c in cast if c.visual_prompt)
        prompt = f"{cast_tokens}, {shot.prompt}" if cast_tokens else shot.prompt
        gen = get_generator(kw.get("video_model") or "ltx", pool)
        try:
            # 项目级产出规格(缺省回落 LTX 常用 768×384@16)
            result = await gen.generate(
                prompt,
                negative=shot.negative,
                width=int(kw.get("width") or 768),
                height=int(kw.get("height") or 384),
                duration_sec=shot.duration_sec,
                fps=int(kw.get("fps") or 16),
            )
        except Exception as e:
            raise RenderError(f"视频生成失败:{e}") from e
        if not result.success:
            raise RenderError(f"视频生成失败:{result.error or '未知错误'}")
        if result.video_url:
            return RenderResult(kind="video", url=result.video_url)
        # fire-and-forget(ltx):提交成功但 URL 需轮询 worker history
        worker = (result.raw or {}).get("worker", "")
        if not result.job_id or not worker:
            raise RenderError("视频生成失败:无产出 URL")
        return RenderResult(kind="video", url=await _wait_video_url(worker, result.job_id))
