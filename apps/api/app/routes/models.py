"""GET /api/models —— 从 ComfyUI object_info 派生前端下拉项（不硬编码）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.deps import get_current_user, get_pool
from app.models import User

router = APIRouter()


def _enum(info: dict, node: str, field: str) -> list[str]:
    req = info.get(node, {}).get("input", {}).get("required", {})
    opts = req.get(field, [[]])
    return opts[0] if opts and isinstance(opts[0], list) else []


@router.get("/models")
async def list_models(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
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


# (分类标签, 节点, 字段)
_LOCAL_SPECS = [
    ("checkpoints", "CheckpointLoaderSimple", "ckpt_name"),
    ("loras", "LoraLoader", "lora_name"),
    ("vae", "VAELoader", "vae_name"),
    ("controlnet", "ControlNetLoader", "control_net_name"),
    ("upscale", "UpscaleModelLoader", "model_name"),
]


@router.get("/models/local")
async def local_models(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
) -> dict[str, list[str]]:
    """按类型列出 worker 上已安装的本地模型。"""
    client = pool.clients[0]
    out: dict[str, list[str]] = {}
    for key, node, field in _LOCAL_SPECS:
        try:
            out[key] = _enum(await client.object_info(node), node, field)
        except ComfyUIError:
            out[key] = []
    return out
