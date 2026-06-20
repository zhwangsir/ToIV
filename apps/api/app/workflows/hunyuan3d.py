"""Hunyuan3D 2.0 图生3D API 工作流构造器(输出 GLB 网格)。

ImageOnlyCheckpointLoader(MODEL/CLIP_VISION/VAE) + LoadImage
  → CLIPVisionEncode → Hunyuan3Dv2Conditioning
  → EmptyLatentHunyuan3Dv2 → KSampler
  → VAEDecodeHunyuan3D(VOXEL) → VoxelToMeshBasic(MESH) → SaveGLB
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class Hunyuan3DParams:
    image: str
    ckpt_name: str = "hunyuan3d-dit-v2-0-fp16.safetensors"
    steps: int = 30
    cfg: float = 5.0
    sampler: str = "euler"
    scheduler: str = "normal"
    resolution: int = 3072
    octree_resolution: int = 256
    num_chunks: int = 8000
    threshold: float = 0.6
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_3d"


def build_hunyuan3d_graph(p: Hunyuan3DParams) -> dict:
    return {
        "1": {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": p.ckpt_name}},
        "2": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "3": {
            "class_type": "CLIPVisionEncode",
            "inputs": {"clip_vision": ["1", 1], "image": ["2", 0], "crop": "center"},
        },
        "4": {"class_type": "Hunyuan3Dv2Conditioning", "inputs": {"clip_vision_output": ["3", 0]}},
        "5": {"class_type": "EmptyLatentHunyuan3Dv2", "inputs": {"resolution": p.resolution, "batch_size": 1}},
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "positive": ["4", 0],
                "negative": ["4", 1],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            },
        },
        "7": {
            "class_type": "VAEDecodeHunyuan3D",
            "inputs": {
                "samples": ["6", 0],
                "vae": ["1", 2],
                "num_chunks": p.num_chunks,
                "octree_resolution": p.octree_resolution,
            },
        },
        "8": {"class_type": "VoxelToMeshBasic", "inputs": {"voxel": ["7", 0], "threshold": p.threshold}},
        "9": {"class_type": "SaveGLB", "inputs": {"mesh": ["8", 0], "filename_prefix": p.filename_prefix}},
    }
