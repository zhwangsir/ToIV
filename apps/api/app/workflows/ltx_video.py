"""LTX2.3 视频生成(t2v / i2v / lipsync / lipdub)API 工作流构造器。

LTX2.3 是 Lightricks 的轻量视频生成模型,12G 显存可跑,音画同步。
本构造器按 Civitai LTX2.3 All in one v4.0 工作流的核心节点链实现,默认走 10Eros NSFW 底模。

10Eros 是 LTXAV 架构模型,文本编码器用 Gemma 3 12B(不是 T5),ComfyUI-LTXVideo 包
用 LTXV 前缀节点名。

参考:https://civitai.red/models/2553704

节点链(t2v):
  UNETLoader →(可选 LoraLoader 叠加链)→ LTXVGemmaCLIPModelLoader + VAELoader → CLIPTextEncode
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

from app.workflows.lora import LoraSpec, lora_chain

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

# LTX2.3 视频底模:10Eros(NSFW) / ltx-2.3-22b-distilled-1.1(SFW 默认) / 22b-dev 均可通过环境变量切换。
# 注:SFW 默认直引真机实存的 22B distilled 1.1;旧 ltx-2.3-distilled 符号链接已失效(勿回退)。
# 配套 CLIP/VAE 默认按 10Eros 工作流(Gemma 3 12B + LTX23_video_vae_bf16);若换用其他底模需自行确认兼容性。
DEFAULT_NSFW_UNET = os.environ.get("TOIV_LTX_UNET", "10eros_v14.safetensors")
DEFAULT_LTX_UNET = os.environ.get("TOIV_LTX_SFW_UNET", "ltx-2.3-22b-distilled-1.1.safetensors")
# Gemma 3 12B 文本编码器:ComfyUI-LTXVideo 的 LTXVGemmaCLIPModelLoader 要求 HF 目录结构
# (model.safetensors + tokenizer.model + config.json + generation_config.json + preprocessor_config.json)。
# 使用 gemma3_12b_it_bf16/:原 fp8_scaled 权重被 HF 加载器忽略 weight_scale 且键名为 ComfyUI 原生
# 命名导致文本编码器随机初始化(提示词失效根因),已反量化转 bf16 并重映射为 HF 键名。
DEFAULT_GEMMA = os.environ.get("TOIV_LTX_GEMMA", "gemma3_12b_it_bf16/model.safetensors")
DEFAULT_VAE = os.environ.get("TOIV_LTX_VAE", "LTX23_video_vae_bf16.safetensors")

# ── LipDub(IC-LoRA 视频重配音对口型)──────────────────────────────
# 官方参考:ComfyUI-LTXVideo example_workflows/2.3/LTX-2.3_ICLoRA_Lipdub_Two_Stage_Distilled.json
# 语义(官方 MarkdownNote):新台词写进 positive 提示词(目标语言原生文字),模型按提示词
# 生成新口型与新语音;LTXVAudioVAEEncode 编码的音频仅作"嗓音参考"(官方接原视频音轨,
# 本构造器允许改接 TTS 新音频)。台词长度与原片台词相近效果最佳(过长漏词、过短语速不自然)。
DEFAULT_LIPDUB_CKPT = os.environ.get("TOIV_LTX_LIPDUB_CKPT", "ltx-2.3-22b-distilled-1.1.safetensors")
DEFAULT_LIPDUB_LORA = os.environ.get(
    "TOIV_LTX_LIPDUB_LORA", "ltx2.3/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors"
)
# LipDub 文本编码器:LTXAVTextEncoderLoader 走 ComfyUI 原生 load_clip,要求 safetensors 内嵌
# spiece_model tokenizer;HF 目录形式的 gemma3_12b_it_bf16 无内嵌 tokenizer 会报 invalid tokenizer。
# fp8_scaled 是 ComfyUI 官方 repack(内嵌 spiece_model + ComfyUI 原生键名),与官方工作流的
# comfy_gemma_3_12B_it.safetensors 等价;原生加载器正确处理 weight_scale(此前 fp8 失效
# 仅发生在 LTXVGemmaCLIPModelLoader 的 HF 加载路径,与本节点无关)。
DEFAULT_LIPDUB_TEXT_ENCODER = os.environ.get(
    "TOIV_LTX_LIPDUB_TEXT_ENCODER", "gemma_3_12B_it_fp8_scaled.safetensors"
)
DEFAULT_LIPDUB_UPSCALER = os.environ.get(
    "TOIV_LTX_LIPDUB_UPSCALER", "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
)

# 官方一阶段 distilled sigma 表(8 步 9 点;steps=8 时原样使用)
_DISTILLED_SIGMAS_S1 = (1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0)
# 官方二阶段精修 sigma 表(3 步,起点接一阶段尾部,固定不重采样)
_DISTILLED_SIGMAS_S2 = "0.909375, 0.725, 0.421875, 0.0"


def _distilled_sigmas(steps: int) -> str:
    """把官方 8 步 distilled sigma 曲线线性重采样到 steps+1 个点(steps=8 与官方完全一致)。"""
    ref = _DISTILLED_SIGMAS_S1
    n = len(ref) - 1
    if steps == n:
        return ", ".join(f"{x:.6g}" for x in ref)
    pts: list[float] = []
    for j in range(steps + 1):
        t = j * n / steps
        i = min(int(t), n - 1)
        pts.append(ref[i] + (ref[i + 1] - ref[i]) * (t - i))
    pts[0], pts[-1] = 1.0, 0.0
    return ", ".join(f"{x:.6g}" for x in pts)


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
    # 叠加的 LoRA(空 = 不加载,图与现状一致);LTX 工作室 loras/ltx2.3/ 的 camera/IC-LoRA/风格 LoRA
    loras: tuple[LoraSpec, ...] = ()


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
    # 叠加的 LoRA(空 = 不加载,图与现状一致);LTX 工作室 loras/ltx2.3/ 的 camera/IC-LoRA/风格 LoRA
    loras: tuple[LoraSpec, ...] = ()


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
    # LTXVAudioVAELoader 从 checkpoints 类目加载,按 `audio_vae.` 前缀抽取子状态字典
    # (nodes_lt_audio.py: state_dict_prefix_replace({"audio_vae.": "autoencoder."}))。
    # 必须用内嵌 audio_vae.* 键的 LTX2.3 全量底模(distilled 底模与 UNET 同源,toiv 库
    # checkpoints/ 已注册,102 个 audio_vae 键);mmaudio gold ckpt 无此前缀 → VAE invalid。
    audio_vae_name: str = "ltx-2.3-22b-distilled-1.1.safetensors"
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


@dataclass(frozen=True)
class LtxLipdubParams:
    """LTX-2.3 LipDub 参数(IC-LoRA 视频重配音对口型,22B 全模型 CheckpointLoaderSimple 链路)。"""
    positive: str   # 场景描述 + 新台词(目标语言原生文字),模型按此生成新口型与新语音
    video: str      # 输入视频(worker input 目录文件名)
    audio: str = ""  # 嗓音参考音频(worker input 文件名;空 = 用原视频音轨,官方默认)
    negative: str = ""
    ckpt_name: str = DEFAULT_LIPDUB_CKPT
    gemma_name: str = DEFAULT_LIPDUB_TEXT_ENCODER  # LTXAVTextEncoderLoader 要求内嵌 tokenizer 的 repack
    lipdub_lora: str = DEFAULT_LIPDUB_LORA
    lipdub_lora_strength: float = 1.0
    width: int = 960   # 一阶段分辨率(官方 960×544)
    height: int = 544
    length: int = 121  # 输出帧数(必须 8k+1,且 ≤ 输入视频帧数;官方按视频帧数动态计算)
    steps: int = 8     # 一阶段采样步数(8 = 官方 sigma 表原值)
    seed: int = field(default_factory=_random_seed)
    # 二阶段精修(预留):latent 2× 上采样 + 3 步再采样,官方 Two_Stage 链路,耗时约翻倍
    two_stage: bool = False
    upscale_model: str = DEFAULT_LIPDUB_UPSCALER
    filename_prefix: str = "ToIV_ltx2_lipdub"


def _build_base_chain(p: LtxT2VParams) -> tuple[dict, list]:
    """基础节点链(UNETLoader + Gemma CLIP + VAE + 正负向编码),t2v/i2v/lipsync 共用。

    返回 (图, 采样侧 model 引用)。p.loras 非空时在 UNET 之后、采样之前插入
    LoraLoader 叠加链(txt2img 同款模式):CLIP 正负向编码改接链末端 clip,
    下游(KSampler / ID LoRA)的 model 引用取链末端。空 loras 时引用直回
    UNET/Gemma,图与未加 LoRA 时完全一致。
    """
    # LtxLipsyncParams 无 loras 字段(用独立 id_lora),getattr 兜底保持三路共用
    loras: tuple[LoraSpec, ...] = getattr(p, "loras", ()) or ()
    lora_nodes, model_ref, clip_ref = lora_chain(
        loras, src_model=["1", 0], src_clip=["2", 0]
    )
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": p.unet_name, "weight_dtype": "default"}},
        "2": {"class_type": "LTXVGemmaCLIPModelLoader", "inputs": {
            "gemma_path": p.gemma_name, "ltxv_path": p.unet_name, "max_length": p.max_length}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": p.vae_name}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": clip_ref}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": clip_ref}},
        **lora_nodes,
    }
    return g, model_ref


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
    g, model_src = _build_base_chain(p)
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
            "model": model_src,
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
    g, model_src = _build_base_chain(p)
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
            "model": model_src,
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
    # 基础链(loras 空 → model_src 直引 UNET)
    g, model_src = _build_base_chain(p)
    # ID LoRA 挂载(声音/角色一致性)
    if p.id_lora:
        g["3"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": model_src, "lora_name": p.id_lora, "strength_model": p.id_lora_strength},
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


# ──────────────────────────────────────────────────────────────
# LipDub(IC-LoRA 视频重配音对口型)
# ──────────────────────────────────────────────────────────────


def _iclora_guide_inputs(positive: list, negative: list, vae: list, latent: list, image: list) -> dict:
    """LTXAddVideoICLoRAGuide 输入(官方默认:tiled VAE 编码 256/64,全分辨率参考)。

    latent_downscale_factor=1:lipdub LoRA 按 reference_downscale_factor=1 训练
    (官方 Note:IC-LoRA Loader 输出的 downscale factor 被有意忽略)。
    """
    return {
        "positive": positive,
        "negative": negative,
        "vae": vae,
        "latent": latent,
        "image": image,
        "frame_idx": 0,
        "strength": 1.0,
        "latent_downscale_factor": 1.0,
        "crop": "disabled",
        "use_tiled_encode": True,
        "tile_size": 256,
        "tile_overlap": 64,
    }


def _resize_node(src: list, width: int, height: int) -> dict:
    """引导帧缩放到目标分辨率(官方两段式各有 s1/s2 两个 ResizeImageMaskNode)。

    COMFY_DYNAMICCOMBO_V3 动态子输入在 API 格式下以 "resize_type.<name>" 命名
    (worker /prompt 400 实测:input_name 为 resize_type.width 等)。
    """
    return {
        "class_type": "ResizeImageMaskNode",
        "inputs": {
            "input": src,
            "resize_type": "scale dimensions",
            "resize_type.width": width,
            "resize_type.height": height,
            "resize_type.crop": "disabled",
            "scale_method": "area",
        },
    }


def build_ltx_lipdub_graph(p: LtxLipdubParams) -> dict:
    """LTX-2.3 LipDub(视频重配音对口型),单阶段 distilled;two_stage=True 追加官方二阶段。

    节点链:
      CheckpointLoaderSimple(22B distilled)→ LTXICLoRALoaderModelOnly(lipdub IC-LoRA)
      LTXAVTextEncoderLoader(Gemma)→ CLIPTextEncode → LTXVConditioning(frame_rate←视频 fps)
      LoadVideo → GetVideoComponents ┬ images → ResizeImageMaskNode → LTXAddVideoICLoRAGuide
                                     └ audio(或 LoadAudio 新音频)→ LTXVAudioVAEEncode
                                       → LTXVSetAudioRefTokens(嗓音参考)
      EmptyLTXVLatentVideo + LTXVEmptyLatentAudio → LTXVConcatAVLatent
      → SamplerCustomAdvanced(RandomNoise + CFGGuider(cfg=1) + euler + distilled sigmas)
      → LTXVSeparateAVLatent → LTXVCropGuides
      → LTXVTiledVAEDecode + LTXVAudioVAEDecode → CreateVideo → SaveVideo
    二阶段(two_stage):LTXVLatentUpsampler(2×)→ 全尺寸引导 → 3 步精修后再解码。
    """
    g: dict = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": p.ckpt_name}},
        "2": {"class_type": "LTXAVTextEncoderLoader", "inputs": {
            "text_encoder": p.gemma_name, "ckpt_name": p.ckpt_name, "device": "default"}},
        # 音频 VAE 与视频 VAE 均由 22B checkpoint 提供(官方同)
        "3": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": p.ckpt_name}},
        "4": {"class_type": "LTXICLoRALoaderModelOnly", "inputs": {
            "model": ["1", 0], "lora_name": p.lipdub_lora, "strength_model": p.lipdub_lora_strength}},
        "5": {"class_type": "LoadVideo", "inputs": {"file": p.video}},
        "6": {"class_type": "GetVideoComponents", "inputs": {"video": ["5", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["2", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["2", 0]}},
        # frame_rate 跟输入视频走(官方同),驱动采样条件与输出封装 fps
        "9": {"class_type": "LTXVConditioning", "inputs": {
            "positive": ["7", 0], "negative": ["8", 0], "frame_rate": ["6", 2]}},
        "10": _resize_node(["6", 0], p.width, p.height),
        "11": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": p.width, "height": p.height, "length": p.length, "batch_size": 1}},
        "12": {"class_type": "LTXFloatToInt", "inputs": {"a": ["6", 2]}},
        "13": {"class_type": "LTXVEmptyLatentAudio", "inputs": {
            "frames_number": p.length, "frame_rate": ["12", 0], "batch_size": 1,
            "audio_vae": ["3", 0]}},
    }
    # 嗓音参考:显式新音频(TTS 等)优先,缺省用原视频音轨(官方默认)
    audio_src = ["6", 1]
    if p.audio:
        g["16"] = {"class_type": "LoadAudio", "inputs": {"audio": p.audio}}
        audio_src = ["16", 0]
    g["15"] = {"class_type": "LTXVAudioVAEEncode", "inputs": {
        "audio": audio_src, "audio_vae": ["3", 0]}}
    # 一阶段:视频引导 + 音频参考 tokens → AV latent 拼接 → 采样
    g["14"] = {"class_type": "LTXAddVideoICLoRAGuide", "inputs": _iclora_guide_inputs(
        ["9", 0], ["9", 1], ["1", 2], ["11", 0], ["10", 0])}
    g["17"] = {"class_type": "LTXVSetAudioRefTokens", "inputs": {
        "positive": ["14", 0], "negative": ["14", 1], "audio_latent": ["15", 0]}}
    g["18"] = {"class_type": "LTXVConcatAVLatent", "inputs": {
        "video_latent": ["14", 2], "audio_latent": ["13", 0]}}
    g["19"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed}}
    g["20"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    g["21"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": _distilled_sigmas(p.steps)}}
    g["22"] = {"class_type": "CFGGuider", "inputs": {
        "model": ["4", 0], "positive": ["17", 0], "negative": ["17", 1], "cfg": 1.0}}
    g["23"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": ["19", 0], "guider": ["22", 0], "sampler": ["20", 0],
        "sigmas": ["21", 0], "latent_image": ["18", 0]}}
    g["24"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["23", 0]}}
    g["25"] = {"class_type": "LTXVCropGuides", "inputs": {
        "positive": ["14", 0], "negative": ["14", 1], "latent": ["24", 0]}}

    video_latent, audio_latent = ["25", 2], ["24", 1]
    if p.two_stage:
        # 二阶段:latent 2× 上采样 → 全尺寸引导 → 3 步精修(音频冻结为一阶段结果)
        g["30"] = {"class_type": "LatentUpscaleModelLoader", "inputs": {"model_name": p.upscale_model}}
        g["31"] = {"class_type": "LTXVLatentUpsampler", "inputs": {
            "samples": ["25", 2], "upscale_model": ["30", 0], "vae": ["1", 2]}}
        g["32"] = {"class_type": "LTXVSetAudioRefTokens", "inputs": {
            "positive": ["25", 0], "negative": ["25", 1], "audio_latent": ["24", 1]}}
        g["33"] = _resize_node(["6", 0], p.width * 2, p.height * 2)
        g["34"] = {"class_type": "LTXAddVideoICLoRAGuide", "inputs": _iclora_guide_inputs(
            ["32", 0], ["32", 1], ["1", 2], ["31", 0], ["33", 0])}
        g["35"] = {"class_type": "CFGGuider", "inputs": {
            "model": ["4", 0], "positive": ["34", 0], "negative": ["34", 1], "cfg": 1.0}}
        g["36"] = {"class_type": "LTXVConcatAVLatent", "inputs": {
            "video_latent": ["34", 2], "audio_latent": ["32", 2]}}
        g["37"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed + 1}}
        g["38"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
        g["39"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": _DISTILLED_SIGMAS_S2}}
        g["40"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["37", 0], "guider": ["35", 0], "sampler": ["38", 0],
            "sigmas": ["39", 0], "latent_image": ["36", 0]}}
        g["41"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["40", 0]}}
        g["42"] = {"class_type": "LTXVCropGuides", "inputs": {
            "positive": ["34", 0], "negative": ["34", 1], "latent": ["41", 0]}}
        video_latent, audio_latent = ["42", 2], ["41", 1]

    # 解码 + 封装(视频 tiled 解码省显存;fps 跟输入视频)
    g["26"] = {"class_type": "LTXVTiledVAEDecode", "inputs": {
        "vae": ["1", 2], "latents": video_latent,
        "horizontal_tiles": 2, "vertical_tiles": 2, "overlap": 6,
        "last_frame_fix": False, "working_device": "auto", "working_dtype": "auto"}}
    g["27"] = {"class_type": "LTXVAudioVAEDecode", "inputs": {
        "samples": audio_latent, "audio_vae": ["3", 0]}}
    g["28"] = {"class_type": "CreateVideo", "inputs": {
        "images": ["26", 0], "fps": ["6", 2], "audio": ["27", 0]}}
    g["29"] = {"class_type": "SaveVideo", "inputs": {
        "video": ["28", 0], "filename_prefix": p.filename_prefix,
        "format": "auto", "codec": "auto"}}
    return g
