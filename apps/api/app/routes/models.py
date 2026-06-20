"""GET /api/models —— 从 ComfyUI object_info 派生前端下拉项（不硬编码）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.deps import get_pool

router = APIRouter()


def _enum(info: dict, node: str, field: str) -> list[str]:
    req = info.get(node, {}).get("input", {}).get("required", {})
    opts = req.get(field, [[]])
    return opts[0] if opts and isinstance(opts[0], list) else []


@router.get("/models")
async def list_models(pool: WorkerPool = Depends(get_pool)):
    client = pool.clients[0]
    try:
        ckpt_info = await client.object_info("CheckpointLoaderSimple")
        ks_info = await client.object_info("KSampler")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "checkpoints": _enum(ckpt_info, "CheckpointLoaderSimple", "ckpt_name"),
        "samplers": _enum(ks_info, "KSampler", "sampler_name"),
        "schedulers": _enum(ks_info, "KSampler", "scheduler"),
    }
