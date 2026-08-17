"""Gemma 3 12B (转换后 bf16) 文本编码语义合理性验证。

在 workstation 上运行:
  /opt/ComfyUI/venv/bin/python /tmp/gemma_semantic_test.py

判定标准:
  - 同语义/近语义文本的余弦相似度 > 无关文本
  - 中英同义句相似度应明显高
"""
from __future__ import annotations

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer

DIR = "/opt/ComfyUI/models/text_encoders/gemma3_12b_it_bf16"

TEXTS = {
    "cultivator": "a young Chinese cultivator standing on a starry peak, golden dao runes swirling around him",
    "farmer": "a farmer standing on a mountain",
    "saiyan": "a saiyan warrior with spiky black hair and golden aura, Dragon Ball anime style",
    "apple": "a red apple on a wooden table",
    "cultivator_zh": "少年荒天帝立于星域之巅，亿万金色道纹环绕",
    "cultivator_en": "a young heavenly emperor stands atop a starfield peak, billions of golden dao runes surround him",
}


def pool(hidden: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    m = mask.unsqueeze(-1).to(hidden.dtype)
    return (hidden * m).sum(dim=1) / m.sum(dim=1).clamp(min=1)


def main() -> None:
    print(f"loading tokenizer from {DIR} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(DIR)
    print("loading model (CPU, bf16, no device_map) ...", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        DIR, torch_dtype=torch.bfloat16, attn_implementation="eager"
    )
    model.eval()
    n_params = sum(p.numel() for p in model.parameters()) / 1e9
    print(f"model loaded: {n_params:.1f}B params", flush=True)

    embs: dict[str, torch.Tensor] = {}
    with torch.no_grad():
        for name, text in TEXTS.items():
            enc = tok(text, return_tensors="pt")
            out = model(**enc, output_hidden_states=True)
            last = out.hidden_states[-1]
            embs[name] = pool(last, enc["attention_mask"])[0]
            print(f"encoded [{name}] tokens={enc['input_ids'].shape[1]}", flush=True)

    names = list(embs)
    print("\n=== cosine similarity matrix ===")
    print(" " * 16 + "".join(f"{n[:12]:>14}" for n in names))
    for a in names:
        row = []
        for b in names:
            s = F.cosine_similarity(embs[a].unsqueeze(0), embs[b].unsqueeze(0)).item()
            row.append(s)
        print(f"{a[:14]:<16}" + "".join(f"{v:>14.4f}" for v in row))

    print("\n=== key checks ===")
    def sim(a: str, b: str) -> float:
        return F.cosine_similarity(embs[a].unsqueeze(0), embs[b].unsqueeze(0)).item()

    checks = [
        ("cultivator vs cultivator_en (中英同义,应>0.75)", sim("cultivator", "cultivator_en"), 0.75),
        ("cultivator vs cultivator_zh (中英近义,应>0.65)", sim("cultivator", "cultivator_zh"), 0.65),
        ("cultivator vs farmer (场景近似,应>apple)", sim("cultivator", "farmer"), None),
        ("cultivator vs apple (无关,应最低)", sim("cultivator", "apple"), None),
        ("saiyan vs apple (无关,应低)", sim("saiyan", "apple"), None),
    ]
    ok = True
    for label, v, thr in checks:
        mark = ""
        if thr is not None:
            mark = "PASS" if v > thr else "FAIL"
            if v <= thr:
                ok = False
        print(f"  {label}: {v:.4f} {mark}")
    print(f"\nverdict: {'SEMANTICALLY OK' if ok and sim('cultivator','farmer') > sim('cultivator','apple') else 'SUSPICIOUS'}")


if __name__ == "__main__":
    main()
