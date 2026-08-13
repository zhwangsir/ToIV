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

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.services import ltx25 as ltx25_service
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
    """LTX-2.5 文生视频请求(蒸馏单阶段,音画同出)。"""
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=960, ge=256, le=1920)
    height: int = Field(default=544, ge=256, le=1088)
    length: int = Field(default=121, ge=9, le=601)
    fps: int = Field(default=24, ge=8, le=60)
    steps: int = Field(default=8, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _align32(cls, v: int) -> int:
        return _snap32(v)

    @field_validator("length")
    @classmethod
    def _grid8k1(cls, v: int) -> int:
        return _snap_8k1(v)


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
    params = Ltx25T2VParams(
        positive=req.positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_ltx25_t2v_graph(params)
    return await ltx25_service.submit_ltx25_job(
        graph, kind="ltx25_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
    )


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
    client = ltx25_service.get_ltx25_client()
    source = resolve_worker(req.worker)
    image_name = await ltx25_service.transfer_ref_image(client, source, req.image)
    params = Ltx25I2VParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        strength=req.strength,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_ltx25_i2v_graph(params)
    return await ltx25_service.submit_ltx25_job(
        graph, kind="ltx25_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
    )
