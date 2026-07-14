"""帧插值工作流构造器。

使用 ComfyUI-Frame-Interpolation (Kosinkadink) 的 RIFE VFI 节点，
将输入视频帧数翻倍，实现更流畅的视频播放。

节点链:
  VHS_LoadVideo → RIFE VFI (rife47.pth, multiplier=2) → VHS_VideoCombine

用户只需提供视频文件名，RIFE 参数全部预设最优值。
"""
from __future__ import annotations

from dataclasses import dataclass

# 可选的 RIFE 模型（与 ComfyUI-Frame-Interpolation 的 ckpts/rife/ 目录对应）
RIFE_MODELS = ("rife47.pth", "rife49.pth", "rife417.pth", "rife426.pth")

# HunyuanVideo 输出默认 24fps；插值后帧数翻倍，输出帧率同步翻倍以保持时长不变
_SOURCE_FPS = 24.0


@dataclass(frozen=True)
class FrameInterpolateParams:
    """用户只需提供 video 文件名，其余参数全部预设。"""

    video: str  # 已上传到 worker input 目录的源视频文件名
    multiplier: float = 2.0  # 帧倍数（float 兼容 API；实际取 int 传给 RIFE 节点）
    model_name: str = RIFE_MODELS[0]
    filename_prefix: str = "FrameInterp"


def build_frame_interpolate_graph(p: FrameInterpolateParams) -> dict:
    # RIFE VFI 节点要求 multiplier 为 int
    mult_int = max(1, round(p.multiplier))
    # 输出帧率 = 源帧率 × 倍数（保持时长不变，仅增加流畅度）
    out_fps = _SOURCE_FPS * mult_int

    g: dict = {
        "1": {
            "class_type": "VHS_LoadVideo",
            "inputs": {
                "video": p.video,
                "force_rate": 0,
                "custom_width": 0,
                "custom_height": 0,
                "frame_load_cap": 0,
                "skip_first_frames": 0,
                "select_every_nth": 1,
            },
        },
        "2": {
            "class_type": "RIFE VFI",
            "inputs": {
                "ckpt_name": p.model_name,
                "frames": ["1", 0],
                "clear_cache_after_n_frames": 10,
                "multiplier": mult_int,
                "fast_mode": True,
                "ensemble": True,
                "scale_factor": 1.0,
                "dtype": "float32",
                "torch_compile": False,
                "batch_size": 1,
            },
        },
        "3": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["2", 0],
                "frame_rate": out_fps,
                "loop_count": 0,
                "filename_prefix": p.filename_prefix,
                "format": "video/h264-mp4",
                "pingpong": False,
                "save_output": True,
            },
        },
    }
    return g
