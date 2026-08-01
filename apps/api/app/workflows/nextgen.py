"""次世代出图族的 ComfyUI 图构造器(flux2 / qwen_image / z_image)。

与 SD 系 `txt2img.build_txt2img_graph`(CheckpointLoaderSimple)不同,次世代模型是
**diffusion_models**(UNETLoader)+ 独立文本编码器(CLIPLoader)+ 独立 VAE(VAELoader),
关键正确性:真实 **CFG≈1**、Euler/res_multistep + **simple**(禁 Karras)、**负向失效**
(空负向,cfg=1 下本就无效)。族差异(clip 类型 / model-sampling 节点 / latent 节点 /
FluxGuidance)全部来自 `model_profiles.NextgenRecipe`(数据,worker /object_info 实测),
本构造器只按配方装配,不写 per-model 分支。

节点 schema 依 worker :8002 /object_info 实测:
  UNETLoader(unet_name, weight_dtype) / CLIPLoader(clip_name, type) / VAELoader(vae_name)
  ModelSamplingAuraFlow(model, shift) / ModelSamplingFlux(model, max_shift, base_shift, w, h)
  CLIPTextEncode(clip, text) / TextEncodeZImageOmni(clip, prompt, auto_resize_images)
  FluxGuidance(conditioning, guidance) / EmptySD3LatentImage|EmptyFlux2LatentImage(w,h,batch)
  LoadImage(image) / VAEEncode(pixels, vae)
  KSampler(...) / VAEDecode(samples, vae) / SaveImage(images, filename_prefix)
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.lora import LoraSpec, lora_chain
from app.workflows.model_profiles import NextgenRecipe, nextgen_recipe

MAX_SEED = 2**63 - 1

# Flux 系 ModelSamplingFlux 默认 shift(ComfyUI flux 模板值)
_FLUX_MAX_SHIFT = 1.15
_FLUX_BASE_SHIFT = 0.5


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class NextgenParams:
    """次世代 txt2img 参数。sampler/cfg/steps 由调用方按 profile 强制后传入;负向已按族决定是否清空。"""

    model_name: str  # diffusion_models 里的 UNET 权重名(决定族 + 配方)
    positive: str
    negative: str = ""  # neg_prompt=False 的族此处应为空(调用方保证)
    width: int = 1024
    height: int = 1024
    steps: int = 20
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    batch_size: int = 1
    weight_dtype: str = "default"
    filename_prefix: str = "ToIV"
    # 文本编码器覆盖:非空时优先于配方默认(调用方按 worker 可用性解析后传入)
    clip_name: str | None = None
    # 叠加 LoRA(经 lora_chain 编成 LoraLoader 链,UNET+CLIP 同时作用)
    loras: tuple[LoraSpec, ...] = ()


@dataclass(frozen=True)
class NextgenImg2ImgParams:
    """次世代 img2img 参数。与 txt2img 区别:输入图 + denoise,无 width/height(由输入图决定)。"""

    model_name: str
    image: str  # ComfyUI input 目录中的文件名(上传后得到)
    positive: str
    negative: str = ""
    denoise: float = 0.6
    steps: int = 20
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    weight_dtype: str = "default"
    filename_prefix: str = "ToIV_i2i"
    # 文本编码器覆盖:非空时优先于配方默认(与 NextgenParams 对齐)
    clip_name: str | None = None
    # 叠加 LoRA(与 NextgenParams 对齐)
    loras: tuple[LoraSpec, ...] = ()


class NextgenError(ValueError):
    """所选模型不是已知的次世代族(无配方)。"""


def build_nextgen_graph(p: NextgenParams) -> dict:
    """把参数 + 族配方编译成 ComfyUI API 格式图。纯函数,返回新 dict。"""
    recipe = nextgen_recipe(p.model_name)
    if recipe is None:
        raise NextgenError(f"{p.model_name} 不是已知次世代族(无 NextgenRecipe)")

    nodes: dict = {}

    # 1) UNET 主模型
    nodes["1"] = {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": p.model_name, "weight_dtype": p.weight_dtype},
    }

    # 2) 文本编码器
    nodes["3"] = {
        "class_type": "CLIPLoader",
        "inputs": {"clip_name": p.clip_name or recipe.clip_name, "type": recipe.clip_type},
    }

    # 3) 可选 LoRA 链(UNET 之后、model-sampling 之前;CLIP 之后、文本编码之前)
    lora_nodes, model_ref, clip_ref = lora_chain(p.loras, ["1", 0], ["3", 0])
    nodes.update(lora_nodes)

    # 4) 可选 model-sampling(AuraFlow/Flux)——修正 shift,提升构图/清晰度
    if recipe.model_sampling == "ModelSamplingAuraFlow":
        nodes["2"] = {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": model_ref, "shift": recipe.shift},
        }
        model_ref = ["2", 0]
    elif recipe.model_sampling == "ModelSamplingFlux":
        nodes["2"] = {
            "class_type": "ModelSamplingFlux",
            "inputs": {
                "model": model_ref,
                "max_shift": _FLUX_MAX_SHIFT,
                "base_shift": _FLUX_BASE_SHIFT,
                "width": p.width,
                "height": p.height,
            },
        }
        model_ref = ["2", 0]

    # 4/5) 正/负条件(负向按族失效 → 空串;Z-Image 用专用 TextEncodeZImageOmni)
    def _encode(node_id: str, text: str) -> None:
        if recipe.text_encode == "TextEncodeZImageOmni":
            nodes[node_id] = {
                "class_type": "TextEncodeZImageOmni",
                "inputs": {"clip": clip_ref, "prompt": text, "auto_resize_images": False},
            }
        else:
            nodes[node_id] = {
                "class_type": "CLIPTextEncode",
                "inputs": {"clip": clip_ref, "text": text},
            }

    _encode("4", p.positive)
    _encode("5", p.negative)
    pos_ref: list = ["4", 0]
    neg_ref: list = ["5", 0]

    # 6) 可选 FluxGuidance(仅作用于正向)
    if recipe.guidance is not None:
        nodes["6"] = {
            "class_type": "FluxGuidance",
            "inputs": {"conditioning": pos_ref, "guidance": recipe.guidance},
        }
        pos_ref = ["6", 0]

    # 7) 空 latent(族专用节点)
    nodes["7"] = {
        "class_type": recipe.latent_node,
        "inputs": {"width": p.width, "height": p.height, "batch_size": p.batch_size},
    }

    # 8) 采样
    nodes["8"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_ref,
            "seed": p.seed,
            "steps": p.steps,
            "cfg": p.cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": pos_ref,
            "negative": neg_ref,
            "latent_image": ["7", 0],
            "denoise": 1.0,
        },
    }

    # 9/10/11) VAE 解码 + 保存
    nodes["9"] = {"class_type": "VAELoader", "inputs": {"vae_name": recipe.vae_name}}
    nodes["10"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["8", 0], "vae": ["9", 0]},
    }
    nodes["11"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["10", 0], "filename_prefix": p.filename_prefix},
    }
    return nodes


def build_nextgen_img2img_graph(p: NextgenImg2ImgParams) -> dict:
    """次世代 img2img:LoadImage → VAEEncode → KSampler(denoise<1) → VAEDecode → SaveImage。

    与 txt2img 区别:无空 latent 节点,改用 LoadImage+VAEEncode 得到输入图 latent;
    KSampler.denoise 取 p.denoise(由调用方传入)。VAE 同样从配方加载(非 checkpoint 内置)。
    """
    recipe = nextgen_recipe(p.model_name)
    if recipe is None:
        raise NextgenError(f"{p.model_name} 不是已知次世代族(无 NextgenRecipe)")

    nodes: dict = {}

    # 1) UNET 主模型
    nodes["1"] = {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": p.model_name, "weight_dtype": p.weight_dtype},
    }

    # 2) 文本编码器
    nodes["3"] = {
        "class_type": "CLIPLoader",
        "inputs": {"clip_name": p.clip_name or recipe.clip_name, "type": recipe.clip_type},
    }

    # 3) 可选 LoRA 链(同 txt2img:UNET 之后、model-sampling 之前)
    lora_nodes, model_ref, clip_ref = lora_chain(p.loras, ["1", 0], ["3", 0])
    nodes.update(lora_nodes)

    # 4) 可选 model-sampling(AuraFlow/Flux)
    if recipe.model_sampling == "ModelSamplingAuraFlow":
        nodes["2"] = {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": model_ref, "shift": recipe.shift},
        }
        model_ref = ["2", 0]
    elif recipe.model_sampling == "ModelSamplingFlux":
        nodes["2"] = {
            "class_type": "ModelSamplingFlux",
            "inputs": {
                "model": model_ref,
                "max_shift": _FLUX_MAX_SHIFT,
                "base_shift": _FLUX_BASE_SHIFT,
                "width": 0,
                "height": 0,
            },
        }
        model_ref = ["2", 0]

    # 4/5) 正/负条件
    def _encode(node_id: str, text: str) -> None:
        if recipe.text_encode == "TextEncodeZImageOmni":
            nodes[node_id] = {
                "class_type": "TextEncodeZImageOmni",
                "inputs": {"clip": clip_ref, "prompt": text, "auto_resize_images": False},
            }
        else:
            nodes[node_id] = {
                "class_type": "CLIPTextEncode",
                "inputs": {"clip": clip_ref, "text": text},
            }

    _encode("4", p.positive)
    _encode("5", p.negative)
    pos_ref: list = ["4", 0]
    neg_ref: list = ["5", 0]

    # 6) 可选 FluxGuidance
    if recipe.guidance is not None:
        nodes["6"] = {
            "class_type": "FluxGuidance",
            "inputs": {"conditioning": pos_ref, "guidance": recipe.guidance},
        }
        pos_ref = ["6", 0]

    # 7/8) 加载输入图 + VAE 编码(用配方 VAE)
    nodes["7"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    nodes["9"] = {"class_type": "VAELoader", "inputs": {"vae_name": recipe.vae_name}}
    nodes["8"] = {
        "class_type": "VAEEncode",
        "inputs": {"pixels": ["7", 0], "vae": ["9", 0]},
    }

    # 10) 采样(denoise<1)
    nodes["10"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_ref,
            "seed": p.seed,
            "steps": p.steps,
            "cfg": p.cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": pos_ref,
            "negative": neg_ref,
            "latent_image": ["8", 0],
            "denoise": p.denoise,
        },
    }

    # 11/12) VAE 解码 + 保存
    nodes["11"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["10", 0], "vae": ["9", 0]},
    }
    nodes["12"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["11", 0], "filename_prefix": p.filename_prefix},
    }
    return nodes
