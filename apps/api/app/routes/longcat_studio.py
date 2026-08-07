"""LongCat-Video 工作室 —— 长视频文生视频(t2v),专用 ComfyUI 实例(TOIV_LONGCAT_BASE_URL)。

POST /api/longcat/t2v —— 文生视频(长镜头:961 帧@16fps≈60s;蒸馏 LoRA 低步数出片)

与 LTX2/H3 工作室的区别:LongCat 走 GPU2 独立实例(默认 workstation :8197,
不走 WorkerPool 集群);产物链路(tracker 落库 + /api/images 代理进作品库)与 h3/ltx2 同路。
参数约束(参考 scripts/longcat_smoke.py 真机实测):
  · 帧数 17-961(默认 121);宽/高 320-1280,16 对齐(非对齐自动向下取整)
  · steps 1-50(默认 10,蒸馏 LoRA 低步数);fps 8-30(仅影响打包帧率)
i2v / 视频续写预留:builder 与服务命名已留扩展位(build_longcat_t2v_graph / submit_longcat_job)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.services import longcat as longcat_service
from app.workflows.longcat_video import LongCatT2VParams, build_longcat_t2v_graph

router = APIRouter()


class LongCatT2VRequest(BaseModel):
    """LongCat 文生视频请求。宽/高非 16 对齐时向下取整(而非 422,对齐 VHS 打包容忍度)。"""
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    num_frames: int = Field(default=121, ge=17, le=961)
    steps: int = Field(default=10, ge=1, le=50)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16


@router.post("/longcat/t2v")
async def generate_longcat_t2v(
    req: LongCatT2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LongCat 文生视频。实例不可达/缺 WanVideo 节点 → 503(见 services/longcat.ensure_longcat_ready)。"""
    enforce_generation_rate_limit(user)
    params = LongCatT2VParams(
        positive=req.positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        num_frames=req.num_frames,
        steps=req.steps,
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_longcat_t2v_graph(params)
    return await longcat_service.submit_longcat_job(
        graph, kind="longcat_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
    )
