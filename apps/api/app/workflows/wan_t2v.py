"""Wan 2.2 文生视频(t2v)API 工作流构造器。

与 wan_i2v 同架构,差别只在「不喂输入图」:Wan 2.2 14B 的 WanImageToVideo 节点
start_image 为可选输入,省略即纯文生视频路径。

经 2026 调研同步修四硬伤:补 ModelSamplingSD3(shift=5)、cfg 拆 high/low、832×480/81 帧。

错配修复:旧版用 i2v UNET + **t2v 专用 LoRA** 是错配(掉质)。本机暂无独立 t2v UNET
(待下载 Wan2.2-T2V-A14B 双专家),故**默认走满血档(use_accel_lora=False,不挂加速 LoRA)**——
Wan 2.2 14B 同底模可纯文本驱动,不挂 LoRA 即无错配。下载 t2v 专用权重后,把
high_unet/low_unet 换成 t2v 权重 + use_accel_lora=True 即可开 8 步快档。

节点链:
  UNETLoader×2 →(可选 t2v 加速 LoRA)→ ModelSamplingSD3(shift)×2
  CLIPLoader(umt5,wan) + VAELoader + CLIPTextEncode×2 → WanImageToVideo(无 start_image)
  KSamplerAdvanced(high, cfg=high_cfg) → KSamplerAdvanced(low, cfg=low_cfg)
  → VAEDecode → VHS_VideoCombine(h264-mp4)
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.wan_i2v import DEFAULT_NEGATIVE

MAX_SEED = 2**63 - 1


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class WanT2VParams:
    positive: str
    negative: str = DEFAULT_NEGATIVE
    # 本机暂复用 i2v UNET(Wan 2.2 14B 同底模通用);下载 Wan2.2-T2V-A14B 后替换为 t2v 权重
    high_unet: str = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
    low_unet: str = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
    # t2v 专用 4 步加速 LoRA(仅 use_accel_lora=True 且 UNET 为 t2v 权重时启用)
    high_lora: str = "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors"
    low_lora: str = "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors"
    clip_name: str = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    vae_name: str = "wan_2.1_vae.safetensors"
    width: int = 832
    height: int = 480
    length: int = 81  # 4n+1
    fps: int = 16
    shift: float = 5.0
    # 默认满血档:不挂加速 LoRA(规避 i2v UNET + t2v LoRA 错配),steps 足、cfg 真
    use_accel_lora: bool = False
    steps: int = 20
    high_cfg: float = 3.5
    low_cfg: float = 3.0
    high_lora_strength: float = 0.8
    low_lora_strength: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_t2v"


def build_wan_t2v_graph(p: WanT2VParams) -> dict:
    """把参数编译成 ComfyUI API 格式的 prompt 图。每次返回新 dict(不可变)。"""
    boundary = max(1, p.steps // 2)
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": p.high_unet, "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": p.low_unet, "weight_dtype": "default"}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": p.clip_name, "type": "wan"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": p.vae_name}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["5", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["5", 0]}},
        # 不传 start_image / clip_vision_output → 纯文生视频(空条件 latent)
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
            },
        },
    }

    high_src: list = ["1", 0]
    low_src: list = ["2", 0]
    if p.use_accel_lora:
        g["3"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": p.high_lora, "strength_model": p.high_lora_strength}}
        g["4"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": p.low_lora, "strength_model": p.low_lora_strength}}
        high_src, low_src = ["3", 0], ["4", 0]
    g["15"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": high_src, "shift": p.shift}}
    g["16"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": low_src, "shift": p.shift}}

    g["11"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": ["15", 0],
            "add_noise": "enable",
            "noise_seed": p.seed,
            "steps": p.steps,
            "cfg": p.high_cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["10", 0],
            "negative": ["10", 1],
            "latent_image": ["10", 2],
            "start_at_step": 0,
            "end_at_step": boundary,
            "return_with_leftover_noise": "enable",
        },
    }
    g["12"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": ["16", 0],
            "add_noise": "disable",
            "noise_seed": p.seed,
            "steps": p.steps,
            "cfg": p.low_cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["10", 0],
            "negative": ["10", 1],
            "latent_image": ["11", 0],
            "start_at_step": boundary,
            "end_at_step": p.steps,
            "return_with_leftover_noise": "disable",
        },
    }
    g["13"] = {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}}
    g["14"] = {
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
    }
    return g
