"""视频超分(4K)—— 帧级工作流构造器 + 目标分辨率推导(纯函数,返回新 dict,不可变)。

单帧超分图(与 scripts/ops/video_4k_upscale.py build_upscale_graph 同构,
M6 fleet :8261/:8262/:8263 真机实测链路):
  UpscaleModelLoader(4x-UltraSharp) → LoadImage → ImageUpscaleWithModel
  → ImageScale(lanczos → 目标宽高) → SaveImage

目标分辨率服务端自动推导,禁止用户手填宽高(AGENTS.md 易错点 28:
竖屏源误用横屏目标,7320 帧被 ImageScale 拉伸报废):
  横屏源(宽 ≥ 高) → 3840×2160;竖屏源 → 2160×3840。
"""
from __future__ import annotations

from dataclasses import dataclass

# M6 超分 fleet 加载的超分模型(4x 原生;fleet 实例仅此用途,--cache-lru 2)
DEFAULT_UPSCALE_MODEL = "4x-UltraSharp.pth"

# target 档位 → (横屏目标, 竖屏目标)。4K 主力;720p/1080p/2K(RES-2026-08-18)供生成链
# 「原生上限 → 二次超分」自动挂链用(H3 原生 1344×768、Wan/LongCat 1280 上限;
# Wan 原生甜点 832×480,720p 也须经超分达成)。
_TARGETS: dict[str, tuple[tuple[int, int], tuple[int, int]]] = {
    "720p": ((1280, 720), (720, 1280)),
    "1080p": ((1920, 1080), (1080, 1920)),
    "2k": ((2560, 1440), (1440, 2560)),
    "4k": ((3840, 2160), (2160, 3840)),
}
TARGET_CHOICES: tuple[str, ...] = tuple(_TARGETS)


def derive_target_resolution(src_w: int, src_h: int, target: str = "4k") -> tuple[int, int]:
    """按源画幅方向推导目标 (宽, 高);横竖方向永远与源一致(护栏内建)。"""
    if target not in _TARGETS:
        raise ValueError(f"不支持的超分档位:{target!r};可选 {list(_TARGETS)}")
    landscape, portrait = _TARGETS[target]
    return landscape if src_w >= src_h else portrait


def assert_orientation_compatible(src_w: int, src_h: int, dst_w: int, dst_h: int) -> None:
    """画幅方向护栏(易错点 28):源与目标横竖不一致即报错,防 ImageScale 拉伸变形。

    derive_target_resolution 推导出的目标天然过此护栏;本函数供 service 在
    提交帧任务前做最终防御性校验(配置/常量被改坏时兜底,不让废片白烧算力)。
    """
    if (src_w >= src_h) != (dst_w >= dst_h):
        raise ValueError(
            f"源 {src_w}×{src_h} 与目标 {dst_w}×{dst_h} 横竖方向不一致(会拉伸变形)"
        )


def validate_resolution_target(v: str | None) -> str | None:
    """生成路由 resolution_target 字段的公共校验(RES-2026-08-18):
    None/"" = 原生直出;否则必须是 TARGET_CHOICES 内档位。"""
    if v is None or v == "":
        return None
    if v not in _TARGETS:
        raise ValueError(f"resolution_target 须为 {list(_TARGETS)} 之一(或留空原生直出)")
    return v


@dataclass(frozen=True)
class FrameUpscaleParams:
    """单帧超分参数。

    image:已上传到 fleet 实例 input 目录的帧文件名。
    target_w/target_h:目标分辨率(由 derive_target_resolution 推导)。
    """

    image: str
    model_name: str = DEFAULT_UPSCALE_MODEL
    target_w: int = 3840
    target_h: int = 2160
    filename_prefix: str = "toiv_vup"


def build_frame_upscale_graph(p: FrameUpscaleParams) -> dict:
    """把参数编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    return {
        "10": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": p.model_name},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "12": {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["10", 0], "image": ["11", 0]},
        },
        "13": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["12", 0],
                "width": p.target_w,
                "height": p.target_h,
                "upscale_method": "lanczos",
                "crop": "disabled",
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["13", 0], "filename_prefix": p.filename_prefix},
        },
    }
