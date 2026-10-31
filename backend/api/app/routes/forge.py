"""Forge 引擎相关 HTTP:产物图服务 + 可用 SD 底模列表 + 探活。

模型列表要过滤:共享的 ComfyUI checkpoints 目录里混了音频(ace_step)/3D(hunyuan3d)/
视频(wan/ltx)/放大(SUPIR)等**非 SD** 权重,Forge 加载它们会崩(MelScale 等)。
只放行真正可做 txt2img 的 SD/SDXL 底模。
"""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.config import get_settings
from app.deps import get_current_user
from app.forge.client import ForgeClient, ForgeError
from app.forge.engine import FORGE_DIR
from app.models import User

router = APIRouter()

_NAME_RE = re.compile(r"^forge-[0-9a-f]{32}-\d+\.png$")
# 非 SD 权重(子串命中即排除):音频 / 3D / 视频 / 放大 / 配乐
_NON_SD = (
    "ace_step", "ace-step", "hunyuan3d", "mmaudio", "supir", "wan2", "wan_",
    "ltx", "cosmos", "mochi", "hunyuanvideo", "stable_audio", "musicgen",
)


def _is_sd_checkpoint(name: str) -> bool:
    low = name.lower()
    return not any(p in low for p in _NON_SD)


def _forge_client() -> ForgeClient:
    base = get_settings().forge_base
    if not base:
        raise HTTPException(status_code=503, detail="Forge 引擎未部署")
    return ForgeClient(base, timeout=20.0)


@router.get("/forge/status")
async def forge_status(user: User = Depends(get_current_user)) -> dict:
    """前端据此决定是否显示「Forge」引擎选项。"""
    base = get_settings().forge_base
    if not base:
        return {"enabled": False, "online": False}
    try:
        online = await ForgeClient(base, timeout=6.0).ping()
    except ForgeError:
        online = False
    return {"enabled": True, "online": online}


@router.get("/forge/models")
async def forge_models(user: User = Depends(get_current_user)) -> dict:
    """Forge 可用 SD 底模(已剔除音频/3D/视频/放大权重)。"""
    client = _forge_client()
    try:
        raw = await client.sd_models()
    except ForgeError as e:
        raise HTTPException(status_code=502, detail=f"取 Forge 模型失败:{e}") from e
    models = [
        {"title": m.get("title", ""), "model_name": m.get("model_name", "")}
        for m in raw
        if m.get("title") and _is_sd_checkpoint(m.get("title", ""))
    ]
    return {"models": models}


@router.get("/forge/image/{name}")
async def forge_image(name: str, user: User = Depends(get_current_user)) -> FileResponse:
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = FORGE_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(
        path, media_type="image/png", filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )
