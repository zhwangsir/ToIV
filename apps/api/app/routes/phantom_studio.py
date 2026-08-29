"""Phantom-Wan-14B 角色一致性视频(Subject-to-Video)—— 短剧跨镜头角色锁定。

POST /api/phantom/s2v —— 1-4 张参考图 + prompt → 角色一致视频;
  与形象库(routes/entities.py)联动:entity_ids 每主体取最优参考图(正面→单图→侧面→
  背面,与 resolve-refs 同一语义)注入参考图链,与显式 images 合并(显式在前,合计 ≤4)。

与 LongCat 同一专用实例(TOIV_LONGCAT_BASE_URL,:8197;WanVideoWrapper 节点包仅该实例
装有),产物链路(tracker 落库 + /api/images 代理进作品库)与 longcat/h3 完全同路——
直接复用 services/longcat 的 client/转运/提交,资源预算预检(显存+RAM)同一防线。

参数约束(实例 :8197 官方示例 wanvideo_2_1_14B_phantom_subject2vid_example_02.json):
  · 参考图 1-4 张(Phantom 节点 phantom_latent_1..4 硬上限)
  · num_frames 4n+1(17-241,非对齐自动向下吸附);宽/高 320-1280,16 对齐(向下取整)
  · accel: turbo(默认,蒸馏 8 步草稿) / off(满血 30 步成片)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Entity, User
from app.nsfw_ctx import job_nsfw_from_intent
from app.ratelimit import enforce_generation_rate_limit
from app.services import longcat as longcat_service
from app.services.entities import best_image_value, parse_image_handle
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.workflows.phantom_s2v import (
    MAX_REF_IMAGES,
    PhantomS2VParams,
    build_phantom_s2v_graph,
    snap_frames,
)

router = APIRouter()

# Phantom 管线核心节点(实例 /object_info 实测);缺此节点 = 实例 WanVideo 包无 Phantom 支持
PHANTOM_NODE = "WanVideoPhantomEmbeds"


class RefImage(BaseModel):
    """上传句柄形态的参考图(/api/upload 返回),worker 为其落点(防 SSRF)。"""

    filename: str = Field(min_length=1, max_length=512)
    worker: str = Field(min_length=1, max_length=512)

    @field_validator("filename")
    @classmethod
    def _no_traversal(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


class PhantomS2VRequest(BaseModel):
    """Phantom 角色一致性视频请求。

    images(显式上传句柄)与 entity_ids(形象库主体)可同给,合并去重后合计 1-4 张;
    宽/高非 16 对齐向下取整;num_frames 非 4n+1 向下吸附(而非 422,与 longcat 同风格)。
    """

    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default="", max_length=2000)
    images: list[RefImage] = Field(default_factory=list, max_length=MAX_REF_IMAGES)
    entity_ids: list[str] = Field(default_factory=list, max_length=MAX_REF_IMAGES)
    width: int = Field(default=832, ge=320, le=1280)
    height: int = Field(default=480, ge=320, le=1280)
    num_frames: int = Field(default=81, ge=17, le=241)
    accel: str = Field(default="turbo", pattern="^(turbo|off)$")
    steps: int | None = Field(default=None, ge=1, le=50)
    cfg: float | None = Field(default=None, ge=0.0, le=30.0)
    phantom_cfg_scale: float | None = Field(default=None, ge=0.0, le=10.0)
    fps: int = Field(default=16, ge=8, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    @field_validator("num_frames")
    @classmethod
    def _snap4n1(cls, v: int) -> int:
        return snap_frames(v)

    @model_validator(mode="after")
    def _refs_total(self) -> "PhantomS2VRequest":
        total = len(self.images) + len(self.entity_ids)
        if total == 0:
            raise ValueError("至少提供 1 张参考图(images 或 entity_ids)")
        if total > MAX_REF_IMAGES:
            raise ValueError(f"参考图合计最多 {MAX_REF_IMAGES} 张(images + entity_ids)")
        return self

    # 宽高比守卫:9:16~16:9 静默归一(训练分布,与 longcat 同款)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)


async def _ensure_phantom_ready(client) -> None:
    """确认实例装有 Phantom 节点;不可达/缺节点一律 503 + 清晰原因。"""
    try:
        await client.object_info(PHANTOM_NODE)
    except ComfyUIError as e:
        if e.status_code is not None:  # 实例在线但无该节点
            raise HTTPException(
                status_code=503,
                detail=f"Phantom 实例 {client.base_url} 缺少 {PHANTOM_NODE} 节点(需 WanVideoWrapper 的 Phantom 支持)",
            ) from e
        raise HTTPException(
            status_code=503, detail=f"Phantom 实例不可达({client.base_url}): {e}"
        ) from e


def _entity_ref_handles(req: PhantomS2VRequest, user: User, session: Session) -> list[RefImage]:
    """entity_ids → 参考图句柄(每主体取最优图,与 /api/entities/resolve-refs 同一优先级)。

    不存在/非属主主体 → 404(防枚举);有主体但无可解析句柄 → 422。
    """
    out: list[RefImage] = []
    for eid in req.entity_ids:
        e = session.get(Entity, eid)
        if not e or e.user_id != user.id:
            raise HTTPException(status_code=404, detail=f"主体不存在({eid})")
        raw = best_image_value(e)
        handle = parse_image_handle(raw) if raw else None
        if not handle:
            raise HTTPException(
                status_code=422,
                detail=f"主体 {e.name} 无可用的上传句柄参考图(URL 形态请先经 resolve-refs 落 worker)",
            )
        out.append(RefImage(filename=handle["filename"], worker=handle["worker"]))
    return out


@router.post("/phantom/s2v")
async def generate_phantom_s2v(
    req: PhantomS2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Phantom 角色一致性视频:参考图(显式 + 形象库)逐个转运到 Phantom 实例后提交。"""
    enforce_generation_rate_limit(user)
    client = longcat_service.get_longcat_client()
    await _ensure_phantom_ready(client)

    handles = [*req.images, *_entity_ref_handles(req, user, session)]
    image_names: list[str] = []
    for h in handles:
        source = resolve_worker(h.worker)
        image_names.append(await longcat_service.transfer_ref_image(client, source, h.filename))

    params = PhantomS2VParams(
        positive=req.positive,
        images=tuple(image_names),
        negative=req.negative,
        width=req.width,
        height=req.height,
        num_frames=req.num_frames,
        accel=req.accel,
        steps=req.steps,
        cfg=req.cfg,
        phantom_cfg_scale=req.phantom_cfg_scale,
        fps=req.fps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_phantom_s2v_graph(params)
    return await longcat_service.submit_longcat_job(
        graph, kind="phantom_s2v", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        # 普通 Phantom 不因专页头打 R18 标;显式 body.nsfw 才走 job_nsfw_from_intent
        nsfw=job_nsfw_from_intent(user, bool(getattr(req, "nsfw", False))),
    )
