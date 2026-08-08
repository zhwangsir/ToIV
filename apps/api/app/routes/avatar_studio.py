"""LongCat-Avatar 音频驱动数字人工作室 —— 人像首帧 + 音频 → 口型数字人视频。

POST /api/avatar/talk —— 数字人说话视频(LongCat-Avatar v1.5,专用实例 :8197,
                        与 LongCat t2v/i2v 同一 ComfyUI 实例,不走 WorkerPool)

输入链路(同 longcat i2v 模式):人像图与驱动音频先经 /api/upload(kind=avatar)
上传到 pool worker,提交时由后端转运到 LongCat 实例 input 目录
(ComfyUI /upload/image 接受任意文件,LoadAudio 从 input 目录读取音频)。

参数约束(参考 workstation /tmp/longcat_avatar_smoke.py 真机冒烟):
  · 帧数 17-2500(默认 93;>93 帧自动按 93 帧窗口链式续段,段间 13 帧
    warmup 重编码垫底后切掉;残段向上取整 4k+1 采样网格,实际产出最多
    多 3 帧;2500 帧@25fps≈100s。续段链路 2026-08-08 真机验证:186 帧
    3 段链式出片 189 帧/7.56s,缝口无跳帧)
  · 宽/高 320-1280,16 对齐(非对齐自动向下取整);默认 480×832
  · steps 1-50(默认 12,dmd 蒸馏 LoRA 低步数);fps 8-30(默认 25,
    WhisperEmbeds 特征帧率与成片打包帧率同源)
  · cfg 默认 1.0(蒸馏链路);shift 默认 12.0
  · 音频时长与 num_frames 不一致时以 num_frames 为准:音频超长部分截断,
    不足时 ExtendEmbeds 按 if_not_enough_audio=pad_with_start 以首帧音频填充
    (尾段口型静止,与官方示例一致的缺省行为)
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
from app.services import longcat as longcat_service
from app.workflows.longcat_avatar import (
    DEFAULT_NEGATIVE,
    LongCatAvatarParams,
    build_longcat_avatar_graph,
)

router = APIRouter()


class AvatarTalkRequest(BaseModel):
    """LongCat-Avatar 数字人请求:image/audio 为上传句柄文件名,worker 为上传落点
    (防 SSRF,两者须在同一 worker)。宽/高非 16 对齐时向下取整(同 longcat_studio)。"""
    image: str = Field(min_length=1, max_length=512)
    audio: str = Field(min_length=1, max_length=512)
    worker: str
    positive: str = Field(min_length=1, max_length=4000)
    negative: str = Field(default=DEFAULT_NEGATIVE, max_length=2000)
    width: int = Field(default=480, ge=320, le=1280)
    height: int = Field(default=832, ge=320, le=1280)
    num_frames: int = Field(default=93, ge=17, le=2500)
    fps: int = Field(default=25, ge=8, le=30)
    steps: int = Field(default=12, ge=1, le=50)
    shift: float = Field(default=12.0, ge=1.0, le=30.0)
    cfg: float = Field(default=1.0, ge=0.0, le=10.0)
    dmd_lora_strength: float = Field(default=1.0, ge=0.0, le=2.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    @field_validator("image", "audio")
    @classmethod
    def _no_traversal(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


@router.post("/avatar/talk")
async def generate_avatar_talk(
    req: AvatarTalkRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LongCat-Avatar 数字人说话视频。实例不可达/缺 WanVideo 节点 → 503(同 longcat)。"""
    enforce_generation_rate_limit(user)
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    image_name = await longcat_service.transfer_ref_image(client, source, req.image)
    audio_name = await longcat_service.transfer_ref_audio(client, source, req.audio)
    params = LongCatAvatarParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        audio=audio_name,
        width=req.width,
        height=req.height,
        num_frames=req.num_frames,
        fps=req.fps,
        steps=req.steps,
        shift=req.shift,
        cfg=req.cfg,
        dmd_lora_strength=req.dmd_lora_strength,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_longcat_avatar_graph(params)
    return await longcat_service.submit_longcat_job(
        graph, kind="avatar_talk", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        # R18 上下文(X-NSFW 头)打标进 /nsfw 专区作品库;nsfw_allowed 含未成年硬阻断,
        # 与 longcat_studio 同一判定来源,主站(无头)恒 False 行为不变
        nsfw=nsfw_allowed(user),
    )
