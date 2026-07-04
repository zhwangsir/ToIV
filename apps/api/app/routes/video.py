"""POST /api/generate/video —— Wan 2.2 图生视频(i2v)。

图片先经 /api/upload 上传到某 worker,再带 filename + worker 调用本端点。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.versioning import params_snapshot
from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph

router = APIRouter()


class WanI2VRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    image: str = Field(min_length=1, max_length=512)
    worker: str
    negative: str | None = Field(default=None, max_length=2000)
    # Wan 2.2 训练甜点档:480p→832×480,81 帧(4n+1);旧 640×480/49 偏离训练分布掉质
    width: int = Field(default=832, ge=128, le=1280)
    height: int = Field(default=480, ge=128, le=1280)
    length: int = Field(default=81, ge=9, le=121)
    fps: int = Field(default=16, ge=4, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    # 数值字段:越界/小数一律钳到合法区间,不硬报 422(生成场景静默钳位比报错友好)。
    # 前端各面板/画布节点可能灌进大图尺寸、复用的巨大 seed 等 → 这里兜底,免整条 i2v 崩。
    @field_validator("width", "height", mode="before")
    @classmethod
    def _clamp_dim(cls, v: object) -> object:
        try:
            return max(128, min(1280, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return v

    @field_validator("length", mode="before")
    @classmethod
    def _clamp_len(cls, v: object) -> object:
        try:
            n = max(9, min(121, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return v
        return ((n - 1) // 4) * 4 + 1  # Wan 需 4n+1

    @field_validator("fps", mode="before")
    @classmethod
    def _clamp_fps(cls, v: object) -> object:
        try:
            return max(4, min(30, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return v

    @field_validator("seed", mode="before")
    @classmethod
    def _clamp_seed(cls, v: object) -> object:
        if v is None:
            return None
        try:
            return max(0, min(2**63 - 1, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None


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
            params=params_snapshot(req, seed=params.seed),
        )
    )
    session.commit()

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
