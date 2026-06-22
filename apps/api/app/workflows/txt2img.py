"""txt2img API 工作流构造器（纯函数，返回新 dict，不可变）。

基于 ComfyUI 实测节点 schema：
CheckpointLoaderSimple →(可选 LoraLoader 链)→ CLIPTextEncode×2
  → EmptyLatentImage → KSampler → VAEDecode → SaveImage

LoRA 叠加:在 checkpoint 与下游(KSampler.model / CLIPTextEncode.clip)之间插入
LoraLoader 链,逐个把 (model, clip) 一起串联,各带独立 strength。class_type 与
inputs 经 /object_info 实测(model/clip/lora_name/strength_model/strength_clip)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.lora import LoraSpec, lora_chain

# SQLite 有符号 64 位上限;ComfyUI 接受此范围,且仍有 9.2e18 种可能
MAX_SEED = 2**63 - 1

# checkpoint 节点 id;LoRA 链以此为 (model,clip) 源头
_CKPT_NODE = "4"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class Txt2ImgParams:
    positive: str
    negative: str = ""
    ckpt_name: str = "DreamShaper_8_pruned.safetensors"
    width: int = 512
    height: int = 512
    steps: int = 20
    cfg: float = 7.0
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    batch_size: int = 1
    filename_prefix: str = "ToIV"
    # 叠加的 LoRA(空 = 不加载,图与现状一致)
    loras: tuple[LoraSpec, ...] = ()


def build_txt2img_graph(p: Txt2ImgParams) -> dict:
    """把参数编译成 ComfyUI API 格式的 prompt 图。每次返回新 dict。"""
    # LoRA 链:把 checkpoint 的 (model,clip) 依次穿过各 LoraLoader;
    # 末端引用供 KSampler.model / CLIPTextEncode.clip 使用。空 loras → 直引 checkpoint。
    lora_nodes, model_ref, clip_ref = lora_chain(
        p.loras, src_model=[_CKPT_NODE, 0], src_clip=[_CKPT_NODE, 1]
    )
    return {
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
                "latent_image": ["5", 0],
                "denoise": 1.0,
            },
        },
        _CKPT_NODE: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": p.ckpt_name},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": p.width, "height": p.height, "batch_size": p.batch_size},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.positive, "clip": clip_ref},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.negative, "clip": clip_ref},
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": [_CKPT_NODE, 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix},
        },
        **lora_nodes,
    }
