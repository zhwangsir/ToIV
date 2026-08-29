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
from app.services import multishot_protocol as multishot
from app.services import video_generators as vgen
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.services.effect_presets import apply_effect_preset, validate_effect_key
from app.services.h3 import is_h3_nsfw_lora
from app.services.lora_picker import inject_triggers, resolve_submit_loras, snapshot_loras, to_specs
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


def _gate_h3_nsfw_loras(loras: list[H3LoraInput] | None, user: User) -> None:
    """NSFW LoRA 门槛:引用已知 H3 R18 LoRA(services/h3.H3_NSFW_LORAS)时仅
    /nsfw 专页(X-NSFW: 1 header)放行,主站调用一律 403(与 _gate_ltx_nsfw 同风格)。"""
    if loras and any(is_h3_nsfw_lora(lora.name) for lora in loras) and not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="所选 LoRA 为 R18 内容,仅限 NSFW 专区使用")


def _resolve_h3_loras(prompt: str, user: User, loras: list[H3LoraInput] | None):
    """省略=auto / 空列表=off / 非空=pin。返回 (specs, picks, mode, reason, positive)。"""
    raw = None if loras is None else [{"name": l.name, "strength": l.strength} for l in loras]
    try:
        picks, mode, reason = resolve_submit_loras("h3", prompt, nsfw_allowed(user), raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    positive = inject_triggers(prompt, picks)
    return to_specs(picks), picks, mode, reason, positive


class H3T2VRequest(BaseModel):
    """H3 文生视频请求。H3 节点无独立负向输入,negative 仅作快照保留(见 workflows/h3_video)。

    时长:优先 duration_sec(秒,任意值;超单段上限自动分段续写并精确裁切);
    length(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    # None=AI 选配; []=关闭; 非空=钉选(须在策划目录内)
    loras: list[H3LoraInput] | None = Field(default=None, max_length=_MAX_LORAS)
    width: int = Field(default=1344, ge=256, le=1344)
    height: int = Field(default=768, ge=256, le=1344)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    length: int | None = Field(default=None, ge=22, le=362)
    steps: int = Field(default=20, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # 特效预设(Pikaffects 式一键物理特效;静态清单见 services/effect_presets):
    # 选中后后端把特效英文描述确定性拼到 positive 前部,不经过 LLM;未知 key → 422
    effect_preset: str | None = Field(default=None, max_length=64)
    # 主体引用(@主体前台化):全局主体库 Entity id 列表,选中后注入 @图片N 引用行
    # 到 prompt 绝对开头(与 drama 线 h3_refs 同规则);空列表 = 显式清空
    entity_ids: list[str] | None = Field(default=None, max_length=9)  # H3 官方全能参考(Ref2VA)上限 9 图
    # RES-2026-08-18:输出分辨率档(1080p/2k/4k)。宽高始终按原生上限(H3≤1344×768)
    # 生成,选档后由超分集群二次放大;空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("effect_preset")
    @classmethod
    def _v_effect_preset(cls, v: str | None) -> str | None:
        return validate_effect_key(v)

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


def _apply_effect(req: H3T2VRequest) -> H3T2VRequest:
    """特效预设注入层:选中后把特效描述确定性拼到 positive 前部(不经过 LLM)。

    用 model_copy 覆盖 req,使下游(params 构图 / extend 续段闭包 / Job.prompt
    落库 / params 快照)全部同源注入后的提示词,续段与首段特效一致。
    """
    if not req.effect_preset:
        return req
    pos, neg = apply_effect_preset(req.positive, req.negative, req.effect_preset)
    return req.model_copy(update={"positive": pos, "negative": neg})


def _apply_entity_refs(req: H3T2VRequest, session: Session, user: User) -> H3T2VRequest:
    """主体引用注入层:entity_ids → @图片N 引用行拼到 prompt 绝对开头。

    与 drama 线 h3_refs.ref_prefix_for_shot 同规则;entity_ids 为空列表时显式
    清空(不注入);主体不存在/无图跳过(h3_refs 内部处理,不让坏主体拖垮整批)。
    """
    if req.entity_ids is None:
        return req
    if not req.entity_ids:
        return req.model_copy(update={"positive": req.positive})
    from app.services.h3_refs import build_ref_prefix, resolve_entity_refs
    prefix = build_ref_prefix(
        resolve_entity_refs(session, req.entity_ids, owner_id=user.id)
    )
    if not prefix:
        return req
    return req.model_copy(update={"positive": f"{prefix}{req.positive}"})


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
    loras = tuple(LoraSpec(name=l.name, weight=l.strength) for l in (req.loras or []))

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
    req = _apply_effect(req)
    req = _apply_entity_refs(req, session, user)
    plan = _resolve_plan(req)
    specs, picks, lora_mode, lora_reason, positive = _resolve_h3_loras(req.positive, user, req.loras)
    req = req.model_copy(update={
        "positive": positive,
        "loras": [H3LoraInput(name=p.name, strength=max(0.5, min(1.0, p.strength))) for p in picks],
    })
    params = H3T2VParams(
        positive=positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        length=plan.frames,
        steps=req.steps,
        loras=specs,
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
        snapshot_extra={
            "loras": snapshot_loras(picks), "lora_mode": lora_mode, "lora_reason": lora_reason,
        },
    )
    result["loras"] = snapshot_loras(picks)
    result["lora_mode"] = lora_mode
    result["lora_reason"] = lora_reason
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


# ──────────────────────────────────────────────────────────────
# POST /api/h3/multishot —— 多镜头单次生成(「镜头一…镜头二…」单 prompt 协议)
# ──────────────────────────────────────────────────────────────


class H3ShotInput(BaseModel):
    """单镜头规格:prompt 必填;duration_sec 留空 = 参与均分(须全部留空 + 显式 total_duration)。

    camera_hint(推/拉/摇/移/跟/固定)与 transition_hint(硬切/淡入淡出/匹配切口)
    可选,白名单由 services/multishot_protocol 校验;transition 挂在被进入的镜头上。
    """
    prompt: str = Field(min_length=1, max_length=2000)
    duration_sec: float | None = Field(default=None, gt=0, le=multishot.MAX_TOTAL_SEC)
    camera_hint: str | None = Field(default=None, max_length=16)
    transition_hint: str | None = Field(default=None, max_length=16)


class H3MultiShotRequest(BaseModel):
    """H3 多镜头单次生成请求(2-4 个镜头 → 单段视频内按序切镜,总长 ≤15s 单段上限)。

    提交链路与 t2v 完全同源(组装单 prompt 后委托同一 submit_h3_job);
    产物 Job kind=h3_multishot,params 存多镜头计划快照(shots + total_duration)。
    """
    shots: list[H3ShotInput] = Field(min_length=multishot.MIN_SHOTS, max_length=multishot.MAX_SHOTS)
    # 均分模式:全部镜头 duration_sec 留空时必填;自定义模式忽略(总长=各镜头之和)
    total_duration: float | None = Field(default=None, gt=0, le=multishot.MAX_TOTAL_SEC)
    negative: str = Field(default="", max_length=2000)
    loras: list[H3LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)
    width: int = Field(default=1344, ge=256, le=1344)
    height: int = Field(default=768, ge=256, le=1344)
    steps: int = Field(default=20, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    effect_preset: str | None = Field(default=None, max_length=64)
    resolution_target: str | None = Field(default=None, max_length=8)
    # 主体引用(@主体前台化):与 t2v 同一语义,组装后的单 prompt 绝对开头注入
    # @图片N 引用行;空列表 = 显式清空(2026-08-29 B3 补齐:此前 multishot 无此字段)
    entity_ids: list[str] | None = Field(default=None, max_length=9)  # H3 官方全能参考(Ref2VA)上限 9 图

    @field_validator("effect_preset")
    @classmethod
    def _v_effect_preset(cls, v: str | None) -> str | None:
        return validate_effect_key(v)

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

    # 宽高比守卫:9:16~16:9 静默归一(与 t2v 同一约束)
    _ratio = aspect_guard(*AR_VIDEO, align=32, min_v=256, max_v=1344)


@router.post("/h3/multishot")
async def generate_h3_multishot(
    req: H3MultiShotRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """H3 多镜头单次生成:「镜头一…镜头二…」协议组装单 prompt,单段内自动切镜。

    与 drama_studio 分镜线独立(单 prompt 协议 vs 分镜表驱动);与关键帧链正交
    (单段内切镜 vs 多段独立转场拼接)。R18 上下文(X-NSFW 头)打标进 /nsfw 专区。
    """
    enforce_generation_rate_limit(user)
    _gate_h3_nsfw_loras(req.loras, user)
    try:
        ms_plan = multishot.plan_multishot(
            [
                multishot.ShotSpec(
                    prompt=s.prompt,
                    duration_sec=s.duration_sec,
                    camera_hint=s.camera_hint,
                    transition_hint=s.transition_hint,
                )
                for s in req.shots
            ],
            total_duration=req.total_duration,
            width=req.width,
            height=req.height,
            seed=req.seed,
        )
    except multishot.MultiShotError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    # 委托 t2v 提交链路(零改动):组装后的单 prompt 作为 positive,时长=总时长;
    # effect 预设/LoRA/分辨率档/时长策略(trim)/R18 UNET 替换全部继承
    t2v_req = H3T2VRequest(
        positive=ms_plan.to_prompt(),
        negative=req.negative,
        loras=req.loras,
        width=req.width,
        height=req.height,
        duration_sec=ms_plan.total_duration,
        steps=req.steps,
        seed=req.seed,
        effect_preset=req.effect_preset,
        resolution_target=req.resolution_target,
        entity_ids=req.entity_ids,
    )
    t2v_req = _apply_effect(t2v_req)
    # 主体引用注入(与 t2v 同层同序:effect 之后,@图片N 恒在绝对开头)
    t2v_req = _apply_entity_refs(t2v_req, session, user)
    plan = _resolve_plan(t2v_req)
    params = H3T2VParams(
        positive=t2v_req.positive,
        negative=t2v_req.negative,
        width=t2v_req.width,
        height=t2v_req.height,
        length=plan.frames,
        steps=t2v_req.steps,
        loras=tuple(LoraSpec(name=l.name, weight=l.strength) for l in t2v_req.loras),
        **({"seed": t2v_req.seed} if t2v_req.seed is not None else {}),
    )
    graph = build_h3_t2v_graph(params)
    nsfw = nsfw_allowed(user)
    result = await h3_service.submit_h3_job(
        graph, kind="h3_multishot", positive=params.positive, seed=params.seed,
        # params 快照存多镜头计划(shots + total_duration,精确重生的事实源)
        req=req, user=user, session=session,
        nsfw=nsfw,  # R18 上下文打标(同 t2v)
    )
    # 多镜头总长 ≤15s 单段上限,策略仅 direct/trim(不触发 extend,无需续段回调)
    if plan.strategy != "direct":
        client = await h3_service.pick_h3_client()
        vgen.spawn_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id=result["prompt_id"],
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    if req.resolution_target and maybe_chain_upscale(result["prompt_id"], req.resolution_target):
        result["upscale_notice"] = (
            f"按原生上限生成完成后将自动二次超分至 {req.resolution_target.upper()}"
        )
    result["multishot"] = ms_plan.to_params()
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
    req = _apply_effect(req)
    req = _apply_entity_refs(req, session, user)
    plan = _resolve_plan(req)
    specs, picks, lora_mode, lora_reason, positive = _resolve_h3_loras(req.positive, user, req.loras)
    req = req.model_copy(update={
        "positive": positive,
        "loras": [H3LoraInput(name=p.name, strength=max(0.5, min(1.0, p.strength))) for p in picks],
    })
    client = await h3_service.pick_h3_client()
    source = resolve_worker(req.worker)
    image_name = await h3_service.transfer_ref_image(client, source, req.image)
    params = H3I2VParams(
        positive=positive,
        negative=req.negative,
        image=image_name,
        width=req.width,
        height=req.height,
        length=plan.frames,
        steps=req.steps,
        loras=specs,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_h3_i2v_graph(params)
    nsfw = nsfw_allowed(user)
    result = await h3_service.submit_h3_job(
        graph, kind="h3_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw,  # R18 上下文打标(同 t2v)
        snapshot_extra={
            "loras": snapshot_loras(picks), "lora_mode": lora_mode, "lora_reason": lora_reason,
        },
    )
    result["loras"] = snapshot_loras(picks)
    result["lora_mode"] = lora_mode
    result["lora_reason"] = lora_reason
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
