"""POST /api/generate/video —— Wan 2.2 图生视频(i2v)。

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
from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph

router = APIRouter()


class WanI2VRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    image: str = Field(min_length=1, max_length=512)
    worker: str
    negative: str | None = Field(default=None, max_length=2000)
    width: int = Field(default=640, ge=128, le=1280)
    height: int = Field(default=480, ge=128, le=1280)
    length: int = Field(default=49, ge=9, le=121)
    fps: int = Field(default=16, ge=4, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/video")
async def generate_video(
    req: WanI2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    client = resolve_worker(req.worker)
    params = WanI2VParams(
        positive=req.positive,
        image=req.image,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        **({"negative": req.negative} if req.negative else {}),
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_i2v_graph(params)
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
            kind="wan_i2v",
            status="queued",
            prompt=params.positive,
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
