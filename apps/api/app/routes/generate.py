"""POST /api/generate/txt2img —— 校验参数 → 选 worker → 提交工作流。"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.controlnet import (
    CONTROL_TYPES,
    ControlNetParams,
    build_controlnet_graph,
    controlnet_model_name,
)
from app.workflows.facedetailer import (
    BBOX_MODELS,
    SAM_MODELS,
    FaceDetailerParams,
    build_facedetailer_graph,
)
from app.workflows.img2img import Img2ImgParams, build_img2img_graph
from app.workflows.lora import LoraSpec
from app.workflows.model_profiles import is_nsfw
from app.workflows.upscale import UPSCALE_MODELS, UpscaleParams, build_upscale_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
from app.workflows.wan_t2v import WanT2VParams, build_wan_t2v_graph


class LoraInput(BaseModel):
    """叠加的单个 LoRA:文件名 + 权重(同时作用于 model 与 clip)。"""

    name: str = Field(min_length=1, max_length=256)
    weight: float = Field(default=1.0, ge=-2.0, le=2.0)


# 单次最多叠加的 LoRA 数(防滥用 + 控制图规模)
_MAX_LORAS = 8


def _to_lora_specs(loras: list[LoraInput]) -> tuple[LoraSpec, ...]:
    return tuple(LoraSpec(name=l.name, weight=l.weight) for l in loras[:_MAX_LORAS])


def _gate_nsfw_ckpt(ckpt_name: str, user: User) -> bool:
    """R18 硬门槛:成人底模须用户已开 R18 才放行,否则 403(防绕过 UI 直调 API)。

    返回该作品是否成人向(供建档打标 Job.nsfw)。
    """
    nsfw = is_nsfw(ckpt_name)
    if nsfw and not user.nsfw_enabled:
        raise HTTPException(status_code=403, detail="该底模属 R18 分区,请先在账号设置开启成人内容")
    return nsfw


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
    loras: list[LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)


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
        loras=_to_lora_specs(req.loras),
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = _gate_nsfw_ckpt(params.ckpt_name, user)
    graph = build_txt2img_graph(params)
    # 路由到既有 checkpoint 又有所选 LoRA 文件的 worker(异构多机下避免缺模型)
    required = {params.ckpt_name, *(l.name for l in params.loras)}
    try:
        client = await pool.pick(required=required)
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
        nsfw=job_nsfw,
    )
    session.add(job)
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE(修前端断开丢结果的真 bug)
    spawn_tracker(client, prompt_id)

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

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE(修前端断开丢结果的真 bug)
    spawn_tracker(client, prompt_id)

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
    loras: list[LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)


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
        loras=_to_lora_specs(req.loras),
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = _gate_nsfw_ckpt(params.ckpt_name, user)
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
            nsfw=job_nsfw,
        )
    )
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE(修前端断开丢结果的真 bug)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }


class ControlNetRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的控制图文件名
    worker: str  # 控制图上传到的 worker(同 img2img,须用图片所在 worker)
    control_type: str = Field(default="canny", max_length=32)
    negative: str = Field(default="", max_length=2000)
    ckpt_name: str | None = None
    strength: float = Field(default=0.8, ge=0.0, le=2.0)
    start_percent: float = Field(default=0.0, ge=0.0, le=1.0)
    end_percent: float = Field(default=1.0, ge=0.0, le=1.0)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler: str = Field(default="euler", max_length=64)
    scheduler: str = Field(default="normal", max_length=64)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    loras: list[LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)


@router.post("/generate/controlnet")
async def generate_controlnet(
    req: ControlNetRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """ControlNet 出图:上传的控制图 → 预处理 → 控网约束 → 出图。

    沿用 img2img 模式:必须用控制图所在的 worker(resolve_worker 防 SSRF)。
    """
    enforce_generation_rate_limit(user)
    settings = get_settings()
    if req.control_type not in CONTROL_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的 control_type:{req.control_type!r};可选 {list(CONTROL_TYPES)}",
        )
    if req.start_percent > req.end_percent:
        raise HTTPException(
            status_code=422, detail="start_percent 不能大于 end_percent"
        )
    client = resolve_worker(req.worker)  # 必须用控制图所在的 worker
    params = ControlNetParams(
        positive=req.positive,
        image=req.image,
        control_type=req.control_type,
        negative=req.negative,
        ckpt_name=req.ckpt_name or settings.default_ckpt,
        strength=req.strength,
        start_percent=req.start_percent,
        end_percent=req.end_percent,
        steps=req.steps,
        cfg=req.cfg,
        sampler=req.sampler,
        scheduler=req.scheduler,
        loras=_to_lora_specs(req.loras),
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = _gate_nsfw_ckpt(params.ckpt_name, user)
    graph = build_controlnet_graph(params)
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
            kind="controlnet",
            status="queued",
            prompt=params.positive,
            seed=params.seed,
            nsfw=job_nsfw,
        )
    )
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE(修前端断开丢结果的真 bug)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
        "control_type": params.control_type,
        "controlnet_model": controlnet_model_name(params.control_type, params.ckpt_name),
    }


class UpscaleRequest(BaseModel):
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的源图文件名
    worker: str  # 源图上传到的 worker(同 img2img,须用图片所在 worker)
    model_name: str = Field(default=UPSCALE_MODELS[0], max_length=128)
    scale: float = Field(default=4.0, ge=1.5, le=4.0)


@router.post("/generate/upscale")
async def generate_upscale(
    req: UpscaleRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """放大:用 ESRGAN 类放大模型把上传的源图放大到目标倍数。

    无 checkpoint(纯放大模型)→ 不涉 R18 门槛;沿用 img2img 模式:
    必须用源图所在的 worker(resolve_worker 防 SSRF)。
    """
    enforce_generation_rate_limit(user)
    if req.model_name not in UPSCALE_MODELS:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的放大模型:{req.model_name!r};可选 {list(UPSCALE_MODELS)}",
        )
    client = resolve_worker(req.worker)  # 必须用源图所在的 worker
    params = UpscaleParams(
        image=req.image, model_name=req.model_name, scale=req.scale
    )
    graph = build_upscale_graph(params)
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
            kind="upscale",
            status="queued",
            prompt=f"upscale x{req.scale:g}",
            seed=None,
            nsfw=False,
        )
    )
    session.commit()

    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "scale": req.scale,
        "model_name": req.model_name,
    }


class FaceDetailerRequest(BaseModel):
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的源图文件名
    worker: str  # 源图所在 worker(同 img2img)
    positive: str = Field(default="detailed face, sharp focus, high quality", max_length=2000)
    negative: str = Field(default="blurry, lowres, deformed, bad anatomy", max_length=2000)
    ckpt_name: str | None = None
    denoise: float = Field(default=0.5, ge=0.1, le=1.0)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=8.0, ge=0.0, le=30.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/facedetailer")
async def generate_facedetailer(
    req: FaceDetailerRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """脸部修复:检测源图人脸 → 局部高清重绘。沿用 img2img 的 worker 锁定模式。

    worker 须已装 bbox 检测模型(bbox/face_yolov8m.pt)+ sam_vit_b;本会话已装。
    """
    enforce_generation_rate_limit(user)
    settings = get_settings()
    client = resolve_worker(req.worker)  # 必须用源图所在的 worker
    params = FaceDetailerParams(
        image=req.image,
        positive=req.positive,
        negative=req.negative,
        ckpt_name=req.ckpt_name or settings.default_ckpt,
        denoise=req.denoise,
        steps=req.steps,
        cfg=req.cfg,
        bbox_model=BBOX_MODELS[0],
        sam_model=SAM_MODELS[0],
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = _gate_nsfw_ckpt(params.ckpt_name, user)
    graph = build_facedetailer_graph(params)
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
            kind="facedetailer",
            status="queued",
            prompt=params.positive,
            seed=params.seed,
            nsfw=job_nsfw,
        )
    )
    session.commit()

    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
