"""视频超分(4K)—— 帧级工作流构造器 + 目标分辨率推导(纯函数,返回新 dict,不可变)。

单帧超分图(与 scripts/ops/video_4k_upscale.py build_upscale_graph 同构,
M6 fleet :8261/:8262/:8263 真机实测链路):
  UpscaleModelLoader(4x-UltraSharp) → LoadImage → ImageUpscaleWithModel
  → ImageScale(lanczos → 目标宽高) → SaveImage

目标分辨率服务端自动推导,禁止用户手填宽高(AGENTS.md 易错点 28:
竖屏源误用横屏目标,7320 帧被 ImageScale 拉伸报废):
  横屏源(宽 ≥ 高) → 3840×2160;竖屏源 → 2160×3840。
"""
from __future__ import annotations

from dataclasses import dataclass

# M6 超分 fleet 加载的超分模型(4x 原生;fleet 实例仅此用途,--cache-lru 2)
DEFAULT_UPSCALE_MODEL = "4x-UltraSharp.pth"

# —— SeedVR2(字节 Seed,arXiv:2506.05301,Apache 2.0)——
# 一步扩散修复超分,图像/视频双修;ComfyUI 原生节点(comfy_extras.nodes_seedvr,
# fleet 0.27.0 已内置,UNETLoader 直接加载)。定位:保守保真档——保原始结构/细节、
# 不偏创意重绘,与 classic(4x-UltraSharp 系,锐化创意向)分层互补。
# 官方模板(comfyui workflow_templates utility_seedvr2_*):
#   LoadImage → ImageScale(目标宽高) → SeedVR2Preprocess(pad) → VAEEncodeTiled
#   → SeedVR2Conditioning(model+latent) → KSampler(1步/cfg1/euler/simple/denoise1)
#   → VAEDecodeTiled → SeedVR2PostProcessing(颜色校正) → SaveImage
SEEDVR2_VAE = "seedvr2_ema_vae_fp16.safetensors"
SEEDVR2_VARIANTS: dict[str, str] = {
    "seedvr2_3b": "seedvr2_3b_fp16.safetensors",  # 轻量档(~6.8G fp16)
    "seedvr2_7b": "seedvr2_7b_fp16.safetensors",  # 高质档(~16.5G fp16)
}
# 超分引擎全集:classic = ESRGAN 类传统模型;seedvr2_* = SeedVR2 保守保真档
UPSCALE_ENGINES: tuple[str, ...] = ("classic", *SEEDVR2_VARIANTS)
# SeedVR2 采样固定参数(官方模板:一步推理;种子固定保证续跑帧间确定性)
_SEEDVR2_SEED = 42
# VAE  tiled 编/解码参数(官方图像模板:tile512/overlap128/temporal4096/t-overlap8)
_SEEDVR2_VAE_TILED = {"tile_size": 512, "overlap": 128, "temporal_size": 4096, "temporal_overlap": 8}
# 输出颜色校正法:lab = CIELAB 色彩迁移,对原图色彩最忠实(保守保真档语义)
_SEEDVR2_COLOR_CORRECTION = "lab"

# target 档位 → (横屏目标, 竖屏目标)。4K 主力;720p/1080p/2K(RES-2026-08-18)供生成链
# 「原生上限 → 二次超分」自动挂链用(H3 原生 1344×768、Wan/LongCat 1280 上限;
# Wan 原生甜点 832×480,720p 也须经超分达成)。
_TARGETS: dict[str, tuple[tuple[int, int], tuple[int, int]]] = {
    "720p": ((1280, 720), (720, 1280)),
    "1080p": ((1920, 1080), (1080, 1920)),
    "2k": ((2560, 1440), (1440, 2560)),
    "4k": ((3840, 2160), (2160, 3840)),
}
TARGET_CHOICES: tuple[str, ...] = tuple(_TARGETS)


def derive_target_resolution(src_w: int, src_h: int, target: str = "4k") -> tuple[int, int]:
    """按源画幅方向推导目标 (宽, 高);横竖方向永远与源一致(护栏内建)。"""
    if target not in _TARGETS:
        raise ValueError(f"不支持的超分档位:{target!r};可选 {list(_TARGETS)}")
    landscape, portrait = _TARGETS[target]
    return landscape if src_w >= src_h else portrait


def assert_orientation_compatible(src_w: int, src_h: int, dst_w: int, dst_h: int) -> None:
    """画幅方向护栏(易错点 28):源与目标横竖不一致即报错,防 ImageScale 拉伸变形。

    derive_target_resolution 推导出的目标天然过此护栏;本函数供 service 在
    提交帧任务前做最终防御性校验(配置/常量被改坏时兜底,不让废片白烧算力)。
    """
    if (src_w >= src_h) != (dst_w >= dst_h):
        raise ValueError(
            f"源 {src_w}×{src_h} 与目标 {dst_w}×{dst_h} 横竖方向不一致(会拉伸变形)"
        )


def validate_resolution_target(v: str | None) -> str | None:
    """生成路由 resolution_target 字段的公共校验(RES-2026-08-18):
    None/"" = 原生直出;否则必须是 TARGET_CHOICES 内档位。"""
    if v is None or v == "":
        return None
    if v not in _TARGETS:
        raise ValueError(f"resolution_target 须为 {list(_TARGETS)} 之一(或留空原生直出)")
    return v


@dataclass(frozen=True)
class FrameUpscaleParams:
    """单帧超分参数。

    image:已上传到 fleet 实例 input 目录的帧文件名。
    engine:超分引擎(classic=4x-UltraSharp 系;seedvr2_3b/seedvr2_7b=SeedVR2 保守保真档)。
    target_w/target_h:目标分辨率(由 derive_target_resolution 推导)。
    """

    image: str
    model_name: str = DEFAULT_UPSCALE_MODEL
    engine: str = "classic"
    target_w: int = 3840
    target_h: int = 2160
    filename_prefix: str = "toiv_vup"


def build_frame_upscale_graph(p: FrameUpscaleParams) -> dict:
    """把参数编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    if p.engine in SEEDVR2_VARIANTS:
        return _build_seedvr2_frame_graph(p)
    if p.engine != "classic":
        raise ValueError(f"不支持的超分引擎:{p.engine!r};可选 {list(UPSCALE_ENGINES)}")
    return {
        "10": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": p.model_name},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "12": {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["10", 0], "image": ["11", 0]},
        },
        "13": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["12", 0],
                "width": p.target_w,
                "height": p.target_h,
                "upscale_method": "lanczos",
                "crop": "disabled",
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["13", 0], "filename_prefix": p.filename_prefix},
        },
    }


def _build_seedvr2_frame_graph(p: FrameUpscaleParams) -> dict:
    """SeedVR2 单帧(图像)超分图——官方模板 utility_seedvr2_*_upscale_image 同构。

    与 classic 的差异:先 ImageScale 到目标宽高(精确尺寸,lanczos/crop 禁用,
    沿用 classic 的画幅语义),再由 SeedVR2 一步扩散在该尺寸上修复细节——
    SeedVR2 不做几何放大,只做「同尺寸修复」,因此目标分辨率推导/护栏完全复用。
    """
    return {
        "10": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": SEEDVR2_VARIANTS[p.engine], "weight_dtype": "default"},
        },
        "11": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": SEEDVR2_VAE},
        },
        "12": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "13": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["12", 0],
                "width": p.target_w,
                "height": p.target_h,
                "upscale_method": "lanczos",
                "crop": "disabled",
            },
        },
        "14": {
            "class_type": "SeedVR2Preprocess",
            "inputs": {"resized_images": ["13", 0]},
        },
        "15": {
            "class_type": "VAEEncodeTiled",
            "inputs": {"pixels": ["14", 0], "vae": ["11", 0], **_SEEDVR2_VAE_TILED},
        },
        "16": {
            "class_type": "SeedVR2Conditioning",
            "inputs": {"model": ["10", 0], "vae_conditioning": ["15", 0]},
        },
        "17": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["10", 0],
                "positive": ["16", 0],
                "negative": ["16", 1],
                "latent_image": ["15", 0],
                "seed": _SEEDVR2_SEED,
                "steps": 1,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
            },
        },
        "18": {
            "class_type": "VAEDecodeTiled",
            "inputs": {"samples": ["17", 0], "vae": ["11", 0], **_SEEDVR2_VAE_TILED},
        },
        "19": {
            "class_type": "SeedVR2PostProcessing",
            "inputs": {
                "images": ["18", 0],
                "original_resized_images": ["13", 0],
                "color_correction_method": _SEEDVR2_COLOR_CORRECTION,
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["19", 0], "filename_prefix": p.filename_prefix},
        },
    }
