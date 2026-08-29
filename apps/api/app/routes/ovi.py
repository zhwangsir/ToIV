"""Ovi 1.1 音画工作室 —— 文本/图 → 同步音画视频(语音对口型 + 环境音效直出)。

POST /api/ovi/t2v —— 文生音画(画面描述 + 台词 + 音频描述 → 10s@960×960 带音轨 mp4)
POST /api/ovi/i2v —— 图生音画(首帧参考图;先经 /api/upload 上传到 pool worker,
                          提交时由后端转运到 :8197 实例 input 目录,同 longcat/i2v 模式)

提示词三段式(后端确定性拼装,格式硬约束见 workflows/ovi.py):
  · positive:画面描述(必填;自带 <S>/Audio: 时视为完整格式原样透传)
  · speech:台词(可选;自动包 <S>…<E>,缺了不出人声)
  · audio_caption:音频描述(可选;自动以 "Audio: " 前缀追加,如 "清脆的风铃,远处的车流")

与 LongCat 同一专用实例(:8197 WanVideoWrapper),提交/预检/hold 排队/产物落库
全复用 services/longcat.submit_longcat_job(同实例同显存预算语义);
产物为 h264+aac mp4,tracker 落库进作品库,与 H3 音画成片同一条路。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.nsfw_ctx import job_nsfw_from_intent
from app.ratelimit import enforce_generation_rate_limit
from app.services import longcat as longcat_service
from app.workflows.ovi import (
    OviI2VParams,
    OviT2VParams,
    assemble_ovi_prompt,
    build_ovi_i2v_graph,
    build_ovi_t2v_graph,
)

router = APIRouter()


def _snap_frames(n: int) -> int:
    """Wan 时序网格 4n+1 吸附(25-241 帧;241≈10s@24fps 训练甜点)。"""
    n = max(25, min(241, n))
    return ((n - 1) // 4) * 4 + 1


class OviT2VRequest(BaseModel):
    """Ovi 文生音画请求。宽/高非 32 对齐时向下取整(而非 422,对齐 VHS 打包容忍度)。"""

    positive: str = Field(min_length=1, max_length=4000)
    speech: str = Field(default="", max_length=500)  # 台词;多段请自行带 <S>/<E> 进 positive
    audio_caption: str = Field(default="", max_length=500)
    negative: str = Field(default="", max_length=2000)  # 空 = builder 默认画面负向
    audio_negative: str = Field(default="", max_length=2000)  # 空 = builder 默认音频负向
    width: int = Field(default=960, ge=256, le=1024)
    height: int = Field(default=960, ge=256, le=1024)
    num_frames: int = Field(default=241, ge=25, le=241)
    steps: int = Field(default=50, ge=1, le=100)
    cfg: float = Field(default=4.0, ge=0.0, le=30.0)
    ovi_audio_cfg: float = Field(default=3.0, ge=0.0, le=100.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _snap32(cls, v: int) -> int:
        return max(256, v // 32 * 32)

    @field_validator("num_frames")
    @classmethod
    def _frames(cls, v: int) -> int:
        return _snap_frames(v)


class OviI2VRequest(OviT2VRequest):
    """Ovi 图生音画请求:image 为上传句柄文件名,worker 为其落点的 pool worker(防 SSRF)。"""

    image: str = Field(min_length=1, max_length=512)
    worker: str

    @field_validator("image")
    @classmethod
    def _no_traversal(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


def _to_params(req: OviT2VRequest, cls=OviT2VParams, **extra):
    """请求 → builder 参数(负向空串回落 builder 默认;提示词三段式拼装)。"""
    return cls(
        positive=assemble_ovi_prompt(req.positive, req.speech, req.audio_caption),
        **({"negative": req.negative} if req.negative else {}),
        **({"audio_negative": req.audio_negative} if req.audio_negative else {}),
        width=req.width,
        height=req.height,
        num_frames=req.num_frames,
        steps=req.steps,
        cfg=req.cfg,
        ovi_audio_cfg=req.ovi_audio_cfg,
        **({"seed": req.seed} if req.seed is not None else {}),
        **extra,
    )


@router.post("/ovi/t2v")
async def generate_ovi_t2v(
    req: OviT2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Ovi 文生音画。实例不可达/缺 WanVideo 节点 → 503(复用 longcat 实例就绪检查)。"""
    enforce_generation_rate_limit(user)
    params = _to_params(req)
    graph = build_ovi_t2v_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="ovi_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
        nsfw=job_nsfw_from_intent(user, bool(getattr(req, "nsfw", False))),  # R18 上下文打标(同 longcat 门控语义)
    )
    return result


@router.post("/ovi/i2v")
async def generate_ovi_i2v(
    req: OviI2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Ovi 图生音画。参考图从上传落点 worker 转运到 :8197 实例后提交(同 longcat/i2v 模式)。"""
    enforce_generation_rate_limit(user)
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    image_name = await longcat_service.transfer_ref_image(client, source, req.image)
    params = _to_params(req, OviI2VParams, image=image_name)
    graph = build_ovi_i2v_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="ovi_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=job_nsfw_from_intent(user, bool(getattr(req, "nsfw", False))),
    )
    return result
