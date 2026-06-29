"""LatentSync 1.6 对口型(lip-sync)API 工作流构造器。

让分镜视频里角色的嘴型对上配音台词:
  VHS_LoadVideo(源视频, force_rate=25)→ 帧
  LoadAudio(配音 wav)→ 音频
  LatentSyncNode(帧, 音频, lips_expression, inference_steps)→ 同步帧 + 音频
  VHS_VideoCombine(同步帧, 25fps, h264)→ 成片(可追踪/可下载)

LatentSync 内部 25fps + 自带人脸检测裁切口部再贴回。注:训练于真人脸,
写实层(电视剧/电影)效果好;动漫脸 face detection 可能不稳(模型局限,非本代码)。

源视频与配音须先上传到目标 worker 的 input 目录(见 routes/lipsync.py)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class LatentSyncParams:
    video: str  # worker input 里的源视频文件名
    audio: str  # worker input 里的配音 wav 文件名
    lips_expression: float = 1.5  # 1.0~3.0,口型幅度
    inference_steps: int = 20
    fps: float = 25.0  # LatentSync 原生 25fps
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_lipsync"


def build_latentsync_graph(p: LatentSyncParams) -> dict:
    """纯函数:返回 API 格式工作流图(node id → {class_type, inputs})。"""
    return {
        "1": {
            "class_type": "VHS_LoadVideo",
            "inputs": {
                "video": p.video,
                "force_rate": p.fps,  # 重采样到 25fps,对齐 LatentSync
                "custom_width": 0,
                "custom_height": 0,
                "frame_load_cap": 0,
                "skip_first_frames": 0,
                "select_every_nth": 1,
            },
        },
        "2": {"class_type": "LoadAudio", "inputs": {"audio": p.audio}},
        "3": {
            "class_type": "LatentSyncNode",
            "inputs": {
                "images": ["1", 0],
                "audio": ["2", 0],
                "seed": p.seed,
                "lips_expression": p.lips_expression,
                "inference_steps": p.inference_steps,
            },
        },
        "4": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["3", 0],
                "frame_rate": p.fps,
                "loop_count": 0,
                "filename_prefix": p.filename_prefix,
                "format": "video/h264-mp4",
                "pingpong": False,
                "save_output": True,
                "audio": ["3", 1],
            },
        },
    }
