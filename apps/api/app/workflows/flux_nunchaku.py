"""Nunchaku SVDQuant fp4 FLUX.1-dev 文生图构造器(2026-08-28 Phase 4D)。

与 nextgen.py 的 flux2 族(UNETLoader+CLIPLoader 标准节点)不同,Nunchaku 走
ComfyUI-nunchaku 插件专用节点:SVDQuant fp4 量化 DiT 在 RTX 50 系(Blackwell
sm_120)5090 实测热跑 ~2.1s/张(vs FP8 3.1s),显存占用约减半。

节点 schema 依 pc01 :8188 /object_info 实测(2026-08-28):
  NunchakuFluxDiTLoader(model_path=enum, cache_threshold=FLOAT 0~1 默认 0,
      attention=[nunchaku-fp16|flash-attention2] 默认 nunchaku-fp16,
      cpu_offload=[auto|enable|disable], device_id=INT, data_type=[bfloat16|float16],
      optional: i2f_mode) → MODEL
  NunchakuTextEncoderLoaderV2(model_type=["flux.1"], text_encoder1=enum,
      text_encoder2=enum, t5_min_length=INT 默认 512) → CLIP

图结构对齐 Nunchaku 官方 FLUX.1-dev 示例:不挂 ModelSamplingFlux(shift 已含在
量化模型默认采样行为里);真实 CFG=1.0(FluxGuidance 承载引导强度,默认 3.5)、
euler+simple、负向失效留空(cfg=1 下本就无效)、VAELoader(ae.safetensors)。

worker pinning(2026-08-28 真机实证):svdq 权重平铺 NAS diffusion_models/ 根目录,
pc01 的 UNETLoader.unet_name 候选已覆盖(与 NunchakuFluxDiTLoader.model_path 同源
同目录);t5xxl/clip_l 由 CLIPLoader(text_encoders/)覆盖;ae 由 VAELoader 覆盖
→ pool.pick(required=required_models()) 零改动生效;required_nodes 双约束
挡住「有权重未装插件」的机。双约束交集即 Nunchaku 就绪 worker。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# ── 权重文件(NAS 平铺,pc01/pc02/workstation 经 extra_model_paths 共享可见)──
NUNCHAKU_DIT = "svdq-fp4_r32-flux.1-dev.safetensors"  # diffusion_models/(6.55GB fp4)
NUNCHAKU_T5 = "t5xxl_fp8_e4m3fn.safetensors"  # text_encoders/
NUNCHAKU_CLIP_L = "clip_l.safetensors"  # text_encoders/
NUNCHAKU_VAE = "ae.safetensors"  # vae/(FLUX.1 通用 VAE)

# 插件专用节点:pick 的 required_nodes 双约束(权重+节点缺一不可)
NUNCHAKU_REQUIRED_NODES = frozenset(
    {"NunchakuFluxDiTLoader", "NunchakuTextEncoderLoaderV2"}
)


def required_models() -> set[str]:
    """图引用的全部权重文件名(pool.pick 的 required 约束,worker pinning 依据)。"""
    return {NUNCHAKU_DIT, NUNCHAKU_T5, NUNCHAKU_CLIP_L, NUNCHAKU_VAE}


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class FluxNunchakuParams:
    """Nunchaku FLUX.1-dev fp4 文生图参数。KSampler cfg 恒 1.0(FluxGuidance 承载引导)。"""

    positive: str
    width: int = 1024
    height: int = 1024
    steps: int = 20
    guidance: float = 3.5  # FluxGuidance 蒸馏引导强度;非 KSampler cfg
    seed: int = field(default_factory=_random_seed)
    batch_size: int = 1
    # first-block 缓存阈值(0=关闭;典型 0.12,提速换微质损)——对齐插件 tooltip
    cache_threshold: float = 0.0
    t5_min_length: int = 512  # T5 最小序列长度(插件默认)
    model_path: str = NUNCHAKU_DIT  # svdq 量化 DiT(保留覆盖口,后续 qwen-image svdq 复用)
    filename_prefix: str = "ToIV_nunchaku"


def build_flux_nunchaku_graph(p: FluxNunchakuParams) -> dict:
    """参数 → ComfyUI API 格式图。纯函数,返回新 dict。"""
    nodes: dict = {}

    # 1) SVDQuant fp4 DiT(nunchaku-fp16 注意力:20 系必须、50 系更快,全端兼容默认)
    nodes["1"] = {
        "class_type": "NunchakuFluxDiTLoader",
        "inputs": {
            "model_path": p.model_path,
            "cache_threshold": p.cache_threshold,
            "attention": "nunchaku-fp16",
            "cpu_offload": "auto",
            "device_id": 0,
            "data_type": "bfloat16",
        },
    }

    # 2) 文本编码器(V2 双槽位:t5xxl + clip_l)
    nodes["2"] = {
        "class_type": "NunchakuTextEncoderLoaderV2",
        "inputs": {
            "model_type": "flux.1",
            "text_encoder1": NUNCHAKU_T5,
            "text_encoder2": NUNCHAKU_CLIP_L,
            "t5_min_length": p.t5_min_length,
        },
    }

    # 3/4) 正/负条件(负向留空:cfg=1.0 下失效,与官方示例一致)
    nodes["3"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"clip": ["2", 0], "text": p.positive},
    }
    nodes["4"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"clip": ["2", 0], "text": ""},
    }

    # 5) FluxGuidance 只作用正向(FLUX.1-dev 引导强度载体,默认 3.5)
    nodes["5"] = {
        "class_type": "FluxGuidance",
        "inputs": {"conditioning": ["3", 0], "guidance": p.guidance},
    }

    # 6) 空 latent(FLUX.1 官方示例用 EmptyLatentImage,非 SD3 变体)
    nodes["6"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": p.width, "height": p.height, "batch_size": p.batch_size},
    }

    # 7) 采样(真实 CFG=1.0、euler+simple;fp4 是 dev 量化非蒸馏,满血 20 步)
    nodes["7"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "seed": p.seed,
            "steps": p.steps,
            "cfg": 1.0,
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["5", 0],
            "negative": ["4", 0],
            "latent_image": ["6", 0],
            "denoise": 1.0,
        },
    }

    # 8/9/10) VAE 解码 + 保存
    nodes["8"] = {"class_type": "VAELoader", "inputs": {"vae_name": NUNCHAKU_VAE}}
    nodes["9"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["7", 0], "vae": ["8", 0]},
    }
    nodes["10"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["9", 0], "filename_prefix": p.filename_prefix},
    }
    return nodes
