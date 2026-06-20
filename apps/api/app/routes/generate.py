"""POST /api/generate/txt2img —— 校验参数 → 选 worker → 提交工作流。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.deps import get_pool
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph


class Txt2ImgRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=2000)
    ckpt_name: str | None = None
    width: int = Field(default=512, ge=64, le=2048)
    height: int = Field(default=512, ge=64, le=2048)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler: str = Field(default="euler", max_length=64)
    scheduler: str = Field(default="normal", max_length=64)
    seed: int | None = Field(default=None, ge=0)


router = APIRouter()


def _snap8(v: int) -> int:
    """SD 潜空间要求宽高是 8 的倍数。"""
    return max(8, v - v % 8)


@router.post("/generate/txt2img")
async def generate_txt2img(req: Txt2ImgRequest, pool: WorkerPool = Depends(get_pool)):
    settings = get_settings()
    params = Txt2ImgParams(
        positive=req.positive,
        negative=req.negative,
        ckpt_name=req.ckpt_name or settings.default_ckpt,
        width=_snap8(req.width),
        height=_snap8(req.height),
        steps=req.steps,
        cfg=req.cfg,
        sampler=req.sampler,
        scheduler=req.scheduler,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_txt2img_graph(params)
    client = await pool.pick()
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
