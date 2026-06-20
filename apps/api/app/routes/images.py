"""GET /api/images —— 代理 ComfyUI /view，前端永不直连 ComfyUI。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.deps import get_current_user, resolve_worker
from app.models import User

router = APIRouter()


def _worker_dep(worker: str) -> ComfyUIClient:
    return resolve_worker(worker)


@router.get("/images")
async def get_image(
    filename: str,
    subfolder: str = "",
    type_: str = Query(default="output", alias="type"),
    client: ComfyUIClient = Depends(_worker_dep),
    user: User = Depends(get_current_user),
):
    try:
        content, content_type = await client.get_image_bytes(filename, subfolder, type_)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
