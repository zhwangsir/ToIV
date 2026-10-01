"""H3 短剧默认管线 C：Motion Context 22 帧 + 1s 音频续写 + Ref2VA 参考 + 原生音频。

图结构对齐工作站实验胜者（tmp/h3_long_exp/workflows/C_zh_seg*.json）：
  MiniMaxH3AudioConditioningT8（Ref2VA UNET + 参考图槽 + native audio）
  → MiniMaxH3MotionContext（续段；首段跳过）
  → Sampler → MiniMaxH3AVDecodeT8
  → MotionContextTrim（续段）→ CreateVideo → SaveVideo
  → MotionContextSaveLatent（供下一段 Load）

仅应提交到装有 T8 / Motion Context 的 h3-eval（默认 :8195）；勿打断 :8196 生产。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any

from app.workflows.h3_video import H3_R2V_UNET, MAX_SEED

# 实验默认：22 帧画面上下文 + 24 帧（1 秒@24fps）音频上下文
C_CONTEXT_FRAMES = "22"
C_AUDIO_CONTEXT_FRAMES = 24

_CLIP = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
_VAE_V = "minimax_h3_video_vae_fp16.safetensors"
_VAE_A = "minimax_h3_audio_vae_fp32.safetensors"


@dataclass(frozen=True)
class H3PipelineCParams:
    """管线 C 单段参数。"""

    positive: str
    images: tuple[str, ...] = ()  # H3 input 目录内文件名
    width: int = 768
    height: int = 1344
    length: int = 362  # ~15.08s @24fps（17k+5 网格）
    steps: int = 20
    seed: int = field(default_factory=lambda: secrets.randbelow(MAX_SEED))
    filename_prefix: str = "ToIV_drama_c"
    context_prefix: str = "toiv_drama_c/context"
    clip_index: int = 1  # Save 索引；续段 Load = clip_index-1 的文件
    context_latent_path: str = ""  # 非空则续写：Load 该 safetensors
    first_frame: str = ""  # 可选首帧（续写时常用上一段尾帧）


def build_h3_pipeline_c_graph(params: H3PipelineCParams) -> dict[str, Any]:
    """构造管线 C API 图。至少一张参考图；续写时带 context_latent_path。"""
    images = tuple(n for n in params.images if (n or "").strip())
    if not images:
        raise ValueError("管线 C 需要至少一张角色/场景参考图（Ref2VA）")
    if len(images) > 9:
        raise ValueError("管线 C 参考图最多 9 张")

    continue_from = bool((params.context_latent_path or "").strip())
    graph: dict[str, Any] = {
        "3": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "5": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(params.seed)}},
        "8": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": H3_R2V_UNET, "weight_dtype": "default"},
        },
        "10": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": _CLIP, "type": "minimax"},
        },
        "11": {"class_type": "VAELoader", "inputs": {"vae_name": _VAE_V}},
        "12": {"class_type": "VAELoader", "inputs": {"vae_name": _VAE_A}},
        "13": {
            "class_type": "BasicScheduler",
            "inputs": {
                "model": ["8", 0],
                "scheduler": "simple",
                "steps": int(params.steps),
                "denoise": 1.0,
            },
        },
    }

    # 参考图 LoadImage：7a,7b,...
    # T8 resolve_task_type：仅参考图 → ref2va；参考图+首/尾帧 → hybrid。
    # 写死 Hybrid 且无 first_frame 会在执行时报 HYBRID requires first_frame。
    ff = (params.first_frame or "").strip()
    task_type = "Hybrid" if ff else "Ref2VA"
    h3_inputs: dict[str, Any] = {
        "clip": ["10", 0],
        "video_vae": ["11", 0],
        "audio_vae": ["12", 0],
        "prompt": params.positive,
        "width": int(params.width),
        "height": int(params.height),
        "length": int(params.length),
        "task_type": task_type,
        "audio_mode": "native",
        "audio_denoise_strength": 0.35,
        "add_source_as_reference": True,
        "prompt_primary_audio_ordinal": 1,
        "strict_prompt_tags": True,
        "ref_image_size": "match",
        "reference_video_policy": "official_2_to_15s",
    }
    for i, name in enumerate(images):
        nid = f"7{chr(ord('a') + i)}"
        graph[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        h3_inputs[f"ref_images.ref_image_{i}"] = [nid, 0]

    if ff:
        graph["7"] = {"class_type": "LoadImage", "inputs": {"image": ff}}
        h3_inputs["first_frame"] = ["7", 0]

    graph["9"] = {"class_type": "MiniMaxH3AudioConditioningT8", "inputs": h3_inputs}

    cond_src: list[Any] = ["9", 0]
    images_src: list[Any]
    if continue_from:
        graph["20"] = {
            "class_type": "MiniMaxH3MotionContextLoadLatent",
            "inputs": {
                "latent_path": params.context_latent_path.strip(),
                "clip_index": max(0, int(params.clip_index) - 1),
            },
        }
        graph["21"] = {
            "class_type": "MiniMaxH3MotionContext",
            "inputs": {
                "conditioning": ["9", 0],
                "vae": ["11", 0],
                "latent": ["20", 0],
                "context_length": C_CONTEXT_FRAMES,
                "audio_context_length": C_AUDIO_CONTEXT_FRAMES,
                "audio_vae": ["12", 0],
            },
        }
        cond_src = ["21", 0]
        graph["6"] = {
            "class_type": "BasicGuider",
            "inputs": {"model": ["8", 0], "conditioning": cond_src},
        }
        graph["14"] = {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["5", 0],
                "guider": ["6", 0],
                "sampler": ["3", 0],
                "sigmas": ["13", 0],
                "latent_image": ["9", 1],
            },
        }
        graph["15"] = {
            "class_type": "MiniMaxH3AVDecodeT8",
            "inputs": {
                "av_latent": ["14", 0],
                "video_vae": ["11", 0],
                "audio_vae": ["12", 0],
            },
        }
        graph["22"] = {
            "class_type": "MiniMaxH3MotionContextTrim",
            "inputs": {"images": ["15", 0], "trim_frames": ["21", 1]},
        }
        images_src = ["22", 0]
    else:
        graph["6"] = {
            "class_type": "BasicGuider",
            "inputs": {"model": ["8", 0], "conditioning": cond_src},
        }
        graph["14"] = {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["5", 0],
                "guider": ["6", 0],
                "sampler": ["3", 0],
                "sigmas": ["13", 0],
                "latent_image": ["9", 1],
            },
        }
        graph["15"] = {
            "class_type": "MiniMaxH3AVDecodeT8",
            "inputs": {
                "av_latent": ["14", 0],
                "video_vae": ["11", 0],
                "audio_vae": ["12", 0],
            },
        }
        images_src = ["15", 0]

    graph["17"] = {
        "class_type": "CreateVideo",
        "inputs": {"images": images_src, "fps": 24.0, "audio": ["15", 1]},
    }
    graph["18"] = {
        "class_type": "SaveVideo",
        "inputs": {
            "video": ["17", 0],
            "filename_prefix": params.filename_prefix,
            "format": "auto",
            "codec": "auto",
        },
    }
    graph["19"] = {
        "class_type": "MiniMaxH3MotionContextSaveLatent",
        "inputs": {
            "latent": ["14", 0],
            "filename_prefix": params.context_prefix,
            "clip_index": int(params.clip_index),
        },
    }
    return graph


def expected_context_latent_name(prefix: str, clip_index: int) -> str:
    """SaveLatent 产物相对 output 的约定名（与实验一致：prefix_00001.safetensors）。"""
    p = (prefix or "toiv_drama_c/context").rstrip("/")
    # Comfy Save 常带 _00001；Load 节点接受完整相对路径
    return f"{p}_{clip_index:05d}.safetensors"
