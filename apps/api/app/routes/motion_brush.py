"""Motion Brush 局部动效标记 —— POST /api/motion-brush/mask。

链路:前端编辑器在源图(视频首帧/参考图)上涂抹笔画 → 本端点栅格化为
RGBA mask PNG(灰度=运动强度,alpha=方向角)→ 上传到指定 worker input 目录
→ 返回 mask 文件名;视频生成/编辑端点(/api/wan/vace、/api/generate/transition)
经 motion_mask 参数引用,提交时随参考图同路转运到 VACE 实例(:8197)。

mask 语义与生成细节见 services/motion_brush.py 模块 docstring。
"""
from __future__ import annotations

import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.comfy.client import ComfyUIError
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.services import motion_brush as mb

router = APIRouter()


class BrushStrokeIn(BaseModel):
    """单笔画输入(像素坐标,画布 = width×height;direction 零向量 = 只标区域不定向)。"""

    center_x: float
    center_y: float
    radius: float
    direction_x: float = 0.0
    direction_y: float = 0.0
    strength: float = Field(default=1.0)


class MotionBrushMaskRequest(BaseModel):
    """mask 生成请求:source_image 为上传句柄文件名(worker 为其落点,防 SSRF 同 wan_studio);
    width/height 为 mask 栅格化尺寸(须与目标视频引擎的生成分辨率一致,前端编辑器按
    引擎当前宽高值传入;笔画坐标即该坐标系下的像素)。"""

    source_image: str = Field(min_length=1, max_length=512)
    worker: str
    strokes: list[BrushStrokeIn] = Field(min_length=1, max_length=mb.MAX_STROKES)
    width: int = Field(ge=16, le=4096)
    height: int = Field(ge=16, le=4096)

    @field_validator("source_image")
    @classmethod
    def _no_traversal(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


@router.post("/motion-brush/mask")
async def create_motion_brush_mask(
    req: MotionBrushMaskRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """笔画列表 → 运动 mask PNG,上传到 worker input 目录,返回实例侧文件名。"""
    enforce_generation_rate_limit(user)
    strokes = [
        mb.BrushStroke(
            center_x=s.center_x, center_y=s.center_y, radius=s.radius,
            direction_x=s.direction_x, direction_y=s.direction_y, strength=s.strength,
        )
        for s in req.strokes
    ]
    try:
        normalized = mb.validate_strokes(strokes, req.width, req.height)
    except mb.MotionBrushError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    source = resolve_worker(req.worker)
    # 源图存在性校验(顺带确认 worker 在线);不存在 → 422,worker 故障 → 502
    try:
        await source.get_image_bytes(req.source_image, "", "input")
    except ComfyUIError as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=422, detail=f"源图 {req.source_image} 在该 worker 上不存在"
            ) from e
        raise HTTPException(status_code=502, detail=f"从源图所在 worker 读取失败: {e}") from e

    mask = mb.MotionBrushMask(width=req.width, height=req.height, strokes=tuple(normalized))
    img = mb.generate_mask(mask)
    name = await mb.save_mask(source, img, f"motion-brush-{uuid.uuid4().hex[:12]}.png")
    return {
        "mask": name,
        "width": req.width,
        "height": req.height,
        "strokes": len(normalized),
        # 调试/预览回读 URL(input 类型,与产物 URL 同构)
        "url": "/api/images?" + urlencode(
            {"filename": name, "type": "input", "worker": source.base_url}
        ),
    }
