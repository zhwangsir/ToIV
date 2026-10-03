"""Studio 视频步默认管线 C：上传参考 → 构图 → 提交 h3-eval → 落盘。"""
from __future__ import annotations

import logging
import secrets
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.services.studio.prompt_c import (
    build_c_visual_prompt,
    build_cast_visual_for_style,
    extract_palette_swatches_from_sheet,
    merge_negative,
)
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
    """拉取参考图字节：studio/files 只直读磁盘，禁止回环调本 API（单 worker 会死锁）。"""
    import os
    from app.storage import drama_output_root

    u = (url or "").strip()
    if not u:
        raise RenderError("空参考图 URL")
    marker = "/api/studio/files/"
    if marker in u:
        name = Path(u.split(marker, 1)[1].split("?", 1)[0]).name
        if not name or name.startswith(".") or "/" in name or "\\" in name:
            raise RenderError("非法 studio 文件路径")
        roots = [
            drama_output_root() / "studio",
            Path(os.environ.get("TOIV_DRAMA_VIDEO_DIR", "")) / "studio",
            Path("/mnt/toiv-nas/toiv/outputs/drama/final/studio"),
            Path("/home/merlin/toiv/tmp/h3_long_exp/assets"),
        ]
        for root in roots:
            try:
                path = root / name
            except Exception:
                continue
            if path.is_file():
                data = path.read_bytes()
                if data:
                    return data
        # 兼容样片原名（无 sample_ 前缀）
        alt = name.replace("sample_", "", 1) if name.startswith("sample_") else ""
        if alt:
            for root in roots:
                path = root / alt
                if path.is_file():
                    data = path.read_bytes()
                    if data:
                        return data
        raise RenderError(f"studio 参考图不在磁盘:{name}（禁止回环拉取）")
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
    if u.startswith("http://") or u.startswith("https://"):
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as http:
            r = await http.get(u)
            r.raise_for_status()
            return r.content
    raise RenderError(f"无法拉取参考图:{u[:80]}")


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



def _studio_file_roots() -> list[Path]:
    import os
    from app.storage import drama_output_root
    return [
        drama_output_root() / "studio",
        Path(os.environ.get("TOIV_DRAMA_VIDEO_DIR", "")) / "studio",
        Path("/mnt/toiv-nas/toiv/outputs/drama/final/studio"),
    ]


def _read_studio_file(name: str) -> bytes | None:
    if not name or name.startswith(".") or "/" in name or "\\" in name:
        return None
    for root in _studio_file_roots():
        try:
            path = root / name
        except Exception:
            continue
        if path.is_file():
            data = path.read_bytes()
            if data:
                return data
    return None


def _latest_sheet_name(cid8: str, style_key: str) -> str | None:
    """磁盘上同角色同风格最新 char_sheet_*.png。"""
    import os
    prefix = f"char_sheet_{cid8}_{style_key}_"
    cands: list[tuple[float, str]] = []
    for root in _studio_file_roots():
        try:
            if not root.is_dir():
                continue
            for pth in root.glob(prefix + "*.png"):
                try:
                    cands.append((pth.stat().st_mtime, pth.name))
                except OSError:
                    continue
        except Exception:
            continue
    if not cands:
        return None
    cands.sort(key=lambda x: x[0], reverse=True)
    return cands[0][1]


def _cid8_from_urls(urls: list[str]) -> str | None:
    for u in urls:
        name = Path(u.split("?")[0]).name
        if name.startswith("char_panel_"):
            parts = name[len("char_panel_"):].split("_")
            if parts and len(parts[0]) >= 8:
                return parts[0][:8]
        if name.startswith("char_sheet_"):
            parts = name[len("char_sheet_"):].split("_")
            if parts and len(parts[0]) >= 8:
                return parts[0][:8]
    return None


def _resolve_sheet_palette_colors(cast: list[Any], style: str | None) -> dict[str, list[str]]:
    """从角色分桶/扁平 URL 或同 cid 最新设定卡抽配色色块（面积序）。"""
    import json
    out: dict[str, list[str]] = {}
    st = (style or "").strip()
    if st in ("古风", "ancient", "ancient_realistic"):
        style_key = "ancient_realistic"
        style_keys = ["ancient_realistic", "ancient", "古风"]
    elif st in ("二次元", "anime"):
        style_key = "anime"
        style_keys = ["anime", "二次元"]
    else:
        return out
    for c in cast or []:
        nm = (getattr(c, "name", None) or "").strip()
        if not nm:
            continue
        urls: list[str] = []
        by = getattr(c, "reference_images_by_style", None) or "{}"
        if isinstance(by, str):
            try:
                by = json.loads(by) if by.strip() else {}
            except Exception:
                by = {}
        if isinstance(by, dict):
            for k in style_keys:
                for u in by.get(k) or []:
                    if isinstance(u, str) and u.strip():
                        urls.append(u.strip())
        flat = getattr(c, "reference_images", None) or "[]"
        if isinstance(flat, str):
            try:
                flat = json.loads(flat) if flat.strip() else []
            except Exception:
                flat = []
        if isinstance(flat, list):
            for u in flat:
                if isinstance(u, str) and u.strip():
                    urls.append(u.strip())
        sheet_names: list[str] = []
        for u in urls:
            name = Path(u.split("/api/studio/files/")[-1].split("?")[0]).name
            if name.startswith("char_sheet_") and style_key in name:
                sheet_names.append(name)
        cid8 = _cid8_from_urls(urls)
        if not sheet_names and cid8:
            latest = _latest_sheet_name(cid8, style_key)
            if latest:
                sheet_names.append(latest)
        for name in sheet_names[:2]:
            data = _read_studio_file(name)
            if not data:
                continue
            sw = extract_palette_swatches_from_sheet(data)
            if sw:
                out[nm] = sw
                logger.info(
                    "costume palette from sheet %s style=%s file=%s colors=%s",
                    nm, st, name, sw[:4],
                )
                break
    return out



async def _brand_ocr_after_render(url: str) -> dict:
    """出片 URL → 本地/临时 mp4 → garment_brand_ocr_hit（含店招）。失败不拦。"""
    from app.services.studio.candidate_pick import garment_brand_ocr_hit
    from app.storage import drama_output_root
    import os

    u = (url or "").strip()
    if not u:
        return {"hit": False, "text": "", "frames_checked": 0, "error": "empty_url"}

    # /api/studio/files/… 直读磁盘
    marker = "/api/studio/files/"
    if marker in u:
        name = Path(u.split(marker, 1)[1].split("?", 1)[0]).name
        roots = [
            drama_output_root() / "studio",
            Path(os.environ.get("TOIV_DRAMA_VIDEO_DIR", "")) / "studio",
            Path("/mnt/toiv-nas/toiv/outputs/drama/final/studio"),
        ]
        for root in roots:
            path = root / name
            if path.is_file():
                return garment_brand_ocr_hit(path)
        # 磁盘尚无：尝试拉字节
        try:
            data = await _fetch_bytes(u)
        except Exception as e:
            return {"hit": False, "text": "", "frames_checked": 0, "error": f"fetch:{e}"}
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
            tf.write(data)
            tmp = tf.name
        try:
            return garment_brand_ocr_hit(tmp)
        finally:
            try:
                Path(tmp).unlink(missing_ok=True)
            except Exception:
                pass

    if u.startswith("/") and Path(u).is_file():
        return garment_brand_ocr_hit(u)

    # Comfy http(s) 或其它：拉字节写临时文件再 OCR
    try:
        data = await _fetch_bytes(u)
    except Exception as e:
        logger.warning("brand_ocr fetch failed url=%s err=%s", u[:80], e)
        return {"hit": False, "text": "", "frames_checked": 0, "error": f"fetch:{e}"}
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
        tf.write(data)
        tmp = tf.name
    try:
        return garment_brand_ocr_hit(tmp)
    finally:
        try:
            Path(tmp).unlink(missing_ok=True)
        except Exception:
            pass


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
    style: str | None = None,
) -> dict[str, Any]:
    """执行管线 C，返回 {url, context_latent, seed, prompt, worker, job_id}。"""
    from fastapi import HTTPException

    from app.services import h3 as h3_service

    # 参考 URL（style 有值时优先分桶 by_style）
    if ref_images is not None:
        urls = [u for u in ref_images if isinstance(u, str) and u.strip()]
        prefix, _ = h3_ref_prefix(
            cast, engine="h3", ref_images=urls, scene_images=None, style=style
        )
    else:
        refs = collect_cast_ref_images(cast, scene_images=scene_images, style=style)
        urls = ref_urls(refs)
        prefix, _ = h3_ref_prefix(
            cast, engine="h3", scene_images=scene_images, style=style
        )
    if not urls:
        raise RenderError("管线 C 需要角色三视图或场景参考图")

    palette_map = _resolve_sheet_palette_colors(cast, style)
    cast_visual = build_cast_visual_for_style(
        cast, style=style, colors_by_name=palette_map or None
    )
    # T8 无独立负向口：merge_negative 必须并进 Avoid，否则店招/乱码条款被丢弃
    positive = build_c_visual_prompt(
        shot_prompt=getattr(shot, "prompt", "") or "",
        cast_visual=cast_visual,
        ref_prefix=prefix,
        dialogue=getattr(shot, "dialogue", "") or "",
        camera=getattr(shot, "camera", "") or "",
        scene=getattr(shot, "scene", "") or "",
        negative=getattr(shot, "negative", "") or "",
    )

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
    brand_ocr_reseeds = 0
    brand_ocr_hits: list[str] = []
    url = ""
    prompt_id = ""
    prefix_ctx = ""
    max_submits = 3  # 首次 + 最多额外 2 次换 seed

    for attempt in range(max_submits):
        if attempt > 0:
            seed_used = secrets.randbelow(2**31 - 1) or 1
            brand_ocr_reseeds += 1
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

        ocr = await _brand_ocr_after_render(url)
        color_hit = False
        color_info: dict = {}
        # 服装主色：期望板岩灰等时出片过黑 → 换 seed
        try:
            from app.services.studio.candidate_pick import garment_main_color_miss_video
            expect_colors: list[str] = []
            for _name, cols in (palette_map or {}).items():
                if isinstance(cols, list):
                    expect_colors.extend([c for c in cols if isinstance(c, str)])
            # 取前角角色色板即可
            if expect_colors:
                # 复用 OCR 的本地解析
                from pathlib import Path as _P
                local = None
                u = (url or "").strip()
                if u.startswith("/api/studio/files/"):
                    local = _P("/mnt/toiv-nas/toiv/outputs/drama/final/studio") / u.rsplit("/", 1)[-1]
                if local and local.is_file():
                    color_info = garment_main_color_miss_video(local, expect_colors)
                    color_hit = bool(color_info.get("hit"))
        except Exception as e:
            logger.warning("garment_color_check failed: %s", e)

        if not ocr.get("hit") and not color_hit:
            break
        if ocr.get("hit"):
            hit_text = str(ocr.get("text") or "")[:120]
            kind = str(ocr.get("kind") or "").strip().lower()
            if not kind:
                kind = "sign" if hit_text.startswith("sign:") else "brand"
            brand_ocr_hits.append(hit_text if kind == "brand" else (
                hit_text if hit_text.startswith("sign:") else f"sign:{hit_text}"
            ))
            logger.warning(
                "%s_ocr_reseed shot=%s clip=%s attempt=%s seed=%s text=%r frames=%s",
                kind,
                getattr(shot, "id", "")[:8],
                clip_index,
                attempt,
                seed_used,
                hit_text,
                ocr.get("frames_checked"),
            )
        if color_hit:
            brand_ocr_hits.append(
                f"color_black:luma={color_info.get('mean_luma')} expected={expect_colors[:4]}"
            )
            logger.warning(
                "color_ocr_reseed shot=%s clip=%s attempt=%s seed=%s luma=%s expected=%s",
                getattr(shot, "id", "")[:8],
                clip_index,
                attempt,
                seed_used,
                color_info.get("mean_luma"),
                expect_colors[:4],
            )
        if attempt >= max_submits - 1:
            break

    # 约定 context 产物名（与 SaveLatent filename_prefix 对齐）
    # SaveLatent 序号与 clip_index 对齐（镜0→00001、镜1→00002…）；写死 00001 会导致续写 FileNotFound
    context_latent = f"{prefix_ctx}_{int(clip_index):05d}.safetensors"
    return {
        "url": url,
        "context_latent": context_latent,
        "seed": seed_used,
        "prompt": positive,
        "worker": client.base_url,
        "job_id": prompt_id,
        "pipeline": "c",
        "ref_images": urls,
        "brand_ocr_reseeds": brand_ocr_reseeds,
        "brand_ocr_hits": brand_ocr_hits,
    }
