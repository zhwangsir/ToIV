"""LoRA 叠加链构造器(纯函数,返回新对象,不可变)。

ComfyUI 的 `LoraLoader` 同时改写 MODEL 与 CLIP,可链式串联以叠加多个 LoRA。
本模块把一组 (lora_name, strength) 编译成连续的 LoraLoader 节点,返回:
  - 节点 dict(可并入主图)
  - 末端 model 引用(供 KSampler.model)
  - 末端 clip 引用(供 CLIPTextEncode.clip)
空列表时直接回传源引用(checkpoint 的 model/clip),图与未加 LoRA 时完全一致。

class_type 与 inputs 经 /object_info 实测:
  required: model / clip / lora_name / strength_model / strength_clip
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# LoRA 节点 id 前缀,避开主图常用的小数字 id(1-20)
_LORA_ID_BASE = 100

# A1111/Forge 风格 <lora:NAME:WEIGHT> 标签。ComfyUI 的 CLIPTextEncode 不解析该语法,
# 标签留在文本里只会污染编码,须在服务端剥离并转成 LoraLoader 链(见 parse_lora_tags)。
_LORA_TAG_RE = re.compile(r"<lora:([^:<>\s]+):([^<>\s]*)>")

# 链接引用:[node_id, output_index]
NodeRef = list


@dataclass(frozen=True)
class LoraSpec:
    """单个叠加 LoRA:文件名 + 权重(同时作用于 model 与 clip)。"""

    name: str
    weight: float = 1.0


def parse_lora_tags(text: str) -> tuple[str, tuple[LoraSpec, ...]]:
    """从 prompt 文本提取 `<lora:NAME:WEIGHT>` 标签,返回 (剔除标签后的文本, LoraSpec 元组)。

    用户手写在 prompt 里的 A1111 标签与预设注入的 LoRA 走同一条 LoraLoader 链生效。
    权重不可解析的非法标签只从文本剔除、不加载(log.warning),不让请求失败。
    """
    loras: list[LoraSpec] = []

    def _sub(m: re.Match[str]) -> str:
        name, raw_weight = m.group(1), m.group(2)
        try:
            weight = float(raw_weight)
        except ValueError:
            logger.warning("忽略非法 LoRA 标签(权重不可解析): %s", m.group(0))
            return ""
        loras.append(LoraSpec(name=name, weight=weight))
        return ""

    cleaned = _LORA_TAG_RE.sub(_sub, text)
    # 标签原位留下的多余空白收敛掉,避免 ",  ," 类残渣进入编码
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned, tuple(loras)


def lora_chain(
    loras: tuple[LoraSpec, ...],
    src_model: NodeRef,
    src_clip: NodeRef,
    id_base: int = _LORA_ID_BASE,
) -> tuple[dict, NodeRef, NodeRef]:
    """把 loras 编译成 LoraLoader 链。

    返回 (节点 dict, 末端 model 引用, 末端 clip 引用)。
    每个 LoraLoader 的 model/clip 接上一节点输出,实现叠加;
    空 loras → 返回 ({}, src_model, src_clip)。
    """
    nodes: dict = {}
    model_ref: NodeRef = list(src_model)
    clip_ref: NodeRef = list(src_clip)
    for i, lora in enumerate(loras):
        node_id = str(id_base + i)
        nodes[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_ref,
                "clip": clip_ref,
                "lora_name": lora.name,
                "strength_model": lora.weight,
                "strength_clip": lora.weight,
            },
        }
        model_ref = [node_id, 0]
        clip_ref = [node_id, 1]
    return nodes, model_ref, clip_ref
