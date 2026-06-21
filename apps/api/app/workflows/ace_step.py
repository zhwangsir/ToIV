"""ACE-Step 文生音乐 API 工作流构造器(输出 MP3)。

CheckpointLoaderSimple(ace_step) → EmptyAceStepLatentAudio
  + TextEncodeAceStepAudio(tags/lyrics) → ConditioningZeroOut(负)
  → KSampler → VAEDecodeAudio → SaveAudioMP3
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1


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
