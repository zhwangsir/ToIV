"""POST /api/generate/video —— Wan 2.2 图生视频(i2v)。
POST /api/generate/ltx-t2v —— LTX2.3 文生视频(NSFW 专区)
POST /api/generate/ltx-i2v —— LTX2.3 图生视频(NSFW 专区)
POST /api/generate/ltx-lipsync —— LTX2.3 口型同步(NSFW 专区)

图片先经 /api/upload 上传到某 worker,再带 filename + worker 调用本端点。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.versioning import params_snapshot
from app.workflows.ltx_video import (
    LtxI2VParams,
    LtxLipsyncParams,
    LtxT2VParams,
    build_ltx_i2v_graph,
    build_ltx_lipsync_graph,
    build_ltx_t2v_graph,
)
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
        _raise_from_comfy_error(e)

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

    # 启动服务端后台追踪:前端 SSE 断开后仍可把结果落库,避免"一直生成中"
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }


# ──────────────────────────────────────────────────────────────────
# LTX2.3 视频生成(NSFW 专区)
# ──────────────────────────────────────────────────────────────────

def _gate_ltx_nsfw(user: User) -> None:
    """LTX 视频端点 NSFW 门槛:仅 /nsfw 专页(X-NSFW: 1 header)放行。
    10Eros 默认底模属 R18,主站调用一律 403。"""
    if not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="LTX 视频生成仅限 NSFW 专区访问")


def _raise_from_comfy_error(e: ComfyUIError) -> None:
    """把 ComfyUI 上游错误透传为对应 HTTP 状态码,方便前端定位是参数/模型问题(4xx)还是
    worker 网络/执行问题(5xx)。"""
    status = e.status_code if e.status_code is not None else 502
    # 后端不应把 5xx 内部错误直接抛给前端;但 4xx 和网关类错误(502/503/504)可以透传
    if status < 400 or status == 500:
        status = 502
    detail = e.detail if e.detail is not None else str(e)
    raise HTTPException(status_code=status, detail=detail) from e


class LtxT2VRequest(BaseModel):
    """LTX2.3 文生视频请求。"""
    positive: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=768, ge=256, le=1920)
    height: int = Field(default=384, ge=256, le=1080)
    length: int = Field(default=97, ge=9, le=241)
    fps: int = Field(default=16, ge=4, le=30)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    use_upscale: bool = False
    use_rife: bool = False

    @field_validator("width", "height", mode="before")
    @classmethod
    def _clamp_dim(cls, v: object) -> object:
        try:
            return max(256, min(1920, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return v


class LtxI2VRequest(LtxT2VRequest):
    """LTX2.3 图生视频请求。"""
    image: str = Field(min_length=1, max_length=512)
    worker: str  # 图片所在 worker(防 SSRF)


class LtxLipsyncRequest(LtxT2VRequest):
    """LTX2.3 口型同步请求。"""
    image: str = Field(min_length=1, max_length=512)
    audio: str = Field(min_length=1, max_length=512)
    worker: str
    id_lora: str = Field(default="", max_length=512)
    id_lora_strength: float = Field(default=0.8, ge=0.0, le=2.0)


@router.post("/generate/ltx-t2v")
async def generate_ltx_t2v(
    req: LtxT2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LTX2.3 文生视频(NSFW 专区)。默认 10Eros 底模 + 720p 2 阶段采样。"""
    enforce_generation_rate_limit(user)
    _gate_ltx_nsfw(user)

    settings = get_settings()
    params = LtxT2VParams(
        positive=req.positive,
        negative=req.negative,
        unet_name=settings.nsfw_default_video_ckpt,
        gemma_name=settings.nsfw_default_gemma,
        vae_name=settings.nsfw_default_vae,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxT2VParams(positive="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
    )
    graph = build_ltx_t2v_graph(params)
    return await _submit_ltx_job(graph, params, "ltx_t2v", user, session)


@router.post("/generate/ltx-i2v")
async def generate_ltx_i2v(
    req: LtxI2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LTX2.3 图生视频(NSFW 专区)。"""
    enforce_generation_rate_limit(user)
    _gate_ltx_nsfw(user)

    settings = get_settings()
    client = resolve_worker(req.worker)
    params = LtxI2VParams(
        positive=req.positive,
        image=req.image,
        negative=req.negative,
        unet_name=settings.nsfw_default_video_ckpt,
        gemma_name=settings.nsfw_default_gemma,
        vae_name=settings.nsfw_default_vae,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxI2VParams(positive="", image="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
    )
    graph = build_ltx_i2v_graph(params)
    return await _submit_ltx_job(graph, params, "ltx_i2v", user, session, client=client)


@router.post("/generate/ltx-lipsync")
async def generate_ltx_lipsync(
    req: LtxLipsyncRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LTX2.3 口型同步(NSFW 专区)。图生视频 + 音频驱动 + ID LoRA。"""
    enforce_generation_rate_limit(user)
    _gate_ltx_nsfw(user)

    settings = get_settings()
    client = resolve_worker(req.worker)
    params = LtxLipsyncParams(
        positive=req.positive,
        image=req.image,
        audio=req.audio,
        negative=req.negative,
        unet_name=settings.nsfw_default_video_ckpt,
        gemma_name=settings.nsfw_default_gemma,
        vae_name=settings.nsfw_default_vae,
        id_lora=req.id_lora,
        id_lora_strength=req.id_lora_strength,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxLipsyncParams(positive="", image="", audio="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
    )
    graph = build_ltx_lipsync_graph(params)
    return await _submit_ltx_job(graph, params, "ltx_lipsync", user, session, client=client)


async def _submit_ltx_job(
    graph: dict,
    params,
    kind: str,
    user: User,
    session: Session,
    client=None,
):
    """提交 LTX 作业到 ComfyUI 并落库。client=None 时由 pool.pick 选 worker。"""
    from app.deps import get_pool
    from app.comfy.pool import WorkerPool
    from app.capabilities import required_nodes, required_models

    if client is None:
        pool: WorkerPool = get_pool()
        node_set = required_nodes(kind)
        model_set = required_models(kind)
        picked = await pool.pick(required=model_set, required_nodes=node_set)
        if picked is None:
            raise HTTPException(status_code=503, detail="无可用 worker(缺 LTX 模型或节点)")
        client = picked

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        _raise_from_comfy_error(e)

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind=kind,
            status="queued",
            prompt=params.positive,
            seed=params.seed,
            nsfw=True,
        )
    )
    session.commit()

    # 启动服务端后台追踪:前端 SSE 断开后仍可把结果落库,避免"一直生成中"
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
