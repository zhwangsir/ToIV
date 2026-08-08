"""MiniMax H3 工作室 —— H3 视频生成(t2v / i2v),专用 ComfyUI 实例(TOIV_H3_BASE_URL)。

POST /api/h3/t2v —— 文生视频(原生 32kHz 立体声音轨,音画同发)
POST /api/h3/i2v —— 图生视频(首帧参考图;先经 /api/upload 上传到 pool worker,
                    提交时由后端转运到 H3 实例 input 目录)

与 LTX2 工作室的区别:H3 走独立 ComfyUI ≥ 0.30 实例(默认 workstation :8195,
不走 WorkerPool 集群);产物链路(tracker 落库 + /api/images 代理进作品库)与 ltx2 同路。
参数约束(见 docs/2026-08-03-minimax-h3-eval.md):
  · 分辨率 256-1344 且 32 对齐(上限 1344×768)
  · 帧数 17k+5 网格,22-362 @24fps(124≈5.2s,362≈15s)
  · 采样 res_multistep/simple,steps 1-50(默认 20)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.services import h3 as h3_service
from app.workflows.h3_video import H3I2VParams, H3T2VParams, build_h3_i2v_graph, build_h3_t2v_graph

router = APIRouter()


# ──────────────────────────────────────────────────────────────
# 请求模型
# ──────────────────────────────────────────────────────────────

class H3T2VRequest(BaseModel):
    """H3 文生视频请求。H3 节点无独立负向输入,negative 仅作快照保留(见 workflows/h3_video)。"""
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=1344, ge=256, le=1344)
    height: int = Field(default=768, ge=256, le=1344)
    length: int = Field(default=124, ge=22, le=362)
    steps: int = Field(default=20, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _aligned32(cls, v: int) -> int:
        if v % 32 != 0:
            raise ValueError("宽高必须 32 对齐(H3 分辨率约束)")
        return v

    @field_validator("length")
    @classmethod
    def _frames_grid(cls, v: int) -> int:
        if (v - 5) % 17 != 0:
            raise ValueError("length 必须为 17k+5(H3 帧数网格,如 124/141/362)")
        return v


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
    params = H3T2VParams(
        positive=req.positive,
        negative=req.negative,
        width=req.width,
        height=req.height,
        length=req.length,
        steps=req.steps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_h3_t2v_graph(params)
    return await h3_service.submit_h3_job(
        graph, kind="h3_t2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session,
        # R18 上下文(X-NSFW 头)打标进 /nsfw 专区作品库;nsfw_allowed 含未成年硬阻断,
        # 与 LTX 门控同一判定来源,主站(无头)恒 False 行为不变
        nsfw=nsfw_allowed(user),
    )


@router.post("/h3/i2v")
async def generate_h3_i2v(
    req: H3I2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """H3 图生视频。参考图从上传落点 worker 转运到 H3 实例后提交。"""
    enforce_generation_rate_limit(user)
    client = h3_service.get_h3_client()
    source = resolve_worker(req.worker)
    image_name = await h3_service.transfer_ref_image(client, source, req.image)
    params = H3I2VParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        width=req.width,
        height=req.height,
        length=req.length,
        steps=req.steps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_h3_i2v_graph(params)
    return await h3_service.submit_h3_job(
        graph, kind="h3_i2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        nsfw=nsfw_allowed(user),  # R18 上下文打标(同 t2v)
    )
