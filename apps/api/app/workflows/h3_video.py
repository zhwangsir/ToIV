"""MiniMax H3 视频生成(t2v / i2v / fl2v / r2v)API 工作流构造器。

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
  · MiniMaxH3ReferenceToVideo(Ref2VA)另需 audio_vae + 1-based 参考槽
    ref_image_1..9 / ref_video_1..3 / ref_video_audio_1..3 / ref_audio_1..3。
    SFW 底模是 Ref2VA UNET,不是模板里的 FL2VA。
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
_NODE_H3 = "104"  # MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo
_NODE_NOISE = "15"  # RandomNoise
_NODE_SCHED = "9"  # BasicScheduler
_NODE_SAVE = "92"  # SaveVideo
_NODE_LOAD_IMAGE = "100"  # LoadImage(i2v 首帧)
_NODE_LOAD_LAST = "101"  # LoadImage(fl2v 尾帧;避开 LoRA 200+)
_NODE_AUDIO_VAE = "24"  # i2v 模板音频 VAE(Ref2VA 的 audio_vae)
_NODE_CLIP = "13"
_NODE_VAE = "11"

# r2v 参考加载节点:避开模板 6-104、i2v/fl2v 的 100/101、LoRA 200+
_R2V_IMAGE_BASE = 110  # LoadImage 110-118 → ref_image_1..9
_R2V_VIDEO_BASE = 120  # LoadVideo+GetVideoComponents 成对:120/121,122/123,124/125
_R2V_AUDIO_BASE = 130  # LoadAudio 130-132 → ref_audio_1..3

# SFW Ref2VA UNET:与 FL2VA 模板(minimax_h3_fl2va_pruned_int8_convrot)不同。
# 文件名来自评测 scripts/eval/r2v_eval.py 与 Comfy 2026 文档;NAS 三件套含 ref2va。
H3_R2V_UNET = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"

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
    """H3 图生视频参数:image 为首帧文件名;last_frame 可选尾帧(同为 H3 input 目录名)。"""

    image: str = ""
    last_frame: str = ""
    filename_prefix: str = "ToIV_h3/i2v"


@dataclass(frozen=True)
class H3R2VParams(H3T2VParams):
    """H3 Ref2VA 多参考视频:至少一张图 / 一段视频 / 一段音频。

    提示词按类型 1-based 标签引用(<Picture 1> / <Video 1> / <Audio 1>)。
    videos 须 ≥5 帧;LoadVideo → GetVideoComponents 拆帧+音轨再接入节点。
    """

    images: tuple[str, ...] = ()
    videos: tuple[str, ...] = ()
    audios: tuple[str, ...] = ()
    ref_image_size: str = "match"
    filename_prefix: str = "ToIV_h3/r2v"


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
    """图生视频图:模板已含 LoadImage → first_frame。

    last_frame 有值时加 LoadImage 101 接到节点 104 inputs.last_frame;
    未设则省略 last_frame 键(Comfy 可选输入:空则不要出现在 API JSON 里)。
    """
    graph = copy.deepcopy(_load_template("i2v_prompt.json"))
    _inject_common(graph, params)
    _inject_loras(graph, params.loras)
    graph[_NODE_LOAD_IMAGE]["inputs"]["image"] = params.image
    last = (params.last_frame or "").strip()
    if last:
        graph[_NODE_LOAD_LAST] = {
            "class_type": "LoadImage",
            "inputs": {"image": last},
        }
        graph[_NODE_H3]["inputs"]["last_frame"] = [_NODE_LOAD_LAST, 0]
    else:
        graph[_NODE_H3]["inputs"].pop("last_frame", None)
    return graph


def build_h3_r2v_graph(params: H3R2VParams) -> dict:
    """Ref2VA 多参考图:克隆 i2v 采样/解码/保存链,节点 104 换成 MiniMaxH3ReferenceToVideo。

    参考槽 1-based(与 Comfy 2026 文档 / prompt 标签一致)。至少一种参考,否则 ValueError。
    SFW UNET 换成 H3_R2V_UNET;NSFW 仍由 submit_h3_job.apply_nsfw_unet 换 10Eros。
    """
    images = tuple(n for n in params.images if (n or "").strip())
    videos = tuple(n for n in params.videos if (n or "").strip())
    audios = tuple(n for n in params.audios if (n or "").strip())
    if not (images or videos or audios):
        raise ValueError("r2v 至少需要一张参考图、一段参考视频或一段参考音频")
    if len(images) > 9:
        raise ValueError("r2v 参考图最多 9 张")
    if len(videos) > 3:
        raise ValueError("r2v 参考视频最多 3 段")
    if len(audios) > 3:
        raise ValueError("r2v 参考音频最多 3 段")
    size = params.ref_image_size if params.ref_image_size in ("match", "max") else "match"

    graph = copy.deepcopy(_load_template("i2v_prompt.json"))
    graph.pop(_NODE_LOAD_IMAGE, None)
    graph[_NODE_UNET]["inputs"]["unet_name"] = H3_R2V_UNET
    graph[_NODE_H3] = {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
            "clip": [_NODE_CLIP, 0],
            "vae": [_NODE_VAE, 0],
            "audio_vae": [_NODE_AUDIO_VAE, 0],
            "prompt": params.positive,
            "width": params.width,
            "height": params.height,
            "length": params.length,
            "ref_image_size": size,
        },
    }
    h3_in = graph[_NODE_H3]["inputs"]
    for i, name in enumerate(images, start=1):
        nid = str(_R2V_IMAGE_BASE + i - 1)
        graph[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        h3_in[f"ref_image_{i}"] = [nid, 0]
    for i, name in enumerate(videos, start=1):
        load_id = str(_R2V_VIDEO_BASE + (i - 1) * 2)
        split_id = str(_R2V_VIDEO_BASE + (i - 1) * 2 + 1)
        graph[load_id] = {"class_type": "LoadVideo", "inputs": {"file": name}}
        graph[split_id] = {"class_type": "GetVideoComponents", "inputs": {"video": [load_id, 0]}}
        h3_in[f"ref_video_{i}"] = [split_id, 0]
        h3_in[f"ref_video_audio_{i}"] = [split_id, 1]
    for i, name in enumerate(audios, start=1):
        nid = str(_R2V_AUDIO_BASE + i - 1)
        graph[nid] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        h3_in[f"ref_audio_{i}"] = [nid, 0]

    _inject_common(graph, params)
    _inject_loras(graph, params.loras)
    return graph
