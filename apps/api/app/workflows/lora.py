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

from dataclasses import dataclass

# LoRA 节点 id 前缀,避开主图常用的小数字 id(1-20)
_LORA_ID_BASE = 100

# 链接引用:[node_id, output_index]
NodeRef = list


@dataclass(frozen=True)
class LoraSpec:
    """单个叠加 LoRA:文件名 + 权重(同时作用于 model 与 clip)。"""

    name: str
    weight: float = 1.0


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
