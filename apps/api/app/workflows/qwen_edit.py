"""Qwen-Image-Edit-2509 语义图像编辑(含多角度相机控制)的 ComfyUI 图构造器。

专用实例:pc02 RTX 5090 :8194(与 LB 池 :8193 隔离,TOIV_QWEN_EDIT_BASE_URL),
节点 `TextEncodeQwenImageEdit`(optional 输入 vae/image)仅该实例装有。
权重(NAS 共享,实例已可见):
  UNET(diffusion_models): qwen_image_edit_2509_fp8_e4m3fn.safetensors
  TE(text_encoders):      qwen_2.5_vl_7b_fp8_scaled.safetensors(CLIPLoader type=qwen_image)
  VAE:                    qwen_image_vae.safetensors
  LoRA(loras): Qwen-Edit-2509-Multiple-angles(相机控制,选了角度才挂,强度 1.0)
               Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16(加速,始终挂)

图结构(官方 qwen image edit 模板接法):
  UNETLoader → (LoraLoader×2 串联) → KSampler
  CLIPLoader → TextEncodeQwenImageEdit(正;接 vae+image)/ 负向同节点但不接 image
  LoadImage(服务端转存后的文件名)→ VAEEncode → KSampler.latent_image(denoise=1.0)
  KSampler(euler / simple;fast=8 步 cfg 1.0,标准=20 步 cfg 2.5)→ VAEDecode → SaveImage

相机角度:LoRA 无触发词,直接把中文指令拼进 positive(指令文案来自作者 README)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.lora import LoraSpec, lora_chain

MAX_SEED = 2**63 - 1

# 权重文件名(与 NAS 落盘一致;改动须同步 engine_registry 探测与实例 extra_model_paths)
QWEN_EDIT_UNET = "qwen_image_edit_2509_fp8_e4m3fn.safetensors"
QWEN_EDIT_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
QWEN_EDIT_VAE = "qwen_image_vae.safetensors"
CAMERA_LORA = "Qwen-Edit-2509-Multiple-angles.safetensors"
LIGHTNING_LORA = "Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors"

# 相机角度预设:key → 拼进 positive 的中文指令(作者 README 原文;LoRA 无触发词)
CAMERA_PRESETS: dict[str, str] = {
    "forward": "将镜头向前移动",
    "left": "将镜头向左移动",
    "right": "将镜头向右移动",
    "up": "将镜头向上移动",
    "down": "将镜头向下移动",
    "rotate_left": "将镜头向左旋转45度",
    "rotate_right": "将镜头向右旋转45度",
    "top_down": "将镜头转为俯视",
    "wide": "将镜头转为广角镜头",
    "closeup": "将镜头转为特写镜头",
}

# 采样档位:fast=True 挂 Lightning 加速 LoRA 走 8 步;标准档 20 步(与作者示例一致)
_FAST_STEPS = 8
_FAST_CFG = 1.0
_STD_STEPS = 20
_STD_CFG = 2.5


class QwenEditError(ValueError):
    """非法参数(如未知相机角度 key)。"""


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class QwenEditParams:
    """Qwen-Image-Edit 参数。image 为已转存到编辑实例 input 目录的文件名。"""

    image: str  # 编辑实例 input 目录中的文件名(端点服务端转存后得到)
    positive: str  # 编辑指令(如「把衣服换成红色」)
    camera: str | None = None  # CAMERA_PRESETS 的 key;None = 不做相机控制
    fast: bool = True  # True=8 步 Lightning 加速档;False=20 步标准档
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_qwen_edit"


def build_qwen_edit_graph(p: QwenEditParams) -> dict:
    """把参数编译成 ComfyUI API 格式图。纯函数,返回新 dict。"""
    if p.camera is not None and p.camera not in CAMERA_PRESETS:
        raise QwenEditError(f"未知相机角度:{p.camera!r};可选 {list(CAMERA_PRESETS)}")

    positive = p.positive
    if p.camera is not None:
        # 纯相机操作时 positive 为空,避免出现前导逗号
        instr = CAMERA_PRESETS[p.camera]
        positive = f"{p.positive}, {instr}" if p.positive.strip() else instr

    steps = _FAST_STEPS if p.fast else _STD_STEPS
    cfg = _FAST_CFG if p.fast else _STD_CFG

    nodes: dict = {}

    # 1) UNET 主模型 + 2) 文本编码器 + 3) VAE
    nodes["1"] = {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": QWEN_EDIT_UNET, "weight_dtype": "default"},
    }
    nodes["3"] = {
        "class_type": "CLIPLoader",
        "inputs": {"clip_name": QWEN_EDIT_CLIP, "type": "qwen_image"},
    }
    nodes["9"] = {"class_type": "VAELoader", "inputs": {"vae_name": QWEN_EDIT_VAE}}

    # 4) LoRA 链:相机 LoRA 仅选了角度时挂(强度 1.0),Lightning 加速始终挂
    loras: list[LoraSpec] = []
    if p.camera is not None:
        loras.append(LoraSpec(name=CAMERA_LORA, weight=1.0))
    loras.append(LoraSpec(name=LIGHTNING_LORA, weight=1.0))
    lora_nodes, model_ref, clip_ref = lora_chain(tuple(loras), ["1", 0], ["3", 0])
    nodes.update(lora_nodes)

    # 5) 源图 + latent(编辑图的 latent 来自源图 VAEEncode,denoise=1.0 全量重采样)
    nodes["7"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    nodes["10"] = {
        "class_type": "VAEEncode",
        "inputs": {"pixels": ["7", 0], "vae": ["9", 0]},
    }

    # 6) 正/负条件:正向 TextEncodeQwenImageEdit 接 vae+image(语义编辑的图条件);
    #    负向同节点但不接 image(社区惯例:空负向即可,cfg 1.0 加速档下本就无效)
    nodes["4"] = {
        "class_type": "TextEncodeQwenImageEdit",
        "inputs": {
            "clip": clip_ref,
            "prompt": positive,
            "vae": ["9", 0],
            "image": ["7", 0],
        },
    }
    nodes["5"] = {
        "class_type": "TextEncodeQwenImageEdit",
        "inputs": {"clip": clip_ref, "prompt": ""},
    }

    # 7) 采样
    nodes["8"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_ref,
            "seed": p.seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["4", 0],
            "negative": ["5", 0],
            "latent_image": ["10", 0],
            "denoise": 1.0,
        },
    }

    # 8) 解码 + 保存
    nodes["11"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["8", 0], "vae": ["9", 0]},
    }
    nodes["12"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["11", 0], "filename_prefix": p.filename_prefix},
    }
    return nodes
