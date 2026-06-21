"""POST /api/generate/audio —— ACE-Step 文生音乐(输出 MP3)。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.ace_step import AceStepParams, build_ace_step_graph

router = APIRouter()


class AudioRequest(BaseModel):
    tags: str = Field(min_length=1, max_length=1000)
    lyrics: str = Field(default="", max_length=4000)
    seconds: float = Field(default=30.0, ge=5.0, le=240.0)
    steps: int = Field(default=50, ge=10, le=150)
    cfg: float = Field(default=5.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/audio")
async def generate_audio(
    req: AudioRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    params = AceStepParams(
        tags=req.tags,
        lyrics=req.lyrics,
        seconds=req.seconds,
        steps=req.steps,
        cfg=req.cfg,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_ace_step_graph(params)
    client = await pool.pick()
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
            kind="ace_audio",
            status="queued",
            prompt=params.tags,
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
