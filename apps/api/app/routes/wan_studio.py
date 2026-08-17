"""Wan 工作室 —— Wan2.2-Animate 动作迁移 + Wan2.1-VACE 多参考图视频(GPU2 :8197,与 LongCat 同实例)。

POST /api/wan/animate —— 参考图角色 + 驱动视频 → 动作迁移视频(先经 /api/upload 上传
                        kind=wan_animate,提交时由后端转运到 :8197 实例 input 目录)
POST /api/wan/vace    —— 多参考图(1-4 张,+可选首尾帧)→ 视频(kind=wan_vace 同上)

参数约束(参考官方示例真机节点参数):
  · 时长按秒选择(duration_sec,任意值;内部经统一策略层 services/duration 换算,
    4k+1 网格吸附后秒差大时生成后精确裁切);num_frames(帧数)为 deprecated 兼容入参
  · 帧数 17-501(Animate,旧默认 121 ≈ 7.5s@16fps)/ 17-241(VACE,旧默认 81 ≈ 5s@16fps),
    自动取整 4k+1(WanVideo 系时序网格)
  · 宽/高 320-1280,16 对齐(非对齐自动向下取整,与 longcat 同一惯例)
  · 提交前 GPU2 显存互斥预检(ensure_wan_vram):H3 突发占卡时 503 错峰
产物链路(tracker 落库 + /api/images 代理进作品库)与 longcat/h3/ltx2 同路。
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
from app.services import wan_video as wan_service
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.workflows.wan_animate import (
    DEFAULT_RELIGHT_LORA,
    WanAnimateParams,
    build_wan_animate_graph,
)
from app.workflows.wan_vace import MAX_REF_IMAGES, WanVaceParams, build_wan_vace_graph

router = APIRouter()


def _no_traversal(v: str) -> str:
    name = v.strip().replace("\\", "/")
    if ".." in name or name.startswith("/"):
        raise ValueError("文件名不允许路径穿越")
    return name


# 旧默认时长:Animate 121 帧 / VACE 81 帧 @16fps(4k+1 网格吸附后与历史默认一致)
_DEFAULT_SECONDS = {"animate": 7.5, "vace": 5.0}


def _resolve_plan(req: "WanAnimateRequest | WanVaceRequest", engine: str) -> DurationPlan:
    """秒数 → 时长计划(统一策略层);legacy num_frames 换算为等价 direct 计划(行为不变)。"""
    if req.duration_sec is None and req.num_frames is not None:
        return DurationPlan(
            engine=engine, seconds=req.num_frames / req.fps, fps=req.fps,
            frames=req.num_frames, segment_frames=(req.num_frames,),
        )
    try:
        return resolve_duration(
            engine,
            req.duration_sec if req.duration_sec is not None else _DEFAULT_SECONDS[engine],
            req.fps,
        )
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


def _attach_duration_chain(result: dict, plan: DurationPlan, get_client) -> dict:
    """非 direct 计划(trim)挂后台后处理链;notice 透出为 duration_notice。

    get_client 惰性调用:仅非 direct 时才取实例客户端(与 longcat_studio 同一模式)。
    """
    if plan.strategy != "direct":
        vgen.spawn_duration_chain(
            client=get_client(),
            plan=plan,
            first_prompt_id=result["prompt_id"],
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    return result


class WanAnimateRequest(BaseModel):
    """Wan2.2-Animate 动作迁移请求。image=参考图,video=驱动视频(均为上传句柄文件名,
    与 worker 指定的落点同机);宽/高非 16 对齐时向下取整。

    时长:优先 duration_sec(秒,任意值;4k+1 网格吸附后秒差大时生成后精确裁切);
    num_frames(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=4000)
    image: str = Field(min_length=1, max_length=512)
    video: str = Field(min_length=1, max_length=512)
    worker: str
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    num_frames: int | None = Field(default=None, ge=17, le=501)
    steps: int = Field(default=6, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    shift: float = Field(default=5.0, ge=0.0, le=20.0)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    relight_lora: bool = Field(default=False)  # Replacement 换背景模式才需要重打光

    _img_ok = field_validator("image", "video")(_no_traversal)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


class WanVaceRequest(BaseModel):
    """Wan2.1-VACE 多参考图请求。images=1-4 张参考图(与 worker 指定的落点同机,前端互钉);
    start_image/end_image 可选首尾帧(同机)。

    时长:优先 duration_sec(秒,任意值;4k+1 网格吸附后秒差大时生成后精确裁切);
    num_frames(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=4000)
    images: list[str] = Field(min_length=1, max_length=MAX_REF_IMAGES)
    worker: str
    start_image: str = Field(default="", max_length=512)
    end_image: str = Field(default="", max_length=512)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    num_frames: int | None = Field(default=None, ge=17, le=241)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=5.0, ge=0.0, le=20.0)
    shift: float = Field(default=8.0, ge=0.0, le=20.0)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    _imgs_ok = field_validator("images", "start_image", "end_image", mode="before")(
        lambda v: [_no_traversal(x) for x in v] if isinstance(v, list) else _no_traversal(v))

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


@router.post("/wan/animate")
async def generate_wan_animate(
    req: WanAnimateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Wan2.2-Animate 动作迁移:参考图角色按驱动视频动作生成视频。

    参考图/驱动视频从上传落点 worker 转运到 :8197 实例;提交前 GPU2 显存互斥预检
    (H3 突发占卡 → 503 错峰,见 services/wan_video.ensure_wan_vram)。
    """
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req, "animate")
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    image_name = await longcat_service.transfer_ref_image(client, source, req.image)
    video_name = await wan_service.transfer_drive_video(client, source, req.video)
    await wan_service.ensure_wan_vram(client)
    params = WanAnimateParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        video=video_name,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        cfg=req.cfg,
        shift=req.shift,
        fps=req.fps,
        relight_lora=DEFAULT_RELIGHT_LORA if req.relight_lora else "",
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_animate_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="wan_animate", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),
    )
    return _attach_duration_chain(result, plan, lambda: client)


@router.post("/wan/vace")
async def generate_wan_vace(
    req: WanVaceRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Wan2.1-VACE 多参考图视频:1-4 张参考图(+可选首尾帧)→ 视频。

    参考图从上传落点 worker 转运到 :8197 实例;提交前 GPU2 显存互斥预检(同 animate)。
    """
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req, "vace")
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    ref_names = [
        await longcat_service.transfer_ref_image(client, source, name) for name in req.images
    ]
    start_name = (
        await longcat_service.transfer_ref_image(client, source, req.start_image)
        if req.start_image else ""
    )
    end_name = (
        await longcat_service.transfer_ref_image(client, source, req.end_image)
        if req.end_image else ""
    )
    await wan_service.ensure_wan_vram(client)
    params = WanVaceParams(
        positive=req.positive,
        negative=req.negative,
        ref_images=tuple(ref_names),
        start_image=start_name,
        end_image=end_name,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        cfg=req.cfg,
        shift=req.shift,
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_vace_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="wan_vace", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),
    )
    return _attach_duration_chain(result, plan, lambda: client)
