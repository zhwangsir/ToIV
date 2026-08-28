"""LTX-2.5 Multishot 一键多镜头工作流构造器。

LTX-2.5(Lightricks,22B)原生音画单次同出 + Multishot:单次生成多镜头,
角色/环境/光线/嗓音跨切一致。Multishot 是模型原生能力,经**单 prompt 分镜
描述**触发(官方建议 2-4 镜;每镜一职 establishing→detail→reaction;重复
角色识别细节;声明音频跨切连续性)。

本构造器按 ComfyUI 官方 LTX-2.5 T2V 模板(video_ltx2_5_t2v.json,0.32+ 原生
节点)实现两阶段 DFR(Diffusion Fidelity Rendering)采样链:
  一阶段:半分辨率结构采样(ManualSigmas 8 步)→ LTXVLatentUpsampler 2×
  二阶段:全分辨率细节渲染(ManualSigmas 3 步,起点 0.85 局部重绘)
  音画:LTXVEmptyLatentAudio 与视频 latent 合流(LTXVConcatAVLatent)联合采样,
  尾部分离(LTXVSeparateAVLatent,slot0=video/slot1=audio)各经 VAEDecodeTiled /
  LTXVAudioVAEDecode,CreateVideo 合流 → SaveVideo。
  audio=False 仅跳过音频解码与挂轨,采样链不变——LTX-2.5 是音画联合
  transformer,音频 latent 必须参与采样,纯静音输出不能靠移除音频 latent 实现。

与 2026-08-23 退役的旧 LTX-2.5 实例(:8198,自定义节点包单镜头链路)无关:
本构造器走 0.32+ 原生节点 + NVFP4 蒸馏 transformer(5090 FP4 加速)。

官方 prompt enhancer(TextGenerateLTX2Prompt,需 gemma4_e2b_it_int8_convrot)
与 auto duration(LTXVDurationPredictor + duration head)本期不接入:
multishot 分镜 prompt 由调用方按镜头结构化,时长显式求和,语义更可控。
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

MIN_SHOTS = 2
MAX_SHOTS = 4  # 官方 multishot 一致性窗口 2-4 镜,超出跨镜一致性显著退化
MAX_TOTAL_SECONDS = 20  # 官方单条时长上限 20s

# ── LTX-2.5 资产(NAS toiv/comfyui-models 平铺,worker extra_model_paths toiv: 段可见)──
DEFAULT_LTX25_UNET = os.environ.get(
    "TOIV_LTX25_UNET", "ltx-2.5-22b-distilled-transformer-nvfp4.safetensors"
)
DEFAULT_LTX25_GEMMA = os.environ.get(
    "TOIV_LTX25_GEMMA", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
)
DEFAULT_LTX25_VIDEO_VAE = os.environ.get(
    "TOIV_LTX25_VIDEO_VAE", "ltx-2.5-video-vae-bf16.safetensors"
)
DEFAULT_LTX25_AUDIO_VAE = os.environ.get(
    "TOIV_LTX25_AUDIO_VAE", "ltx-2.5-audio-vae-bf16.safetensors"
)
DEFAULT_LTX25_UPSCALER = os.environ.get(
    "TOIV_LTX25_UPSCALER", "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
)
# 官方模板固定负向(抑制游戏/卡通质感)
DEFAULT_LTX25_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly"

# 官方 distilled sigma 表:一阶段 8 步(结构),二阶段 3 步(0.85 起点局部重绘)
_SIGMAS_STAGE1 = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
_SIGMAS_STAGE2 = "0.85, 0.725, 0.4219, 0.0"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class LtxShot:
    """单个镜头:分镜描述 + 时长(秒)。跨镜一致性细节(角色/服装/场景/嗓音)由 prompt 文本承载。"""

    prompt: str
    seconds: int = 4


@dataclass(frozen=True)
class LtxMultishotParams:
    """LTX-2.5 Multishot 参数。"""

    shots: tuple[LtxShot, ...]
    global_style: str = ""  # 全局风格/一致性前缀(可选,置首行,如固定角色描述与影调)
    negative: str = DEFAULT_LTX25_NEGATIVE
    width: int = 1280
    height: int = 720
    fps: int = 24
    audio: bool = True  # False = 输出不挂音轨(采样链不变)
    seed: int = field(default_factory=_random_seed)
    unet_name: str = DEFAULT_LTX25_UNET
    gemma_name: str = DEFAULT_LTX25_GEMMA
    video_vae_name: str = DEFAULT_LTX25_VIDEO_VAE
    audio_vae_name: str = DEFAULT_LTX25_AUDIO_VAE
    upscaler_name: str = DEFAULT_LTX25_UPSCALER
    filename_prefix: str = "ToIV_ltx_ms"


def compose_multishot_prompt(shots: tuple[LtxShot, ...] | list[LtxShot], global_style: str = "") -> str:
    """shots → 单 prompt 分镜文本(每镜独立段,标镜头号与时长,官方 multishot 格式)。"""
    parts: list[str] = []
    if global_style.strip():
        parts.append(global_style.strip())
    for i, s in enumerate(shots, 1):
        parts.append(f"Shot {i} ({s.seconds} seconds): {s.prompt.strip()}")
    return "\n".join(parts)


def total_seconds(shots: tuple[LtxShot, ...] | list[LtxShot]) -> int:
    return sum(s.seconds for s in shots)


def total_frames(shots: tuple[LtxShot, ...] | list[LtxShot], fps: int) -> int:
    """LTX 帧网格:frames = fps × 总秒 + 1,且必须满足 8n+1。"""
    secs = total_seconds(shots)
    frames = secs * fps + 1
    if (frames - 1) % 8 != 0:
        raise ValueError(f"fps({fps}) × 总时长({secs}s) 不满足 8n+1 帧网格")
    return frames


def validate_multishot(p: LtxMultishotParams) -> None:
    if not (MIN_SHOTS <= len(p.shots) <= MAX_SHOTS):
        raise ValueError(f"镜头数须 {MIN_SHOTS}-{MAX_SHOTS}(官方 multishot 一致性窗口),实收 {len(p.shots)}")
    secs = total_seconds(p.shots)
    if secs > MAX_TOTAL_SECONDS:
        raise ValueError(f"总时长 {secs}s 超上限 {MAX_TOTAL_SECONDS}s")
    for i, s in enumerate(p.shots, 1):
        if not s.prompt.strip():
            raise ValueError(f"镜头 {i} prompt 为空")
        if not (1 <= s.seconds <= 10):
            raise ValueError(f"镜头 {i} 时长 {s.seconds}s 越界(1-10s)")
    if p.width % 16 or p.height % 16:
        raise ValueError("width/height 须为 16 倍数(两阶段:半分辨结构采样 + 2× latent 上采样,latent 8× 压缩)")
    total_frames(p.shots, p.fps)  # 帧网格校验(非法抛 ValueError)


def build_ltx_multishot_graph(p: LtxMultishotParams) -> dict:
    """LTX-2.5 Multishot 两阶段音画图(与官方模板同构)。"""
    validate_multishot(p)
    frames = total_frames(p.shots, p.fps)
    prompt = compose_multishot_prompt(p.shots, p.global_style)
    half_w, half_h = p.width // 2, p.height // 2

    g: dict[str, dict] = {}
    # ── 加载器 ──
    g["1"] = {"class_type": "UNETLoader", "inputs": {"unet_name": p.unet_name, "weight_dtype": "default"}}
    g["2"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": p.gemma_name, "type": "ltxv"}}
    g["3"] = {"class_type": "VAELoader", "inputs": {"vae_name": p.video_vae_name}}
    g["4"] = {"class_type": "VAELoader", "inputs": {"vae_name": p.audio_vae_name}}
    g["5"] = {"class_type": "LatentUpscaleModelLoader", "inputs": {"model_name": p.upscaler_name}}
    # ── 条件(multishot 分镜 prompt 注入点)──
    g["6"] = {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}}
    g["7"] = {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["2", 0]}}
    g["8"] = {
        "class_type": "LTXVConditioning",
        "inputs": {"positive": ["6", 0], "negative": ["7", 0], "frame_rate": float(p.fps)},
    }
    # ── 空 latent(音画合流;视频半分辨起步)──
    g["9"] = {
        "class_type": "EmptyLTXVLatentVideo",
        "inputs": {"width": half_w, "height": half_h, "length": frames, "batch_size": 1},
    }
    g["10"] = {
        "class_type": "LTXVEmptyLatentAudio",
        "inputs": {
            "frames_number": frames,
            "frame_rate": float(p.fps),
            "batch_size": 1,
            "audio_vae": ["4", 0],
        },
    }
    g["11"] = {
        "class_type": "LTXVConcatAVLatent",
        "inputs": {"video_latent": ["9", 0], "audio_latent": ["10", 0]},
    }
    # ── 一阶段:半分辨结构采样(distilled CFG=1)──
    g["12"] = {
        "class_type": "LTXVDualCFGGuider",
        "inputs": {"model": ["1", 0], "positive": ["8", 0], "negative": ["8", 1], "video_cfg": 1.0, "audio_cfg": 1.0},
    }
    g["13"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed}}
    g["14"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral"}}
    g["15"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": _SIGMAS_STAGE1}}
    g["16"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {"noise": ["13", 0], "guider": ["12", 0], "sampler": ["14", 0], "sigmas": ["15", 0], "latent_image": ["11", 0]},
    }
    # ── latent 2× 上采样(音频 latent 直通)──
    g["17"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["16", 0]}}
    g["18"] = {
        "class_type": "LTXVLatentUpsampler",
        "inputs": {"samples": ["17", 0], "upscale_model": ["5", 0], "vae": ["3", 0]},
    }
    g["19"] = {
        "class_type": "LTXVConcatAVLatent",
        "inputs": {"video_latent": ["18", 0], "audio_latent": ["17", 1]},
    }
    # ── 二阶段:全分辨细节渲染(新噪声,0.85 起点)──
    g["20"] = {
        "class_type": "LTXVDualCFGGuider",
        "inputs": {"model": ["1", 0], "positive": ["8", 0], "negative": ["8", 1], "video_cfg": 1.0, "audio_cfg": 1.0},
    }
    g["21"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed + 1}}
    g["22"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral"}}
    g["23"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": _SIGMAS_STAGE2}}
    g["24"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {"noise": ["21", 0], "guider": ["20", 0], "sampler": ["22", 0], "sigmas": ["23", 0], "latent_image": ["19", 0]},
    }
    # ── 解码输出 ──
    g["25"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["24", 0]}}
    g["26"] = {
        "class_type": "VAEDecodeTiled",
        "inputs": {"samples": ["25", 0], "vae": ["3", 0], "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 16},
    }
    create_inputs: dict = {"images": ["26", 0], "fps": float(p.fps)}
    if p.audio:
        g["27"] = {
            "class_type": "LTXVAudioVAEDecode",
            "inputs": {"samples": ["25", 1], "audio_vae": ["4", 0]},
        }
        create_inputs["audio"] = ["27", 0]
    g["28"] = {"class_type": "CreateVideo", "inputs": create_inputs}
    g["29"] = {
        "class_type": "SaveVideo",
        "inputs": {"video": ["28", 0], "filename_prefix": p.filename_prefix, "format": "auto", "codec": "auto"},
    }
    return g
