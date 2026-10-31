"""抠图去背(Remove Background)工作流构造器(纯函数,返回新 dict,不可变)。

用 ComfyUI_essentials 的 rembg 节点把主体抠出、去掉背景:
  RemBGSession+(选模型)→ ImageRemoveBackground+(session, LoadImage)→ RGBA → SaveImage

worker(.100)依赖:venv 已装 rembg + onnxruntime(本会话装,torch 不受影响);
首次按模型下载 u2net/isnet 权重。providers 用 CPU(装的是 CPU onnxruntime,单图够快)。
模型枚举值含描述后缀,须逐字传(见 _REMBG_MODELS)。
"""
from __future__ import annotations

from dataclasses import dataclass

# 抠图模式 key → RemBGSession+ 的 model 枚举值(逐字,含后缀)。
_REMBG_MODELS: dict[str, str] = {
    "general": "u2net: general purpose",
    "anime": "isnet-anime: anime illustrations",
    "human": "u2net_human_seg: human segmentation",
}
REMBG_MODES = tuple(_REMBG_MODELS.keys())


@dataclass(frozen=True)
class RemoveBgParams:
    """抠图参数。image 为已上传到 worker 的源图文件名(必填)。"""

    image: str
    mode: str = "general"
    filename_prefix: str = "ToIV_cutout"


def build_removebg_graph(p: RemoveBgParams) -> dict:
    """把参数编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    model_value = _REMBG_MODELS.get(p.mode, _REMBG_MODELS["general"])
    return {
        "10": {
            "class_type": "RemBGSession+",
            "inputs": {"model": model_value, "providers": "CPU"},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "12": {
            "class_type": "ImageRemoveBackground+",
            "inputs": {"rembg_session": ["10", 0], "image": ["11", 0]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["12", 0], "filename_prefix": p.filename_prefix},
        },
    }
