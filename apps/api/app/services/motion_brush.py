"""Motion Brush 局部动效标记 —— 笔画 → 二值运动 mask(对标 Runway Motion Brush / 海螺 H3)。

原理:用户在视频首帧(或参考图)上涂抹标记区域,服务端把笔画栅格化为
RGBA PNG mask 并上传到目标 worker input 目录;视频引擎(当前 Wan2.1-VACE
:8197)把 mask 接 VACEEncode.input_masks,只对标记区域应用运动,其余保持静止。

PNG 通道约定(单文件同时携带区域/强度/方向,LoadImage 兼容):
  · R=G=B  运动强度(0=静止,255=全强度;按笔画 strength 缩放,重叠取 max)
  · A      方向角量化:atan2(dy,dx) 从 [-π,π] 映射到 [1,255];
           0 保留给「静止区/无方向笔画」(VACE 只读 RGB 通道,alpha 不干扰;
           ⚠️ 因此图加载 mask 必须用 ImageToMask(channel="red"),不能直接用
           LoadImage 的 MASK(alpha)输出——那里是方向角不是区域)
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

from PIL import Image, ImageChops, ImageDraw

from app.comfy.client import ComfyUIClient, ComfyUIError
from fastapi import HTTPException

MIN_RADIUS = 5
MAX_RADIUS = 100
MAX_STROKES = 64
_EPS = 1e-6


class MotionBrushError(ValueError):
    """笔画/画布参数非法(路由层转 422)。"""


@dataclass(frozen=True)
class BrushStroke:
    """单笔画:圆心(像素)+ 半径 + 运动方向矢量 + 运动强度。

    direction 为零向量 = 只标区域不定向(引擎自由演绎方向);
    非零时 validate_strokes 归一化为单位向量。
    """

    center_x: float
    center_y: float
    radius: float
    direction_x: float = 0.0
    direction_y: float = 0.0
    strength: float = 1.0  # 0-1,0 等于该区域保持静止(不参与栅格化)


@dataclass(frozen=True)
class MotionBrushMask:
    """一次标记会话:同一源图尺寸下的全部笔画。"""

    width: int
    height: int
    strokes: tuple[BrushStroke, ...] = field(default_factory=tuple)


def _normalize_direction(dx: float, dy: float) -> tuple[float, float]:
    """方向矢量归一化:模长 >1 归一到单位圆;近零 → (0,0) 无方向。"""
    mag = math.hypot(dx, dy)
    if mag < _EPS:
        return 0.0, 0.0
    if mag > 1.0 + _EPS:
        return dx / mag, dy / mag
    return dx, dy


def validate_strokes(strokes: list[BrushStroke], width: int, height: int) -> list[BrushStroke]:
    """校验并规范化笔画列表;非法抛 MotionBrushError。

    规则:坐标须在图内;半径 5-100px;强度 0-1;方向矢量模长 >1 时归一化
    (不报错,用户拖拽长度天然任意);空列表/超上限报错。
    """
    if width < 16 or height < 16:
        raise MotionBrushError(f"画布尺寸过小({width}x{height},至少 16x16)")
    if not strokes:
        raise MotionBrushError("至少需要 1 条笔画")
    if len(strokes) > MAX_STROKES:
        raise MotionBrushError(f"笔画最多 {MAX_STROKES} 条")
    out: list[BrushStroke] = []
    for i, s in enumerate(strokes):
        for name, v in (("center_x", s.center_x), ("center_y", s.center_y),
                        ("radius", s.radius), ("direction_x", s.direction_x),
                        ("direction_y", s.direction_y), ("strength", s.strength)):
            if not math.isfinite(v):
                raise MotionBrushError(f"strokes[{i}].{name} 必须是有限数字")
        if not (0 <= s.center_x < width and 0 <= s.center_y < height):
            raise MotionBrushError(
                f"strokes[{i}] 圆心 ({s.center_x:g},{s.center_y:g}) 超出画布 {width}x{height}"
            )
        if not MIN_RADIUS <= s.radius <= MAX_RADIUS:
            raise MotionBrushError(
                f"strokes[{i}] 半径 {s.radius:g} 越界(须 {MIN_RADIUS}-{MAX_RADIUS}px)"
            )
        if not 0.0 <= s.strength <= 1.0:
            raise MotionBrushError(f"strokes[{i}] 强度 {s.strength:g} 越界(须 0-1)")
        dx, dy = _normalize_direction(s.direction_x, s.direction_y)
        out.append(BrushStroke(
            center_x=s.center_x, center_y=s.center_y, radius=s.radius,
            direction_x=dx, direction_y=dy, strength=s.strength,
        ))
    return out


def _direction_alpha(dx: float, dy: float) -> int:
    """方向角 → alpha 量化值 [1,255];无方向 → 0。"""
    if math.hypot(dx, dy) < _EPS:
        return 0
    angle = math.atan2(dy, dx)  # [-π, π]
    return 1 + round((angle + math.pi) / (2 * math.pi) * 254)


def generate_mask(mask: MotionBrushMask) -> Image.Image:
    """笔画列表 → RGBA mask(栅格化)。

    R=G=B=运动强度(round(strength*255),重叠区取 max);
    A=方向角量化(重叠区取后画者,静止区/无方向为 0;见模块 docstring)。
    全零强度笔画不产生像素(该区域保持静止)。
    """
    size = (mask.width, mask.height)
    intensity = Image.new("L", size, 0)
    direction = Image.new("L", size, 0)
    for s in mask.strokes:
        if s.strength <= 0.0:
            continue
        bbox = [
            s.center_x - s.radius, s.center_y - s.radius,
            s.center_x + s.radius, s.center_y + s.radius,
        ]
        v = max(1, round(s.strength * 255))
        stroke_img = Image.new("L", size, 0)
        ImageDraw.Draw(stroke_img).ellipse(bbox, fill=v)
        intensity = ImageChops.lighter(intensity, stroke_img)  # 重叠取 max
        shape = Image.new("L", size, 0)
        ImageDraw.Draw(shape).ellipse(bbox, fill=255)
        direction.paste(_direction_alpha(s.direction_x, s.direction_y), (0, 0), shape)
    # alpha 仅在运动区生效;静止区恒 0
    moving = intensity.point(lambda p: 255 if p else 0)
    alpha = Image.composite(direction, Image.new("L", size, 0), moving)
    return Image.merge("RGBA", (intensity, intensity, intensity, alpha))


def mask_to_png_bytes(img: Image.Image) -> bytes:
    """RGBA mask → PNG 字节(供 upload_image 上传)。"""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def save_mask(
    client: ComfyUIClient, img: Image.Image, filename: str
) -> str:
    """mask PNG 上传到 worker input 目录,返回实例侧文件名(供 LoadImage 引用)。"""
    try:
        return await client.upload_image(mask_to_png_bytes(img), filename)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"mask 上传到 worker 失败: {e}") from e
