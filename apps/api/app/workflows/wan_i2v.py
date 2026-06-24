"""Wan 2.2 图生视频(i2v)API 工作流构造器。

Wan 2.2 采用 high/low noise 双扩散模型 + lightx2v 4 步加速 LoRA:
  UNETLoader×2 → LoraLoaderModelOnly×2(4步加速)
  CLIPLoader(umt5,type=wan) + VAELoader(wan_2.1_vae)
  CLIPTextEncode×2 + LoadImage → WanImageToVideo
  KSamplerAdvanced(high, 步 0→2) → KSamplerAdvanced(low, 步 2→4)
  → VAEDecode → SaveAnimatedWEBP(动图,<img> 可播放)
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# Wan 官方推荐负面提示词
DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class WanI2VParams:
    positive: str
    image: str
    negative: str = DEFAULT_NEGATIVE
    high_unet: str = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
    low_unet: str = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
    high_lora: str = "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
    low_lora: str = "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
    clip_name: str = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    vae_name: str = "wan_2.1_vae.safetensors"
    width: int = 640
    height: int = 480
    length: int = 49  # 帧数;16fps 下约 3 秒
    fps: int = 16
    steps: int = 4
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_vid"


def build_wan_i2v_graph(p: WanI2VParams) -> dict:
    boundary = max(1, p.steps // 2)
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": p.high_unet, "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": p.low_unet, "weight_dtype": "default"}},
        "3": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": p.high_lora, "strength_model": 1.0}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": p.low_lora, "strength_model": 1.0}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": p.clip_name, "type": "wan"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": p.vae_name}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["5", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["5", 0]}},
        "9": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "10": {
            "class_type": "WanImageToVideo",
            "inputs": {
                "positive": ["7", 0],
                "negative": ["8", 0],
                "vae": ["6", 0],
                "width": p.width,
                "height": p.height,
                "length": p.length,
                "batch_size": 1,
                "start_image": ["9", 0],
            },
        },
        "11": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "model": ["3", 0],
                "add_noise": "enable",
                "noise_seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "positive": ["10", 0],
                "negative": ["10", 1],
                "latent_image": ["10", 2],
                "start_at_step": 0,
                "end_at_step": boundary,
                "return_with_leftover_noise": "enable",
            },
        },
        "12": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "model": ["4", 0],
                "add_noise": "disable",
                "noise_seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "positive": ["10", 0],
                "negative": ["10", 1],
                "latent_image": ["11", 0],
                "start_at_step": boundary,
                "end_at_step": p.steps,
                "return_with_leftover_noise": "disable",
            },
        },
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}},
        # 输出真 mp4(h264):可分享/可下载、ffmpeg 可直接拼接(自动剪辑),
        # 优于动画 WebP(ffmpeg 解码不稳、非标准视频)。
        "14": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["13", 0],
                "frame_rate": float(p.fps),
                "loop_count": 0,
                "filename_prefix": p.filename_prefix,
                "format": "video/h264-mp4",
                "pingpong": False,
                "save_output": True,
            },
        },
    }
