"""HunyuanVideo-I2V 图生视频工作流构造器。

使用 ComfyUI-HunyuanVideoWrapper 自定义节点，核心链：
  DownloadAndLoadHyVideoTextEncoder → HyVideoLoraSelect → HyVideoModelLoader →
  HyVideoVAELoader → HyVideoI2VEncode + HyVideoEncode → HyVideoSampler →
  HyVideoDecode → VHS_VideoCombine

模型全部预设，用户只需提供 prompt + negative_prompt + image。
FastVideo 加速 LoRA，步数降为 10（约 3 倍加速）。
CLIP-L 文本编码器已禁用（pending transformers 5.x compat），LLM 编码器单独工作。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

DEFAULT_NEGATIVE = (
    "低质量，模糊，静止，重复，闪烁，抖动，水印，字幕，文字，logo，"
    "丑陋，畸形，变形，不自然，伪影，噪点，过曝，欠曝"
)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class HunyuanI2VParams:
    """用户只需提供 positive、image、negative，其余参数全部预设最优值。"""

    positive: str
    image: str
    negative: str = DEFAULT_NEGATIVE
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "HunyuanVideo_I2V"

    # —— 以下参数全部硬编码，不暴露给用户 ——
    _model_name: str = "hunyuan_video_I2V_720_fixed_fp8_e4m3fn.safetensors"
    _vae_name: str = "hunyuan_video_vae_bf16.safetensors"
    _lora_name: str = "hyvideo_FastVideo_LoRA-fp8.safetensors"
    _lora_strength: float = 1.0
    _width: int = 720
    _height: int = 480
    _length: int = 65  # 帧数（4n+1）
    _fps: int = 24
    _steps: int = 10  # FastVideo LoRA 加速：30→10 步
    _embedded_guidance_scale: float = 6.0
    _flow_shift: int = 0


def build_hunyuan_i2v_graph(p: HunyuanI2VParams) -> dict:
    g: dict = {
        "1": {
            "class_type": "DownloadAndLoadHyVideoTextEncoder",
            "inputs": {
                "llm_model": "xtuner/llava-llama-3-8b-v1_1-transformers",
                "clip_model": "disabled",
                "precision": "fp16",
            },
        },
        "2": {
            "class_type": "HyVideoVAELoader",
            "inputs": {
                "model_name": p._vae_name,
                "precision": "bf16",
            },
        },
        "10": {
            "class_type": "HyVideoLoraSelect",
            "inputs": {
                "lora": p._lora_name,
                "strength": p._lora_strength,
            },
        },
        "3": {
            "class_type": "HyVideoModelLoader",
            "inputs": {
                "model": p._model_name,
                "base_precision": "bf16",
                "quantization": "fp8_e4m3fn",
                "load_device": "offload_device",
                "attention_mode": "sdpa",
                "auto_cpu_offload": False,
                "upcast_rope": True,
                "lora": ["10", 0],
            },
        },
        "4": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "5": {
            "class_type": "HyVideoI2VEncode",
            "inputs": {
                "text_encoders": ["1", 0],
                "prompt": p.positive,
                "prompt_template": "I2V_video",
                "image": ["4", 0],
                "force_offload": False,
            },
        },
        "6": {
            "class_type": "HyVideoEncode",
            "inputs": {
                "vae": ["2", 0],
                "image": ["4", 0],
                "enable_vae_tiling": False,
                "temporal_tiling_sample_size": 256,
                "spatial_tile_sample_min_size": 64,
                "auto_tile_size": True,
            },
        },
        "7": {
            "class_type": "HyVideoSampler",
            "inputs": {
                "model": ["3", 0],
                "hyvid_embeds": ["5", 0],
                "width": p._width,
                "height": p._height,
                "num_frames": p._length,
                "steps": p._steps,
                "embedded_guidance_scale": p._embedded_guidance_scale,
                "flow_shift": float(p._flow_shift),
                "seed": p.seed,
                "force_offload": False,
                "image_cond_latents": ["6", 0],
                "denoise_strength": 1.0,
                "scheduler": "FlowMatchDiscreteScheduler",
                "i2v_mode": "stability",
            },
        },
        "8": {
            "class_type": "HyVideoDecode",
            "inputs": {
                "vae": ["2", 0],
                "samples": ["7", 0],
                "enable_vae_tiling": True,
                "temporal_tiling_sample_size": 192,
                "spatial_tile_sample_min_size": 64,
                "auto_tile_size": True,
            },
        },
        "9": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["8", 0],
                "frame_rate": float(p._fps),
                "loop_count": 0,
                "filename_prefix": p.filename_prefix,
                "format": "video/h264-mp4",
                "pingpong": False,
                "save_output": True,
            },
        },
    }
    return g
