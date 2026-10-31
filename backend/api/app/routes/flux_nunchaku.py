"""POST /api/generate/flux-nunchaku —— Nunchaku SVDQuant fp4 FLUX.1-dev 高速文生图。

2026-08-28 Phase 4D:SFW 高速出图新引擎(与 flux2 默认引擎并存,不替代)。
RTX 50 系上 fp4 量化 5090 实测 ~2.1s/张(vs FP8 3.1s)。

worker 路由:pool.pick(required=权重文件名集, required_nodes=插件节点集)双约束
自然钉到 Nunchaku 就绪 worker——svdq 权重在 diffusion_models/(UNETLoader 枚举覆盖)、
t5xxl/clip_l 在 text_encoders/(CLIPLoader 覆盖)、ae 在 vae/(VAELoader 覆盖),
详见 workflows/flux_nunchaku.py 头注的 2026-08-28 真机实证。

注册:本路由由 main.py 统一收口挂载(主控负责),本文件只交付 router。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.versioning import params_snapshot
from app.workflows.flux_nunchaku import (
    NUNCHAKU_REQUIRED_NODES,
    FluxNunchakuParams,
    build_flux_nunchaku_graph,
    required_models,
)
from app.workflows.model_profiles import AR_IMAGE, aspect_guard

router = APIRouter()


def _snap8(v: int) -> int:
    """SD 潜空间要求宽高是 8 的倍数。"""
    return max(8, v - v % 8)


class FluxNunchakuRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    width: int = Field(default=1024, ge=64, le=2048)
    height: int = Field(default=1024, ge=64, le=2048)
    steps: int = Field(default=20, ge=1, le=50)
    # FluxGuidance 蒸馏引导强度(FLUX.1-dev 语义);KSampler cfg 恒 1.0,两者别混淆
    guidance: float = Field(default=3.5, ge=1.0, le=10.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    batch_size: int = Field(default=1, ge=1, le=4)
    # first-block 缓存阈值:0=关闭(默认,质量优先);0.12 为插件典型提速档(微质损)
    cache_threshold: float = Field(default=0.0, ge=0.0, le=1.0)

    # 宽高比守卫:1:2~2:1 静默归一(与 txt2img 同一护栏,SD 系训练分布)
    _ratio = aspect_guard(*AR_IMAGE, align=8, min_v=64, max_v=2048)


@router.post("/generate/flux-nunchaku")
async def generate_flux_nunchaku(
    req: FluxNunchakuRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """提交 fp4 FLUX.1-dev 文生图:构图 → 双约束选 worker → 建档 → 后台追踪。"""
    enforce_generation_rate_limit(user)
    params = FluxNunchakuParams(
        positive=req.positive,
        width=_snap8(req.width),
        height=_snap8(req.height),
        steps=req.steps,
        guidance=req.guidance,
        batch_size=req.batch_size,
        cache_threshold=req.cache_threshold,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_flux_nunchaku_graph(params)
    try:
        client = await pool.pick(
            required=required_models(), required_nodes=NUNCHAKU_REQUIRED_NODES
        )
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    # 固定 SFW 权重引擎:不涉 R18 门槛,不打 nsfw 标
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind="flux_nunchaku",
            status="queued",
            prompt=req.positive,
            seed=params.seed,
            nsfw=False,
            params=params_snapshot(req, seed=params.seed),
        )
    )
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
