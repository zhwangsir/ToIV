"""W2.2(2026-10-11):多视角分镜扩展——单角色参考图 → 多景别候选示意图。

对标可灵「多视角分镜扩展」:导演在分镜阶段先看构图候选(远景/中景/近景),
选中后再进视频生成。实现复用设定卡线的 img2img 机器(:8262/:8264 + build_img2img_graph)。

产物为示意图(still),落 studio 文件域 frame_var_*;Job 异步(模式同设定卡 S3-b)。
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx
from sqlmodel import Session, select

from app.models import StudioCharacter, StudioShot
from app.services.studio.character_sheet import (
    CharacterSheetError,
    _pick_sheet_client,
    _wait_images,
)

logger = logging.getLogger(__name__)

# 景别 → (英文镜头语言注入, denoise):远景保持场景、近景提高重构幅度
SCALES: tuple[tuple[str, str, float], ...] = (
    ("wide", "wide establishing shot, full scene visible, character small in frame, environmental context", 0.55),
    ("medium", "medium shot, waist-up framing, balanced subject and environment", 0.60),
    ("closeup", "close-up shot, head and shoulders, shallow depth of field, facial detail", 0.62),
)

_FRAME_MARK = "frame_var_"


class FrameVariantError(Exception):
    def __init__(self, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _save_frame_png(data: bytes, *, shot_id: str, scale: str) -> str:
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{_FRAME_MARK}{shot_id[:8]}_{scale}_{uuid.uuid4().hex[:12]}.png"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def _primary_ref_url(session: Session, shot: StudioShot) -> tuple[str, str]:
    """(参考图 URL, 角色视觉 token)——取镜头首个有参考图的角色。"""
    import json as _json

    try:
        names = _json.loads(shot.characters or "[]")
    except (ValueError, TypeError):
        names = []
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == shot.project_id)
    ).all()
    for c in chars:
        if (c.name or "").strip() in names:
            try:
                refs = _json.loads(c.reference_images or "[]")
            except (ValueError, TypeError):
                refs = []
            if isinstance(refs, list) and refs and isinstance(refs[0], str) and refs[0]:
                return refs[0], (c.visual_prompt or "").strip()
    raise FrameVariantError("镜头角色无定妆参考图(先在资产段生成设定卡并采用)")


async def _fetch_bytes(url: str) -> bytes:
    if url.startswith("/api/"):
        from app.config import get_settings

        base = (get_settings().api_base_url or "http://127.0.0.1:8090").rstrip("/")
        url = base + url
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as hc:
        r = await hc.get(url)
        r.raise_for_status()
        return r.content


async def generate_frame_variants(
    session: Session, shot: StudioShot, *, style: str = "anime"
) -> list[dict[str, str]]:
    """同步核心(后台 Job 内跑):3 景别示意图 → [{scale,url}]。"""
    import json as _json

    from app.workflows.img2img import Img2ImgParams, build_img2img_graph

    from app.services.studio.character_sheet import _SHEET_CKPT, _build_img2img_graph  # noqa: F401 复用负向模板

    ref_url, visual = _primary_ref_url(session, shot)
    data = await _fetch_bytes(ref_url)
    cli = await _pick_sheet_client(None)
    fname = f"frame_var_src_{uuid.uuid4().hex[:10]}.png"
    image_name = await cli.upload_image(data, fname)
    ckpt = _SHEET_CKPT.get(style, _SHEET_CKPT["anime"])
    scene = (shot.scene or shot.prompt or "").strip() or "scene"
    base_prompt = f"{scene}"
    if visual:
        base_prompt = f"{visual}, {scene}"
    out: list[dict[str, str]] = []
    for scale, camera, denoise in SCALES:
        prompt = f"{base_prompt}, {camera}"
        graph = _build_img2img_graph(
            prompt,
            image_name=image_name,
            ckpt_name=ckpt,
            seed=uuid.uuid4().int % (2**31 - 1),
            filename_prefix=f"ToIV_drama_c/frame_var/{shot.id[:8]}_{scale}",
            style=style,
            denoise=denoise,
        )
        prompt_id = await cli.queue_prompt(graph, uuid.uuid4().hex)
        images = await _wait_images(cli, prompt_id)
        if not images:
            raise FrameVariantError(f"{scale} 景别出图失败(无产物)", status_code=502)
        img = images[0]
        # get_images 条目:filename/subfolder/type → 取回字节落 studio 文件域
        content, _worker = await cli.get_image_bytes(
            img.get("filename", ""),
            img.get("subfolder", ""),
            img.get("type", "output"),
        )
        url = _save_frame_png(content, shot_id=shot.id, scale=scale)
        out.append({"scale": scale, "url": url})
    return out
