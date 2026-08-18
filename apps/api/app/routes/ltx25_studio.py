"""LTX-2.5 工作室 —— SFW 主力视频生成(音画同出,GPU0 专用实例 :8198)。

POST /api/ltx25/t2v —— 文生视频(提示词 → 音画同出 mp4)
POST /api/ltx25/i2v —— 图生视频(参考图首帧 → 视频;先经 /api/upload 上传
                      kind=ltx25_i2v,提交时由后端转运到 :8198 实例 input 目录)

参数约束(官方 LTX-2.5 单阶段蒸馏模板):
  · 宽/高 32 对齐(非对齐自动向下取整),默认 960×544
  · 帧数 8k+1 网格(LTX 时序压缩),121 帧@24fps≈5s,上限 601(≈25s)
  · 采样:cfg=1 固定 + euler_ancestral + 8 步蒸馏 sigma 曲线(workflows/ltx25_video)
产物链路(tracker 落库 + /api/images 代理进作品库)与 longcat/h3/wan 同路。
NSFW 视频仍走 LTX-2.3 + 10Eros(/api/generate/ltx-*),本板块只接 SFW。
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
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.services import ltx25 as ltx25_service
from app.services import video_generators as vgen
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.services.video_upscale import maybe_chain_upscale
from app.workflows.video_upscale import validate_resolution_target
from app.workflows.ltx25_video import (
    Ltx25I2VParams,
    Ltx25T2VParams,
    build_ltx25_i2v_graph,
    build_ltx25_t2v_graph,
)

router = APIRouter()


def _no_traversal(v: str) -> str:
    name = v.strip().replace("\\", "/")
    if ".." in name or name.startswith("/"):
        raise ValueError("文件名不允许路径穿越")
    return name


def _snap32(v: int) -> int:
    """32 对齐(LTX latent 空间网格),非对齐向下取整(与 longcat 16 对齐同一惯例)。"""
    return v // 32 * 32


def _snap_8k1(v: int) -> int:
    """8k+1 帧网格(LTX 时序压缩):吸附到最近合法帧数(如 121/129)。"""
    return max(9, ((v - 1) // 8) * 8 + 1)


class Ltx25T2VRequest(BaseModel):
    """LTX-2.5 文生视频请求(蒸馏单阶段,音画同出)。

    时长:优先 duration_sec(秒,任意值;超单段上限自动分段续写并精确裁切);
    length(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    宽高比静默收敛到 9:16~16:9(训练分布;极端比例出主体被裁/文字溢出)。
    """
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=960, ge=256, le=1920)
    height: int = Field(default=544, ge=256, le=1088)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    length: int | None = Field(default=None, ge=9, le=601)
    fps: int = Field(default=24, ge=8, le=60)
    steps: int = Field(default=8, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # RES-2026-08-18:输出分辨率档(1080p/2k/4k);空 = 原生直出
    resolution_target: str | None = Field(default=None, max_length=8)

    @field_validator("resolution_target")
    @classmethod
    def _v_target(cls, v: str | None) -> str | None:
        return validate_resolution_target(v)

    @field_validator("width", "height")
    @classmethod
    def _align32(cls, v: int) -> int:
        return _snap32(v)

    # 宽高比守卫:9:16~16:9(超出自动纠正,如 1920×256 → 1920×1088)
    _ratio = aspect_guard(*AR_VIDEO, align=32, min_v=256, max_v=1920)

    @field_validator("length")
    @classmethod
    def _grid8k1(cls, v: int | None) -> int | None:
        return _snap_8k1(v) if v is not None else None


# 旧默认时长:5s@24fps → 8k+1 网格 121 帧(与历史默认一致)
_DEFAULT_SECONDS = 5.0


def _resolve_plan(req: Ltx25T2VRequest) -> DurationPlan:
    """秒数 → 时长计划(统一策略层);legacy length 换算为等价 direct 计划(行为不变)。"""
    if req.duration_sec is None and req.length is not None:
        return DurationPlan(
            engine="ltx25", seconds=req.length / req.fps, fps=req.fps, frames=req.length,
            segment_frames=(req.length,),
        )
    try:
        return resolve_duration(
            "ltx25", req.duration_sec if req.duration_sec is not None else _DEFAULT_SECONDS, req.fps
        )
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


def _route_extend_submit(
    *, client, req: Ltx25T2VRequest, user: User, seed0: int,
):
    """extend 续段提交(路由链路:末帧 i2v,strength=1.0 硬锁末帧;段作业登记 kind=ltx25_extend_i2v)。"""
    async def _submit(frame_bytes: bytes, frames: int, idx: int) -> str:
        image_name = await client.upload_image(frame_bytes, f"ltx25_ext_{uuid.uuid4().hex}.jpg")
        p = Ltx25I2VParams(
            positive=req.positive,
            negative=req.negative,
            image=image_name,
            width=req.width,
            height=req.height,
            length=frames,
            fps=req.fps,
            steps=req.steps,
            strength=1.0,
            seed=seed0 + idx,
            filename_prefix="ToIV_ltx25_extend",
        )
        graph = build_ltx25_i2v_graph(p)
        with Session(db_engine) as s2:
            res = await ltx25_service.submit_ltx25_job(
                graph, kind="ltx25_extend_i2v", positive=p.positive, seed=p.seed,
                req=req, user=user, session=s2, client=client,
            )
        return res["prompt_id"]

    return _submit


class Ltx25I2VRequest(Ltx25T2VRequest):
    """LTX-2.5 图生视频请求。image=参考图首帧(上传句柄文件名,与 worker 落点同机)。"""
    image: str = Field(min_length=1, max_length=512)
    worker: str
    # 首帧条件强度(官方模板默认 0.7;1.0 = 完全锁定首帧)
    strength: float = Field(default=0.7, ge=0.0, le=1.0)

    _img_ok = field_validator("image")(_no_traversal)


@router.post("/ltx25/t2v")
async def generate_ltx25_t2v(
    req: Ltx25T2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LTX-2.5 文生视频:提示词 → 音画同出 mp4(蒸馏 8 步,GPU0 专用实例)。"""
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req)
    params = Ltx25T2VParams(
        positive=req.positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        length=plan.frames,
        fps=req.fps,
        steps=req.steps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_ltx25_t2v_graph(params)
    result = await ltx25_service.submit_ltx25_job(
        graph, kind="ltx25_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
    )
    if plan.strategy != "direct":
        client = ltx25_service.get_ltx25_client()
        vgen.spawn_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id=result["prompt_id"],
            submit_next=_route_extend_submit(
                client=client, req=req, user=user, seed0=params.seed,
            ),
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    if req.resolution_target and maybe_chain_upscale(result["prompt_id"], req.resolution_target):
        result["upscale_notice"] = (
            f"原生生成完成后将自动二次超分至 {req.resolution_target.upper()}"
        )
    return result


@router.post("/ltx25/i2v")
async def generate_ltx25_i2v(
    req: Ltx25I2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LTX-2.5 图生视频:参考图首帧(LTXVImgToVideoInplace 引导)→ 音画同出 mp4。

    参考图从上传落点 worker 转运到 :8198 实例(与 longcat/wan 同一转运模式)。
    """
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req)
    client = ltx25_service.get_ltx25_client()
    source = resolve_worker(req.worker)
    image_name = await ltx25_service.transfer_ref_image(client, source, req.image)
    params = Ltx25I2VParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        width=req.width,
        height=req.height,
        length=plan.frames,
        fps=req.fps,
        steps=req.steps,
        strength=req.strength,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_ltx25_i2v_graph(params)
    result = await ltx25_service.submit_ltx25_job(
        graph, kind="ltx25_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
    )
    if plan.strategy != "direct":
        vgen.spawn_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id=result["prompt_id"],
            submit_next=_route_extend_submit(
                client=client, req=req, user=user, seed0=params.seed,
            ),
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    if req.resolution_target and maybe_chain_upscale(result["prompt_id"], req.resolution_target):
        result["upscale_notice"] = (
            f"原生生成完成后将自动二次超分至 {req.resolution_target.upper()}"
        )
    return result
