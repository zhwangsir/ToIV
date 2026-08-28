"""Ovi 1.1 音画联合生成工作流构建 —— t2v / i2v(语音+音效与画面同步直出)。

Ovi(Character AI,Apache 2.0):Wan2.2-5B 视频骨干 + 音频骨干双塔跨模态融合,
文本/图 → 10s@960×960 带音轨视频(语音对口型 + 环境音效),补 Wan/LongCat 无原生音频的短板。
跑在 :8197 专用实例(Kijai ComfyUI-WanVideoWrapper ≥ 2026-05,与 LongCat 同实例)。

节点链(照搬 wrapper example_workflows/wanvideo_2_2_5B_Ovi_*_10_seconds_example_01.json,
实例 /object_info 已核实节点注册齐全):
  WanVideoBlockSwap(34) → WanVideoModelLoader(Ovi 双塔融合权重,bf16/offload/sdpa)
  WanVideoTextEncodeCached(主:画面+台词+音频描述正负提示词)
  WanVideoTextEncodeCached(音频负向:positive="", negative=audio_negative)→ 第 2 输出
  → WanVideoOviCFG(ovi_audio_cfg=3.0,音频负嵌入取上面第 2 输出)
  WanVideoEmptyEmbeds(宽高/帧数;i2v 经 extra_latents 接首帧 WanVideoEncode)
  WanVideoEmptyMMAudioLatents(音频潜长度,与帧数联动)→ WanVideoSampler.samples
  → WanVideoDecode(画面) + WanVideoDecodeOviAudio(mmaudio VAE+BigVGAN 声码器 → AUDIO)
  → VHS_VideoCombine(audio 输入 → h264-mp4 带音轨,产物链路与 H3 音画成片同路)

提示词格式(wrapper 官方 note,硬约束):
  · 台词必须包在 <S>…<E> 标签内(MANDATORY,缺了不出人声);多段台词可多对 <S>/<E>
  · 新版模型(960x960_10s)音频描述跟在主提示词后,以 "Audio:" 开头
    (旧 5s 模型的 <AUDCAP> 格式不适用,勿混用)
  · assemble_ovi_prompt 确定性拼装:画面描述 + <S>台词</E> + Audio: 音频描述

关键约束(踩坑预防):
  · base_precision 必须 bf16(官方 note:fp16 会出黑屏);fp8_scaled 权重 quantization=disabled
    (KJ 缩放版权重自带 scale,与 LongCat fp8 同款加载语义)
  · 音频潜长度与帧数锚定:121 帧→157、241 帧→314(示例实测两锚点,
    公式 round((num_frames-1)*31.25/24 + 1) 两锚点均命中;示例 note 称改动为实验性)
  · 模型文件平铺 NAS 根目录(勿入子目录,SMB 授权不继承,pc worker 不可见)
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS toiv/comfyui-models,全部平铺根目录)
DEFAULT_MODEL = "Wan2_2-5B-Ovi_960x960_10s_fp8_e4m3fn_scaled_KJ.safetensors"  # diffusion_models/
DEFAULT_T5 = "umt5-xxl-enc-bf16.safetensors"  # text_encoders/
DEFAULT_VAE = "Wan2_2_VAE_bf16.safetensors"  # vae/(Wan2.2 TI2V 5B 专用,与 2.1 VAE 不通用)
DEFAULT_AUDIO_VAE = "mmaudio_vae_16k_bf16.safetensors"  # vae/(OviMMAudioVAELoader 读 vae 目录)
DEFAULT_AUDIO_VOCODER = "mmaudio_vocoder_bigvgan_best_netG_bf16.safetensors"  # vae/

# 示例工作流默认负向提示词(画面 / 音频分列,两者可对不同模型分别生效)
DEFAULT_NEGATIVE = "jitter, bad hands, blur, distortion"
DEFAULT_AUDIO_NEGATIVE = "robotic, muffled, echo, distorted"

# 音频潜长度:31.25 latents/s(16kHz mmaudio VAE 下采样率),与 24fps 帧数联动
_AUDIO_LATENTS_PER_FRAME = 31.25 / 24


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def audio_latent_length(num_frames: int) -> int:
    """帧数 → 音频潜序列长度。锚点:121 帧→157、241 帧→314(官方示例实测)。"""
    return round((num_frames - 1) * _AUDIO_LATENTS_PER_FRAME + 1)


def assemble_ovi_prompt(positive: str, speech: str = "", audio_caption: str = "") -> str:
    """确定性拼装 Ovi 提示词:画面描述 + <S>台词<E> + Audio: 音频描述。

    positive 已含 <S> 时视为用户自带完整格式,不再追加 speech(防双重包裹);
    speech/audio_caption 均空时原样返回(纯环境音场景,Ovi 仍会从画面推理音效)。
    """
    parts = [positive.strip()]
    speech = speech.strip()
    audio_caption = audio_caption.strip()
    if speech and "<S>" not in positive:
        parts.append(f"<S>{speech}<E>")
    if audio_caption and "Audio:" not in positive:
        parts.append(f"Audio: {audio_caption}")
    return " ".join(p for p in parts if p)


@dataclass(frozen=True)
class OviT2VParams:
    """Ovi 文生音画参数。positive 为完整拼装后的提示词(经 assemble_ovi_prompt)。

    num_frames 4n+1(Wan 时序网格),默认 241≈10s@24fps(模型训练甜点);
    短档 121≈5s。fps 仅影响 VHS 打包帧率(模型原生 24fps,别动)。
    """

    positive: str
    negative: str = DEFAULT_NEGATIVE
    audio_negative: str = DEFAULT_AUDIO_NEGATIVE
    width: int = 960
    height: int = 960
    num_frames: int = 241
    steps: int = 50  # 非蒸馏满血采样(示例值;无加速 LoRA 生态)
    cfg: float = 4.0  # 视频 CFG(示例值)
    shift: float = 5.0
    ovi_audio_cfg: float = 3.0  # 音频 CFG(示例值;0=关闭音频引导)
    fps: int = 24
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    audio_vae_name: str = DEFAULT_AUDIO_VAE
    audio_vocoder_name: str = DEFAULT_AUDIO_VOCODER
    blocks_to_swap: int = 34  # 示例值;GPU0 与 LongCat/池实例共卡,全程 offload 压峰值
    filename_prefix: str = "ToIV_ovi/t2v"


@dataclass(frozen=True)
class OviI2VParams(OviT2VParams):
    """Ovi 图生音画参数:在 t2v 基础上加首帧参考图(实例 input 目录文件名)。"""

    image: str = ""
    filename_prefix: str = "ToIV_ovi/i2v"


def build_ovi_t2v_graph(p: OviT2VParams) -> dict:
    """参数 → ComfyUI API 格式图(节点 id 编排与官方 10s 示例同构,便于对照)。"""
    return {
        "1": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": p.blocks_to_swap, "offload_img_emb": True, "offload_txt_emb": True}},
        "2": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16",  # 官方 note:fp16 出黑屏,恒 bf16
            "quantization": "disabled",  # KJ fp8_scaled 权重自带 scale,勿再量化
            "load_device": "offload_device", "attention_mode": "sdpa",
            "lora": None, "block_swap_args": ["1", 0]}},
        "3": {"class_type": "WanVideoTextEncodeCached", "inputs": {
            "model_name": p.t5_name, "precision": "bf16",
            "positive_prompt": p.positive, "negative_prompt": p.negative,
            "quantization": "disabled", "use_disk_cache": True, "device": "gpu"}},
        "4": {"class_type": "WanVideoTextEncodeCached", "inputs": {
            "model_name": p.t5_name, "precision": "bf16",
            # 音频负向编码:positive 留空,负向文本走 negative_prompt;
            # 第 2 输出 = {"prompt_embeds": negative_prompt_embeds},供 OviCFG 取用
            "positive_prompt": "", "negative_prompt": p.audio_negative,
            "quantization": "disabled", "use_disk_cache": True, "device": "gpu"}},
        "5": {"class_type": "WanVideoOviCFG", "inputs": {
            "original_text_embeds": ["3", 0], "ovi_audio_cfg": p.ovi_audio_cfg,
            "ovi_negative_text_embeds": ["4", 1]}},
        "6": {"class_type": "WanVideoEmptyEmbeds", "inputs": {
            "width": p.width, "height": p.height, "num_frames": p.num_frames}},
        "7": {"class_type": "WanVideoEmptyMMAudioLatents", "inputs": {
            "length": audio_latent_length(p.num_frames)}},
        "8": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["2", 0], "image_embeds": ["6", 0], "text_embeds": ["5", 0],
            "samples": ["7", 0],  # 音频潜注入采样器(音画联合去噪)
            "steps": p.steps, "cfg": p.cfg, "shift": p.shift, "seed": p.seed,
            "force_offload": True, "scheduler": "euler",  # 示例用 euler(非节点默认 unipc)
            "riflex_freq_index": 0, "rope_function": "default"}},  # Ovi 示例值(LongCat 的 comfy 约束不适用)
        "9": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name, "precision": "bf16"}},
        "10": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["9", 0], "samples": ["8", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        "11": {"class_type": "OviMMAudioVAELoader", "inputs": {
            "vae": p.audio_vae_name, "vocoder": p.audio_vocoder_name, "precision": "bf16"}},
        "12": {"class_type": "WanVideoDecodeOviAudio", "inputs": {
            "mmaudio_vae": ["11", 0], "samples": ["8", 0]}},
        "13": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["10", 0], "audio": ["12", 0],  # 音轨打进 mp4(与 H3 音画产物同路)
            "frame_rate": float(p.fps), "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }


def build_ovi_i2v_graph(p: OviI2VParams) -> dict:
    """i2v 图:t2v 骨架 + 首帧编码支路(节点 14/15/16,编号接 t2v 之后便于对照)。

    连线照搬官方示例:LoadImage → ImageResizeKJv2(lanczos/crop,32 对齐)
    → WanVideoEncode(VAE 编码)→ WanVideoEmptyEmbeds.extra_latents。
    """
    graph = build_ovi_t2v_graph(p)
    graph["6"]["inputs"]["extra_latents"] = ["16", 0]
    graph["14"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    graph["15"] = {"class_type": "ImageResizeKJv2", "inputs": {
        "image": ["14", 0], "width": p.width, "height": p.height,
        "upscale_method": "lanczos", "keep_proportion": "crop",
        "pad_color": "0, 0, 0", "crop_position": "center",
        "divisible_by": 32, "device": "cpu"}}
    graph["16"] = {"class_type": "WanVideoEncode", "inputs": {
        "vae": ["9", 0], "image": ["15", 0], "enable_vae_tiling": False,
        "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}}
    return graph


# 引擎登记所需的模型清单(供主控注册 engine spec / 模型健康检查引用)
def required_models(p: OviT2VParams | None = None) -> dict[str, str]:
    p = p or OviT2VParams(positive="")
    return {
        "diffusion_models": p.model_name,
        "text_encoders": p.t5_name,
        "vae": p.vae_name,
        "vae_audio": p.audio_vae_name,
        "vae_vocoder": p.audio_vocoder_name,
    }
