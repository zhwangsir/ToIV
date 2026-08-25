"""MiniMax H3 工作室 —— H3 视频生成(t2v / i2v),专用 ComfyUI 实例(TOIV_H3_BASE_URL)。

POST /api/h3/t2v —— 文生视频(原生 32kHz 立体声音轨,音画同发)
POST /api/h3/i2v —— 图生视频(首帧参考图;先经 /api/upload 上传到 pool worker,
                    提交时由后端转运到 H3 实例 input 目录)

与 LTX2 工作室的区别:H3 走独立 ComfyUI ≥ 0.30 实例(默认 workstation :8195,
不走 WorkerPool 集群);产物链路(tracker 落库 + /api/images 代理进作品库)与 ltx2 同路。
参数约束(真机压测):
  · 分辨率 256-1344 且 32 对齐(上限 1344×768)
  · 帧数 17k+5 网格,22-362 @24fps(124≈5.2s,362≈15s)
  · 采样 res_multistep/simple,steps 1-50(默认 20)
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import engine as db_engine
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.workflows.video_upscale import validate_resolution_target
from app.services import h3 as h3_service
from app.services import video_generators as vgen
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.services.h3 import is_h3_nsfw_lora
from app.services.video_upscale import maybe_chain_upscale
from app.workflows.h3_video import H3I2VParams, H3T2VParams, build_h3_i2v_graph, build_h3_t2v_graph
from app.workflows.lora import LoraSpec

router = APIRouter()


# ──────────────────────────────────────────────────────────────
# 请求模型
# ──────────────────────────────────────────────────────────────

# LoRA 叠加上限(与 ltx_studio 同一约束)
_MAX_LORAS = 3


class H3LoraInput(BaseModel):
    """单个叠加 LoRA:H3 worker loras 目录内文件(NAS h3/loras 映射),强度 0.5-1.0(作者推荐 0.6)。"""
    name: str = Field(min_length=1, max_length=512)
    strength: float = Field(default=0.6, ge=0.5, le=1.0)

    @field_validator("name")
    @classmethod
    def _safe_name(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("LoRA 文件名不允许路径穿越")
        if not name.endswith(".safetensors"):
            raise ValueError("LoRA 必须是 .safetensors 文件")
        return name


def _gate_h3_nsfw_loras(loras: list[H3LoraInput], user: User) -> None:
    """NSFW LoRA 门槛:引用已知 H3 R18 LoRA(services/h3.H3_NSFW_LORAS)时仅
    /nsfw 专页(X-NSFW: 1 header)放行,主站调用一律 403(与 _gate_ltx_nsfw 同风格)。"""
    if any(is_h3_nsfw_lora(lora.name) for lora in loras) and not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="所选 LoRA 为 R18 内容,仅限 NSFW 专区使用")


class H3T2VRequest(BaseModel):
    """H3 文生视频请求。H3 节点无独立负向输入,negative 仅作快照保留(见 workflows/h3_video)。

    时长:优先 duration_sec(秒,任意值;超单段上限自动分段续写并精确裁切);
    length(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    loras: list[H3LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)
    width: int = Field(default=1344, ge=256, le=1344)
    height: int = Field(default=768, ge=256, le=1344)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    length: int | None = Field(default=None, ge=22, le=362)
    steps: int = Field(default=20, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # RES-2026-08-18:输出分辨率档(1080p/2k/4k)。宽高始终按原生上限(H3≤1344×768)
    # 生成,选档后由超分集群二次放大;空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("resolution_target")
    @classmethod
    def _v_target(cls, v: str | None) -> str | None:
        return validate_resolution_target(v)

    @field_validator("width", "height")
    @classmethod
    def _aligned32(cls, v: int) -> int:
        if v % 32 != 0:
            raise ValueError("宽高必须 32 对齐(H3 分辨率约束)")
        return v

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=32, min_v=256, max_v=1344)

    @field_validator("length")
    @classmethod
    def _frames_grid(cls, v: int | None) -> int | None:
        if v is not None and (v - 5) % 17 != 0:
            raise ValueError("length 必须为 17k+5(H3 帧数网格,如 124/141/362)")
        return v


# 旧默认时长:5s@24fps → 17k+5 网格 124 帧(与历史默认一致)
_DEFAULT_SECONDS = 5.0


def _resolve_plan(req: H3T2VRequest) -> DurationPlan:
    """秒数 → 时长计划(统一策略层);legacy length 换算为等价 direct 计划(行为不变)。"""
    if req.duration_sec is None and req.length is not None:
        return DurationPlan(
            engine="h3", seconds=req.length / 24, fps=24, frames=req.length,
            segment_frames=(req.length,),
        )
    try:
        return resolve_duration("h3", req.duration_sec if req.duration_sec is not None else _DEFAULT_SECONDS, 24)
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


def _route_extend_submit(
    *, client, req: H3T2VRequest, user: User, seed0: int, nsfw: bool,
):
    """extend 续段提交(路由链路:末帧 i2v,段作业登记 kind=h3_extend_i2v 并进作品库)。

    后台链执行时机晚于请求生命周期:闭包只捕获 user_id,回调内以独立会话
    重取 User,避免 DetachedInstanceError(同 ltx25 2026-08-19 修复)。
    """
    owner_id = user.id  # 请求期内取值(安全)
    loras = tuple(LoraSpec(name=l.name, weight=l.strength) for l in req.loras)

    async def _submit(frame_bytes: bytes, frames: int, idx: int) -> str:
        image_name = await client.upload_image(frame_bytes, f"h3_ext_{uuid.uuid4().hex}.jpg")
        p = H3I2VParams(
            positive=req.positive,
            negative=req.negative,
            image=image_name,
            width=req.width,
            height=req.height,
            length=frames,
            steps=req.steps,
            seed=seed0 + idx,
            loras=loras,
            filename_prefix="ToIV_h3/extend",
        )
        graph = build_h3_i2v_graph(p)
        with Session(db_engine) as s2:
            fresh_user = s2.get(User, owner_id) or user
            res = await h3_service.submit_h3_job(
                graph, kind="h3_extend_i2v", positive=p.positive, seed=p.seed,
                req=req, user=fresh_user, session=s2, client=client, nsfw=nsfw,
            )
        return res["prompt_id"]

    return _submit


class H3I2VRequest(H3T2VRequest):
    """H3 图生视频请求:image 为上传句柄文件名,worker 为其落点的 pool worker(防 SSRF)。"""
    image: str = Field(min_length=1, max_length=512)
    worker: str

    @field_validator("image")
    @classmethod
    def _no_traversal(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


# ──────────────────────────────────────────────────────────────
# POST /api/h3/t2v | /api/h3/i2v
# ──────────────────────────────────────────────────────────────

@router.post("/h3/t2v")
async def generate_h3_t2v(
    req: H3T2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """H3 文生视频。实例不可达/缺 H3 节点 → 503(见 services/h3.ensure_h3_ready)。"""
    enforce_generation_rate_limit(user)
    _gate_h3_nsfw_loras(req.loras, user)
    plan = _resolve_plan(req)
    params = H3T2VParams(
        positive=req.positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        length=plan.frames,
        steps=req.steps,
        loras=tuple(LoraSpec(name=l.name, weight=l.strength) for l in req.loras),
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_h3_t2v_graph(params)
    nsfw = nsfw_allowed(user)
    result = await h3_service.submit_h3_job(
        graph, kind="h3_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
        # R18 上下文(X-NSFW 头)打标进 /nsfw 专区作品库;nsfw_allowed 含未成年硬阻断,
        # 与 LTX 门控同一判定来源,主站(无头)恒 False 行为不变
        nsfw=nsfw,
    )
    if plan.strategy != "direct":
        client = await h3_service.pick_h3_client()
        vgen.spawn_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id=result["prompt_id"],
            submit_next=_route_extend_submit(
                client=client, req=req, user=user, seed0=params.seed, nsfw=nsfw,
            ),
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    if req.resolution_target and maybe_chain_upscale(result["prompt_id"], req.resolution_target):
        result["upscale_notice"] = (
            f"按原生上限生成完成后将自动二次超分至 {req.resolution_target.upper()}"
        )
    return result


@router.post("/h3/i2v")
async def generate_h3_i2v(
    req: H3I2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """H3 图生视频。参考图从上传落点 worker 转运到 H3 实例后提交。"""
    enforce_generation_rate_limit(user)
    _gate_h3_nsfw_loras(req.loras, user)
    plan = _resolve_plan(req)
    client = await h3_service.pick_h3_client()
    source = resolve_worker(req.worker)
    image_name = await h3_service.transfer_ref_image(client, source, req.image)
    params = H3I2VParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        width=req.width,
        height=req.height,
        length=plan.frames,
        steps=req.steps,
        loras=tuple(LoraSpec(name=l.name, weight=l.strength) for l in req.loras),
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_h3_i2v_graph(params)
    nsfw = nsfw_allowed(user)
    result = await h3_service.submit_h3_job(
        graph, kind="h3_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw,  # R18 上下文打标(同 t2v)
    )
    if plan.strategy != "direct":
        vgen.spawn_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id=result["prompt_id"],
            submit_next=_route_extend_submit(
                client=client, req=req, user=user, seed0=params.seed, nsfw=nsfw,
            ),
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    if req.resolution_target and maybe_chain_upscale(result["prompt_id"], req.resolution_target):
        result["upscale_notice"] = (
            f"按原生上限生成完成后将自动二次超分至 {req.resolution_target.upper()}"
        )
    return result
