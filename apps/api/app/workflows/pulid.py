"""PuLID-Flux 角色一致性工作流构造器(纯函数,返回新 dict,不可变)。

短剧次世代底模(flux2/qwen_image/z_image)场景的角色一致性首帧:IPAdapter 构图
(ipadapter.py)用 CheckpointLoaderSimple,未与次世代 UNET 底模打通;PuLID-Flux v0.9.1
只适配 FLUX.1 dev/schnell(不适用 FLUX.2),故用 FLUX.1 fp8 全量包(CheckpointLoaderSimple
单节点全量加载,内含 clip_l+t5xxl+VAE)做角色一致性首帧底模。

图结构(节点经 worker :8189 /object_info 实测,2026-08-01):

CheckpointLoaderSimple(flux1-dev-fp8)
  → ApplyPulidFlux(model, pulid_flux=PulidFluxModelLoader,
                   eva_clip=PulidFluxEvaClipLoader,
                   face_analysis=PulidFluxInsightFaceLoader,
                   image=LoadImage(角色参考图), weight/start_at/end_at)
  → KSampler.model
CLIPTextEncode(+) → FluxGuidance(cfg=1 时负向失效,负向仍照常接线)
→ KSampler → VAEDecode → SaveImage

采样档对齐 model_profiles flux 族(flux2 档):cfg=1.0 / euler / simple / guidance=3.5。
FLUX 为 guidance 蒸馏模型,真实 CFG=1,负向不生效,FluxGuidance 负责引导强度。

节点 id 约定沿用 txt2img.py:小数字 id(3-9)给主链,PuLID 节点用 _PULID_ID_BASE
起的较大 id(避开 LoRA 链 100 段与 IPAdapter 200 段)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.comfy.client import ComfyUIError

# SQLite 有符号 64 位上限;与 txt2img 一致
MAX_SEED = 2**63 - 1

# checkpoint 节点 id;PuLID 链以此为 (model,clip,vae) 源头
_CKPT_NODE = "4"

# PuLID 节点 id 起点:避开主链(3-9)、LoRA 链(100 段)与 IPAdapter(200 段)
_PULID_ID_BASE = 300
_PULID_MODEL_NODE = str(_PULID_ID_BASE)  # PulidFluxModelLoader
_PULID_FACE_NODE = str(_PULID_ID_BASE + 1)  # PulidFluxInsightFaceLoader
_PULID_EVA_NODE = str(_PULID_ID_BASE + 2)  # PulidFluxEvaClipLoader
_PULID_APPLY_NODE = str(_PULID_ID_BASE + 3)  # ApplyPulidFlux
_PULID_IMAGE_NODE = str(_PULID_ID_BASE + 4)  # LoadImage(角色参考图)
_PULID_GUIDANCE_NODE = str(_PULID_ID_BASE + 5)  # FluxGuidance

# 默认权重(worker :8189-8191 / pc01 :8188 实测可见,均挂同一份 NAS 模型)
DEFAULT_CKPT = "flux1-dev-fp8.safetensors"  # checkpoints/,Comfy-Org repack 17.2GB
DEFAULT_PULID_FILE = "pulid_flux_v0.9.1.safetensors"  # pulid/ 目录,节点枚举值

# pool 探测所需自定义节点(worker /object_info 实测 class_type)
REQUIRED_NODES: frozenset[str] = frozenset({
    "PulidFluxModelLoader",
    "PulidFluxInsightFaceLoader",
    "PulidFluxEvaClipLoader",
    "ApplyPulidFlux",
})


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class PulidTxt2ImgParams:
    """PuLID-Flux 角色一致性 txt2img 参数(风格对齐 IPAdapterTxt2ImgParams)。

    ref_image:已上传到 worker 的角色参考图文件名(必填,空则不应走本构造器)。
    weight/start_at/end_at 透传给 ApplyPulidFlux 控制参考强度与作用区间。
    cfg 固定 1.0 档(flux 族),负向失效但照常接线;guidance 进 FluxGuidance。
    """

    positive: str
    ref_image: str
    negative: str = ""
    ckpt_name: str = DEFAULT_CKPT
    pulid_file: str = DEFAULT_PULID_FILE
    weight: float = 1.0
    start_at: float = 0.0
    end_at: float = 1.0
    width: int = 1024
    height: int = 1024
    steps: int = 20
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    guidance: float = 3.5
    seed: int = field(default_factory=_random_seed)
    batch_size: int = 1
    filename_prefix: str = "ToIV_pulid"


def build_pulid_txt2img_graph(p: PulidTxt2ImgParams) -> dict:
    """把参数编译成 PuLID-Flux 角色一致性的 ComfyUI API 格式 prompt 图。每次返回新 dict。

    model 线:checkpoint → ApplyPulidFlux(参考图条件化)→ KSampler.model。
    clip 线不受 PuLID 影响,照常供 CLIPTextEncode;正向再穿 FluxGuidance。
    """
    pulid_nodes: dict = {
        _PULID_MODEL_NODE: {
            "class_type": "PulidFluxModelLoader",
            "inputs": {"pulid_file": p.pulid_file},
        },
        _PULID_FACE_NODE: {
            "class_type": "PulidFluxInsightFaceLoader",
            "inputs": {"provider": "CUDA"},
        },
        _PULID_EVA_NODE: {
            "class_type": "PulidFluxEvaClipLoader",
            "inputs": {},
        },
        _PULID_IMAGE_NODE: {
            "class_type": "LoadImage",
            "inputs": {"image": p.ref_image},
        },
        _PULID_APPLY_NODE: {
            "class_type": "ApplyPulidFlux",
            "inputs": {
                "model": [_CKPT_NODE, 0],
                "pulid_flux": [_PULID_MODEL_NODE, 0],
                "eva_clip": [_PULID_EVA_NODE, 0],
                "face_analysis": [_PULID_FACE_NODE, 0],
                "image": [_PULID_IMAGE_NODE, 0],
                "weight": p.weight,
                "start_at": p.start_at,
                "end_at": p.end_at,
            },
        },
        _PULID_GUIDANCE_NODE: {
            "class_type": "FluxGuidance",
            "inputs": {"conditioning": ["6", 0], "guidance": p.guidance},
        },
    }

    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": [_PULID_APPLY_NODE, 0],
                "seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                "positive": [_PULID_GUIDANCE_NODE, 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            },
        },
        _CKPT_NODE: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": p.ckpt_name},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": p.width, "height": p.height, "batch_size": p.batch_size},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.positive, "clip": [_CKPT_NODE, 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.negative, "clip": [_CKPT_NODE, 1]},
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": [_CKPT_NODE, 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix},
        },
        **pulid_nodes,
    }


async def is_available(pool, ckpt_name: str = DEFAULT_CKPT) -> bool:
    """pool 中是否存在同时具备 PuLID 自定义节点与 FLUX.1 底模的可用 worker。

    底模经 CheckpointLoaderSimple 枚举(在 client.model_names 汇总范围内)可查;
    pulid 权重(pulid/)与 EVA02(clip_vision/)不在该汇总范围,但与节点同属一份
    NAS 模型目录,装了节点的 worker 即有权重(2026-08-01 设备侧实测)。
    """
    try:
        await pool.pick(required={ckpt_name}, required_nodes=REQUIRED_NODES)
    except ComfyUIError:
        return False
    return True
