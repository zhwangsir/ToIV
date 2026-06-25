"""脸部修复(FaceDetailer)工作流构造器(纯函数,返回新 dict,不可变)。

用 Impact-Pack 的 FaceDetailer 自动检测脸部 → 局部高清重绘,修复糊脸/坏脸:
  CheckpointLoaderSimple → (v-pred 时 ModelSamplingDiscrete) → FaceDetailer.model
  CLIPTextEncode×2(脸部正/负提示词)→ FaceDetailer.positive/negative
  LoadImage(源图)→ FaceDetailer.image
  UltralyticsDetectorProvider(bbox 人脸检测)→ FaceDetailer.bbox_detector
  SAMLoader(sam_vit_b)→ FaceDetailer.sam_model_opt
  FaceDetailer → SaveImage

worker(.100)实测:bbox 模型 bbox/face_yolov8m.pt(本会话经 Manager 装)、
sam 模型 sam_vit_b_01ec64.pth;FaceDetailer 必填项默认值取自 object_info。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.model_profiles import is_vpred, model_sampling_node

MAX_SEED = 2**63 - 1

# worker 实测可用的检测/分割模型
BBOX_MODELS = ("bbox/face_yolov8m.pt",)
SAM_MODELS = ("sam_vit_b_01ec64.pth",)

_CKPT_NODE = "4"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class FaceDetailerParams:
    """脸部修复参数。image 为已上传到 worker 的源图文件名(必填)。"""

    image: str
    positive: str = "detailed face, sharp focus, high quality"
    negative: str = "blurry, lowres, deformed, bad anatomy, extra eyes"
    ckpt_name: str = "DreamShaper_8_pruned.safetensors"
    bbox_model: str = BBOX_MODELS[0]
    sam_model: str = SAM_MODELS[0]
    denoise: float = 0.5
    steps: int = 20
    cfg: float = 8.0
    sampler: str = "euler"
    scheduler: str = "karras"
    feather: int = 5
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_facefix"


def build_facedetailer_graph(p: FaceDetailerParams) -> dict:
    """把参数编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    model_ref: list = [_CKPT_NODE, 0]
    vpred_nodes: dict = {}
    if is_vpred(p.ckpt_name):
        vpred_nodes, model_ref = model_sampling_node(model_ref)

    return {
        _CKPT_NODE: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": p.ckpt_name},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.positive, "clip": [_CKPT_NODE, 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.negative, "clip": [_CKPT_NODE, 1]},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": p.image},
        },
        "20": {
            "class_type": "UltralyticsDetectorProvider",
            "inputs": {"model_name": p.bbox_model},
        },
        "21": {
            "class_type": "SAMLoader",
            "inputs": {"model_name": p.sam_model, "device_mode": "AUTO"},
        },
        "22": {
            "class_type": "FaceDetailer",
            "inputs": {
                "image": ["11", 0],
                "model": model_ref,
                "clip": [_CKPT_NODE, 1],
                "vae": [_CKPT_NODE, 2],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "bbox_detector": ["20", 0],
                "sam_model_opt": ["21", 0],
                "guide_size": 512,
                "guide_size_for": True,
                "max_size": 1024,
                "seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "denoise": p.denoise,
                "feather": p.feather,
                "noise_mask": True,
                "force_inpaint": True,
                "bbox_threshold": 0.5,
                "bbox_dilation": 10,
                "bbox_crop_factor": 3.0,
                "sam_detection_hint": "center-1",
                "sam_dilation": 0,
                "sam_threshold": 0.93,
                "sam_bbox_expansion": 0,
                "sam_mask_hint_threshold": 0.7,
                "sam_mask_hint_use_negative": "False",
                "drop_size": 10,
                "wildcard": "",
                "cycle": 1,
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["22", 0], "filename_prefix": p.filename_prefix},
        },
        **vpred_nodes,
    }
