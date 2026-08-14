"""POST /api/upload —— 把用户图片上传到 ComfyUI(供 img2img 使用)。"""
from __future__ import annotations

import asyncio
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from app.capabilities import required_models, required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import User
from app.ratelimit import enforce_rate_limit

router = APIRouter()

_MAX_BYTES = 20 * 1024 * 1024  # 20MB(图/音频)
_MAX_VIDEO_BYTES = 200 * 1024 * 1024  # 200MB(驱动视频,Animate/VACE 链路)

# ---- 上传内容安全校验:扩展名 + Content-Type + 魔数三重白名单 ----
# 仅放行参考图/驱动音频实际需要的格式;魔数与扩展名不符即 415,杜绝
# exe 伪装 .png / php 伪装 .jpg / 无扩展名投递 webshell(QA-FULL-2026-08-11 P0)。
_EXT_TO_KIND = {
    ".png": "png",
    ".jpg": "jpg",
    ".jpeg": "jpg",
    ".webp": "webp",
    ".gif": "gif",
    ".wav": "wav",
    ".mp3": "mp3",
    ".m4a": "m4a",
    ".ogg": "ogg",
    ".flac": "flac",
    ".mp4": "mp4",
    ".mov": "mov",
    ".webm": "webm",
}
_IMAGE_KINDS = {"png", "jpg", "webp", "gif"}
_VIDEO_KINDS = {"mp4", "mov", "webm"}  # Animate 驱动视频 / VACE 参考视频等


def _sniff_media(content: bytes) -> str | None:
    """按魔数识别真实文件类型,识别不出返回 None。"""
    if len(content) < 4:
        return None
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if content.startswith(b"GIF8"):
        return "gif"
    if content.startswith(b"fLaC"):
        return "flac"
    if content.startswith(b"OggS"):
        return "ogg"
    if content[:4] == b"RIFF" and len(content) >= 12:
        if content[8:12] == b"WEBP":
            return "webp"
        if content[8:12] == b"WAVE":
            return "wav"
        return None
    if content.startswith(b"ID3") or (content[0] == 0xFF and (content[1] & 0xE0) == 0xE0):
        return "mp3"
    if content.startswith(b"\x1a\x45\xdf\xa3"):  # EBML 头(webm/mkv 容器)
        return "webm"
    if len(content) >= 12 and content[4:8] == b"ftyp":  # ISO-BMFF:按 major brand 区分
        brand = content[8:12]
        if brand == b"qt  ":
            return "mov"
        if brand in (b"M4A ", b"M4B "):
            return "m4a"
        return "mp4"  # isom/iso2/mp41/mp42/avc1 等一律 mp4
    return None


def _validate_upload(filename: str | None, content_type: str | None, content: bytes) -> str:
    """三重白名单校验,通过返回安全扩展名,否则 415。"""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in _EXT_TO_KIND:
        raise HTTPException(status_code=415, detail=f"不支持的文件类型:{ext or '无扩展名'}")
    sniffed = _sniff_media(content)
    if sniffed != _EXT_TO_KIND[ext]:
        raise HTTPException(status_code=415, detail="文件内容与扩展名不符")
    if content_type and content_type != "application/octet-stream":
        want = (
            "image/" if sniffed in _IMAGE_KINDS
            else "video/" if sniffed in _VIDEO_KINDS
            else "audio/"
        )
        if not content_type.startswith(want):
            raise HTTPException(status_code=415, detail="Content-Type 与文件内容不符")
    return ext


@router.post("/upload")
async def upload_image(
    image: UploadFile,
    kind: str = "img2img",  # 上传后用于哪种任务 → 选具备对应模型的 worker
    all_workers: bool = False,  # true=分发到所有 worker(角色参考图,供跨机并行出图)
    worker: str | None = None,  # 指定目标 worker(防 SSRF,仅允许白名单),确保音频/参考图与后续生成同机
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
    # 上传限流(60s/10 次,scope="upload" 已在 ratelimit 定义);在读文件/落 worker 前拦截
    enforce_rate_limit(user, scope="upload")
    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    # 三重白名单(扩展名+Content-Type+魔数),在任何 worker 落盘前拦截伪造文件
    safe_ext = _validate_upload(image.filename, image.content_type, content)
    # 大小上限按真实类型分流(视频类放宽到 200MB,图/音频 20MB)
    limit = _MAX_VIDEO_BYTES if _EXT_TO_KIND[safe_ext] in _VIDEO_KINDS else _MAX_BYTES
    if len(content) > limit:
        raise HTTPException(
            status_code=413, detail=f"文件过大(上限 {limit // 1024 // 1024}MB)")

    # 分发模式:角色参考图上传到全部可达 worker(唯一名避免各机命名分歧),这样带参考图的
    # 分镜出图可 pool.pick 跨机并行,而非全钉在参考图所在的单机上串行。
    if all_workers:
        name = f"toivref-{uuid.uuid4().hex}{safe_ext}"
        results = await asyncio.gather(
            *(c.upload_image(content, name) for c in pool.clients),
            return_exceptions=True,
        )
        ok = [
            c.base_url
            for c, r in zip(pool.clients, results)
            if isinstance(r, str) and r == name
        ]
        if not ok:
            raise HTTPException(status_code=503, detail="参考图分发失败(无可达 worker)")
        return {"filename": name, "worker": ok[0], "workers": ok, "all_workers": True}

    # 指定 worker 模式:前端已把参考图/音频钉到后续生成所在的 worker,避免多机路径不一致。
    if worker:
        client = resolve_worker(worker)
        req_models = required_models(kind)
        req_nodes = required_nodes(kind)
        if req_models and not req_models.issubset(await client.model_names()):
            raise HTTPException(status_code=503, detail="指定 worker 缺少该任务所需模型")
        if req_nodes and not req_nodes.issubset(await client.node_names()):
            raise HTTPException(status_code=503, detail="指定 worker 缺少该任务所需节点")
    else:
        try:
            client = await pool.pick(required=required_models(kind), required_nodes=required_nodes(kind))
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        name = await client.upload_image(content, image.filename or "upload.png")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"filename": name, "worker": client.base_url}
