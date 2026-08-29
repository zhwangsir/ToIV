"""MiniMax H3 视频生成(t2v / i2v)API 工作流构造器。

模板来自评测存档(app/workflows/h3/{t2v,i2v}_prompt.json,外层 {"prompt": {...}}),
节点链:UNETLoader → CLIPLoader(minimax) → MiniMaxH3ImageToVideo → BasicScheduler(simple)
+ KSamplerSelect(res_multistep) → SamplerCustomAdvanced → VAEDecode + VAEDecodeAudio
→ CreateVideo(24fps) → SaveVideo(h264 + AAC 32kHz)。

关键参数事实(真机压测):
  · 分辨率上限 1344×768,32 对齐
  · 帧数 17k+5 网格 @24fps(124≈5.2s,上限 362≈15s)
  · 采样 20 steps,res_multistep/simple(模板内固定)
  · MiniMaxH3ImageToVideo 输入仅 clip/vae/prompt/width/height/length
    + 可选 first_frame/last_frame —— **无独立负向提示词输入**。
    调用方仍传 negative:节点没有该字段时折进 prompt 末尾「Avoid: …」
    (H3 单条件模型,这是唯一能起作用的路径);模板若已有 negative_prompt
    则写入节点、不再折进 prompt(见 _inject_common / _fold_negative)
"""
from __future__ import annotations

import copy
import json
import secrets
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from app.workflows.lora import LoraSpec

MAX_SEED = 2**63 - 1

_TEMPLATE_DIR = Path(__file__).parent / "h3"

# 模板节点 id(评测存档固定)
_NODE_UNET = "6"  # UNETLoader(H3 DiT,int8 分片)
_NODE_H3 = "104"  # MiniMaxH3ImageToVideo
_NODE_NOISE = "15"  # RandomNoise
_NODE_SCHED = "9"  # BasicScheduler
_NODE_SAVE = "92"  # SaveVideo
_NODE_LOAD_IMAGE = "100"  # LoadImage(仅 i2v 模板)

# 消费 UNET 输出的下游节点(LoRA 链插入后须把它们的 model 引用改接到链末端)
_MODEL_CONSUMERS = ("16", "9")  # BasicGuider / BasicScheduler

# LoRA 节点 id 起点:避开模板 id(6-104)与 lora.py 默认 _LORA_ID_BASE=100(i2v 的 LoadImage)
_LORA_ID_BASE = 200


@dataclass(frozen=True)
class H3T2VParams:
    """H3 文生视频参数。seed 缺省随机(与 ltx_video 同一惯例)。

    loras:可选 LoRA 叠加链(musubi 系 H3 LoRA 只含 DiT 权重,故用
    LoraLoaderModelOnly 只作用 UNET,不碰 qwen3vl CLIP);空 = 图与未加 LoRA 一致。
    """

    positive: str
    negative: str = ""
    width: int = 1344
    height: int = 768
    length: int = 124  # 17k+5 帧网格 @24fps
    steps: int = 20
    seed: int = field(default_factory=lambda: secrets.randbelow(MAX_SEED))
    loras: tuple[LoraSpec, ...] = ()
    filename_prefix: str = "ToIV_h3/t2v"


@dataclass(frozen=True)
class H3I2VParams(H3T2VParams):
    """H3 图生视频参数:image 为 H3 实例 input 目录中的首帧文件名。"""

    image: str = ""
    filename_prefix: str = "ToIV_h3/i2v"


@lru_cache
def _load_template(name: str) -> dict:
    """加载 API 格式模板(外层 {"prompt": {...}},取内层节点图)。缓存后 deepcopy 使用。"""
    with open(_TEMPLATE_DIR / name, encoding="utf-8") as f:
        data = json.load(f)
    return data["prompt"]


# 与 H3T2VRequest.positive max_length 对齐;超长时截 negative 不截场景
_H3_PROMPT_MAX = 4000
_AVOID_MARK = "Avoid: "


def _fold_negative(positive: str, negative: str, h3_inputs: dict) -> str:
    """节点无负向口时把 negative 折进 prompt;已有 negative_prompt/negative 字段则不折。"""
    neg = (negative or "").strip()
    if not neg:
        return positive
    if "negative_prompt" in h3_inputs or "negative" in h3_inputs:
        return positive
    if _AVOID_MARK in positive:
        return positive
    suffix = "\n\n" + _AVOID_MARK + neg
    room = _H3_PROMPT_MAX - len(positive)
    if room <= len("\n\n" + _AVOID_MARK):
        return positive
    if len(suffix) > room:
        suffix = suffix[:room]
    return positive + suffix


def _inject_common(graph: dict, params: H3T2VParams) -> None:
    """注入两模式共用参数:提示词/宽高/帧数/steps/seed/产物前缀。"""
    h3 = graph[_NODE_H3]["inputs"]
    h3["prompt"] = _fold_negative(params.positive, params.negative, h3)
    h3["width"] = params.width
    h3["height"] = params.height
    h3["length"] = params.length
    # 未来模板若出现负向口,写入节点(此时 _fold_negative 已跳过,不会双写)
    if params.negative and "negative_prompt" in h3:
        h3["negative_prompt"] = params.negative
    elif params.negative and "negative" in h3:
        h3["negative"] = params.negative
    graph[_NODE_NOISE]["inputs"]["noise_seed"] = params.seed
    graph[_NODE_SCHED]["inputs"]["steps"] = params.steps
    graph[_NODE_SAVE]["inputs"]["filename_prefix"] = params.filename_prefix


def _inject_loras(graph: dict, loras: tuple[LoraSpec, ...]) -> None:
    """在 UNETLoader 之后、采样链之前插入 LoraLoaderModelOnly 叠加链。

    H3(musubi 系)LoRA 只含 DiT 权重,用 ModelOnly 变体只改写 MODEL,不接 CLIP
    (CLIP 是 qwen3vl 32B,LoRA 无对应键);下游 BasicGuider/BasicScheduler 的 model
    引用改接到链末端。空 loras → 图与未加 LoRA 完全一致。
    """
    if not loras:
        return
    model_ref: list = [_NODE_UNET, 0]
    for i, lora in enumerate(loras):
        node_id = str(_LORA_ID_BASE + i)
        graph[node_id] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": model_ref,
                "lora_name": lora.name,
                "strength_model": lora.weight,
            },
        }
        model_ref = [node_id, 0]
    for consumer in _MODEL_CONSUMERS:
        graph[consumer]["inputs"]["model"] = model_ref


def apply_nsfw_unet(graph: dict, unet_name: str) -> None:
    """NSFW 场景切换 UNETLoader(节点 "6")底模(如 10Eros-Max 嫁接版);SFW 不调用。"""
    graph[_NODE_UNET]["inputs"]["unet_name"] = unet_name


def build_h3_t2v_graph(params: H3T2VParams) -> dict:
    """文生视频图:模板 + 参数注入(+ 可选 LoRA 链)。"""
    graph = copy.deepcopy(_load_template("t2v_prompt.json"))
    _inject_common(graph, params)
    _inject_loras(graph, params.loras)
    return graph


def build_h3_i2v_graph(params: H3I2VParams) -> dict:
    """图生视频图:模板已含 LoadImage → first_frame 连接,注入首帧文件名(+ 可选 LoRA 链)。"""
    graph = copy.deepcopy(_load_template("i2v_prompt.json"))
    _inject_common(graph, params)
    _inject_loras(graph, params.loras)
    graph[_NODE_LOAD_IMAGE]["inputs"]["image"] = params.image
    return graph
