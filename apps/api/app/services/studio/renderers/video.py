"""视频链:封装 services/video_generators(默认 h3;LTX-2.5 退役后切换,见 2026-08-21)。

角色一致性:视觉 token 注入 prompt(PuLID 首帧在 video_generators 次世代场景接入,
本层不重复实现)。

H3/LTX 等 ComfyUI 系生成器为 fire-and-forget:generate() 只提交返回 job_id,
产物 URL 需轮询 worker history(raw.worker + job_id → get_result_files → 代理 URL)。
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.services.studio.renderers.base import RenderError, RenderResult
from app.services.studio.renderers.image_motion import _save_output
from app.services.video_generators import get_generator
from app.request_cancel import mark_prompt_canceled

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 3.0  # 视频轮询间隔(秒);测试可 monkeypatch
_POLL_TIMEOUT = 1800.0  # 视频最长等待(秒);H3 单段(含排队)实测可达 15min+,900s 会误杀


async def _wait_video_url(worker: str, prompt_id: str, request: Any = None) -> str:
    """轮询 worker history,产物下载落盘 Studio 目录,返回 /api/studio/files URL。

    落盘而非 /api/images 代理 URL(2026-08-22 修复):assemble 仅认 Studio 产出
    前缀(防穿越校验),代理 URL 会让 render_mode=video 分镜永远无法通过合成;
    落盘后合成也不依赖 worker 在线。
    """
    client = ComfyUIClient(worker)
    waited = 0.0
    while waited < _POLL_TIMEOUT:
        if request is not None and await request.is_disconnected():
            try:
                await client.cancel_prompt(prompt_id)
            except Exception:  # noqa: BLE001
                logger.warning("studio video 中止: cancel_prompt 失败 prompt=%s", prompt_id)
            mark_prompt_canceled(prompt_id)
            raise RenderError("已中止")
        try:
            files = await client.get_result_files(prompt_id)
        except ComfyUIError:
            files = []  # worker 暂不可达/历史未就绪,下轮再试
        if files:
            f = files[0]
            data, _ = await client.get_image_bytes(
                f["filename"], f.get("subfolder", ""), f.get("type", "output"))
            if not data:
                raise RenderError("视频产物下载为空")
            return await asyncio.to_thread(_save_output, data, ".mp4")
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
        # 默认 h3:LTX-2.5 专用实例 :8198 已退役(2026-08-21 用户决策,由 H3 全面替代),
        # 沿用旧默认 "ltx" 会让 studio 视频分镜全数连接拒绝
        gen = get_generator(kw.get("video_model") or "h3", pool)
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
        return RenderResult(
            kind="video",
            url=await _wait_video_url(worker, result.job_id, request=kw.get("request")),
        )
