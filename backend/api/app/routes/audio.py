"""POST /api/generate/audio —— ACE-Step 文生音乐(输出 MP3)。

默认 ACE-Step 1.5(quality=turbo 8 步草稿 / quality=quality 50 步成品,支持 10s-600s);
quality=legacy 走 ACE-Step 1.0 旧工作流(≤240s,可回退)。
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.versioning import params_snapshot
from app.workflows.ace_step import (
    AceStep15Params,
    AceStepParams,
    ace_step_15_required_models,
    build_ace_step_15_graph,
    build_ace_step_graph,
)

router = APIRouter()

# ACE-Step 1.5 TextEncode 节点支持的语言(ComfyUI COMBO 全集之外给常见子集 + unknown)
_LANGUAGES = ("en", "zh", "yue", "ja", "ko", "es", "de", "fr", "pt", "it", "ru", "unknown")


class AudioRequest(BaseModel):
    tags: str = Field(min_length=1, max_length=1000)
    lyrics: str = Field(default="", max_length=4000)
    seconds: float = Field(default=30.0, ge=5.0, le=600.0)
    quality: Literal["turbo", "quality", "legacy"] = "turbo"
    steps: int | None = Field(default=None, ge=0, le=150)  # 0/None=按档位默认
    cfg: float | None = Field(default=None, ge=0.0, le=20.0)  # 0/None=按档位默认
    bpm: int = Field(default=120, ge=10, le=300)
    language: str = Field(default="en", max_length=10)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/audio")
async def generate_audio(
    req: AudioRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    if req.quality == "legacy":
        if req.seconds > 240.0:
            raise HTTPException(status_code=422, detail="ACE-Step 1.0(legacy) 时长上限 240s;长音乐请用 1.5 档位")
        params = AceStepParams(
            tags=req.tags,
            lyrics=req.lyrics,
            seconds=req.seconds,
            steps=req.steps or 50,
            cfg=req.cfg or 5.0,
            **({"seed": req.seed} if req.seed is not None else {}),
        )
        graph = build_ace_step_graph(params)
        required = {params.ckpt_name}
        seed = params.seed
    else:
        if req.language not in _LANGUAGES:
            raise HTTPException(status_code=422, detail=f"不支持的歌词语言: {req.language}")
        params15 = AceStep15Params(
            tags=req.tags,
            lyrics=req.lyrics,
            seconds=req.seconds,
            quality=req.quality,
            steps=req.steps or None,
            cfg=req.cfg or None,
            bpm=req.bpm,
            language=req.language,
            **({"seed": req.seed} if req.seed is not None else {}),
        )
        graph = build_ace_step_15_graph(params15)
        required = ace_step_15_required_models(params15)
        seed = params15.seed
    try:
        client = await pool.pick(required=required)
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
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
            prompt=req.tags,
            seed=seed,
            params=params_snapshot(req, seed=seed),
        )
    )
    session.commit()

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
    }
