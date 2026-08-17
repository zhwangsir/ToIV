"""将 ComfyUI fp8_scaled 格式的 Gemma 3 12B 转换为标准 bf16 safetensors。

背景:gemma3_12b_it/model.safetensors 是 ComfyUI 私有混合格式
(weight=F8_E4M3 + weight_scale=F32 + comfy_quant=U8),标准 HF
from_pretrained 会忽略 weight_scale,导致权重偏离真实值约 2800 倍,
文本 embedding 完全损坏(画面与提示词无关)。

转换规则:
- 带 weight_scale 的 fp8 weight: out = (weight.float() * scale).to(bfloat16)
- 跳过 comfy_quant / weight_scale 辅助 tensor
- 其余 tensor(BF16,如 embed_tokens / layernorm)原样保留
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file

SRC_DIR = Path("/opt/ComfyUI/models/text_encoders/gemma3_12b_it")
DST_DIR = Path("/opt/ComfyUI/models/text_encoders/gemma3_12b_it_bf16")
SRC = SRC_DIR / "model.safetensors"
DST = DST_DIR / "model.safetensors"


def main() -> None:
    DST_DIR.mkdir(parents=True, exist_ok=True)

    with safe_open(str(SRC), framework="pt") as f:
        keys = list(f.keys())
        scale_keys = {k for k in keys if k.endswith(".weight_scale")}
        quant_keys = {k for k in keys if k.endswith(".comfy_quant")}
        weight_keys = [
            k for k in keys
            if k not in scale_keys and k not in quant_keys
        ]
        print(f"total={len(keys)} weights={len(weight_keys)} "
              f"scales={len(scale_keys)} quants={len(quant_keys)}")

        out: dict[str, torch.Tensor] = {}
        n_dequant = 0
        for i, k in enumerate(weight_keys):
            t = f.get_tensor(k)
            # weight: "...down_proj.weight" -> scale: "...down_proj.weight_scale"
            sk = k[: -len(".weight")] + ".weight_scale" if k.endswith(".weight") else None
            if sk and sk in scale_keys:
                s = f.get_tensor(sk)
                t = (t.to(torch.float32) * s).to(torch.bfloat16)
                n_dequant += 1
            elif t.dtype not in (torch.bfloat16, torch.float16, torch.float32):
                t = t.to(torch.bfloat16)
            out[k] = t
            if (i + 1) % 200 == 0:
                print(f"  {i + 1}/{len(weight_keys)} tensors ...", flush=True)

    print(f"dequantized={n_dequant}, saving -> {DST}")
    save_file(out, str(DST), metadata={"format": "pt"})

    # 复制 HF 加载所需的配置/tokenizer 文件
    for name in ("config.json", "generation_config.json", "preprocessor_config.json",
                 "processor_config.json", "tokenizer.json", "tokenizer_config.json",
                 "tokenizer.model"):
        src = SRC_DIR / name
        if src.exists():
            shutil.copy2(src, DST_DIR / name)
            print(f"copied {name}")

    size_gb = DST.stat().st_size / 1024**3
    print(f"done: {DST} ({size_gb:.1f} GB)")


if __name__ == "__main__":
    sys.exit(main())
