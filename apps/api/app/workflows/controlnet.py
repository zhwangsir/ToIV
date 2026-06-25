"""ControlNet 出图 API 工作流构造器（纯函数，返回新 dict，不可变）。

CheckpointLoaderSimple →(可选 LoraLoader 链)→ CLIPTextEncode×2(正/负)
LoadImage(用户上传的控制图) → 预处理器 → ControlNetLoader
  → ControlNetApplyAdvanced(接 正/负条件 + control_net + 预处理图)
  → KSampler → VAEDecode → SaveImage

控制类型 control_type ∈ {canny, depth, lineart, openpose}:
  - canny      → CannyEdgePreprocessor
  - depth/...  → AIO_Preprocessor(以 `preprocessor` 指定对应预处理器名)

ControlNet 模型按所选 checkpoint 选择:
  - SD1.5 路径(默认):每个 control_type 对应一个 control_v11* 控网,
    ControlNetLoader 直接加载。
  - SDXL 路径(可选分支):checkpoint 命中 SDXL 时改用 union promax 控网,
    ControlNetLoader 加载 union 后插 SetUnionControlNetType 指定控制类型,
    再接 ControlNetApplyAdvanced。

ControlNetApplyAdvanced 必填(经 /object_info 实测):
  positive, negative, control_net, image, strength, start_percent, end_percent
  输出 CONDITIONING@0(positive)、CONDITIONING@1(negative)。

LoRA 叠加与 v-pred 注入沿用 txt2img/img2img 的约定。所有引用为 [node_id, output_index]。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.lora import LoraSpec, lora_chain
from app.workflows.model_profiles import is_vpred, model_sampling_node

MAX_SEED = 2**63 - 1  # 见 txt2img:适配 SQLite 有符号 64 位

# checkpoint 节点 id;LoRA 链以此为 (model,clip) 源头
_CKPT_NODE = "4"
# 控制图相关节点 id(避开主图 1-20、LoRA 链 100+、v-pred 50)
_LOADIMAGE_NODE = "10"
_PREPROCESS_NODE = "12"
_CTRLNET_LOADER_NODE = "13"
_UNION_TYPE_NODE = "14"
_CTRLNET_APPLY_NODE = "15"

# 受支持的控制类型
CONTROL_TYPES: tuple[str, ...] = ("canny", "depth", "lineart", "openpose")

# SD1.5 控网:control_type → 模型文件名(worker 已装)
_SD15_CONTROLNET_MODELS: dict[str, str] = {
    "canny": "control_v11p_sd15_canny_fp16.safetensors",
    "depth": "control_v11f1p_sd15_depth_fp16.safetensors",
    "lineart": "control_v11p_sd15_lineart_fp16.safetensors",
    "openpose": "control_v11p_sd15_openpose_fp16.safetensors",
}

# SDXL union 控网(promax,单文件覆盖全类型)
_SDXL_UNION_CONTROLNET_MODEL = "controlnet-union-sdxl-1.0-promax.safetensors"

# canny 以外的控制类型 → AIO_Preprocessor 的 `preprocessor` 取值。
# canny 走独立的 CannyEdgePreprocessor,不在此表。
_AIO_PREPROCESSORS: dict[str, str] = {
    "depth": "DepthAnythingV2Preprocessor",
    "lineart": "LineArtPreprocessor",
    "openpose": "OpenposePreprocessor",
}

# SetUnionControlNetType 的 type 取值(union 控网指定控制语义)。
_UNION_TYPE_NAMES: dict[str, str] = {
    "canny": "canny/lineart/anime_lineart/mlsd",
    "depth": "depth",
    "lineart": "canny/lineart/anime_lineart/mlsd",
    "openpose": "openpose",
}

# checkpoint 文件名命中以下任一子串(大小写不敏感)即视为 SDXL,走 union 路径。
_SDXL_HINTS: tuple[str, ...] = ("xl", "sdxl", "pony", "illustrious", "noobai", "animagine")


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def is_sdxl(ckpt_name: str) -> bool:
    """文件名是否提示 SDXL 底模(子串匹配,大小写不敏感)。

    命中则改用 union promax 控网 + SetUnionControlNetType;否则走 SD1.5 控网。
    """
    low = ckpt_name.lower()
    return any(h in low for h in _SDXL_HINTS)


@dataclass(frozen=True)
class ControlNetParams:
    positive: str
    image: str  # ComfyUI input 目录中的文件名（上传后得到）
    control_type: str = "canny"
    negative: str = ""
    ckpt_name: str = "DreamShaper_8_pruned.safetensors"
    strength: float = 0.8
    start_percent: float = 0.0
    end_percent: float = 1.0
    steps: int = 20
    cfg: float = 7.0
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    preprocess_resolution: int = 512
    filename_prefix: str = "ToIV_cn"
    loras: tuple[LoraSpec, ...] = ()

    def __post_init__(self) -> None:
        if self.control_type not in CONTROL_TYPES:
            raise ValueError(
                f"不支持的 control_type: {self.control_type!r};"
                f"可选 {CONTROL_TYPES}"
            )


def controlnet_model_name(control_type: str, ckpt_name: str) -> str:
    """按控制类型与底模返回应加载的 ControlNet 模型文件名。

    SDXL → union promax;SD1.5 → 对应 control_v11* 控网。
    """
    if control_type not in CONTROL_TYPES:
        raise ValueError(f"不支持的 control_type: {control_type!r}")
    if is_sdxl(ckpt_name):
        return _SDXL_UNION_CONTROLNET_MODEL
    return _SD15_CONTROLNET_MODELS[control_type]


def _preprocess_node(control_type: str, resolution: int) -> dict:
    """构造控制图预处理器节点(接 LoadImage 输出)。

    canny → CannyEdgePreprocessor;其它 → AIO_Preprocessor 指定 preprocessor。
    输出 IMAGE@0 供 ControlNetApplyAdvanced.image。
    """
    image_ref = [_LOADIMAGE_NODE, 0]
    if control_type == "canny":
        return {
            _PREPROCESS_NODE: {
                "class_type": "CannyEdgePreprocessor",
                "inputs": {"image": image_ref, "resolution": resolution},
            }
        }
    return {
        _PREPROCESS_NODE: {
            "class_type": "AIO_Preprocessor",
            "inputs": {
                "image": image_ref,
                "preprocessor": _AIO_PREPROCESSORS[control_type],
                "resolution": resolution,
            },
        }
    }


def _controlnet_nodes(p: ControlNetParams) -> tuple[dict, list]:
    """构造 ControlNetLoader(+SDXL union 时的 SetUnionControlNetType)节点。

    返回 (节点 dict, 供 ControlNetApplyAdvanced.control_net 的引用)。
    SD1.5 → 直引 ControlNetLoader 输出;SDXL → 经 SetUnionControlNetType。
    """
    model_name = controlnet_model_name(p.control_type, p.ckpt_name)
    nodes: dict = {
        _CTRLNET_LOADER_NODE: {
            "class_type": "ControlNetLoader",
            "inputs": {"control_net_name": model_name},
        }
    }
    if not is_sdxl(p.ckpt_name):
        return nodes, [_CTRLNET_LOADER_NODE, 0]
    # SDXL union:插 SetUnionControlNetType 指定控制语义
    nodes[_UNION_TYPE_NODE] = {
        "class_type": "SetUnionControlNetType",
        "inputs": {
            "control_net": [_CTRLNET_LOADER_NODE, 0],
            "type": _UNION_TYPE_NAMES[p.control_type],
        },
    }
    return nodes, [_UNION_TYPE_NODE, 0]


def build_controlnet_graph(p: ControlNetParams) -> dict:
    """把参数编译成 ComfyUI API 格式的 prompt 图。每次返回新 dict。"""
    # LoRA 链:checkpoint 的 (model,clip) 穿过各 LoraLoader;空 loras → 直引 checkpoint。
    lora_nodes, model_ref, clip_ref = lora_chain(
        p.loras, src_model=[_CKPT_NODE, 0], src_clip=[_CKPT_NODE, 1]
    )
    # v-pred:在 model 线末端插 ModelSamplingDiscrete;非 v-pred → {} 且 model_ref 不变。
    vpred_nodes: dict = {}
    if is_vpred(p.ckpt_name):
        vpred_nodes, model_ref = model_sampling_node(model_ref)

    preprocess_nodes = _preprocess_node(p.control_type, p.preprocess_resolution)
    ctrlnet_nodes, control_net_ref = _controlnet_nodes(p)

    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": model_ref,
                "seed": p.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "sampler_name": p.sampler,
                "scheduler": p.scheduler,
                # ControlNetApplyAdvanced 改写后的条件
                "positive": [_CTRLNET_APPLY_NODE, 0],
                "negative": [_CTRLNET_APPLY_NODE, 1],
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
            "inputs": {"width": 512, "height": 512, "batch_size": 1},
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": clip_ref}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": clip_ref}},
        _LOADIMAGE_NODE: {"class_type": "LoadImage", "inputs": {"image": p.image}},
        _CTRLNET_APPLY_NODE: {
            "class_type": "ControlNetApplyAdvanced",
            "inputs": {
                "positive": ["6", 0],
                "negative": ["7", 0],
                "control_net": control_net_ref,
                "image": [_PREPROCESS_NODE, 0],
                "strength": p.strength,
                "start_percent": p.start_percent,
                "end_percent": p.end_percent,
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": [_CKPT_NODE, 2]}},
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix},
        },
        **preprocess_nodes,
        **ctrlnet_nodes,
        **lora_nodes,
        **vpred_nodes,
    }
