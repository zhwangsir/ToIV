"""Studio 视频步默认管线 C：上传参考 → 构图 → 提交 h3-eval → 落盘。"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.services.studio.prompt_c import build_c_visual_prompt, merge_negative
from app.services.studio.renderers.base import RenderError
from app.services.studio.renderers.image_motion import _save_output
from app.services.studio.renderers.video import _wait_video_url
from app.services.studio.shot_refs import collect_cast_ref_images, h3_ref_prefix, ref_urls
from app.workflows.h3_pipeline_c import H3PipelineCParams, build_h3_pipeline_c_graph
from app.workflows.h3_video import H3_R2V_UNET  # noqa: F401 — 文档锚点

logger = logging.getLogger(__name__)

# 管线 C 所需节点（h3-eval :8195）
_C_NODE = "MiniMaxH3AudioConditioningT8"
_C_MOTION = "MiniMaxH3MotionContext"


def _snap32(v: int) -> int:
    v = max(256, min(1344, int(v)))
    return max(256, (v // 32) * 32)


def _h3_length(duration_sec: float) -> int:
    """吸附到 H3 17k+5 网格，上限 362（~15s）。"""
    from app.services.duration import DurationLimitError, resolve_duration

    try:
        plan = resolve_duration("h3", float(duration_sec or 6), 24)
        return min(362, int(plan.frames))
    except DurationLimitError:
        # 超长：单段按上限；分段续写由编排层负责
        return 362


async def _fetch_bytes(url: str) -> bytes:
    """拉取参考图字节：studio/files 直读；/api/images 或 http(s) 走 HTTP。"""
    from app.storage import drama_output_root

    u = (url or "").strip()
    if not u:
        raise RenderError("空参考图 URL")
    marker = "/api/studio/files/"
    if marker in u:
        name = u.split(marker, 1)[1].split("?", 1)[0]
        path = drama_output_root() / "studio" / Path(name).name
        if path.is_file():
            return path.read_bytes()
    if u.startswith("/") and Path(u).is_file():
        return Path(u).read_bytes()
    # /api/images?filename=&worker=
    if "/api/images" in u:
        q = parse_qs(urlparse(u).query)
        fn = (q.get("filename") or [""])[0]
        worker = (q.get("worker") or [""])[0]
        sub = (q.get("subfolder") or [""])[0]
        typ = (q.get("type") or ["input"])[0]
        if fn and worker:
            client = ComfyUIClient(worker)
            data, _ = await client.get_image_bytes(fn, sub, typ)
            if data:
                return data
    async with httpx.AsyncClient(timeout=60.0, trust_env=False) as http:
        # 相对路径：拼本地 API（仅测试/同进程）
        if u.startswith("/"):
            from app.config import get_settings

            base = get_settings().api_base_url.rstrip("/")
            u = base + u
        r = await http.get(u)
        r.raise_for_status()
        return r.content


async def _upload_refs(client: ComfyUIClient, urls: list[str]) -> list[str]:
    names: list[str] = []
    for i, url in enumerate(urls):
        data = await _fetch_bytes(url)
        ext = ".png"
        low = url.lower()
        if ".jpg" in low or ".jpeg" in low:
            ext = ".jpg"
        elif ".webp" in low:
            ext = ".webp"
        fname = f"toiv_c_ref_{uuid.uuid4().hex[:12]}_{i}{ext}"
        names.append(await client.upload_image(data, fname))
    return names


async def render_pipeline_c(
    shot: Any,
    cast: list[Any],
    *,
    width: int = 768,
    height: int = 1344,
    seed: int | None = None,
    ref_images: list[str] | None = None,
    scene_images: list[str] | None = None,
    context_latent_path: str = "",
    clip_index: int = 1,
    request: Any = None,
) -> dict[str, Any]:
    """执行管线 C，返回 {url, context_latent, seed, prompt, worker, job_id}。"""
    from fastapi import HTTPException

    from app.services import h3 as h3_service

    # 参考 URL
    if ref_images is not None:
        urls = [u for u in ref_images if isinstance(u, str) and u.strip()]
        prefix, _ = h3_ref_prefix(cast, engine="h3", ref_images=urls, scene_images=None)
    else:
        refs = collect_cast_ref_images(cast, scene_images=scene_images)
        urls = ref_urls(refs)
        prefix, _ = h3_ref_prefix(cast, engine="h3", scene_images=scene_images)
    if not urls:
        raise RenderError("管线 C 需要角色三视图或场景参考图")

    cast_visual = ", ".join(c.visual_prompt for c in cast if getattr(c, "visual_prompt", None))
    positive = build_c_visual_prompt(
        shot_prompt=getattr(shot, "prompt", "") or "",
        cast_visual=cast_visual,
        ref_prefix=prefix,
        dialogue=getattr(shot, "dialogue", "") or "",
        camera=getattr(shot, "camera", "") or "",
        scene=getattr(shot, "scene", "") or "",
    )
    # negative 折进 Avoid（T8 节点无独立负向口时由 prompt 携带；仍保留合并供快照）
    _ = merge_negative(getattr(shot, "negative", "") or "")

    try:
        h3_service.ensure_h3_enabled()
        client = await h3_service.pick_h3_client()
        await h3_service.ensure_h3_ready(client, node=_C_NODE)
        # Motion Context 仅续写需要；首段可不强制
        if (context_latent_path or "").strip():
            await h3_service.ensure_h3_ready(client, node=_C_MOTION)
        await h3_service.ensure_h3_vram(client)
    except HTTPException as e:
        raise RenderError(str(e.detail)) from e

    try:
        image_names = await _upload_refs(client, urls)
    except Exception as e:
        raise RenderError(f"参考图上传失败:{e}") from e

    w = _snap32(width or 768)
    h = _snap32(height or 1344)
    # 竖屏短剧：若宽>高则对调（样片 768×1360）
    if w > h:
        w, h = h, w
    length = _h3_length(getattr(shot, "duration_sec", 6) or 6)
    seed_used = int(seed) if seed is not None else H3PipelineCParams(positive="x").seed
    prefix_vid = f"ToIV_drama_c/{shot.id[:8]}_{clip_index}_{seed_used % 100000}"
    prefix_ctx = f"toiv_drama_c/context/{shot.id[:8]}_{clip_index}_{seed_used % 100000}"

    params = H3PipelineCParams(
        positive=positive,
        images=tuple(image_names),
        width=w,
        height=h,
        length=length,
        seed=seed_used,
        filename_prefix=prefix_vid,
        context_prefix=prefix_ctx,
        clip_index=clip_index,
        context_latent_path=(context_latent_path or "").strip(),
    )
    try:
        graph = build_h3_pipeline_c_graph(params)
    except ValueError as e:
        raise RenderError(str(e)) from e

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise RenderError(f"管线 C 提交失败:{e}") from e

    url = await _wait_video_url(client.base_url, prompt_id, request=request)
    # 约定 context 产物名（与 SaveLatent filename_prefix 对齐）
    context_latent = f"{prefix_ctx}_00001.safetensors"
    return {
        "url": url,
        "context_latent": context_latent,
        "seed": seed_used,
        "prompt": positive,
        "worker": client.base_url,
        "job_id": prompt_id,
        "pipeline": "c",
        "ref_images": urls,
    }
