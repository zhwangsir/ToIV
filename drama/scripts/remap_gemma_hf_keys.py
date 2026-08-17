"""将 ComfyUI 原生命名的 Gemma 3 12B bf16 权重重映射为 HF transformers 命名。

背景: ComfyUI-LTXVideo 的 LTXVGemmaCLIPModelLoader 用
Gemma3ForConditionalGeneration.from_pretrained 加载, 期望 HF 命名:
  model.language_model.{layers,embed_tokens,norm}.*
  model.vision_tower.{encoder,embeddings,post_layernorm}.*
  model.multi_modal_projector.*
而 Comfy-Org 的 fp8_scaled 文件(及由其转换的 bf16)使用 ComfyUI 命名:
  model.{layers,embed_tokens,norm}.* / vision_model.* / multi_modal_projector.*
命名不匹配 -> from_pretrained 把文本模型全部随机初始化 -> 提示词完全失效。

用法 (workstation):
  /opt/ComfyUI/venv/bin/python /tmp/remap_gemma_hf_keys.py
"""
from __future__ import annotations

import os
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file

DIR = Path("/opt/ComfyUI/models/text_encoders/gemma3_12b_it_bf16")
SRC = DIR / "model.safetensors"
DST = DIR / "model_hf.safetensors"


def remap(k: str) -> str | None:
    if k == "spiece_model":
        return None  # tokenizer 二进制 blob, 非权重, 丢弃
    if k.startswith("model.layers.") or k in ("model.embed_tokens.weight", "model.norm.weight"):
        return "model.language_model." + k[len("model."):]
    if k.startswith("vision_model."):
        return "model.vision_tower." + k[len("vision_model."):]
    if k.startswith("multi_modal_projector."):
        return "model." + k
    return k


def main() -> None:
    out: dict[str, torch.Tensor] = {}
    dropped = renamed = kept = 0
    with safe_open(str(SRC), framework="pt") as f:
        for k in f.keys():
            nk = remap(k)
            if nk is None:
                dropped += 1
                continue
            if nk != k:
                renamed += 1
            else:
                kept += 1
            out[nk] = f.get_tensor(k)
    print(f"renamed={renamed} kept={kept} dropped={dropped} total_out={len(out)}")

    # 抽查关键键存在性
    for probe in (
        "model.language_model.embed_tokens.weight",
        "model.language_model.layers.0.self_attn.q_proj.weight",
        "model.language_model.norm.weight",
        "model.vision_tower.encoder.layers.0.self_attn.q_proj.weight",
        "model.multi_modal_projector.mm_input_projection_weight",
    ):
        assert probe in out, f"missing expected key: {probe}"
    print("key probes OK")

    save_file(out, str(DST), metadata={"format": "pt"})
    size_gb = DST.stat().st_size / 1024**3
    print(f"saved {DST} ({size_gb:.1f} GB)")

    # 原子替换
    backup = DIR / "model_comfyui_named.safetensors.bak"
    os.replace(SRC, backup)
    os.replace(DST, SRC)
    print(f"swapped: {SRC} (old -> {backup.name})")


if __name__ == "__main__":
    main()
