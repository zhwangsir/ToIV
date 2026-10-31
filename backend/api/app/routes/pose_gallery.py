"""姿势图库只读静态文件接口(W5)。

对齐 covers / forge FileResponse 风格:
- GET /api/pose-gallery/thumbs/{file} → core `/data/pose-gallery/thumbs/{file}`
- GET /api/pose-gallery/img/{file} → NAS `/mnt/toiv-nas/toiv/pose-gallery/img/{file}`
- GET /api/pose-gallery/health → 目录存在探测(运维)

约束:
- basename-only + pathsafe;拒绝穿越/绝对路径
- 公开 GET(无登录);成人闸仅前端 redline,本模块不加
- 不 mkdir、不写盘、不把二进制进 git;缺文件干净 404
- 根路径模块级常量,测试可 monkeypatch
"""
from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.pathsafe import PathTraversalError, validate_path_component

router = APIRouter()

# 生产绝对根(运维侧路 rsync 上量;本地缺目录时读路径 404,不自动创建)
THUMBS_ROOT = Path("/data/pose-gallery/thumbs")
IMG_ROOT = Path("/mnt/toiv-nas/toiv/pose-gallery/img")

# 测试可 monkeypatch 这两项
_thumbs_root: Path = THUMBS_ROOT
_img_root: Path = IMG_ROOT

_THUMB_CACHE = {"Cache-Control": "public, max-age=604800"}  # 7d
_IMG_CACHE = {"Cache-Control": "public, max-age=86400"}  # 1d


def _resolve_under(root: Path, name: str) -> Path:
    """basename-only 安全拼接;越界/非法 → 400;缺根或缺文件 → 404。不 mkdir。"""
    try:
        cleaned = validate_path_component(name, allow_subdirs=False)
    except PathTraversalError as exc:
        raise HTTPException(status_code=400, detail="非法文件名") from exc
    if not cleaned or cleaned in (".", "..") or "/" in cleaned or "\\" in cleaned:
        raise HTTPException(status_code=400, detail="非法文件名")
    # 再收一道:必须是纯 basename(与 Path.name 一致)
    if Path(cleaned).name != cleaned:
        raise HTTPException(status_code=400, detail="非法文件名")

    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=404, detail="文件不存在")

    base = root.resolve()
    target = (base / cleaned).resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="非法文件名") from exc
    if not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return target


def _media_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


@router.get("/pose-gallery/health")
async def pose_gallery_health() -> dict:
    """运维探活:根目录是否存在(不上量前可双 false)。"""
    thumbs = _thumbs_root
    imgs = _img_root
    return {
        "ok": thumbs.is_dir() or imgs.is_dir(),
        "thumbs_root": str(thumbs),
        "thumbs_ok": thumbs.is_dir(),
        "img_root": str(imgs),
        "img_ok": imgs.is_dir(),
    }


@router.get("/pose-gallery/thumbs/{file}")
async def pose_gallery_thumb(file: str) -> FileResponse:
    path = _resolve_under(_thumbs_root, file)
    return FileResponse(
        path,
        media_type=_media_type(path),
        filename=path.name,
        headers=_THUMB_CACHE,
    )


@router.get("/pose-gallery/img/{file}")
async def pose_gallery_img(file: str) -> FileResponse:
    path = _resolve_under(_img_root, file)
    return FileResponse(
        path,
        media_type=_media_type(path),
        filename=path.name,
        headers=_IMG_CACHE,
    )
