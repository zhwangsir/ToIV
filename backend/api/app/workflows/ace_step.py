"""ACE-Step 文生音乐 API 工作流构造器(输出 MP3)。

1.0(legacy): CheckpointLoaderSimple(ace_step) → EmptyAceStepLatentAudio
  + TextEncodeAceStepAudio(tags/lyrics) → ConditioningZeroOut(负)
  → KSampler → VAEDecodeAudio → SaveAudioMP3

1.5(ComfyUI 原生节点,官方模板 audio_ace_step_1_5_checkpoint/split 对齐):
  Turbo AIO 档: CheckpointLoaderSimple(ace_step_1.5_turbo_aio) → ModelSamplingAuraFlow(shift=3)
    + TextEncodeAceStepAudio1.5(元数据规划) → ConditioningZeroOut(负)
    + EmptyAceStep1.5LatentAudio → KSampler(8 步/cfg1) → VAEDecodeAudio → SaveAudioMP3
  quality 成品档: UNETLoader(acestep_v1.5_base) + DualCLIPLoader(qwen ace 双编码器)
    + VAELoader(ace_1.5_vae),其余同构(50 步/cfg5)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# ACE-Step 1.5 权重文件名(Comfy-Org/ace_step_1.5_ComfyUI_files,落 NAS 主模型库)
ACE_STEP_15_TURBO_AIO = "ace_step_1.5_turbo_aio.safetensors"  # checkpoints/(AIO 单模型)
ACE_STEP_15_BASE_UNET = "acestep_v1.5_base.safetensors"  # diffusion_models/(50 步成品档 DiT)
ACE_STEP_15_CLIP_L = "qwen_0.6b_ace15.safetensors"  # text_encoders/
ACE_STEP_15_CLIP_G = "qwen_1.7b_ace15.safetensors"  # text_encoders/
ACE_STEP_15_VAE = "ace_1.5_vae.safetensors"  # vae/


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class AceStepParams:
    tags: str  # 风格/流派标签,如 "lofi hip hop, chill, piano"
    lyrics: str = ""  # 歌词(留空=纯音乐)
    seconds: float = 30.0
    ckpt_name: str = "ace_step_v1_3.5b.safetensors"
    steps: int = 50
    cfg: float = 5.0
    sampler: str = "euler"
    scheduler: str = "simple"
    lyrics_strength: float = 1.0
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_audio/track"


def build_ace_step_graph(p: AceStepParams) -> dict:
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": p.ckpt_name}},
        "2": {"class_type": "EmptyAceStepLatentAudio", "inputs": {"seconds": p.seconds, "batch_size": 1}},
        "3": {
            "class_type": "TextEncodeAceStepAudio",
            "inputs": {
                "clip": ["1", 1],
                "tags": p.tags,
                "lyrics": p.lyrics,
                "lyrics_strength": p.lyrics_strength,
            },
        },
        "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["2", 0],
                "denoise": 1.0,
            },
        },
        "6": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {
            "class_type": "SaveAudioMP3",
            "inputs": {"audio": ["6", 0], "filename_prefix": p.filename_prefix, "quality": "V0"},
        },
    }


# ---------------------------------------------------------------------------
# ACE-Step 1.5(LM 规划 + DiT;10s-10min;Turbo 8 步草稿 / base 50 步成品)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AceStep15Params:
    tags: str  # 风格/流派标签(1.5 由 LM 规划成歌曲蓝图,可写自然语言描述)
    lyrics: str = ""  # 歌词(留空=纯音乐)
    seconds: float = 30.0  # 1.5 支持 10s-600s
    quality: str = "turbo"  # "turbo"=AIO 8 步草稿;"quality"=split base 50 步成品
    ckpt_name: str = ACE_STEP_15_TURBO_AIO
    steps: int | None = None  # None=按档位默认(turbo 8 / quality 50)
    cfg: float | None = None  # None=按档位默认(turbo 1.0 无 CFG / quality 5.0)
    sampler: str = "euler"
    scheduler: str = "simple"
    shift: float = 3.0  # ModelSamplingAuraFlow shift(官方模板值)
    bpm: int = 120
    timesignature: str = "4"  # 拍号(2/3/4/6)
    language: str = "en"  # 歌词语言
    keyscale: str = "C major"  # 调式
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_audio/track"


def _ace15_sampling(p: AceStep15Params) -> tuple[int, float]:
    turbo = p.quality == "turbo"
    steps = p.steps if p.steps is not None else (8 if turbo else 50)
    cfg = p.cfg if p.cfg is not None else (1.0 if turbo else 5.0)
    return steps, cfg


def _ace15_encode_inputs(p: AceStep15Params, clip_ref: list) -> dict:
    # seed 与 KSampler 共用(官方模板同一 PrimitiveNode 喂两处),保证可复现;
    # cfg_scale/temperature/top_p/top_k/min_p 是 LM audio-codes 采样参数,
    # API 模式下 advanced 输入同样必填(节点默认值,生产冒烟实证缺了会 400)
    return {
        "clip": clip_ref,
        "tags": p.tags,
        "lyrics": p.lyrics,
        "seed": p.seed,
        "bpm": p.bpm,
        "duration": p.seconds,
        "timesignature": p.timesignature,
        "language": p.language,
        "keyscale": p.keyscale,
        "generate_audio_codes": True,
        "cfg_scale": 2.0,
        "temperature": 0.85,
        "top_p": 0.9,
        "top_k": 0,
        "min_p": 0.0,
    }


def ace_step_15_required_models(p: AceStep15Params) -> set[str]:
    """按档位返回 worker 必须具备的模型文件集合(pool.pick required 用)。"""
    if p.quality == "turbo":
        return {p.ckpt_name}
    if p.quality == "quality":
        return {ACE_STEP_15_BASE_UNET, ACE_STEP_15_CLIP_L, ACE_STEP_15_CLIP_G, ACE_STEP_15_VAE}
    raise ValueError(f"未知 ACE-Step 1.5 档位: {p.quality}")


def build_ace_step_15_graph(p: AceStep15Params) -> dict:
    steps, cfg = _ace15_sampling(p)
    if p.quality == "turbo":
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": p.ckpt_name}},
            "2": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": p.shift}},
            "3": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": _ace15_encode_inputs(p, ["1", 1])},
            "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
            "5": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": p.seconds, "batch_size": 1}},
            "6": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "seed": p.seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": p.sampler,
                    "scheduler": p.scheduler,
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                    "denoise": 1.0,
                },
            },
            "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
            "8": {
                "class_type": "SaveAudioMP3",
                "inputs": {"audio": ["7", 0], "filename_prefix": p.filename_prefix, "quality": "V0"},
            },
        }
    if p.quality == "quality":
        return {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": ACE_STEP_15_BASE_UNET, "weight_dtype": "default"}},
            "2": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": ACE_STEP_15_CLIP_L,
                    "clip_name2": ACE_STEP_15_CLIP_G,
                    "type": "ace",
                    "device": "default",
                },
            },
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": ACE_STEP_15_VAE}},
            "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": p.shift}},
            "5": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": _ace15_encode_inputs(p, ["2", 0])},
            "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
            "7": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": p.seconds, "batch_size": 1}},
            "8": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["4", 0],
                    "seed": p.seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": p.sampler,
                    "scheduler": p.scheduler,
                    "positive": ["5", 0],
                    "negative": ["6", 0],
                    "latent_image": ["7", 0],
                    "denoise": 1.0,
                },
            },
            "9": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
            "10": {
                "class_type": "SaveAudioMP3",
                "inputs": {"audio": ["9", 0], "filename_prefix": p.filename_prefix, "quality": "V0"},
            },
        }
    raise ValueError(f"未知 ACE-Step 1.5 档位: {p.quality}")
