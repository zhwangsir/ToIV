"""局部重绘(文字定向 Inpaint)工作流构造器(纯函数,返回新 dict,不可变)。

不需手绘蒙版:用 Florence2 按文字分割出目标区域 → 仅重绘该区域:
  DownloadAndLoadFlorence2Model → Florence2Run(referring_expression_segmentation, 目标短语)
    → mask
  CheckpointLoaderSimple →(v-pred 时 ModelSamplingDiscrete)→ KSampler.model
  CLIPTextEncode×2(重绘内容正/负)
  VAEEncodeForInpaint(源图 + vae + mask)→ LATENT → KSampler → VAEDecode → SaveImage

worker(.100)实测:Florence2 节点在,DownloadAndLoadFlorence2Model 首次自动下载
microsoft/Florence-2-base;整链 /prompt smoke 出图成功。class_type/入参与 object_info 对齐。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.model_profiles import is_vpred, model_sampling_node

MAX_SEED = 2**63 - 1
_CKPT_NODE = "4"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class InpaintParams:
    """局部重绘参数。

    image:已上传到 worker 的源图文件名(必填)。
    target:要替换的区域的文字描述(Florence2 分割短语,如 "the hat")。
    positive:该区域重绘成什么。
    """

    image: str
    target: str
    positive: str
    negative: str = "blurry, lowres, deformed, watermark, text"
    ckpt_name: str = "DreamShaper_8_pruned.safetensors"
    denoise: float = 0.85
    grow_mask: int = 6
    steps: int = 20
    cfg: float = 7.0
    sampler: str = "euler"
    scheduler: str = "normal"
    florence_model: str = "microsoft/Florence-2-base"
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_inpaint"


def build_inpaint_graph(p: InpaintParams) -> dict:
    """把参数编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    model_ref: list = [_CKPT_NODE, 0]
    vpred_nodes: dict = {}
    if is_vpred(p.ckpt_name):
        vpred_nodes, model_ref = model_sampling_node(model_ref)

    return {
        _CKPT_NODE: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": p.ckpt_name},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.positive, "clip": [_CKPT_NODE, 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.negative, "clip": [_CKPT_NODE, 1]},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "30": {
            "class_type": "DownloadAndLoadFlorence2Model",
            "inputs": {"model": p.florence_model, "precision": "fp16"},
        },
        "31": {
            "class_type": "Florence2Run",
            "inputs": {
                "image": ["11", 0],
                "florence2_model": ["30", 0],
                "text_input": p.target,
                "task": "referring_expression_segmentation",
                "fill_mask": True,
            },
        },
        "32": {
            "class_type": "VAEEncodeForInpaint",
            "inputs": {
                "pixels": ["11", 0],
                "vae": [_CKPT_NODE, 2],
                "mask": ["31", 1],
                "grow_mask_by": p.grow_mask,
            },
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": model_ref,
                "seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["32", 0],
                "denoise": p.denoise,
            },
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": [_CKPT_NODE, 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix},
        },
        **vpred_nodes,
    }
