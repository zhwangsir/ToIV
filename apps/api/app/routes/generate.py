"""POST /api/generate/txt2img —— 校验参数 → 选 worker → 提交工作流。"""
from __future__ import annotations

import logging
import secrets
import uuid
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.capabilities import required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.imagedims import input_image_dims
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker, wait_for_jobs
from app.config import get_settings
from app.db import engine, get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
# ComfyUI 错误码统一语义(2026-08-30 P2-7):worker 4xx 透传、5xx/无状态 → 502,
# 消除与 routes/video.py 同场景 4xx/502 不一致;pool.pick 无可用 worker 仍 503。
from app.routes.video import _raise_from_comfy_error
from app.scoring import BestOfResult, ScorerUnavailable, ScoringService, get_scoring_service
from app.versioning import params_snapshot
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
from app.workflows.inpaint import InpaintParams, build_inpaint_graph
from app.workflows.lora import LoraSpec, parse_lora_tags
from app.workflows.model_profiles import (
    AR_IMAGE,
    aspect_guard,
    detect_model_family,
    fit_resolution,
    is_nsfw,
    is_nextgen,
    nextgen_recipe,
    profile_for,
)
from app.workflows.nextgen import NextgenImg2ImgParams, NextgenParams, build_nextgen_graph, build_nextgen_img2img_graph, resolve_qwen_accel
from app.workflows.removebg import REMBG_MODES, RemoveBgParams, build_removebg_graph
from app.workflows.qwen_edit import (
    CAMERA_PRESETS,
    QwenEditError,
    QwenEditParams,
    build_qwen_edit_graph,
)
from app.services.qwen_edit import get_qwen_edit_client
from app.workflows.style_presets import MediaType, resolve_style_preset
from app.workflows.upscale import UPSCALE_MODELS, UpscaleParams, build_upscale_graph
from app.workflows.frame_interpolate import RIFE_MODELS, FrameInterpolateParams, build_frame_interpolate_graph
from app.workflows.hunyuan_i2v import DEFAULT_NEGATIVE as HUNYUAN_DEFAULT_NEG, HunyuanI2VParams, build_hunyuan_i2v_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
from app.workflows.wan_t2v import WanT2VParams, build_wan_t2v_graph
from app.forge.client import ForgeClient
from app.forge.engine import spawn as forge_spawn, txt2img_payload as forge_txt2img_payload


class LoraInput(BaseModel):
    """叠加的单个 LoRA:文件名 + 权重(同时作用于 model 与 clip)。"""

    name: str = Field(min_length=1, max_length=256)
    weight: float = Field(default=1.0, ge=-2.0, le=2.0)


# 单次最多叠加的 LoRA 数(防滥用 + 控制图规模)
_MAX_LORAS = 8


def _to_lora_specs(loras: list[LoraInput]) -> tuple[LoraSpec, ...]:
    return tuple(LoraSpec(name=l.name, weight=l.weight) for l in loras[:_MAX_LORAS])


def _apply_lora_tags(req: Txt2ImgRequest | Img2ImgRequest) -> None:
    """剥离 positive 里的 `<lora:NAME:WEIGHT>` 标签并并入 req.loras(原地修改)。

    用户手写标签与预设 LoRA 走同一条 LoraLoader 链生效;权重超出 LoraInput
    合法区间的标签忽略(log.warning),不让请求失败。
    """
    req.positive, tag_loras = parse_lora_tags(req.positive)
    existing_names = {l.name for l in req.loras}
    for spec in tag_loras:
        if spec.name in existing_names or len(req.loras) >= _MAX_LORAS:
            continue
        if not (-2.0 <= spec.weight <= 2.0):
            logger.warning("忽略越界 LoRA 权重标签: %s:%s", spec.name, spec.weight)
            continue
        req.loras.append(LoraInput(name=spec.name, weight=spec.weight))
        existing_names.add(spec.name)


def _gate_nsfw_ckpt(ckpt_name: str, user: User) -> bool:
    """R18 硬门槛:成人底模须用户已开 R18 才放行,否则 403(防绕过 UI 直调 API)。

    返回该作品是否成人向(供建档打标 Job.nsfw)。
    """
    nsfw = is_nsfw(ckpt_name)
    if nsfw and not nsfw_allowed(user):
         raise HTTPException(status_code=403, detail="该底模属 R18 分区,请先在账号设置开启成人内容")
    return nsfw


class Txt2ImgRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=2000)
    ckpt_name: str | None = None
    style_preset: str | None = Field(default=None, max_length=64, description="风格预设ID,设置后自动选择模型+采样参数")
    width: int = Field(default=512, ge=64, le=2048)
    height: int = Field(default=512, ge=64, le=2048)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler: str = Field(default="euler", max_length=64)
    scheduler: str = Field(default="normal", max_length=64)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    batch_size: int = Field(default=1, ge=1, le=8)
    loras: list[LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)
    # 出图引擎:comfyui(默认,异步工作流)| forge(reForge sdapi 同步出图)
    engine: str = Field(default="comfyui")
    # Qwen-Image 加速档(2026-08-28 Phase 3A):off=满血(默认)/ turbo=4 步 Lightning 草稿 /
    # turbo_cache=8 步 Lightning + CacheDiT;仅 qwen_image 底模生效,其他底模显式给非 off → 422
    accel: str | None = Field(default=None, max_length=16)

    # 宽高比守卫:1:2~2:1 静默归一(SD 系训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_IMAGE, align=8, min_v=64, max_v=2048)

    @field_validator("accel")
    @classmethod
    def _v_accel(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if v not in ("off", "turbo", "turbo_cache"):
            raise ValueError("Qwen-Image 加速档须为 off / turbo / turbo_cache")
        return v


router = APIRouter()
logger = logging.getLogger(__name__)


def _snap8(v: int) -> int:
    """SD 潜空间要求宽高是 8 的倍数。"""
    return max(8, v - v % 8)


async def _submit_forge_txt2img(
    req: Txt2ImgRequest, ckpt_name: str, job_nsfw: bool, user: User, session: Session
) -> dict:
    """Forge 引擎 txt2img:建 Job + 后台 sdapi 出图,返回与 ComfyUI 同构的句柄。"""
    settings = get_settings()
    if not settings.forge_base:
         raise HTTPException(status_code=503, detail="Forge 引擎未部署")
    prompt_id = uuid.uuid4().hex
    # 锁 seed 微调要可复现:未指定时服务端先定 seed(否则 forge 侧 -1 随机后真实 seed 丢失,
    # rerun keep 会锁到列默认值 0,与原图无关)。与 ComfyUI 路径的 seed_used 语义对齐。
    seed_used = req.seed if req.seed is not None else secrets.randbelow(2**32)
    payload = forge_txt2img_payload(
         positive=req.positive, negative=req.negative, steps=req.steps, cfg=req.cfg,
         width=_snap8(req.width), height=_snap8(req.height), sampler=req.sampler,
         scheduler=req.scheduler, seed=seed_used, batch_size=req.batch_size, ckpt=ckpt_name,
    )
    session.add(Job(
         tenant_id=user.tenant_id, user_id=user.id, prompt_id=prompt_id,
         worker=settings.forge_base, kind="txt2img", status="queued",
         prompt=req.positive, seed=seed_used, nsfw=job_nsfw,
         params=params_snapshot(req, seed=seed_used, ckpt_name=ckpt_name),
    ))
    session.commit()
    forge_spawn(ForgeClient(settings.forge_base, timeout=600.0), prompt_id, "txt2img", payload)
    return {
         "prompt_id": prompt_id,
         "client_id": uuid.uuid4().hex,
         "worker": settings.forge_base,
         "seed": seed_used,
    }


async def _submit_txt2img(
    req: Txt2ImgRequest,
    pool: WorkerPool,
    user: User,
    session: Session,
) -> dict:
    """提交单个 txt2img 作业。返回与 generate_txt2img 同构的句柄。"""
    settings = get_settings()

    # ── 风格预设应用 ──
    # 若指定 style_preset,自动填充最佳模型+采样参数;用户显式传入的 ckpt_name 优先。
    explicit_ckpt = bool(req.ckpt_name)
    preset = None
    if req.style_preset:
        preset = resolve_style_preset(req.style_preset, MediaType.IMAGE)
        if not req.ckpt_name:
            req.ckpt_name = preset.ckpt_name
        # 采样参数:用户未显式偏离默认值时用预设推荐值(步骤/_CFG/采样器)
        if req.steps == 20 and preset.sampling.steps is not None:
            req.steps = preset.sampling.steps
        if req.cfg == 7.0 and preset.sampling.cfg is not None:
            req.cfg = preset.sampling.cfg
        if req.sampler == "euler" and preset.sampling.sampler is not None:
            req.sampler = preset.sampling.sampler
        if req.scheduler == "normal" and preset.sampling.scheduler is not None:
            req.scheduler = preset.sampling.scheduler
        # 分辨率:用户保持默认 512x512 时用预设推荐
        if req.width == 512 and req.height == 512:
            req.width = preset.width
            req.height = preset.height
        # 负向:用户为空时用预设推荐
        if not req.negative and preset.negative_prompt:
            req.negative = preset.negative_prompt
        # 正向:附加风格提示词尾缀
        if preset.prompt_hint and preset.prompt_hint not in req.positive:
            req.positive = req.positive + preset.prompt_hint
        # LoRA:预设 LoRA 叠加到用户请求的 LoRA 前面(用户 LoRA 权重优先生效)
        if preset.loras:
            existing_names = {l.name for l in req.loras}
            for lora_name, lora_weight in preset.loras:
                if lora_name not in existing_names and len(req.loras) < _MAX_LORAS:
                    req.loras.insert(0, LoraInput(name=lora_name, weight=lora_weight))

    # A1111 风格 <lora:NAME:WEIGHT> 标签:ComfyUI 不解析该语法,剥离后并入 LoRA 链
    _apply_lora_tags(req)

    ckpt_name = req.ckpt_name or settings.default_ckpt
    # SFW 意图预设(sfw_intent=True):底模虽命中 is_nsfw 家族 hints(wai/pony 等),
    # 预设定位是主站通用风格,豁免 R18 门槛且不打 nsfw 标;用户显式自选 ckpt 不受豁免。
    sfw_preset = preset is not None and preset.sfw_intent and not explicit_ckpt
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = False if sfw_preset else _gate_nsfw_ckpt(ckpt_name, user)

    # 加速档门槛:仅 qwen_image 底模;其他底模显式请求加速档 → 422(不静默忽略)
    if req.accel not in (None, "off") and detect_model_family(ckpt_name) != "qwen_image":
        raise HTTPException(status_code=422, detail="加速档(Lightning/CacheDiT)仅 Qwen-Image 底模支持")

    # 引擎分流:Forge 走 sdapi 同步出图(包装成异步 Job),ComfyUI 走既有工作流。
    if req.engine == "forge":
        return await _submit_forge_txt2img(req, ckpt_name, job_nsfw, user, session)

    # 次世代族(flux2/qwen_image/z_image)走 UNET 图 + 服务端**强制**正确采样(cfg≈1、
    # euler/res_multistep+simple、负向失效族清空负向);传统族走既有 checkpoint 图。
    # 分流依据全在 model_profiles(端点不写 per-model 分支,见开发协议)。
    if is_nextgen(ckpt_name):
         prof = profile_for(ckpt_name)
         recipe = nextgen_recipe(ckpt_name)
         # 文本编码器按 worker 可用性解析(默认候选未部署时自动降级,避免 503)
         clip_override: str | None = None
         if recipe and recipe.clip_candidates:
             avail = await pool.first_available(recipe.clip_candidates)
             if avail and avail != recipe.clip_name:
                 clip_override = avail
                 logger.info("nextgen clip fallback: %s → %s (model=%s)",
                             recipe.clip_name, avail, ckpt_name)
         w, h = fit_resolution(ckpt_name, _snap8(req.width), _snap8(req.height))
         ng = NextgenParams(
              model_name=ckpt_name,
              positive=req.positive,
              negative=req.negative if prof.neg_prompt else "",
              width=w,
              height=h,
              steps=prof.steps,
              cfg=prof.cfg,
              sampler=prof.sampler,
              scheduler=prof.scheduler,
              batch_size=req.batch_size,
              loras=_to_lora_specs(req.loras),
              **({"seed": req.seed} if req.seed is not None else {}),
              clip_name=clip_override,
              accel=req.accel,
         )
         graph = build_nextgen_graph(ng)
         seed_used = ng.seed
         # 次世代图需 UNET + 文本编码器 + VAE 三件都在的 worker(缺则 pick 干净失败 503)
         effective_clip = clip_override or (recipe.clip_name if recipe else None)
         required = {ckpt_name, effective_clip, recipe.vae_name} if recipe else {ckpt_name}
         # LoRA 文件也须在目标 worker 上(与传统族一致,避免派到缺模型的机)
         required |= {l.name for l in ng.loras}
         # 加速档 Lightning LoRA 同样须在(worker 共享 NAS,常态全集;防御异构)
         accel_spec = resolve_qwen_accel(req.accel)
         if accel_spec.lora_name:
              required |= {accel_spec.lora_name}
    else:
         params = Txt2ImgParams(
              positive=req.positive,
              negative=req.negative,
              ckpt_name=ckpt_name,
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
         graph = build_txt2img_graph(params)
         seed_used = params.seed
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
         _raise_from_comfy_error(e)

    # 按租户记录作业(隔离 / 历史;P2 只隔离不计费)
    job = Job(
         tenant_id=user.tenant_id,
         user_id=user.id,
         prompt_id=prompt_id,
         worker=client.base_url,
         kind="txt2img",
         status="queued",
         prompt=req.positive,
         seed=seed_used,
         nsfw=job_nsfw,
         params=params_snapshot(req, seed=seed_used, ckpt_name=ckpt_name),
    )
    session.add(job)
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE(修前端断开丢结果的真 bug)
    spawn_tracker(client, prompt_id)

    return {
         "prompt_id": prompt_id,
         "client_id": client_id,
         "worker": client.base_url,
         "seed": seed_used,
    }


@router.post("/generate/txt2img")
async def generate_txt2img(
    req: Txt2ImgRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    return await _submit_txt2img(req, pool, user, session)


class BestOfNRequest(Txt2ImgRequest):
    """Best-of-N 请求:基于 Txt2ImgRequest 参数,一次性生成 N 张并选出最优。"""

    n: int = Field(default=4, ge=2, le=8)


class GenerateBestOfNResponse(BestOfResult):
    """Best-of-N 生成响应:评分结果 + 各候选的作业标识。"""

    prompt_ids: list[str]
    seeds: list[int]


@router.post("/generate/best-of-n", response_model=GenerateBestOfNResponse)
async def generate_best_of_n(
    req: BestOfNRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    scoring_service: ScoringService = Depends(get_scoring_service),
):
    """并发提交 N 个 txt2img,全部完成后用评分服务选出最优图。"""
    enforce_generation_rate_limit(user, count=req.n)

    # 为 N 个候选生成不同 seed,保证多样性;同时固定 batch_size=1(每个候选一张图)。
    base_seed = req.seed if req.seed is not None else secrets.randbelow(2**32)
    candidates: list[Txt2ImgRequest] = []
    for i in range(req.n):
        candidate = Txt2ImgRequest(**req.model_dump(exclude={"n"}))
        candidate.seed = (base_seed + i) % (2**32)
        candidate.batch_size = 1
        candidates.append(candidate)

    # 并发提交 N 个作业;每个作业使用独立会话避免同一请求会话并发问题。
    submitted = await asyncio.gather(
        *(_submit_txt2img(c, pool, user, Session(engine)) for c in candidates)
    )
    prompt_ids = [s["prompt_id"] for s in submitted]
    seeds = [s["seed"] for s in submitted]

    # 等待所有作业完成
    try:
        results = await wait_for_jobs(
            session, prompt_ids, timeout=300.0, poll_interval=1.0
        )
    except RuntimeError as e:
        status = 504 if "超时" in str(e) else 502
        raise HTTPException(status_code=status, detail=str(e)) from e

    # 提取每个候选的产物 URL
    image_urls: list[str] = []
    for pid in prompt_ids:
        urls = results.get(pid, [])
        if not urls:
            raise HTTPException(status_code=502, detail=f"作业 {pid} 没有产物")
        image_urls.append(urls[0])

    # 评分选出最优
    try:
        best_result = await scoring_service.best(image_urls, req.positive)
    except ScorerUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    return GenerateBestOfNResponse(
        best=best_result.best,
        scores=best_result.scores,
        ranked=best_result.ranked,
        prompt_ids=prompt_ids,
        seeds=seeds,
    )


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
    # 加速档(2026-08-27 Phase 2):off=满血(默认,20 步) / turbo=草稿 4 步 Seko 双 LoRA /
    # turbo_cache=成片 8 步 Seko + EasyCache;缺省 None=满血(现状)
    accel: str | None = Field(default=None, max_length=16)
    # EasyCache 复用阈值(仅 turbo_cache 档生效;空=builder 默认 0.15)
    cache_threshold: float | None = Field(default=None, ge=0.05, le=0.40)

    @field_validator("accel")
    @classmethod
    def _v_accel(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if v not in ("off", "turbo", "turbo_cache"):
            raise ValueError("Wan 加速档须为 off / turbo / turbo_cache")
        return v


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
         accel=req.accel,
         **({"cache_threshold": req.cache_threshold} if req.cache_threshold is not None else {}),
         **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_t2v_graph(params)
    try:
         client = await pool.pick(required=_wan_t2v_required(), required_nodes=required_nodes("video"))
    except ComfyUIError as e:
         raise HTTPException(status_code=503, detail=str(e)) from e
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
              kind="wan_t2v",
              status="queued",
              prompt=params.positive,
              seed=params.seed,
              params=params_snapshot(req, seed=params.seed),
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


class HunyuanVideoI2VRequest(BaseModel):
    """用户只需提供提示词、反向提示词和图片，模型参数全部预设。"""

    positive: str = Field(min_length=1, max_length=2000)
    image: str = Field(min_length=1, max_length=512)
    worker: str  # 图片上传到的 worker
    negative: str = Field(default="", max_length=2000)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/hunyuan-video-i2v")
async def generate_hunyuan_video_i2v(
    req: HunyuanVideoI2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """HunyuanVideo-I2V 图生视频：图片 + 提示词 → 视频。

    模型、分辨率、帧数、采样步数等参数全部预设最优值，用户无需调整。
    """
    enforce_generation_rate_limit(user)
    client = resolve_worker(req.worker)
    params = HunyuanI2VParams(
        positive=req.positive,
        image=req.image,
        negative=req.negative or HUNYUAN_DEFAULT_NEG,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_hunyuan_i2v_graph(params)
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
            kind="hunyuan_i2v",
            status="queued",
            prompt=params.positive,
            seed=params.seed,
            params=params_snapshot(req, seed=params.seed),
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


class Img2ImgRequest(BaseModel):
    positive: str = Field(min_length=1, max_length=2000)
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的文件名
    worker: str  # 图片上传到的 worker
    negative: str = Field(default="", max_length=2000)
    ckpt_name: str | None = None
    style_preset: str | None = Field(default=None, max_length=64, description="风格预设ID")
    denoise: float = Field(default=0.6, ge=0.1, le=1.0)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler: str = Field(default="euler", max_length=64)
    scheduler: str = Field(default="normal", max_length=64)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    loras: list[LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)
    # Qwen-Image 加速档(与 txt2img 同一套):off=满血(默认)/ turbo / turbo_cache;仅 qwen_image 底模
    accel: str | None = Field(default=None, max_length=16)

    @field_validator("accel")
    @classmethod
    def _v_accel(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if v not in ("off", "turbo", "turbo_cache"):
            raise ValueError("Qwen-Image 加速档须为 off / turbo / turbo_cache")
        return v


@router.post("/generate/img2img")
async def generate_img2img(
    req: Img2ImgRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    settings = get_settings()

    # ── 风格预设应用(同 txt2img) ──
    explicit_ckpt = bool(req.ckpt_name)
    preset = None
    if req.style_preset:
        preset = resolve_style_preset(req.style_preset, MediaType.IMAGE)
        if not req.ckpt_name:
            req.ckpt_name = preset.ckpt_name
        if req.steps == 20 and preset.sampling.steps is not None:
            req.steps = preset.sampling.steps
        if req.cfg == 7.0 and preset.sampling.cfg is not None:
            req.cfg = preset.sampling.cfg
        if req.sampler == "euler" and preset.sampling.sampler is not None:
            req.sampler = preset.sampling.sampler
        if req.scheduler == "normal" and preset.sampling.scheduler is not None:
            req.scheduler = preset.sampling.scheduler
        if req.denoise == 0.6 and preset.sampling.denoise is not None:
            req.denoise = preset.sampling.denoise
        if not req.negative and preset.negative_prompt:
            req.negative = preset.negative_prompt
        if preset.prompt_hint and preset.prompt_hint not in req.positive:
            req.positive = req.positive + preset.prompt_hint
        # LoRA:预设 LoRA 叠加到用户请求的 LoRA 前面
        if preset.loras:
            existing_names = {l.name for l in req.loras}
            for lora_name, lora_weight in preset.loras:
                if lora_name not in existing_names and len(req.loras) < _MAX_LORAS:
                    req.loras.insert(0, LoraInput(name=lora_name, weight=lora_weight))

    # A1111 风格 <lora:NAME:WEIGHT> 标签:同 txt2img,剥离后并入 LoRA 链
    _apply_lora_tags(req)

    ckpt_name = req.ckpt_name or settings.default_ckpt
    client = resolve_worker(req.worker)  # 必须用图片所在的 worker
    # SFW 意图预设豁免 R18 门槛(同 txt2img);显式自选 ckpt 不受豁免。
    sfw_preset = preset is not None and preset.sfw_intent and not explicit_ckpt
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = False if sfw_preset else _gate_nsfw_ckpt(ckpt_name, user)

    # 加速档门槛:仅 qwen_image 底模(与 txt2img 同一套)
    if req.accel not in (None, "off") and detect_model_family(ckpt_name) != "qwen_image":
        raise HTTPException(status_code=422, detail="加速档(Lightning/CacheDiT)仅 Qwen-Image 底模支持")

    if is_nextgen(ckpt_name):
         prof = profile_for(ckpt_name)
         recipe = nextgen_recipe(ckpt_name)
         # ModelSamplingFlux 需输入图尺寸做 shift 估算(≥16 校验);探测失败回退 1024,
         # 其余族(AuraFlow/无)不需要,避免多余网络往返。
         i2i_w, i2i_h = 0, 0
         if recipe and recipe.model_sampling == "ModelSamplingFlux":
              i2i_w, i2i_h = await input_image_dims(client, req.image)
         ng = NextgenImg2ImgParams(
              model_name=ckpt_name,
              image=req.image,
              positive=req.positive,
              negative=req.negative if prof.neg_prompt else "",
              denoise=req.denoise,
              steps=prof.steps,
              cfg=prof.cfg,
              sampler=prof.sampler,
              scheduler=prof.scheduler,
              width=i2i_w,
              height=i2i_h,
              loras=_to_lora_specs(req.loras),
              **({"seed": req.seed} if req.seed is not None else {}),
              accel=req.accel,
         )
         graph = build_nextgen_img2img_graph(ng)
         seed_used = ng.seed
    else:
         params = Img2ImgParams(
              positive=req.positive,
              image=req.image,
              negative=req.negative,
              ckpt_name=ckpt_name,
              denoise=req.denoise,
              steps=req.steps,
              cfg=req.cfg,
              sampler=req.sampler,
              scheduler=req.scheduler,
              loras=_to_lora_specs(req.loras),
              **({"seed": req.seed} if req.seed is not None else {}),
         )
         graph = build_img2img_graph(params)
         seed_used = params.seed

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
              kind="img2img",
              status="queued",
              prompt=req.positive,
              seed=seed_used,
              nsfw=job_nsfw,
              params=params_snapshot(req, seed=seed_used, ckpt_name=ckpt_name),
         )
    )
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE(修前端断开丢结果的真 bug)
    spawn_tracker(client, prompt_id)

    return {
         "prompt_id": prompt_id,
         "client_id": client_id,
         "worker": client.base_url,
         "seed": seed_used,
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
         _raise_from_comfy_error(e)

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
              params=params_snapshot(req, seed=params.seed, ckpt_name=params.ckpt_name),
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
         _raise_from_comfy_error(e)

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
              params=params_snapshot(req),
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
         _raise_from_comfy_error(e)

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
              params=params_snapshot(req, seed=params.seed, ckpt_name=params.ckpt_name),
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


# raw 工作流 R18 门控:模型引用字段远不止 ckpt_name(UNETLoader.unet_name /
# LoraLoader.lora_name / VAELoader.vae_name / LTXVGemmaCLIPModelLoader.ltxv_path …),
# 逐字段列举必漏(10Eros 系即经 unet_name 加载)。统一递归遍历 inputs 内全部
# 字符串,凡以模型扩展名结尾的一律过 R18 判定。
_MODEL_REF_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".bin")


def _iter_input_strings(value: object):
    """递归展开 inputs 值中的所有字符串(嵌套 dict/list 一并遍历)。"""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _iter_input_strings(v)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_input_strings(item)


def _is_nsfw_model_ref(name: str) -> bool:
    """模型引用字符串的 R18 判定:is_nsfw 子串 + H3 已知 NSFW LoRA 名单。

    H3 名单内 LoRA(如 riding_pose_H3_i2v_v1.0.safetensors)文件名不含通用
    NSFW 子串,is_nsfw 漏判,须复用 services.h3 的 curated 判定(与
    h3_studio._gate_h3_nsfw_loras 同一事实源)。延迟导入避免 routes↔services 环。"""
    if is_nsfw(name):
        return True
    from app.services.h3 import is_h3_nsfw_lora

    return is_h3_nsfw_lora(name)


def _gate_raw_graph_nsfw(graph: dict, user: User) -> bool:
    """扫描任意工作流图中的模型引用(ckpt/unet/lora/vae 等全部 inputs 字符串),
    对 R18 模型套用与其它端点一致的硬门槛。

    返回该图是否含成人向模型(供建档打标 Job.nsfw)。
    """
    any_nsfw = False
    for node in graph.values():
         if not isinstance(node, dict):
              continue
         inputs = node.get("inputs")
         if not isinstance(inputs, dict):
              continue
         for value in inputs.values():
              for s in _iter_input_strings(value):
                   if s.lower().endswith(_MODEL_REF_EXTS) and _is_nsfw_model_ref(s):
                        any_nsfw = True
    # header-only R18 语义:与 _gate_nsfw_ckpt 同一信号(X-NSFW 头),账户开关不再放行
    if any_nsfw and not nsfw_allowed(user):
         raise HTTPException(
              status_code=403, detail="工作流含 R18 底模,请在 R18 专区(/nsfw)使用"
         )
    return any_nsfw


class RawWorkflowRequest(BaseModel):
    # ComfyUI API-format prompt 图(节点 id → {class_type, inputs});须含 SaveImage 类产物节点
    graph: dict
    worker: str | None = None  # 可选:指定 worker(图引用了某机上传的图时需要);否则自动选活机


@router.post("/generate/raw")
async def generate_raw(
    req: RawWorkflowRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
):
    """运行任意 ComfyUI 工作流(API-format JSON)。把整台 ComfyUI 直通给高级用户。

    R18:扫描图中底模套用统一门槛。worker 未指定则自动选可达机(绕开掉线实例)。
    图须自带 SaveImage 类节点,产物才能被追踪回取。
    """
    enforce_generation_rate_limit(user)
    if not isinstance(req.graph, dict) or not req.graph:
         raise HTTPException(status_code=422, detail="graph 必须是非空的 ComfyUI API 格式图")
    if len(req.graph) > 400:
         raise HTTPException(status_code=422, detail="工作流节点过多(>400)")
    job_nsfw = _gate_raw_graph_nsfw(req.graph, user)
    try:
         client = resolve_worker(req.worker) if req.worker else await pool.pick()
    except ComfyUIError as e:
         _raise_from_comfy_error(e)
    client_id = uuid.uuid4().hex
    try:
         prompt_id = await client.queue_prompt(req.graph, client_id)
    except ComfyUIError as e:
         _raise_from_comfy_error(e)

    session.add(
         Job(
              tenant_id=user.tenant_id,
              user_id=user.id,
              prompt_id=prompt_id,
              worker=client.base_url,
              kind="raw",
              status="queued",
              prompt="raw workflow",
              seed=None,
              nsfw=job_nsfw,
              params=params_snapshot(req),
         )
    )
    session.commit()

    spawn_tracker(client, prompt_id)

    return {
         "prompt_id": prompt_id,
         "client_id": client_id,
         "worker": client.base_url,
    }


class RemoveBgRequest(BaseModel):
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的源图文件名
    worker: str  # 源图所在 worker(同 img2img)
    mode: str = Field(default="general", max_length=32)


@router.post("/generate/removebg")
async def generate_removebg(
    req: RemoveBgRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """抠图去背:把主体抠出、去掉背景(rembg)。无 checkpoint→不涉 R18。

    沿用 img2img 模式:必须用源图所在的 worker(resolve_worker 防 SSRF)。
    """
    enforce_generation_rate_limit(user)
    if req.mode not in REMBG_MODES:
         raise HTTPException(
              status_code=422,
              detail=f"不支持的抠图模式:{req.mode!r};可选 {list(REMBG_MODES)}",
         )
    client = resolve_worker(req.worker)  # 必须用源图所在的 worker
    params = RemoveBgParams(image=req.image, mode=req.mode)
    graph = build_removebg_graph(params)
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
              kind="removebg",
              status="queued",
              prompt=f"removebg:{req.mode}",
              seed=None,
              nsfw=False,
              params=params_snapshot(req),
         )
    )
    session.commit()

    spawn_tracker(client, prompt_id)

    return {
         "prompt_id": prompt_id,
         "client_id": client_id,
         "worker": client.base_url,
         "mode": req.mode,
    }


class InpaintRequest(BaseModel):
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的源图文件名
    worker: str  # 源图所在 worker(同 img2img)
    target: str = Field(min_length=1, max_length=500)  # 要替换区域的文字描述
    positive: str = Field(min_length=1, max_length=2000)  # 该区域重绘成什么
    negative: str = Field(default="blurry, lowres, deformed, watermark, text", max_length=2000)
    ckpt_name: str | None = None
    denoise: float = Field(default=0.85, ge=0.1, le=1.0)
    grow_mask: int = Field(default=6, ge=0, le=64)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


@router.post("/generate/inpaint")
async def generate_inpaint(
    req: InpaintRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """文字定向局部重绘:Florence2 按 target 文字分割区域 → 仅重绘该区域。

    沿用 img2img 的 worker 锁定模式;首次会下载 Florence2-base(worker 处理)。
    """
    enforce_generation_rate_limit(user)
    settings = get_settings()
    client = resolve_worker(req.worker)  # 必须用源图所在的 worker
    params = InpaintParams(
         image=req.image,
         target=req.target,
         positive=req.positive,
         negative=req.negative,
         ckpt_name=req.ckpt_name or settings.default_ckpt,
         denoise=req.denoise,
         grow_mask=req.grow_mask,
         **({"seed": req.seed} if req.seed is not None else {}),
    )
    # R18 硬门槛:成人底模须已开 R18,否则 403;并据此给作品打 nsfw 标。
    job_nsfw = _gate_nsfw_ckpt(params.ckpt_name, user)
    graph = build_inpaint_graph(params)
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
              kind="inpaint",
              status="queued",
              prompt=params.positive,
              seed=params.seed,
              nsfw=job_nsfw,
              params=params_snapshot(req, seed=params.seed, ckpt_name=params.ckpt_name),
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


class QwenEditRequest(BaseModel):
    image: str = Field(min_length=1, max_length=512)  # 上传后得到的源图文件名
    worker: str  # 源图所在 worker(同 img2img)
    positive: str = Field(default="", max_length=2000)  # 编辑指令(纯相机操作时可空)
    camera: str | None = Field(default=None, max_length=32)  # CAMERA_PRESETS 的 key
    # 3D 相机(2511 底模,96 机位):三项同时给出才生效,与 camera 互斥
    azimuth: int | None = None  # 0/45/90/135/180/225/270/315(0=正面,顺时针)
    elevation: int | None = None  # -30/0/30/60
    distance: str | None = Field(default=None, max_length=16)  # closeup/medium/wide
    fast: bool = True  # True=Lightning 加速档;False=20 步标准档
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # 内容分组 id(360° 环绕序列同批 8 张归组,作品库折叠为文件夹):仅标识用,安全字符白名单
    batch_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    # 主体库引用(1-4 个 Entity id):prompt_hint 注入编辑指令,首个有图主体补参考图
    entity_ids: list[str] | None = Field(default=None, max_length=4)


@router.post("/generate/qwen-edit")
async def generate_qwen_edit(
    req: QwenEditRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Qwen-Image-Edit-2509 语义图像编辑(含多角度相机控制),专用实例 :8194。

    LoadImage 只能读本实例 input 目录,而源图在源 worker 上 → 服务端转存:
    从源 worker /view 拉字节,POST 到编辑实例 /upload/image,用新文件名进图。
    不经过 LB 池;固定 SFW 模型,不涉 R18 门控。
    """
    enforce_generation_rate_limit(user)
    if req.camera is not None and req.camera not in CAMERA_PRESETS:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的相机角度:{req.camera!r};可选 {list(CAMERA_PRESETS)}",
        )
    has_cam3d = req.azimuth is not None or req.elevation is not None or req.distance is not None
    if has_cam3d and req.camera is not None:
        raise HTTPException(status_code=422, detail="3D 相机与相机角度预设只能二选一")
    if not req.positive.strip() and req.camera is None and not has_cam3d and not req.entity_ids:
        raise HTTPException(status_code=422, detail="编辑指令与相机角度至少填一项")

    # 主体库注入:prompt_hint 拼入编辑指令末尾
    positive = req.positive
    if req.entity_ids:
        from app.services.entities import image_handle_for_injection
        from sqlmodel import select as _select
        from app.models import Entity as _Entity
        ids = [i for i in req.entity_ids if isinstance(i, str) and i.strip()][:4]
        rows = session.exec(
            _select(_Entity).where(_Entity.user_id == user.id, _Entity.id.in_(ids))  # type: ignore[attr-defined]
        ).all() if ids else []
        order = {i: n for n, i in enumerate(ids)}
        rows = sorted(rows, key=lambda e: order.get(e.id, len(ids)))
        hints = []
        for e in rows:
            hint = (e.prompt_hint or e.description or "").strip()
            if hint:
                hints.append(f"{e.name}: {hint}")
        if hints:
            positive = f"{positive}\n[主体库] " + "; ".join(hints) if positive else "; ".join(hints)
    src = resolve_worker(req.worker)  # 源图所在 worker(resolve_worker 防 SSRF)
    try:
        content, _ = await src.get_image_bytes(req.image, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"读取源图失败: {e}") from e
    client = get_qwen_edit_client()  # 专用编辑实例,不入池
    try:
        transferred = await client.upload_image(content, req.image)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"转存源图到编辑实例失败: {e}") from e

    params = QwenEditParams(
        image=transferred,
        positive=positive,  # 含主体库注入的编辑指令
        camera=req.camera,
        azimuth=req.azimuth,
        elevation=req.elevation,
        distance=req.distance,
        fast=req.fast,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    try:
        graph = build_qwen_edit_graph(params)
    except QwenEditError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
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
            kind="qwen_edit",
            status="queued",
            prompt=(
                positive
                + (f" [camera:{req.camera}]" if req.camera else "")
                + (f" [3d:{req.azimuth}°/{req.elevation}°/{req.distance}]" if has_cam3d else "")
            ).strip(),
            seed=params.seed,
            nsfw=False,
            params=params_snapshot(req, seed=params.seed),
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


class FrameInterpolateRequest(BaseModel):
    video: str = Field(min_length=1, max_length=512)  # 已上传到 worker 的源视频文件名
    worker: str  # 源视频所在 worker(同 img2img,须用视频所在 worker)
    multiplier: float = Field(default=2.5, ge=1.5, le=4.0)
    model_name: str = Field(default=RIFE_MODELS[0], max_length=128)


@router.post("/generate/frame-interpolate")
async def generate_frame_interpolate(
    req: FrameInterpolateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """帧插值:用 RIFE 模型把源视频插帧到更高帧率(如 24fps→60fps)。

    无 checkpoint(纯插值模型)→ 不涉 R18;沿用 img2img 模式:
    必须用源视频所在的 worker(resolve_worker 防 SSRF)。
    """
    enforce_generation_rate_limit(user)
    if req.model_name not in RIFE_MODELS:
         raise HTTPException(
              status_code=422,
              detail=f"不支持的 RIFE 模型:{req.model_name!r};可选 {list(RIFE_MODELS)}",
         )
    client = resolve_worker(req.worker)  # 必须用源视频所在的 worker
    params = FrameInterpolateParams(
         video=req.video, multiplier=req.multiplier, model_name=req.model_name
    )
    graph = build_frame_interpolate_graph(params)
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
              kind="frame_interpolate",
              status="queued",
              prompt=f"frame-interpolate x{req.multiplier:g}",
              seed=None,
              nsfw=False,
              params=params_snapshot(req),
         )
    )
    session.commit()

    spawn_tracker(client, prompt_id)

    return {
         "prompt_id": prompt_id,
         "client_id": client_id,
         "worker": client.base_url,
         "multiplier": req.multiplier,
         "model_name": req.model_name,
    }
