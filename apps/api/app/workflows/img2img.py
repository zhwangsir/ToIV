"""img2img API 工作流构造器（纯函数，返回新 dict）。

CheckpointLoaderSimple →(可选 LoraLoader 链)+ LoadImage → VAEEncode
  → KSampler(denoise<1) → VAEDecode → SaveImage
LoRA 叠加同 txt2img:在 checkpoint 与 KSampler.model/CLIP 之间插 LoraLoader 链。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.lora import LoraSpec, lora_chain

MAX_SEED = 2**63 - 1  # 见 txt2img:适配 SQLite 有符号 64 位

_CKPT_NODE = "4"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class Img2ImgParams:
    positive: str
    image: str  # ComfyUI input 目录中的文件名（上传后得到）
    negative: str = ""
    ckpt_name: str = "DreamShaper_8_pruned.safetensors"
    denoise: float = 0.6
    steps: int = 20
    cfg: float = 7.0
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_i2i"
    loras: tuple[LoraSpec, ...] = ()


def build_img2img_graph(p: Img2ImgParams) -> dict:
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
                "latent_image": ["11", 0],
                "denoise": p.denoise,
            },
        },
        _CKPT_NODE: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": p.ckpt_name},
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": clip_ref}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": clip_ref}},
        "10": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "11": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": [_CKPT_NODE, 2]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": [_CKPT_NODE, 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix}},
        **lora_nodes,
    }
