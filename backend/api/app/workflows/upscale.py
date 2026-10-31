"""放大(Upscale)工作流构造器(纯函数,返回新 dict,不可变)。

用 ESRGAN 类放大模型把图放大:
  UpscaleModelLoader(model_name) → ImageUpscaleWithModel(upscale_model, LoadImage)
  →(目标倍数 ≠ 模型原生 4x 时)ImageScaleBy 调整到目标倍数 → SaveImage

worker(.100)实测可用模型:4x-UltraSharp.pth / 4x_NMKD-Siax_200k.pth(均 4x 原生)。
节点 class_type / 入参与 worker object_info 对齐。
"""
from __future__ import annotations

from dataclasses import dataclass

# worker 上可用的放大模型(object_info 实测);均为 4x 原生。
UPSCALE_MODELS = ("4x-UltraSharp.pth", "4x_NMKD-Siax_200k.pth")
# 放大模型原生倍数(上述两者都是 4x)。
_NATIVE_SCALE = 4.0


@dataclass(frozen=True)
class UpscaleParams:
    """放大参数。

    image:已上传到 worker 的源图文件名(必填)。
    scale:目标放大倍数(如 2.0 / 4.0);模型原生 4x,非 4 时用 ImageScaleBy 调整。
    """

    image: str
    model_name: str = UPSCALE_MODELS[0]
    scale: float = 4.0
    filename_prefix: str = "ToIV_upscale"


def build_upscale_graph(p: UpscaleParams) -> dict:
    """把参数编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    nodes: dict = {
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
    }
    out: list = ["12", 0]
    # 目标倍数 ≠ 模型原生 4x → 在放大后按比例缩放到目标倍数(lanczos 高质量)。
    if abs(p.scale - _NATIVE_SCALE) > 1e-3:
        nodes["13"] = {
            "class_type": "ImageScaleBy",
            "inputs": {
                "image": ["12", 0],
                "upscale_method": "lanczos",
                "scale_by": round(p.scale / _NATIVE_SCALE, 4),
            },
        }
        out = ["13", 0]
    nodes["9"] = {
        "class_type": "SaveImage",
        "inputs": {"images": out, "filename_prefix": p.filename_prefix},
    }
    return nodes
