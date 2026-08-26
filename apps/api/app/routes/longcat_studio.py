"""LongCat-Video 工作室 —— 长视频生成(t2v / i2v / 视频续写),专用 ComfyUI 实例(TOIV_LONGCAT_BASE_URL)。

POST /api/longcat/t2v      —— 文生视频(长镜头:961 帧@16fps≈60s;蒸馏 LoRA 低步数出片)
POST /api/longcat/i2v      —— 图生视频(首帧参考图;先经 /api/upload 上传到 pool worker,
                              提交时由后端转运到 LongCat 实例 input 目录,同 h3/i2v 模式)
POST /api/longcat/continue —— 视频续写(源视频 = /api/images? 产物 URL 或上传视频文件名;
                              后端 ffmpeg 抽末帧作 i2v 首帧续写下一段,同 drama continue-video 模式)

与 LTX2/H3 工作室的区别:LongCat 走 GPU0 独立实例(默认 workstation :8197,
不走 WorkerPool 集群);产物链路(tracker 落库 + /api/images 代理进作品库)与 h3/ltx2 同路。
参数约束(参考 scripts/e2e/longcat_smoke.py 真机实测):
  · 时长按秒选择(duration_sec,任意值;内部经统一策略层 services/duration 换算,
    网格/下限吸附后秒差大时生成后精确裁切);num_frames(帧数)为 deprecated 兼容入参
  · 帧数 17-961(旧默认 121 ≈ 7.5s@16fps);宽/高 320-1280,16 对齐(非对齐自动向下取整)
  · steps 1-50(默认 10,蒸馏 LoRA 低步数);fps 8-30(仅影响打包帧率)
  · num_frames > 241 时 builder 自动开上下文窗口(81/overlap16)+ 块交换 30(三种模式统一)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.services import longcat as longcat_service
from app.services import video_generators as vgen
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.services.video_upscale import maybe_chain_upscale
from app.workflows.video_upscale import validate_resolution_target
from app.workflows.longcat_video import (
    LongCatI2VParams,
    LongCatT2VParams,
    build_longcat_i2v_graph,
    build_longcat_t2v_graph,
)

router = APIRouter()


def _clamp16(v: int, lo: int = 320, hi: int = 1280) -> int:
    """16 对齐 + 区间夹取(续写源视频实测分辨率对齐用)。"""
    return max(lo, min(hi, v // 16 * 16))


class LongCatT2VRequest(BaseModel):
    """LongCat 文生视频请求。宽/高非 16 对齐时向下取整(而非 422,对齐 VHS 打包容忍度)。

    时长:优先 duration_sec(秒,任意值;下限 17 帧吸附后秒差大时生成后精确裁切);
    num_frames(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    num_frames: int | None = Field(default=None, ge=17, le=961)
    steps: int = Field(default=10, ge=1, le=50)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # RES-2026-08-18:输出分辨率档(1080p/2k/4k);空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("resolution_target")
    @classmethod
    def _v_target(cls, v: str | None) -> str | None:
        return validate_resolution_target(v)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


class LongCatI2VRequest(LongCatT2VRequest):
    """LongCat 图生视频请求:image 为上传句柄文件名,worker 为其落点的 pool worker(防 SSRF)。"""
    image: str = Field(min_length=1, max_length=512)
    worker: str

    @field_validator("image")
    @classmethod
    def _no_traversal(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


class LongCatContinueRequest(BaseModel):
    """LongCat 视频续写请求:video 为 /api/images? 产物 URL 或上传视频文件名(后者需 worker)。

    width/height/fps 缺省 None = 向源视频实测值对齐(ffprobe,同 drama continue-video
    原则:下一段参数与源视频一致);显式传值则按显式值(宽高 16 对齐向下取整)。
    """
    video: str = Field(min_length=1, max_length=1000)
    worker: str | None = Field(default=None, max_length=512)
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    width: int | None = Field(default=None, ge=320, le=1280)
    height: int | None = Field(default=None, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    num_frames: int | None = Field(default=None, ge=17, le=961)
    steps: int = Field(default=10, ge=1, le=50)
    fps: int | None = Field(default=None, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # RES-2026-08-18:输出分辨率档(引擎参数表与 t2v/i2v 同源,此处同步支持);空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("resolution_target")
    @classmethod
    def _v_target(cls, v: str | None) -> str | None:
        return validate_resolution_target(v)

    @field_validator("width", "height")
    @classmethod
    def _snap16_opt(cls, v: int | None) -> int | None:
        return v if v is None else v // 16 * 16

    # 宽高比守卫(仅双值齐给时生效;缺省走源视频对齐)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


# 旧默认时长:121 帧@16fps≈7.56s → 7.5s(与历史默认等价取整)
_DEFAULT_SECONDS = 7.5


def _resolve_plan(
    req: LongCatT2VRequest | LongCatContinueRequest, *, fps: int
) -> DurationPlan:
    """秒数 → 时长计划(统一策略层);legacy num_frames 换算为等价 direct 计划(行为不变)。"""
    if req.duration_sec is None and req.num_frames is not None:
        return DurationPlan(
            engine="longcat", seconds=req.num_frames / fps, fps=fps,
            frames=req.num_frames, segment_frames=(req.num_frames,),
        )
    try:
        return resolve_duration(
            "longcat",
            req.duration_sec if req.duration_sec is not None else _DEFAULT_SECONDS,
            fps,
        )
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


def _attach_duration_chain(
    result: dict,
    plan: DurationPlan,
    get_client,
    resolution_target: str | None = None,
) -> dict:
    """非 direct 计划(trim)挂后台后处理链;notice 透出为 duration_notice。

    get_client 惰性调用:仅非 direct 时才取实例客户端(引擎禁用时 submit 已先 503,
    不额外创建客户端,保持 t2v 路由原有顺序语义)。
    resolution_target(RES-2026-08-18):非空时挂融合超分链(等生成+时长链终态后
    自动二次超分);notice 透出为 upscale_notice。
    """
    if plan.strategy != "direct":
        vgen.spawn_duration_chain(
            client=get_client(),
            plan=plan,
            first_prompt_id=result["prompt_id"],
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    if resolution_target and maybe_chain_upscale(result["prompt_id"], resolution_target):
        result["upscale_notice"] = (
            f"原生生成完成后将自动二次超分至 {resolution_target.upper()}"
        )
    return result


@router.post("/longcat/t2v")
async def generate_longcat_t2v(
    req: LongCatT2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LongCat 文生视频。实例不可达/缺 WanVideo 节点 → 503(见 services/longcat.ensure_longcat_ready)。"""
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req, fps=req.fps)
    params = LongCatT2VParams(
        positive=req.positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_longcat_t2v_graph(params)
    # 不显式预取 client:引擎禁用时 submit 内部 ensure 先 503(保持原有顺序语义)
    result = await longcat_service.submit_longcat_job(
        graph, kind="longcat_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
        # R18 上下文(X-NSFW 头)打标进 /nsfw 专区作品库;nsfw_allowed 含未成年硬阻断,
        # 与 LTX 门控同一判定来源,主站(无头)恒 False 行为不变
        nsfw=nsfw_allowed(user),
    )
    return _attach_duration_chain(
        result, plan, longcat_service.get_longcat_client, req.resolution_target
    )


@router.post("/longcat/i2v")
async def generate_longcat_i2v(
    req: LongCatI2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LongCat 图生视频。参考图从上传落点 worker 转运到 LongCat 实例后提交(同 h3/i2v 模式)。"""
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req, fps=req.fps)
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    image_name = await longcat_service.transfer_ref_image(client, source, req.image)
    params = LongCatI2VParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_longcat_i2v_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="longcat_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),  # R18 上下文打标(同 t2v)
    )
    return _attach_duration_chain(
        result, plan, lambda: client, req.resolution_target
    )


@router.post("/longcat/continue")
async def generate_longcat_continue(
    req: LongCatContinueRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LongCat 视频续写:源视频抽末帧作 i2v 首帧;分辨率/帧率缺省向源视频实测对齐。"""
    enforce_generation_rate_limit(user)
    client = longcat_service.get_longcat_client()
    frame_name, meta = await longcat_service.prepare_continue_first_frame(
        client, req.video, req.worker
    )
    src_w, src_h, src_fps = meta if meta else (832, 480, 16)
    width = req.width if req.width is not None else _clamp16(src_w)
    height = req.height if req.height is not None else _clamp16(src_h)
    fps = req.fps if req.fps is not None else max(8, min(30, src_fps))
    plan = _resolve_plan(req, fps=fps)
    params = LongCatI2VParams(
        positive=req.positive,
        negative=req.negative,
        image=frame_name,
        width=width,
        height=height,
        num_frames=plan.frames,
        steps=req.steps,
        fps=fps,
        filename_prefix="ToIV_longcat/continue",
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_longcat_i2v_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="longcat_continue", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),  # R18 上下文打标(同 t2v)
    )
    return _attach_duration_chain(
        result, plan, lambda: client, req.resolution_target
    )
