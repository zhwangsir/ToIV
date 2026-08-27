"""Wan 2.2 文生视频(t2v)API 工作流构造器。

与 wan_i2v 同架构,差别只在「不喂输入图」:Wan 2.2 14B 的 WanImageToVideo 节点
start_image 为可选输入,省略即纯文生视频路径。

经 2026 调研同步修四硬伤:补 ModelSamplingSD3(shift=5)、cfg 拆 high/low、832×480/81 帧。

2026-08-27 Phase 2:Wan2.2-T2V-A14B 双专家 FP8 已入库,默认 UNET 换成 t2v 权重
(不再复用 i2v UNET 的错配);LightX2V Seko 4 步蒸馏 LoRA 就位,加速档三档:
  · off         —— 满血(默认,现状):不挂加速 LoRA,20 步,cfg 3.5/3.0。
  · turbo       —— 草稿高速:Seko 双 LoRA 成对挂(高噪→high_noise、低噪→low_noise),
                  steps=4,cfg=1.0(蒸馏无 CFG)。
  · turbo_cache —— 成片平衡:同 turbo 双 LoRA,steps=8,cfg=1.0 + EasyCache×2
                  (ComfyUI 原生,ModelSamplingSD3 之后、KSamplerAdvanced 之前)。

节点链:
  UNETLoader×2 →(可选 Seko 加速 LoRA)→ ModelSamplingSD3(shift)×2 →(可选 EasyCache×2)
  CLIPLoader(umt5,wan) + VAELoader + CLIPTextEncode×2 → WanImageToVideo(无 start_image)
  KSamplerAdvanced(high, cfg=high_cfg) → KSamplerAdvanced(low, cfg=low_cfg)
  → VAEDecode → VHS_VideoCombine(h264-mp4)
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.wan_i2v import DEFAULT_NEGATIVE

MAX_SEED = 2**63 - 1

# LightX2V Seko 加速 LoRA 资产(2026-08-27 已就位,三 worker 共享可见)
SEKO_T2V_HIGH_LORA = "lightx2v/Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V2.0/high_noise_model.safetensors"
SEKO_T2V_LOW_LORA = "lightx2v/Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V2.0/low_noise_model.safetensors"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class WanT2VParams:
    positive: str
    negative: str = DEFAULT_NEGATIVE
    # Wan2.2-T2V-A14B 双专家 FP8(2026-08-27 起默认,修掉复用 i2v UNET 的错配)
    high_unet: str = "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors"
    low_unet: str = "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"
    # t2v 专用 Seko 4 步蒸馏 LoRA(高噪模型挂 high_noise、低噪挂 low_noise,成对)
    high_lora: str = SEKO_T2V_HIGH_LORA
    low_lora: str = SEKO_T2V_LOW_LORA
    clip_name: str = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    vae_name: str = "wan_2.1_vae.safetensors"
    width: int = 832
    height: int = 480
    length: int = 81  # 4n+1
    fps: int = 16
    shift: float = 5.0
    # 加速档(2026-08-27 Phase 2):off=满血(默认)/ turbo=草稿 4 步 / turbo_cache=成片 8 步+EasyCache;
    # None=旧行为(use_accel_lora 开关,默认 False→满血)
    accel: str | None = None
    use_accel_lora: bool = False  # 旧开关;accel 显式给定时被忽略
    steps: int | None = None  # None=按档默认(off 20 / turbo 4 / turbo_cache 8;旧默认 20)
    high_cfg: float | None = None  # None=按档默认(蒸馏档 1.0;满血 3.5)
    low_cfg: float | None = None  # None=按档默认(蒸馏档 1.0;满血 3.0)
    high_lora_strength: float = 0.8
    low_lora_strength: float = 1.0
    # EasyCache 参数(仅 turbo_cache 档启用;ComfyUI 原生节点,全实例可用)
    cache_threshold: float = 0.15  # reuse_threshold,保守起步
    cache_start: float = 0.15  # start_percent,首段保护(构图)
    cache_end: float = 0.95  # end_percent,尾段保护(细节)
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_t2v"


def _resolve_sampling(p: WanT2VParams) -> tuple[bool, int, float, float, bool]:
    """把加速档解析为具体采样参数(语义与 wan_i2v._resolve_sampling 一致)。

    返回 (use_lora, steps, high_cfg, low_cfg, use_cache):
    - accel="off"         → (False, 20, 3.5, 3.0, False)  满血,不挂加速 LoRA
    - accel="turbo"       → (True, 4, 1.0, 1.0, False)    草稿高速,Seko 双 LoRA
    - accel="turbo_cache" → (True, 8, 1.0, 1.0, True)     成片平衡,Seko 双 LoRA + EasyCache
    - accel=None          → 旧行为(use_accel_lora=False→满血 20 步 cfg 3.5/3.0)
    显式 steps/high_cfg/low_cfg 覆盖档位默认(与 AceStep15Params 的 quality 同风格)。
    """
    if p.accel is None:
        return (
            p.use_accel_lora,
            p.steps if p.steps is not None else 20,
            p.high_cfg if p.high_cfg is not None else 3.5,
            p.low_cfg if p.low_cfg is not None else 3.0,
            False,
        )
    if p.accel == "off":
        return (
            False,
            p.steps if p.steps is not None else 20,
            p.high_cfg if p.high_cfg is not None else 3.5,
            p.low_cfg if p.low_cfg is not None else 3.0,
            False,
        )
    if p.accel == "turbo":
        return (
            True,
            p.steps if p.steps is not None else 4,
            p.high_cfg if p.high_cfg is not None else 1.0,
            p.low_cfg if p.low_cfg is not None else 1.0,
            False,
        )
    if p.accel == "turbo_cache":
        return (
            True,
            p.steps if p.steps is not None else 8,
            p.high_cfg if p.high_cfg is not None else 1.0,
            p.low_cfg if p.low_cfg is not None else 1.0,
            True,
        )
    raise ValueError(f"未知 Wan 加速档: {p.accel!r}(可选 off/turbo/turbo_cache)")


def build_wan_t2v_graph(p: WanT2VParams) -> dict:
    """把参数编译成 ComfyUI API 格式的 prompt 图。每次返回新 dict(不可变)。"""
    use_lora, steps, high_cfg, low_cfg, use_cache = _resolve_sampling(p)
    boundary = max(1, steps // 2)
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
    if use_lora:
        g["3"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": p.high_lora, "strength_model": p.high_lora_strength}}
        g["4"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": p.low_lora, "strength_model": p.low_lora_strength}}
        high_src, low_src = ["3", 0], ["4", 0]
    g["15"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": high_src, "shift": p.shift}}
    g["16"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": low_src, "shift": p.shift}}

    high_model_ref: list = ["15", 0]
    low_model_ref: list = ["16", 0]
    if use_cache:
        g["17"] = {
            "class_type": "EasyCache",
            "inputs": {
                "model": ["15", 0],
                "reuse_threshold": p.cache_threshold,
                "start_percent": p.cache_start,
                "end_percent": p.cache_end,
                "verbose": False,
            },
        }
        g["18"] = {
            "class_type": "EasyCache",
            "inputs": {
                "model": ["16", 0],
                "reuse_threshold": p.cache_threshold,
                "start_percent": p.cache_start,
                "end_percent": p.cache_end,
                "verbose": False,
            },
        }
        high_model_ref = ["17", 0]
        low_model_ref = ["18", 0]

    g["11"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": high_model_ref,
            "add_noise": "enable",
            "noise_seed": p.seed,
            "steps": steps,
            "cfg": high_cfg,
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
            "model": low_model_ref,
            "add_noise": "disable",
            "noise_seed": p.seed,
            "steps": steps,
            "cfg": low_cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["10", 0],
            "negative": ["10", 1],
            "latent_image": ["11", 0],
            "start_at_step": boundary,
            "end_at_step": steps,
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
