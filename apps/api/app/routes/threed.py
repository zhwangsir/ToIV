"""POST /api/generate/3d —— Hunyuan3D 图生3D(输出 GLB)。

图片先经 /api/upload 上传到某 worker,再带 filename + worker 调用本端点。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.hunyuan3d import Hunyuan3DParams, build_hunyuan3d_graph

router = APIRouter()


class Gen3DRequest(BaseModel):
    image: str = Field(min_length=1, max_length=512)
    worker: str
    steps: int = Field(default=30, ge=10, le=100)
    cfg: float = Field(default=5.0, ge=0.0, le=20.0)
    octree_resolution: int = Field(default=256, ge=64, le=512)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/3d")
async def generate_3d(
    req: Gen3DRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    client = resolve_worker(req.worker)
    params = Hunyuan3DParams(
        image=req.image,
        steps=req.steps,
        cfg=req.cfg,
        octree_resolution=req.octree_resolution,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_hunyuan3d_graph(params)
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind="hunyuan3d",
            status="queued",
            prompt="图生3D",
            seed=params.seed,
        )
    )
    session.commit()

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
