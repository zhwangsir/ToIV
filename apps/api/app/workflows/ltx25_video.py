"""LTX-2.5 视频生成(t2v / i2v)API 工作流构造器 —— SFW 主力视频链路。

LTX-2.5 是 Lightricks 的 22B 音视频基础模型(2026-07 发布),原生音画同构:
DiT 同时生成视频 latent + 音频 latent(AV latent 拼接采样),输出自带音轨。
本构造器按官方 2.5 单阶段蒸馏模板(LTX-2.5_T2V_I2V_Single_Stage_Distilled.json)
的核心节点链实现,替换原 SFW LTX-2.3 链路(NSFW 仍走 2.3 + 10Eros)。

部署形态:GPU0 专用实例 ComfyUI :8198(ComfyUI 0.32.x,与生产 :8189 隔离),
权重在 workstation /home/merlin/models/ltx25/(extra_model_paths 注册):
  · diffusion_models/ltx-2.5-22b-distilled-transformer-nvfp4.safetensors (18.7GB,nvfp4 量化)
  · text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors (15.4GB)
    —— 内嵌 text_embedding_projection.* + tokenizer_json(with-proj)
  · vae/ltx-2.5-video-vae-bf16.safetensors / ltx-2.5-audio-vae-bf16.safetensors
  · checkpoints/ 下软链同名 transformer —— LTXAVTextEncoderLoader.ckpt_name 只扫
    checkpoints 类目,需从中抽 model.diffusion_model.*_embeddings_connector.* 键
    (comfy/text_encoders/lt.py LTXAVTEModel.load_state_dict;同易错点 21 的键布局陷阱)

节点链(t2v):
  UNETLoader(nvfp4 transformer) → LTXAVTextEncoderLoader(gemma4+connector ckpt)
  → CLIPTextEncode ×2 → LTXVConditioning(frame_rate)
  EmptyLTXVLatentVideo + LTXVEmptyLatentAudio(← VAELoader audio-vae)→ LTXVConcatAVLatent
  → SamplerCustomAdvanced(RandomNoise + CFGGuider(cfg=1) + euler_ancestral + 蒸馏 sigmas)
  → LTXVSeparateAVLatent → VAEDecodeTiled(video) + LTXVAudioVAEDecode(audio)
  → CreateVideo → SaveVideo

i2v 在 t2v 基础上:LoadImage → LTXVPreprocess(img_compression=18)
  → LTXVImgToVideoInplace(首帧引导,inplace 写入空视频 latent)→ 同链采样

关键参数(官方蒸馏单阶段):
  · 分辨率 960×544(32 对齐),cfg=1 固定(蒸馏),euler_ancestral
  · 8 步蒸馏 sigma 原表(与 2.3 同曲线,复用 _distilled_sigmas)
  · 帧数 8k+1 网格(121≈5s @24fps),官方默认 24fps
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field

from app.workflows.ltx_video import _distilled_sigmas

MAX_SEED = 2**63 - 1

# LTX-2.5 权重(:8198 实例 extra_model_paths 可见;环境变量可覆盖)
DEFAULT_LTX25_UNET = os.environ.get(
    "TOIV_LTX25_UNET", "ltx-2.5-22b-distilled-transformer-nvfp4.safetensors"
)
# gemma4 12B with-proj:自带 text_embedding_projection.* + tokenizer_json;
# ckpt 参数从 checkpoints 类目的 transformer 软链抽 embeddings_connector 键
DEFAULT_LTX25_TEXT_ENCODER = os.environ.get(
    "TOIV_LTX25_TEXT_ENCODER", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
)
DEFAULT_LTX25_VIDEO_VAE = os.environ.get("TOIV_LTX25_VIDEO_VAE", "ltx-2.5-video-vae-bf16.safetensors")
DEFAULT_LTX25_AUDIO_VAE = os.environ.get("TOIV_LTX25_AUDIO_VAE", "ltx-2.5-audio-vae-bf16.safetensors")

# 官方蒸馏单阶段固定采样配置:cfg=1 + euler_ancestral + 8 步蒸馏 sigma 表
_LTX25_SAMPLER = "euler_ancestral"
_LTX25_STEPS = 8
_LTX25_CFG = 1.0
# i2v 首帧图像压缩(官方模板 LTXVPreprocess widgets=18)
_LTX25_IMG_COMPRESSION = 18


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class Ltx25T2VParams:
    """LTX-2.5 文生视频参数(蒸馏单阶段,音画同出)。"""
    positive: str
    negative: str = ""
    unet_name: str = DEFAULT_LTX25_UNET
    text_encoder_name: str = DEFAULT_LTX25_TEXT_ENCODER
    video_vae_name: str = DEFAULT_LTX25_VIDEO_VAE
    audio_vae_name: str = DEFAULT_LTX25_AUDIO_VAE
    width: int = 960    # 官方默认(32 对齐)
    height: int = 544
    length: int = 121   # 5s @24fps,8k+1 网格
    fps: int = 24       # 官方 conditioning 默认 24fps
    steps: int = _LTX25_STEPS  # 蒸馏 8 步(映射官方 sigma 曲线)
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_ltx25_vid"


@dataclass(frozen=True)
class Ltx25I2VParams(Ltx25T2VParams):
    """LTX-2.5 图生视频参数(首帧引导)。"""
    image: str = ""
    # 首帧条件强度(官方模板默认 0.7;1.0 = 完全锁定首帧)
    strength: float = 0.7


def _build_av_condition_chain(p: Ltx25T2VParams) -> dict:
    """模型 + 编码 + AV latent 拼接链(t2v/i2v 共用段)。

    返回图含:UNET(1) / 文本编码器(2) / 双 VAE(3 video,4 audio) /
    正负向文本编码(7,8) / LTXV 条件化(9) / 空视频 latent(10) / 空音频 latent(11)。
    """
    return {
        # nvfp4 蒸馏 transformer(UNETLoader,diffusion_models 类目)
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": p.unet_name, "weight_dtype": "default"}},
        # gemma4 12B 文本编码器;ckpt_name 抽 transformer 的 embeddings_connector 键
        "2": {"class_type": "LTXAVTextEncoderLoader", "inputs": {
            "text_encoder": p.text_encoder_name, "ckpt_name": p.unet_name, "device": "default"}},
        # 视频/音频 VAE 独立文件(VAELoader,vae 类目)
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": p.video_vae_name}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": p.audio_vae_name}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["2", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["2", 0]}},
        # LTXV 条件化(注入 frame_rate)
        "9": {"class_type": "LTXVConditioning", "inputs": {
            "positive": ["7", 0], "negative": ["8", 0], "frame_rate": float(p.fps)}},
        # 空白视频 latent(t2v 直用;i2v 经 LTXVImgToVideoInplace 写入首帧)
        "10": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": p.width, "height": p.height, "length": p.length, "batch_size": 1}},
        # 空白音频 latent(帧数/帧率与视频对齐,形状由 audio VAE 推导)
        "11": {"class_type": "LTXVEmptyLatentAudio", "inputs": {
            "frames_number": p.length, "frame_rate": float(p.fps), "batch_size": 1,
            "audio_vae": ["4", 0]}},
    }


def _append_sample_and_output(g: dict, p: Ltx25T2VParams, video_latent: list) -> None:
    """AV 拼接 → 蒸馏采样 → 分离解码 → CreateVideo/SaveVideo 输出。"""
    # AV latent 拼接(视频 + 音频统一采样)
    g["12"] = {"class_type": "LTXVConcatAVLatent", "inputs": {
        "video_latent": video_latent, "audio_latent": ["11", 0]}}
    # 蒸馏采样:cfg=1 + euler_ancestral + 官方 sigma 曲线(8 步原表)
    g["13"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": p.seed}}
    g["14"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": _LTX25_SAMPLER}}
    g["15"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": _distilled_sigmas(p.steps)}}
    g["16"] = {"class_type": "CFGGuider", "inputs": {
        "model": ["1", 0], "positive": ["9", 0], "negative": ["9", 1], "cfg": _LTX25_CFG}}
    g["17"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": ["13", 0], "guider": ["16", 0], "sampler": ["14", 0],
        "sigmas": ["15", 0], "latent_image": ["12", 0]}}
    # 分离视频/音频 latent([0]=video [1]=audio)
    g["18"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["17", 0]}}
    # 视频 tiled 解码(官方 512/64/64/8,省显存)+ 音频解码
    g["19"] = {"class_type": "VAEDecodeTiled", "inputs": {
        "samples": ["18", 0], "vae": ["3", 0],
        "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}}
    g["20"] = {"class_type": "LTXVAudioVAEDecode", "inputs": {
        "samples": ["18", 1], "audio_vae": ["4", 0]}}
    # 封装输出(音画同出 mp4)
    g["21"] = {"class_type": "CreateVideo", "inputs": {
        "images": ["19", 0], "fps": float(p.fps), "audio": ["20", 0]}}
    g["22"] = {"class_type": "SaveVideo", "inputs": {
        "video": ["21", 0], "filename_prefix": p.filename_prefix,
        "format": "auto", "codec": "auto"}}


def build_ltx25_t2v_graph(p: Ltx25T2VParams) -> dict:
    """LTX-2.5 文生视频(音画同出,蒸馏单阶段)。"""
    g = _build_av_condition_chain(p)
    _append_sample_and_output(g, p, ["10", 0])
    return g


def build_ltx25_i2v_graph(p: Ltx25I2VParams) -> dict:
    """LTX-2.5 图生视频:首帧经 LTXVPreprocess 压缩后 inplace 写入空视频 latent。"""
    g = _build_av_condition_chain(p)
    g["5"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    g["6"] = {"class_type": "LTXVPreprocess", "inputs": {
        "image": ["5", 0], "img_compression": _LTX25_IMG_COMPRESSION}}
    # 首帧引导(inplace 改写空 latent;bypass=False 生效条件)
    g["30"] = {"class_type": "LTXVImgToVideoInplace", "inputs": {
        "vae": ["3", 0], "image": ["6", 0], "latent": ["10", 0],
        "strength": p.strength, "bypass": False}}
    _append_sample_and_output(g, p, ["30", 0])
    return g
