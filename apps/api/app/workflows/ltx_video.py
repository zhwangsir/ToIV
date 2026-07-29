"""LTX2.3 视频生成(t2v / i2v / lipsync)API 工作流构造器。

LTX2.3 是 Lightricks 的轻量视频生成模型,12G 显存可跑,音画同步。
本构造器按 Civitai LTX2.3 All in one v4.0 工作流的核心节点链实现,默认走 10Eros NSFW 底模。

10Eros 是 LTXAV 架构模型,文本编码器用 Gemma 3 12B(不是 T5),ComfyUI-LTXVideo 包
用 LTXV 前缀节点名。

参考:https://civitai.red/models/2553704

节点链(t2v):
  UNETLoader → LTXVGemmaCLIPModelLoader + VAELoader → CLIPTextEncode
  → LTXVConditioning → EmptyLTXVLatentVideo → KSampler(cfg=1) → VAEDecode → VHS_VideoCombine

i2v 在 t2v 基础上:LTXVImgToVideo 替代 EmptyLTXVLatentVideo(首帧引导,输出 pos/neg/latent 三路)

lipsync 在 i2v 基础上加:LoadAudio + LTXVAudioVAELoader + LTXVReferenceAudio(音频驱动)

关键参数(v4.0 推荐):
  · 分辨率 768×384(半分辨率),2 阶段采样(生成 + 2× 上采样)质量最佳
  · CFG=1(distilled 模型)+ NAG 负向提示词
  · 帧数 97(6s @16fps)
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# RIFE 模型文件名:worker 原生节点(detect_rife_config)要求 5 blocks + encode.cnn3 键结构,
# 原版 rife47/49.pth(hzwer 4 blocks + 2 层 encode)不被识别;使用 Comfy-Org 官方转换版 rife_v4.26.safetensors。
# 保留环境变量覆盖能力。
_DEFAULT_RIFE_CKPT = os.environ.get("TOIV_RIFE_CKPT", "rife_v4.26.safetensors")

# 上采样模型(worker upscale_models 目录实测:RealESRGAN_x2plus.pth / 4x-UltraSharp.pth;
# "nvidia_video_super_resolution" 实为 RTX VSR 节点(nvvfx SDK),并非 safetensors 文件)。
# worker 另有 ltx-2-spatial-upscaler-x2-1.0(latent 上采样,LTXVLatentUpsampler 链路预留)。
_DEFAULT_UPSCALE_MODEL = os.environ.get("TOIV_LTX_UPSCALE_MODEL", "RealESRGAN_x2plus.pth")

# 上采样 + RIFE 模型已补齐(RealESRGAN_x2plus / rife_v4.26 均已在 worker)。
# LTX v4.0 推荐"半分辨率生成 + 2× 上采样"获得最佳画质，故默认开启上采样；
# RIFE 插帧按需开启(会增耗时)。
_DEFAULT_USE_UPSCALE = os.environ.get("TOIV_LTX_USE_UPSCALE", "true").lower() == "true"
_DEFAULT_USE_RIFE = os.environ.get("TOIV_LTX_USE_RIFE", "false").lower() == "true"

# LTX2.3 视频底模:10Eros(NSFW) / zImage Turbo / ltx-2.3-distilled(SFW) 均可通过环境变量切换。
# 配套 CLIP/VAE 默认按 10Eros 工作流(Gemma 3 12B + LTX23_video_vae_bf16);若换用其他底模需自行确认兼容性。
DEFAULT_NSFW_UNET = os.environ.get("TOIV_LTX_UNET", "10eros_v14.safetensors")
DEFAULT_LTX_UNET = "ltx-2.3-distilled.safetensors"
# Gemma 3 12B 文本编码器:ComfyUI-LTXVideo 的 LTXVGemmaCLIPModelLoader 要求 HF 目录结构
# (model.safetensors + tokenizer.model + config.json + generation_config.json + preprocessor_config.json)。
# 使用 gemma3_12b_it_bf16/:原 fp8_scaled 权重被 HF 加载器忽略 weight_scale 且键名为 ComfyUI 原生
# 命名导致文本编码器随机初始化(提示词失效根因),已反量化转 bf16 并重映射为 HF 键名。
DEFAULT_GEMMA = os.environ.get("TOIV_LTX_GEMMA", "gemma3_12b_it_bf16/model.safetensors")
DEFAULT_VAE = os.environ.get("TOIV_LTX_VAE", "LTX23_video_vae_bf16.safetensors")


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class LtxT2VParams:
    """LTX2.3 文生视频参数。"""
    positive: str
    negative: str = ""
    unet_name: str = DEFAULT_NSFW_UNET
    gemma_name: str = DEFAULT_GEMMA
    vae_name: str = DEFAULT_VAE
    max_length: int = 1024
    width: int = 768   # 半分辨率(2 阶段采样:768→1536)
    height: int = 384  # 同上
    length: int = 97   # 6s @16fps
    fps: int = 16
    steps: int = 20
    cfg: float = 1.0   # distilled 模型 CFG=1
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    # 2 阶段采样:半分辨率生成 + 2× 上采样(v4.0 推荐质量最佳)
    use_upscale: bool = _DEFAULT_USE_UPSCALE
    upscale_model: str = _DEFAULT_UPSCALE_MODEL
    # RIFE 插帧(v4.0 新增,平滑画面)
    use_rife: bool = _DEFAULT_USE_RIFE
    filename_prefix: str = "ToIV_nsfw_vid"


@dataclass(frozen=True)
class LtxI2VParams:
    """LTX2.3 图生视频参数。"""
    positive: str
    image: str
    negative: str = ""
    unet_name: str = DEFAULT_NSFW_UNET
    gemma_name: str = DEFAULT_GEMMA
    vae_name: str = DEFAULT_VAE
    max_length: int = 1024
    width: int = 768
    height: int = 384
    length: int = 97
    fps: int = 16
    steps: int = 20
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    use_upscale: bool = _DEFAULT_USE_UPSCALE
    upscale_model: str = _DEFAULT_UPSCALE_MODEL
    use_rife: bool = _DEFAULT_USE_RIFE
    filename_prefix: str = "ToIV_nsfw_vid"


@dataclass(frozen=True)
class LtxLipsyncParams:
    """LTX2.3 口型同步参数(图生视频 + 音频驱动 + ID LoRA)。"""
    positive: str
    image: str
    audio: str
    negative: str = ""
    unet_name: str = DEFAULT_NSFW_UNET
    gemma_name: str = DEFAULT_GEMMA
    vae_name: str = DEFAULT_VAE
    max_length: int = 1024
    audio_vae_name: str = "mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors"
    id_lora: str = ""  # ID LoRA(声音/角色一致性,空=不挂)
    id_lora_strength: float = 0.8
    width: int = 768
    height: int = 384
    length: int = 97
    fps: int = 16
    steps: int = 20
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    use_upscale: bool = _DEFAULT_USE_UPSCALE
    upscale_model: str = _DEFAULT_UPSCALE_MODEL
    use_rife: bool = _DEFAULT_USE_RIFE
    filename_prefix: str = "ToIV_nsfw_lipsync"


def _build_base_chain(p: LtxT2VParams) -> dict:
    """基础节点链(UNETLoader + Gemma CLIP + VAE + 正负向编码),t2v/i2v/lipsync 共用。"""
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": p.unet_name, "weight_dtype": "default"}},
        "2": {"class_type": "LTXVGemmaCLIPModelLoader", "inputs": {
            "gemma_path": p.gemma_name, "ltxv_path": p.unet_name, "max_length": p.max_length}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": p.vae_name}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["2", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["2", 0]}},
    }
    return g


def _append_postprocess(g: dict, p: LtxT2VParams, vae_decode_id: str) -> str:
    """上采样 + RIFE 插帧 + VHS 输出,返回最终输出节点 id。"""
    images_src = [vae_decode_id, 0]
    # 2× 上采样(v4.0 推荐:半分辨率生成 + 上采样质量最佳)
    if p.use_upscale:
        g["22"] = {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": p.upscale_model},
        }
        g["20"] = {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["22", 0], "image": images_src},
        }
        images_src = ["20", 0]
    # RIFE 插帧(平滑画面,v4.0 新增;worker 节点为 FrameInterpolationModelLoader+FrameInterpolate)
    if p.use_rife:
        g["23"] = {
            "class_type": "FrameInterpolationModelLoader",
            "inputs": {"model_name": _DEFAULT_RIFE_CKPT},
        }
        g["21"] = {
            "class_type": "FrameInterpolate",
            "inputs": {
                "interp_model": ["23", 0],
                "images": images_src,
                "multiplier": 2,
            },
        }
        images_src = ["21", 0]
    # VHS 输出 mp4
    g["14"] = {
        "class_type": "VHS_VideoCombine",
        "inputs": {
            "images": images_src,
            "frame_rate": float(p.fps),
            "loop_count": 0,
            "filename_prefix": p.filename_prefix,
            "format": "video/h264-mp4",
            "pingpong": False,
            "save_output": True,
        },
    }
    return "14"


def build_ltx_t2v_graph(p: LtxT2VParams) -> dict:
    """LTX2.3 文生视频。

    节点链:
      UNETLoader → LTXVGemmaCLIPModelLoader + VAELoader → CLIPTextEncode
      → LTXVConditioning → EmptyLTXVLatentVideo → KSampler → VAEDecode → VHS
    """
    g = _build_base_chain(p)
    # LTXV 条件化(注入 frame_rate,输出 positive/negative 两路)
    g["9"] = {
        "class_type": "LTXVConditioning",
        "inputs": {"positive": ["7", 0], "negative": ["8", 0], "frame_rate": float(p.fps)},
    }
    # 空白 latent(文生视频无首帧)
    g["10"] = {
        "class_type": "EmptyLTXVLatentVideo",
        "inputs": {"width": p.width, "height": p.height, "length": p.length, "batch_size": 1},
    }
    # KSampler + 后处理
    g["12"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "seed": p.seed,
            "steps": p.steps,
            "cfg": p.cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["9", 0],
            "negative": ["9", 1],
            "latent_image": ["10", 0],
            "denoise": 1.0,
        },
    }
    g["13"] = {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}}
    _append_postprocess(g, p, "13")
    return g


def build_ltx_i2v_graph(p: LtxI2VParams) -> dict:
    """LTX2.3 图生视频。

    节点链:
      UNETLoader → LTXVGemmaCLIPModelLoader + VAELoader → CLIPTextEncode + LoadImage
      → LTXVImgToVideo(输出 positive/negative/latent 三路)→ KSampler → VAEDecode → VHS
    """
    g = _build_base_chain(p)
    # 加载首帧图
    g["9"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    # LTXV 图生视频(首帧引导 + 条件化,输出 pos[0]/neg[1]/latent[2])
    g["15"] = {
        "class_type": "LTXVImgToVideo",
        "inputs": {
            "positive": ["7", 0],
            "negative": ["8", 0],
            "vae": ["6", 0],
            "image": ["9", 0],
            "width": p.width,
            "height": p.height,
            "length": p.length,
            "batch_size": 1,
            "strength": 1.0,
        },
    }
    # KSampler + 后处理
    g["12"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "seed": p.seed,
            "steps": p.steps,
            "cfg": p.cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["15", 0],
            "negative": ["15", 1],
            "latent_image": ["15", 2],
            "denoise": 1.0,
        },
    }
    g["13"] = {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}}
    _append_postprocess(g, p, "13")
    return g


def build_ltx_lipsync_graph(p: LtxLipsyncParams) -> dict:
    """LTX2.3 口型同步(图生视频 + 音频驱动 + ID LoRA)。

    节点链:
      UNETLoader(+ID LoRA) → LTXVGemmaCLIPModelLoader + VAELoader → CLIPTextEncode
      + LoadImage + LoadAudio + LTXVAudioVAELoader
      → LTXVImgToVideo → LTXVReferenceAudio(音频驱动,输出 model/pos/neg 三路)
      → KSampler → VAEDecode → VHS
    """
    # 基础链
    g = _build_base_chain(p)
    # ID LoRA 挂载(声音/角色一致性)
    model_src = ["1", 0]
    if p.id_lora:
        g["3"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["1", 0], "lora_name": p.id_lora, "strength_model": p.id_lora_strength},
        }
        model_src = ["3", 0]
    # 加载首帧图 + 音频
    g["9"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    g["16"] = {"class_type": "LoadAudio", "inputs": {"audio": p.audio}}
    # 音频 VAE
    g["17"] = {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": p.audio_vae_name}}
    # LTXV 图生视频(首帧引导 + 条件化,输出 pos[0]/neg[1]/latent[2])
    g["15"] = {
        "class_type": "LTXVImgToVideo",
        "inputs": {
            "positive": ["7", 0],
            "negative": ["8", 0],
            "vae": ["6", 0],
            "image": ["9", 0],
            "width": p.width,
            "height": p.height,
            "length": p.length,
            "batch_size": 1,
            "strength": 1.0,
        },
    }
    # LTXV 音频驱动(注入参考音频,输出 model[0]/positive[1]/negative[2])
    g["18"] = {
        "class_type": "LTXVReferenceAudio",
        "inputs": {
            "model": model_src,
            "positive": ["15", 0],
            "negative": ["15", 1],
            "reference_audio": ["16", 0],
            "audio_vae": ["17", 0],
            "identity_guidance_scale": 0.5,
            "start_percent": 0.0,
            "end_percent": 1.0,
        },
    }
    # KSampler + 后处理
    g["12"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["18", 0],
            "seed": p.seed,
            "steps": p.steps,
            "cfg": p.cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["18", 1],
            "negative": ["18", 2],
            "latent_image": ["15", 2],
            "denoise": 1.0,
        },
    }
    g["13"] = {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}}
    _append_postprocess(g, p, "13")
    return g
