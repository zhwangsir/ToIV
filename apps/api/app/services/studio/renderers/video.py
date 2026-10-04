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
        # 失败任务无产物时尽快抛错，避免空等到 _POLL_TIMEOUT（Motion Context 缺文件等）
        if not files:
            try:
                hist_wrap = await client.get_history(prompt_id)
            except Exception:
                hist_wrap = None
            entry = None
            if isinstance(hist_wrap, dict):
                entry = hist_wrap.get(prompt_id) or (hist_wrap if "status" in hist_wrap else None)
            if isinstance(entry, dict):
                status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
                outputs = entry.get("outputs") or {}
                if status.get("status_str") == "error" or (
                    status.get("completed") is True and not outputs
                ):
                    detail = ""
                    for m in status.get("messages") or []:
                        if isinstance(m, (list, tuple)) and len(m) >= 2 and m[0] == "execution_error":
                            err = m[1] if not isinstance(m[1], dict) else m[1].get("exception_message") or m[1]
                            detail = str(err)[:300]
                            break
                    raise RenderError(
                        f"Comfy 任务失败无视频产物:{detail or status.get('status_str') or 'error'}"
                    )
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
        video_model = (kw.get("video_model") or getattr(shot, "video_model", "") or "h3").strip() or "h3"
        # Batch2:H3 多参考 @图片N(角色三视图 + 场景图);非 h3 不注入
        from app.services.studio.shot_refs import h3_ref_prefix

        ref_prefix, used_refs = h3_ref_prefix(
            cast,
            engine=video_model,
            ref_images=kw.get("ref_images"),
            scene_images=kw.get("scene_images"),
        )
        if ref_prefix:
            prompt = ref_prefix + prompt
            kw["_used_ref_images"] = used_refs  # 供编排层回写 shot.ref_images_json
        # Batch6: H3 默认管线 C（Ref2VA+Motion Context+原生音频）；显式 pipeline=legacy 回退旧 t2v
        pipeline = (kw.get("pipeline") or "c").strip().lower()
        if video_model == "h3" and pipeline in ("c", "c_hybrid"):
            from app.services.studio.pipeline_c_render import render_pipeline_c
            from app.services.studio.renderers.base import RenderResult as _RR

            try:
                out = await render_pipeline_c(
                    shot,
                    cast,
                    width=int(kw.get("width") or 768),
                    height=int(kw.get("height") or 1344),
                    seed=kw.get("seed"),
                    ref_images=kw.get("ref_images"),
                    scene_images=kw.get("scene_images"),
                    context_latent_path=str(kw.get("context_latent_path") or ""),
                    clip_index=int(kw.get("clip_index") or 1),
                    request=kw.get("request"),
                    style=kw.get("ref_style"),
                    first_frame_url=(
                        str(kw.get("first_frame_url") or "") if pipeline == "c_hybrid" else ""
                    ),
                    worker_url=kw.get("worker_url"),
                    pipeline_name=pipeline,
                    ref_overrides=kw.get("ref_overrides"),
                    outfit_desc=str(kw.get("outfit_desc") or ""),
                )
            except RenderError:
                raise
            except Exception as e:
                raise RenderError(f"管线 C 失败:{e}") from e
            return _RR(kind="video", url=out["url"], pipeline_meta=out)
        gen = get_generator(video_model, pool)
        try:
            # 项目级产出规格(缺省回落 LTX 常用 768×384@16);seed 供多候选分叉
            gen_kw = dict(
                negative=shot.negative,
                width=int(kw.get("width") or 768),
                height=int(kw.get("height") or 384),
                duration_sec=shot.duration_sec,
                fps=int(kw.get("fps") or 16),
            )
            if kw.get("seed") is not None:
                gen_kw["seed"] = int(kw["seed"])
            result = await gen.generate(prompt, **gen_kw)
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
