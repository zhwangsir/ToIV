"""Wan 工作室 —— Wan2.2-Animate 动作迁移 + Wan2.1-VACE 多参考图视频(GPU2 :8197,与 LongCat 同实例)。

POST /api/wan/animate —— 参考图角色 + 驱动视频 → 动作迁移视频(先经 /api/upload 上传
                        kind=wan_animate,提交时由后端转运到 :8197 实例 input 目录)
POST /api/wan/vace    —— 多参考图(1-4 张,+可选首尾帧)→ 视频(kind=wan_vace 同上)
POST /api/generate/transition —— 首尾帧转场(首帧+尾帧 → 过渡视频,kind=transition;
                        复用 VACE 工作流,首帧兼作参考图;路由挂 /generate 前缀对齐竞品语义入口)
POST /api/generate/video-edit —— VACE 视频到视频编辑(Runway Aleph 式 in-context:
                        源视频+编辑指令 → 对象增删换/重打光/换风格/换机位,kind=video_edit;
                        可选 ≤5 关键帧锚点(整帧保留,内容向全片传播)与区域保留 mask)

参数约束(参考官方示例真机节点参数):
  · 时长按秒选择(duration_sec,任意值;内部经统一策略层 services/duration 换算,
    4k+1 网格吸附后秒差大时生成后精确裁切);num_frames(帧数)为 deprecated 兼容入参
  · 帧数 17-501(Animate,旧默认 121 ≈ 7.5s@16fps)/ 17-241(VACE,旧默认 81 ≈ 5s@16fps),
    自动取整 4k+1(WanVideo 系时序网格)
  · 宽/高 320-1280,16 对齐(非对齐自动向下取整,与 longcat 同一惯例)
  · 提交前 GPU2 显存互斥预检(ensure_wan_vram):H3 突发占卡时转 hold 排队
    (资源释放后自动放行;hold 开关关闭则维持 503 错峰,见 services/hold_queue)
产物链路(tracker 落库 + /api/images 代理进作品库)与 longcat/h3/ltx2 同路。
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.services import keyframe_chain as keychain_service
from app.services import longcat as longcat_service
from app.services import hold_queue
from app.services import video_generators as vgen
from app.services import wan_animate2 as animate2_service
from app.services import wan_video as wan_service
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.services.keyframe_chain import KeyframeChainError
from app.workflows.wan_animate import (
    DEFAULT_RELIGHT_LORA,
    WanAnimateParams,
    build_wan_animate_graph,
)
from app.workflows.wan_animate2 import WanAnimate2Params, build_wan_animate2_graph
from app.workflows.wan_vace import (
    ACCEL_MODES,
    EDIT_MODES,
    MAX_KEYFRAMES,
    MAX_REF_IMAGES,
    WanVaceEditParams,
    WanVaceParams,
    build_wan_vace_edit_graph,
    build_wan_vace_graph,
)

router = APIRouter()


def _no_traversal(v: str) -> str:
    name = v.strip().replace("\\", "/")
    if ".." in name or name.startswith("/"):
        raise ValueError("文件名不允许路径穿越")
    return name


async def _wan_precheck_or_hold(client) -> HTTPException | None:
    """GPU2 显存/RAM 互斥预检(资源预算二期改造点)。

    通过 → None;不足且 hold 开关开 → 返回 503 异常对象,由 submit_longcat_job
    转 hold 排队(engine=wan);开关关 → 维持一期行为原样抛 503。
    """
    try:
        await wan_service.ensure_wan_vram(client)
    except HTTPException as e:
        if hold_queue.holdable(e):
            return e
        raise
    return None


# 旧默认时长:Animate 121 帧 / VACE 81 帧 @16fps(4k+1 网格吸附后与历史默认一致)
_DEFAULT_SECONDS = {"animate": 7.5, "vace": 5.0, "animate2": 7.5}


def _resolve_plan(req: "WanAnimateRequest | WanVaceRequest | WanAnimate2Request", engine: str) -> DurationPlan:
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
    # Motion Brush 局部动效 mask(POST /api/motion-brush/mask 产物文件名,同 worker 落点):
    # 灰度 0=静止/255=运动,接 VACEEncode.input_masks;与首尾帧同给时取交集(两约束并存)
    motion_mask: str = Field(default="", max_length=512)
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
    # 加速档(2026-08-28 Phase 2B):off=满血(默认) / magcache=MagCache 缓存加速
    accel: str = Field(default="off", max_length=16)

    @field_validator("accel")
    @classmethod
    def _accel_ok(cls, v: str) -> str:
        if v not in ACCEL_MODES:
            raise ValueError(f"accel 仅支持 {'/'.join(ACCEL_MODES)}")
        return v

    _imgs_ok = field_validator("images", "start_image", "end_image", "motion_mask", mode="before")(
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
    hold_exc = await _wan_precheck_or_hold(client)
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
        prechecked=True,  # 上方 _wan_precheck_or_hold 已做显存+RAM 预检(Wan 阈值独立)
        hold_exc=hold_exc,  # 预检失败转 hold 排队(None=预检通过,正常提交)
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
    # Motion Brush mask 与参考图同路转运(同 worker 落点,PNG 与图片同通道)
    mask_name = (
        await longcat_service.transfer_ref_image(client, source, req.motion_mask)
        if req.motion_mask else ""
    )
    hold_exc = await _wan_precheck_or_hold(client)
    params = WanVaceParams(
        positive=req.positive,
        negative=req.negative,
        ref_images=tuple(ref_names),
        start_image=start_name,
        end_image=end_name,
        motion_mask=mask_name,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        cfg=req.cfg,
        shift=req.shift,
        fps=req.fps,
        accel=req.accel,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_vace_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="wan_vace", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),
        prechecked=True,  # 上方 _wan_precheck_or_hold 已做显存+RAM 预检(Wan 阈值独立)
        hold_exc=hold_exc,  # 预检失败转 hold 排队(None=预检通过,正常提交)
    )
    return _attach_duration_chain(result, plan, lambda: client)


class TransitionRequest(BaseModel):
    """首尾帧转场请求(Wan2.1-VACE,:8197)。first_frame/last_frame 为上传句柄文件名
    (与 worker 指定的落点同机,前端互钉);VACE 链路要求至少 1 张参考图,
    首帧兼作 ref_images 锚点(start/end 帧支路同时生效)。

    时长:优先 duration_sec(秒,任意值;4k+1 网格吸附后秒差大时生成后精确裁切);
    num_frames(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(min_length=1, max_length=4000)
    first_frame: str = Field(min_length=1, max_length=512)
    last_frame: str = Field(min_length=1, max_length=512)
    worker: str
    # Motion Brush 局部动效 mask(同 VACE;与首尾帧 masks 经 MaskComposite 取交集并存)
    motion_mask: str = Field(default="", max_length=512)
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

    _frames_ok = field_validator("first_frame", "last_frame", "motion_mask")(_no_traversal)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


@router.post("/generate/transition")
async def generate_transition(
    req: TransitionRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """首尾帧转场:首帧 + 尾帧 → 中间过渡视频(对标即梦/PixVerse 首尾帧卖点)。

    两帧从上传落点 worker 转运到 :8197 实例(qwen_edit 同款服务端转存);
    复用 VACE 工作流(首帧兼作参考图锚点);提交前 GPU2 显存互斥预检(同 vace)。
    """
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req, "vace")
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    first_name = await longcat_service.transfer_ref_image(client, source, req.first_frame)
    last_name = await longcat_service.transfer_ref_image(client, source, req.last_frame)
    # Motion Brush mask 与首尾帧同路转运(同 worker 落点)
    mask_name = (
        await longcat_service.transfer_ref_image(client, source, req.motion_mask)
        if req.motion_mask else ""
    )
    hold_exc = await _wan_precheck_or_hold(client)
    params = WanVaceParams(
        positive=req.positive,
        negative=req.negative,
        ref_images=(first_name,),  # VACE 至少 1 张参考图:首帧兼作条件锚点
        start_image=first_name,
        end_image=last_name,
        motion_mask=mask_name,
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
        graph, kind="transition", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),
        prechecked=True,  # 上方 _wan_precheck_or_hold 已做显存+RAM 预检(Wan 阈值独立)
        hold_exc=hold_exc,  # 预检失败转 hold 排队(None=预检通过,正常提交)
    )
    return _attach_duration_chain(result, plan, lambda: client)


class KeyframeChainRequest(BaseModel):
    """关键帧链式转场请求(2-5 张关键帧 → N-1 段首尾帧转场 → 拼接整条视频,:8197)。

    keyframes 为上传句柄文件名(与 worker 指定的落点同机,前端互钉),按链序排列;
    prompts 单 string 全段共用 / list[str] 逐段(数量须=N-1);durations 缺省每段
    5s 均分,显式给出时逐段 1-10s 且总长 ≤25s(校验细节见 services/keyframe_chain)。
    motion_mask 为可选 Motion Brush 局部动效 mask(与参考图同路转运到 :8197),
    各段统一应用(段 i 与段 i+1 共享同一运动区域标记)。
    """
    keyframes: list[str] = Field(min_length=2, max_length=5)
    prompts: str | list[str]
    worker: str
    durations: list[float] | None = Field(default=None)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=5.0, ge=0.0, le=20.0)
    shift: float = Field(default=8.0, ge=0.0, le=20.0)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    motion_mask: str = Field(default="", max_length=512)

    _frames_ok = field_validator("keyframes", "motion_mask", mode="before")(
        lambda v: [_no_traversal(x) for x in v] if isinstance(v, list) else (_no_traversal(v) if v else v))

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


@router.post("/generate/keyframe-chain")
async def generate_keyframe_chain(
    req: KeyframeChainRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """关键帧链式转场(对标 Pika 2.5 Pikaframes):2-5 张关键帧逐段转场并拼接。

    关键帧从上传落点 worker 转运到 :8197 实例(每张一次,相邻段共享衔接帧);
    各段复用 transition 提交链路(段 Job kind=transition 各自保留,便于调试);
    合并 Job(kind=keyframe_chain)由后台拼接链在各段完成后 ffmpeg concat 出整条成片
    (api 重启由 keyframe_chain.reconcile_interrupted 按 params 快照重挂)。
    提交前 GPU2 显存互斥预检(整链一次):不足时各段转 hold 排队,资源释放后 FIFO 放行。
    """
    enforce_generation_rate_limit(user)
    try:
        plan = keychain_service.plan_keyframe_chain(
            req.keyframes, req.prompts, req.durations,
            fps=req.fps, width=req.width, height=req.height,
            steps=req.steps, cfg=req.cfg, seed=req.seed,
        )
    except KeyframeChainError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    # 关键帧全部转运到 :8197(每张一次;相邻段共享衔接帧,不重复转运)
    names = [
        await longcat_service.transfer_ref_image(client, source, kf) for kf in req.keyframes
    ]
    # Motion Brush mask 同路转运(可选;各段统一应用同一运动区域标记)
    mask_name = (
        await longcat_service.transfer_ref_image(client, source, req.motion_mask)
        if req.motion_mask else ""
    )
    hold_exc = await _wan_precheck_or_hold(client)
    nsfw = nsfw_allowed(user)
    seg_prompt_ids: list[str] = []
    for i, seg in enumerate(plan.segments):
        params = WanVaceParams(
            positive=seg.prompt,
            negative=req.negative,
            ref_images=(names[i],),  # 与 transition 同:VACE 至少 1 张参考图,首帧兼作锚点
            start_image=names[i],
            end_image=names[i + 1],
            width=plan.width,
            height=plan.height,
            num_frames=seg.frames,
            steps=seg.steps,
            cfg=seg.cfg,
            shift=req.shift,
            fps=plan.fps,
            motion_mask=mask_name,
            **({"seed": seg.seed} if seg.seed is not None else {}),
        )
        graph = build_wan_vace_graph(params)
        # 段 Job params 按等价 transition 请求建档(支撑精确重生/锁 seed 微调)
        seg_req = TransitionRequest(
            positive=seg.prompt,
            first_frame=seg.first_frame,
            last_frame=seg.last_frame,
            worker=req.worker,
            negative=req.negative,
            width=plan.width,
            height=plan.height,
            duration_sec=seg.duration_sec,
            steps=seg.steps,
            cfg=seg.cfg,
            shift=req.shift,
            fps=plan.fps,
            seed=seg.seed,
            motion_mask=req.motion_mask,  # 段 Job params 快照(精确重生用)
        )
        result = await longcat_service.submit_longcat_job(
            graph, kind="transition", positive=params.positive, seed=params.seed,
            req=seg_req, user=user, session=session, client=client,
            nsfw=nsfw,
            prechecked=True,  # 上方 _wan_precheck_or_hold 已做显存+RAM 预检(整链一次)
            hold_exc=hold_exc,  # 预检失败各段均转 hold 排队(None=预检通过,正常提交)
        )
        seg_prompt_ids.append(result["prompt_id"])
    # 合并 Job:params 存完整链计划 + 段 prompt_id(拼接链/重启重挂的事实源)
    merged_prompt_id = f"chain-{uuid.uuid4().hex[:16]}"
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=merged_prompt_id,
            worker=client.base_url,
            kind="keyframe_chain",
            status="queued",
            prompt=" → ".join(dict.fromkeys(s.prompt for s in plan.segments)),
            seed=plan.seed if plan.seed is not None else 0,
            nsfw=nsfw,
            params=json.dumps(
                {
                    **plan.to_params(),
                    "keyframes": req.keyframes,
                    "segment_prompt_ids": seg_prompt_ids,
                    "worker": req.worker,
                },
                ensure_ascii=False,
            ),
        )
    )
    session.commit()
    keychain_service.spawn_keyframe_chain_merge(
        client=client,
        prompt_ids=seg_prompt_ids,
        seconds=plan.total_duration,
        merged_prompt_id=merged_prompt_id,
    )
    return {
        "prompt_id": merged_prompt_id,
        "worker": client.base_url,
        "seed": plan.seed,
        "segments": seg_prompt_ids,
        "total_duration": plan.total_duration,
        **(
            {"held": True, "hold_reason": str(hold_exc.detail)}
            if hold_exc is not None
            else {}
        ),
    }


class WanVaceEditRequest(BaseModel):
    """VACE 视频到视频编辑请求(Runway Aleph 式 in-context 编辑)。

    source_video 为上传句柄文件名(与 worker 指定的落点同机,前端互钉;≤10s);
    edit_prompt 为英文编辑指令(只描述要改的内容);keyframe_indices 可选编辑锚点
    (0 基帧索引,≤5,越界 422);preserve_mask 可选区域保留 mask(同机,白色区域保留,
    与 Motion Brush 集成预留)。宽/高非 16 对齐时向下取整。时长上限 10s(编辑链路
    全帧上下文,比生成链路显存压力大)。
    """
    source_video: str = Field(min_length=1, max_length=512)
    edit_prompt: str = Field(min_length=1, max_length=4000)
    edit_mode: str = Field(default="style_transfer")
    worker: str
    keyframe_indices: list[int] | None = Field(default=None, max_length=MAX_KEYFRAMES)
    preserve_mask: str = Field(default="", max_length=512)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=10)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=5.0, ge=0.0, le=20.0)
    shift: float = Field(default=8.0, ge=0.0, le=20.0)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # 加速档(2026-08-28 Phase 2B):off=满血(默认) / magcache=MagCache 缓存加速
    accel: str = Field(default="off", max_length=16)

    @field_validator("accel")
    @classmethod
    def _accel_ok(cls, v: str) -> str:
        if v not in ACCEL_MODES:
            raise ValueError(f"accel 仅支持 {'/'.join(ACCEL_MODES)}")
        return v

    _media_ok = field_validator("source_video", "preserve_mask")(_no_traversal)

    @field_validator("edit_mode")
    @classmethod
    def _mode_ok(cls, v: str) -> str:
        if v not in EDIT_MODES:
            raise ValueError(f"edit_mode 仅支持 {'/'.join(EDIT_MODES)}")
        return v

    @field_validator("keyframe_indices")
    @classmethod
    def _kfs_ok(cls, v: list[int] | None) -> list[int] | None:
        if v is None:
            return v
        if any(isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in v):
            raise ValueError("keyframe_indices 须为非负整数帧索引")
        return v

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


@router.post("/generate/video-edit")
async def generate_video_edit(
    req: WanVaceEditRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """VACE 视频到视频编辑(Runway Aleph 式 in-context):源视频 + 编辑指令 → 编辑后视频。

    源视频/区域 mask 从上传落点 worker 转运到 :8197 实例(transfer_drive_video
    同 animate 驱动视频通道,无音轨素材自动补静音轨);关键帧锚点(≤5)整帧保留,
    其余帧按 edit_prompt 重生成并向锚点传播;提交前 GPU2 显存互斥预检(同 vace)。
    """
    enforce_generation_rate_limit(user)
    try:
        plan = resolve_duration(
            "vace",
            req.duration_sec if req.duration_sec is not None else _DEFAULT_SECONDS["vace"],
            req.fps,
        )
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    kfs = tuple(req.keyframe_indices or ())
    if kfs and max(kfs) >= plan.frames:
        raise HTTPException(
            status_code=422,
            detail=f"关键帧索引越界(输出共 {plan.frames} 帧,索引须 ≤ {plan.frames - 1})",
        )
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    video_name = await wan_service.transfer_drive_video(client, source, req.source_video)
    mask_name = (
        await longcat_service.transfer_ref_image(client, source, req.preserve_mask)
        if req.preserve_mask else ""
    )
    hold_exc = await _wan_precheck_or_hold(client)
    params = WanVaceEditParams(
        positive=req.edit_prompt,
        ref_images=(),  # 编辑链路不走参考图支路(条件全部来自源视频帧)
        negative=req.negative,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        cfg=req.cfg,
        shift=req.shift,
        fps=req.fps,
        source_video=video_name,
        edit_prompt=req.edit_prompt,
        edit_mode=req.edit_mode,
        keyframe_indices=kfs,
        preserve_mask=mask_name,
        accel=req.accel,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_vace_edit_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="video_edit", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),
        prechecked=True,  # 上方 _wan_precheck_or_hold 已做显存+RAM 预检(Wan 阈值独立)
        hold_exc=hold_exc,  # 预检失败转 hold 排队(None=预检通过,正常提交)
    )
    return _attach_duration_chain(result, plan, lambda: client)


# --------------------------------------------------------------------------- #
# Wan-Animate-2(原生节点 :8199,与 v1 wrapper 路线完全独立)
# --------------------------------------------------------------------------- #


async def _animate2_precheck_or_hold(client) -> HTTPException | None:
    """GPU3 显存/RAM 互斥预检(与 FlashTalk 共卡;语义同 _wan_precheck_or_hold)。"""
    try:
        await animate2_service.ensure_animate2_vram(client)
    except HTTPException as e:
        if hold_queue.holdable(e):
            return e
        raise
    return None


class WanAnimate2Request(BaseModel):
    """Wan-Animate-2 动作迁移/视频换人请求。image=参考图,video=驱动视频(均为上传句柄
    文件名,与 worker 指定的落点同机);宽/高非 16 对齐时向下取整。

    positive 可留空:官方要求 prompt 只描述参考图「外观+背景」、不描述动作,
    留空时后端用 VLM 按官方反推指令自动生成外观 caption(蒸馏版 10 步无 CFG,
    cfg 固定 1.0 不开放)。

    时长:优先 duration_sec(秒,任意值;4k+1 网格吸附后秒差大时生成后精确裁切);
    num_frames(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    positive: str = Field(default="", max_length=4000)  # 空 → 自动反推外观 caption
    image: str = Field(min_length=1, max_length=512)
    video: str = Field(min_length=1, max_length=512)
    worker: str
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    num_frames: int | None = Field(default=None, ge=17, le=501)
    steps: int = Field(default=10, ge=1, le=50)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    _img_ok = field_validator("image", "video")(_no_traversal)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;与 v1 同一惯例)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


@router.post("/wan/animate2")
async def generate_wan_animate2(
    req: WanAnimate2Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Wan-Animate-2 动作迁移:参考图角色按驱动视频动作生成视频(原生节点 :8199)。

    参考图/驱动视频从上传落点 worker 转运到 :8199 实例;positive 留空时先 VLM
    反推外观 caption(官方提示词要求);提交前 GPU3 显存互斥预检(FlashTalk 共卡,
    见 services/wan_animate2.ensure_animate2_vram)。
    """
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req, "animate2")
    client = animate2_service.get_animate2_client()
    source = resolve_worker(req.worker)

    positive = req.positive.strip()
    if positive:
        image_name = await longcat_service.transfer_ref_image(client, source, req.image)
    else:
        # 自动 caption:读一次参考图字节,先反推外观描述再上传(避免二次读取)
        try:
            content, content_type = await source.get_image_bytes(req.image, "", "input")
        except ComfyUIError as e:
            raise HTTPException(status_code=502, detail=f"从参考图所在 worker 读取失败: {e}") from e
        positive = (await animate2_service.caption_reference_appearance(content, content_type)).strip()
        try:
            image_name = await client.upload_image(content, req.image)
        except ComfyUIError as e:
            raise HTTPException(status_code=502, detail=f"参考图上传到 Wan-Animate-2 实例失败: {e}") from e
    video_name = await wan_service.transfer_drive_video(client, source, req.video)
    hold_exc = await _animate2_precheck_or_hold(client)
    params = WanAnimate2Params(
        positive=positive,
        negative=req.negative,
        image=image_name,
        video=video_name,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        steps=req.steps,
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_wan_animate2_graph(params)
    result = await animate2_service.submit_animate2_job(
        graph, kind="wan_animate2", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),
        prechecked=True,  # 上方 _animate2_precheck_or_hold 已做显存+RAM 预检
        hold_exc=hold_exc,  # 预检失败转 hold 排队(None=预检通过,正常提交)
    )
    if req.positive.strip() == "":
        result["auto_caption"] = positive  # 透出自动反推的提示词,便于前端展示/复用
    return _attach_duration_chain(result, plan, lambda: client)
