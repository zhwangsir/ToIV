"""img2img API 工作流构造器（纯函数，返回新 dict）。

CheckpointLoaderSimple + LoadImage → VAEEncode → KSampler(denoise<1) → VAEDecode → SaveImage
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1  # 见 txt2img:适配 SQLite 有符号 64 位


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


def build_img2img_graph(p: Img2ImgParams) -> dict:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
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
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": p.ckpt_name},
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["4", 1]}},
        "10": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "11": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["4", 2]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix}},
    }
