"""IPAdapter 角色一致性工作流构造器(纯函数，返回新 dict，不可变)。

漫剧 M2 核心:每个镜头喂同一张角色参考图，使各镜人物外观保持一致。
在 txt2img 基础上插入 IPAdapter 节点链(节点经 worker 实测在 .100 上可用):

CheckpointLoaderSimple
  →(可选 LoraLoader 链)
  → IPAdapterUnifiedLoader(model, preset)        # 自动装好 ipadapter + CLIP vision
  → IPAdapterAdvanced(model, ipadapter, image=LoadImage(角色参考图),
                      weight, weight_type, start_at, end_at)
  → (v-pred 时 ModelSamplingDiscrete)
  → KSampler.model
CLIPTextEncode×2 / EmptyLatentImage / VAEDecode / SaveImage 照常(同 txt2img)。

IPAdapterUnifiedLoader 入参 {model, preset};preset 默认 'PLUS FACE (portraits)'
(肖像/角色脸最稳)。IPAdapterAdvanced 把参考图(LoadImage)接到 image 输入，并产出
新的 MODEL，串到下游采样。无参考图时不应调用本构造器(端点层回退普通 txt2img)。

节点 id 约定沿用 txt2img.py:小数字 id(3-9)给主链，IPAdapter 节点用 _IPA_ID_BASE
起的较大 id(避开 LoRA 链的 100 段)。class_type 与 inputs 对齐 worker 实测 schema。

⚠️ 已知约束:worker 上 ip-adapter 模型文件当前未装(ipadapter_file: [])。本图按标准
做法(IPAdapterUnifiedLoader + preset)照常构建，真跑前需先装 ip-adapter 模型，该步
由主程序另行处理。图结构与接口在此先建对。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

from app.workflows.lora import LoraSpec, lora_chain
from app.workflows.model_profiles import is_vpred, model_sampling_node

# SQLite 有符号 64 位上限;与 txt2img 一致
MAX_SEED = 2**63 - 1

# checkpoint 节点 id;LoRA / IPAdapter 链以此为 (model,clip,vae) 源头
_CKPT_NODE = "4"

# IPAdapter 节点 id 起点:避开主链(3-9)与 LoRA 链(100 段)
_IPA_ID_BASE = 200
_IPA_LOADER_NODE = str(_IPA_ID_BASE)  # IPAdapterUnifiedLoader
_IPA_APPLY_NODE = str(_IPA_ID_BASE + 1)  # IPAdapterAdvanced
_IPA_IMAGE_NODE = str(_IPA_ID_BASE + 2)  # LoadImage(角色参考图)

# 默认 preset:肖像/角色脸一致性最稳;可由调用方覆盖
DEFAULT_PRESET = "PLUS FACE (portraits)"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class IPAdapterTxt2ImgParams:
    """IPAdapter 角色一致性 txt2img 参数。

    ref_image:已上传到 worker 的角色参考图文件名(必填，空则不应走本构造器)。
    weight/weight_type/start_at/end_at 透传给 IPAdapterAdvanced 控制参考强度与作用区间。
    """

    positive: str
    ref_image: str
    negative: str = ""
    ckpt_name: str = "DreamShaper_8_pruned.safetensors"
    preset: str = DEFAULT_PRESET
    weight: float = 0.8
    weight_type: str = "linear"
    start_at: float = 0.0
    end_at: float = 1.0
    width: int = 512
    height: int = 512
    steps: int = 20
    cfg: float = 7.0
    sampler: str = "euler"
    scheduler: str = "normal"
    seed: int = field(default_factory=_random_seed)
    batch_size: int = 1
    filename_prefix: str = "ToIV_ipa"
    # 叠加的 LoRA(空 = 不加载，链退化为直引 checkpoint)
    loras: tuple[LoraSpec, ...] = ()


def build_ipadapter_txt2img_graph(p: IPAdapterTxt2ImgParams) -> dict:
    """把参数编译成带 IPAdapter 的 ComfyUI API 格式 prompt 图。每次返回新 dict。

    model 线:checkpoint →(LoRA 链)→ IPAdapterUnifiedLoader → IPAdapterAdvanced
    →(v-pred 时 ModelSamplingDiscrete)→ KSampler.model。
    clip 线不受 IPAdapter 影响,照常供 CLIPTextEncode。
    """
    # LoRA 链:checkpoint 的 (model,clip) 依次穿过各 LoraLoader;空 loras → 直引 checkpoint
    lora_nodes, model_ref, clip_ref = lora_chain(
        p.loras, src_model=[_CKPT_NODE, 0], src_clip=[_CKPT_NODE, 1]
    )

    # IPAdapter:UnifiedLoader 先在 model 上装好 ipadapter + CLIP vision(按 preset)，
    # 再由 Advanced 用参考图(LoadImage)条件化，产出新的 MODEL。
    ipa_nodes: dict = {
        _IPA_LOADER_NODE: {
            "class_type": "IPAdapterUnifiedLoader",
            "inputs": {"model": model_ref, "preset": p.preset},
        },
        _IPA_IMAGE_NODE: {
            "class_type": "LoadImage",
            "inputs": {"image": p.ref_image},
        },
        _IPA_APPLY_NODE: {
            "class_type": "IPAdapterAdvanced",
            "inputs": {
                "model": [_IPA_LOADER_NODE, 0],
                "ipadapter": [_IPA_LOADER_NODE, 1],
                "image": [_IPA_IMAGE_NODE, 0],
                "weight": p.weight,
                "weight_type": p.weight_type,
                "start_at": p.start_at,
                "end_at": p.end_at,
            },
        },
    }
    # IPAdapter 之后的 MODEL 引用，送往采样器
    model_ref = [_IPA_APPLY_NODE, 0]

    # v-pred:在 model 线末端(IPAdapter 之后)插 ModelSamplingDiscrete;非 v-pred → 不插
    vpred_nodes: dict = {}
    if is_vpred(p.ckpt_name):
        vpred_nodes, model_ref = model_sampling_node(model_ref)

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
                "positive": ["6", 0],
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
            "inputs": {"text": p.positive, "clip": clip_ref},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": p.negative, "clip": clip_ref},
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": [_CKPT_NODE, 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix},
        },
        **lora_nodes,
        **ipa_nodes,
        **vpred_nodes,
    }
