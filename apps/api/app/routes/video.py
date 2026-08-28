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

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.services import video_generators as vgen
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.services.effect_presets import apply_effect_preset, validate_effect_key
from app.services.video_upscale import maybe_chain_upscale
from app.versioning import params_snapshot
from app.workflows.video_upscale import validate_resolution_target
from app.workflows.ltx_video import (
    LtxI2VParams,
    LtxLipsyncParams,
    LtxT2VParams,
    build_ltx_i2v_graph,
    build_ltx_lipsync_graph,
    build_ltx_t2v_graph,
)
from app.workflows.wan_i2v import WAN_I2V_NSFW_LORAS, WanI2VParams, build_wan_i2v_graph

router = APIRouter()


class WanLoraInput(BaseModel):
    """Wan2.2 I2V NSFW LoRA 选择(2026-08-16):name 须在 WAN_I2V_NSFW_LORAS 注册表内,
    侧别(high/low)由注册表判定;strength 留空用注册表默认值。"""

    name: str = Field(min_length=1, max_length=200)
    strength: float | None = Field(default=None, ge=0.0, le=2.0)


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
    # NSFW LoRA 叠加链(仅 R18 上下文生效;SFW 请求带了一律剔除,防绕过)
    loras: list[WanLoraInput] = Field(default_factory=list, max_length=4)
    # 满血档:不挂加速 LoRA,20 步 + cfg 3.5/3.0(慢 ~4 倍换质量,成片用);默认加速档 8 步
    full_quality: bool = False
    # 加速档(2026-08-27 Phase 2):off=满血 / turbo=草稿 4 步 Seko 双 LoRA /
    # turbo_cache=成片 8 步 Seko + EasyCache;缺省 None → 按 full_quality 映射
    # (True→off,False→turbo_cache);显式给定时优先于 full_quality
    accel: str | None = Field(default=None, max_length=16)
    # EasyCache 复用阈值(仅 turbo_cache 档生效;空=builder 默认 0.15。
    # 高动态场景建议 0.10 保守,静态场景可 0.20-0.25 换更大加速)
    cache_threshold: float | None = Field(default=None, ge=0.05, le=0.40)
    # 特效预设(Pikaffects 式一键物理特效;静态清单见 services/effect_presets):
    # 选中后后端把特效英文描述确定性拼到 positive 前部,不经过 LLM;未知 key → 422
    effect_preset: str | None = Field(default=None, max_length=64)
    # RES-2026-08-18:输出分辨率档(1080p/2k/4k);空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("accel")
    @classmethod
    def _v_accel(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if v not in ("off", "turbo", "turbo_cache"):
            raise ValueError("Wan 加速档须为 off / turbo / turbo_cache")
        return v

    @field_validator("effect_preset")
    @classmethod
    def _v_effect_preset(cls, v: str | None) -> str | None:
        return validate_effect_key(v)

    @field_validator("resolution_target")
    @classmethod
    def _v_target(cls, v: str | None) -> str | None:
        return validate_resolution_target(v)

    # 数值字段:越界/小数一律钳到合法区间,不硬报 422(生成场景静默钳位比报错友好)。
    # 前端各面板/画布节点可能灌进大图尺寸、复用的巨大 seed 等 → 这里兜底,免整条 i2v 崩。
    @field_validator("width", "height", mode="before")
    @classmethod
    def _clamp_dim(cls, v: object) -> object:
        try:
            return max(128, min(1280, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return v

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=8, min_v=128, max_v=1280)

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
    # 特效预设注入层:选中后把特效描述确定性拼到 positive 前部(不经过 LLM);
    # model_copy 覆盖使 params 构图 / Job.prompt 落库 / 参数快照全部同源
    if req.effect_preset:
        pos, neg = apply_effect_preset(req.positive, req.negative or "", req.effect_preset)
        req = req.model_copy(update={"positive": pos, "negative": neg})
    # NSFW LoRA 分侧挂载:R18 上下文才生效(SFW 请求带 loras 静默剔除);
    # 注册表外的名字直接 422(防任意文件路径注入)
    high_loras: list[tuple[str, float]] = []
    low_loras: list[tuple[str, float]] = []
    if req.loras and nsfw_allowed(user):
        for l in req.loras:
            entry = WAN_I2V_NSFW_LORAS.get(l.name)
            if entry is None:
                raise HTTPException(status_code=422, detail=f"未知 Wan NSFW LoRA: {l.name}")
            (high_loras if entry.side == "high" else low_loras).append(
                (l.name, l.strength if l.strength is not None else entry.default_strength))
    # 加速档映射(2026-08-27 Phase 2):显式 accel 优先;缺省按 full_quality 兼容映射
    # (True→off 满血 20 步 3.5/3.0;False→turbo_cache 成片 8 步 Seko + EasyCache)
    accel = req.accel if req.accel is not None else ("off" if req.full_quality else "turbo_cache")
    params = WanI2VParams(
        positive=req.positive,
        image=req.image,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        high_loras=tuple(high_loras),
        low_loras=tuple(low_loras),
        accel=accel,
        **({"cache_threshold": req.cache_threshold} if req.cache_threshold is not None else {}),
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
            # R18 上下文(/nsfw 专区提交)产物打标进 R18 作品库;主链 SFW 请求不打标
            nsfw=nsfw_allowed(user),
            params=params_snapshot(req, seed=params.seed),
        )
    )
    session.commit()

    # 启动服务端后台追踪:前端 SSE 断开后仍可把结果落库,避免"一直生成中"
    spawn_tracker(client, prompt_id)

    result = {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
    if req.resolution_target and maybe_chain_upscale(prompt_id, req.resolution_target):
        result["upscale_notice"] = (
            f"原生生成完成后将自动二次超分至 {req.resolution_target.upper()}"
        )
    return result


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
    """LTX2.3 文生视频请求。

    时长:优先 duration_sec(秒;8k+1 网格取整,秒差大时生成后精确裁切);
    length(帧数)为兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=768, ge=256, le=1920)
    height: int = Field(default=384, ge=256, le=1920)
    duration_sec: float | None = Field(default=None, gt=0, le=60)
    length: int = Field(default=97, ge=9, le=241)
    fps: int = Field(default=16, ge=4, le=30)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    use_upscale: bool = False
    use_rife: bool = False
    # RES-2026-08-18:输出分辨率档(1080p/2k/4k);空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("resolution_target")
    @classmethod
    def _v_target(cls, v: str | None) -> str | None:
        return validate_resolution_target(v)

    @field_validator("width", "height", mode="before")
    @classmethod
    def _clamp_dim(cls, v: object) -> object:
        try:
            return max(256, min(1920, int(float(v))))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return v

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=8, min_v=256, max_v=1920)


def _resolve_ltx_plan(req: LtxT2VRequest) -> DurationPlan | None:
    """duration_sec → 统一策略层时长计划;未给 → None(走旧 length 入参)。"""
    if req.duration_sec is None:
        return None
    try:
        return resolve_duration("ltx", req.duration_sec, req.fps)
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


def _apply_duration(result: dict, plan: DurationPlan | None, resolution_target: str | None = None) -> dict:
    """时长策略透出:notice 进响应;trim 时后台挂精确裁剪链(ltx 无 extend)。

    resolution_target(RES-2026-08-18):非空时挂融合超分链(生成+裁剪终态后自动二次超分)。
    """
    if plan is not None and plan.strategy != "direct":
        vgen.spawn_duration_chain(
            client=ComfyUIClient(result["worker"]),
            plan=plan,
            first_prompt_id=result["prompt_id"],
        )
    if plan is not None and plan.notice:
        result["duration_notice"] = plan.notice
    if resolution_target and maybe_chain_upscale(result["prompt_id"], resolution_target):
        result["upscale_notice"] = (
            f"原生生成完成后将自动二次超分至 {resolution_target.upper()}"
        )
    return result


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
    plan = _resolve_ltx_plan(req)
    params = LtxT2VParams(
        positive=req.positive,
        negative=req.negative,
        unet_name=settings.nsfw_default_video_ckpt,
        gemma_name=settings.nsfw_default_gemma,
        vae_name=settings.nsfw_default_vae,
        width=req.width,
        height=req.height,
        length=plan.frames if plan else req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxT2VParams(positive="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
    )
    graph = build_ltx_t2v_graph(params)
    return _apply_duration(
        await _submit_ltx_job(graph, params, "ltx_t2v", user, session), plan, req.resolution_target
    )


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
    plan = _resolve_ltx_plan(req)
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
        length=plan.frames if plan else req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxI2VParams(positive="", image="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
    )
    graph = build_ltx_i2v_graph(params)
    return _apply_duration(
        await _submit_ltx_job(graph, params, "ltx_i2v", user, session, client=client), plan, req.resolution_target
    )


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
    plan = _resolve_ltx_plan(req)
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
        length=plan.frames if plan else req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxLipsyncParams(positive="", image="", audio="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
    )
    graph = build_ltx_lipsync_graph(params)
    return _apply_duration(
        await _submit_ltx_job(graph, params, "ltx_lipsync", user, session, client=client), plan, req.resolution_target
    )


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
        # pool.pick 无可用 worker 时抛 ComfyUIError(从不返回 None),须捕获转 503,
        # 否则冒泡成 500(2026-08-14 Team E 测试实证,对齐 generate.py 写法)
        try:
            picked = await pool.pick(required=model_set, required_nodes=node_set)
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=f"无可用 worker(缺 LTX 模型或节点): {e}") from e
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
