"""POST /api/upload —— 把用户图片上传到 ComfyUI(供 img2img 使用)。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from app.capabilities import required_models
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.deps import get_current_user, get_pool
from app.models import User

router = APIRouter()

_MAX_BYTES = 20 * 1024 * 1024  # 20MB


@router.post("/upload")
async def upload_image(
    image: UploadFile,
    kind: str = "img2img",  # 上传后用于哪种任务 → 选具备对应模型的 worker
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if len(content) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片过大(上限 20MB)")
    try:
        client = await pool.pick(required=required_models(kind))
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        name = await client.upload_image(content, image.filename or "upload.png")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"filename": name, "worker": client.base_url}
