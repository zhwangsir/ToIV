"""Wan 2.2 文生视频(t2v)API 工作流构造器。

与 wan_i2v 同架构,差别只在「不喂输入图」:Wan 2.2 14B 的 WanImageToVideo
节点 start_image 为可选输入(introspect /object_info 确认:required 仅
positive/negative/vae/width/height/length/batch_size;start_image 在 optional),
省略 start_image 即纯文生视频路径。

本机 ComfyUI(192.168.71.100:8000)没有独立的 T2V UNET 检查点,只有 i2v UNET
(wan2.2_i2v_high/low_noise_14B);Wan 2.2 14B 同一套底模即可文/图生视频,
配 T2V 专用 4 步加速 LoRA(wan2.2_t2v_lightx2v_4steps_lora_v1.1)。

节点链(class_type 均经 /object_info 实测存在):
  UNETLoader×2 → LoraLoaderModelOnly×2(T2V 4 步加速)
  CLIPLoader(umt5,type=wan) + VAELoader(wan_2.1_vae)
  CLIPTextEncode×2 → WanImageToVideo(无 start_image,纯文本条件)
  KSamplerAdvanced(high, 步 0→2) → KSamplerAdvanced(low, 步 2→4)
  → VAEDecode → SaveAnimatedWEBP(动图,<img> 可播放)
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
    # Wan 2.2 14B 同底模文/图生视频通用;本机无独立 T2V UNET,复用 i2v UNET
    high_unet: str = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
    low_unet: str = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
    # T2V 专用 4 步加速 LoRA(与 i2v LoRA 不同)
    high_lora: str = "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors"
    low_lora: str = "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors"
    clip_name: str = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    vae_name: str = "wan_2.1_vae.safetensors"
    width: int = 480
    height: int = 480
    length: int = 49  # 帧数;16fps 下约 3 秒。Wan 需 4n+1 帧
    fps: int = 16
    steps: int = 4
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_t2v"


def build_wan_t2v_graph(p: WanT2VParams) -> dict:
    """把参数编译成 ComfyUI API 格式的 prompt 图。每次返回新 dict(不可变)。"""
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
