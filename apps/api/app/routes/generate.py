"""POST /api/generate/txt2img —— 校验参数 → 选 worker → 提交工作流。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.img2img import Img2ImgParams, build_img2img_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
from app.workflows.wan_t2v import WanT2VParams, build_wan_t2v_graph


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
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    batch_size: int = Field(default=1, ge=1, le=8)


router = APIRouter()


def _snap8(v: int) -> int:
    """SD 潜空间要求宽高是 8 的倍数。"""
    return max(8, v - v % 8)


@router.post("/generate/txt2img")
async def generate_txt2img(
    req: Txt2ImgRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
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
        batch_size=req.batch_size,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_txt2img_graph(params)
    try:
        client = await pool.pick(required={params.ckpt_name})
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    # 按租户记录作业(隔离 / 历史;P2 只隔离不计费)
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        worker=client.base_url,
        kind="txt2img",
        status="queued",
        prompt=params.positive,
        seed=params.seed,
    )
    session.add(job)
    session.commit()

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }


def _snap16(v: int) -> int:
    """Wan 视频潜空间要求宽高是 16 的倍数。"""
    return max(16, v - v % 16)


def _snap_length(v: int) -> int:
    """Wan 帧数需满足 4n+1(否则节点报错)。"""
    return max(5, v - (v - 1) % 4)


# Wan T2V 用到的模型文件名集合,用于把任务只路由到具备 Wan 视频模型的 worker
def _wan_t2v_required() -> set[str]:
    p = WanT2VParams(positive="")
    return {p.high_unet, p.low_unet, p.high_lora, p.low_lora, p.clip_name, p.vae_name}


class Txt2VideoRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=480, ge=128, le=1280)
    height: int = Field(default=480, ge=128, le=1280)
    length: int = Field(default=49, ge=9, le=121)  # 帧数,4n+1
    fps: int = Field(default=16, ge=4, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/txt2video")
async def generate_txt2video(
    req: Txt2VideoRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """文生视频(Wan 2.2 T2V):纯文本 → 短视频,无需输入图。

    用原生 Wan 节点链(WanImageToVideo 省略 start_image 即纯文本条件),
    经 pool 选到具备 Wan 视频模型的最闲 worker 提交。响应与 /video 一致。
    """
    enforce_generation_rate_limit(user)
    params = WanT2VParams(
        positive=req.positive,
        negative=req.negative or WanT2VParams.negative,
        width=_snap16(req.width),
        height=_snap16(req.height),
        length=_snap_length(req.length),
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_t2v_graph(params)
    try:
        client = await pool.pick(required=_wan_t2v_required())
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
            kind="wan_t2v",
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


class Img2ImgRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的文件名
    worker: str  # 图片上传到的 worker
    negative: str = Field(default="", max_length=2000)
    ckpt_name: str | None = None
    denoise: float = Field(default=0.6, ge=0.1, le=1.0)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler: str = Field(default="euler", max_length=64)
    scheduler: str = Field(default="normal", max_length=64)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/img2img")
async def generate_img2img(
    req: Img2ImgRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    settings = get_settings()
    client = resolve_worker(req.worker)  # 必须用图片所在的 worker
    params = Img2ImgParams(
        positive=req.positive,
        image=req.image,
        negative=req.negative,
        ckpt_name=req.ckpt_name or settings.default_ckpt,
        denoise=req.denoise,
        steps=req.steps,
        cfg=req.cfg,
        sampler=req.sampler,
        scheduler=req.scheduler,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_img2img_graph(params)
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
            kind="img2img",
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
