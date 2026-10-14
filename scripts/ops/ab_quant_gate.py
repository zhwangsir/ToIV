#!/usr/bin/env python3
"""量化 A/B 质量门（#22/#23 共用）：同 seed 同提示词，bf16 vs 量化变体各出一张，算 SSIM 并留样。

用法(在仓库根, 用 apps/api 的 venv):
  apps/api/.venv/bin/python scripts/ops/ab_quant_gate.py \
    --worker http://192.168.71.127:8265 \
    --ckpt-a z_image_turbo_bf16.safetensors \
    --ckpt-b z-image-turbo_fp8_scaled_e4m3fn_KJ.safetensors \
    --prompt "一只柴犬在城市街道上轻快奔跑，阳光明媚，电影感镜头" \
    --seed 20261015 --out-dir "$HOME/toiv-ops-logs/ab_quant/zimage"

门判读(不自动改生产):SSIM ≥ 0.90 且肉眼留样无结构劣化 → 该量化变体可进灰度;
0.80–0.90 → 仅草稿档可用;<0.80 → 拒。报告 json + 两张样张落 out-dir 供人工/VLM 复核。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

import numpy as np
from PIL import Image

from app.workflows.model_profiles import nextgen_recipe
from app.workflows.nextgen import NextgenParams, build_nextgen_graph


def _post(worker: str, graph: dict, client_id: str) -> str:
    req = urllib.request.Request(
        f"{worker}/prompt",
        data=json.dumps({"prompt": graph, "client_id": client_id}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as x:
        data = json.load(x)
    if not data.get("prompt_id"):
        raise RuntimeError(json.dumps(data)[:400])
    return data["prompt_id"]


def _wait(worker: str, pid: str, timeout: int = 900) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with urllib.request.urlopen(f"{worker}/history/{pid}", timeout=90) as x:
            hist = json.load(x)
        if pid in hist:
            return hist[pid]
        time.sleep(4)
    raise TimeoutError(f"{pid} 900s 未出片")


def _fetch_image(worker: str, meta: dict) -> bytes:
    out = meta["outputs"]
    node = next(v for v in out.values() if v.get("images"))
    img = node["images"][0]
    url = f"{worker}/view?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
    with urllib.request.urlopen(url, timeout=300) as x:
        return x.read()


def _ssim_bytes(a: bytes, b: bytes) -> float:
    ia = np.asarray(Image.open(__import__("io").BytesIO(a)).convert("L"), dtype=np.float64)
    ib = np.asarray(Image.open(__import__("io").BytesIO(b)).convert("L"), dtype=np.float64)
    if ia.shape != ib.shape:
        ib = np.asarray(Image.open(__import__("io").BytesIO(b)).convert("L").resize(
            (ia.shape[1], ia.shape[0])), dtype=np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = ia.mean(), ib.mean()
    sa, sb = ia.var(), ib.var()
    sab = ((ia - mu_a) * (ib - mu_b)).mean()
    return float(((2 * mu_a * mu_b + c1) * (2 * sab + c2)) /
                 ((mu_a ** 2 + mu_b ** 2 + c1) * (sa + sb + c2)))


def _params_for(ckpt: str, prompt: str, seed: int, w: int, h: int) -> NextgenParams:
    recipe = nextgen_recipe(ckpt)
    if recipe is None:
        raise SystemExit(f"无配方: {ckpt}")
    return NextgenParams(
        model_name=ckpt, positive=prompt, negative="",
        width=w, height=h,
        steps=getattr(recipe, "steps", 8), cfg=getattr(recipe, "cfg", 1.0),
        sampler=getattr(recipe, "sampler", "euler"),
        scheduler=getattr(recipe, "scheduler", "simple"),
        seed=seed,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", default="http://192.168.71.127:8265")
    ap.add_argument("--ckpt-a", required=True)
    ap.add_argument("--ckpt-b", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seed", type=int, default=20261015)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    report = {"worker": args.worker, "seed": args.seed, "prompt": args.prompt, "arms": {}}
    blobs = {}
    for arm, ckpt in (("a_bf16", args.ckpt_a), ("b_quant", args.ckpt_b)):
        p = _params_for(ckpt, args.prompt, args.seed, args.width, args.height)
        t0 = time.time()
        pid = _post(args.worker, build_nextgen_graph(p), f"abq-{arm}")
        hist = _wait(args.worker, pid)
        blob = _fetch_image(args.worker, hist)
        (out / f"{arm}.png").write_bytes(blob)
        blobs[arm] = blob
        report["arms"][arm] = {"ckpt": ckpt, "prompt_id": pid,
                               "sec": round(time.time() - t0, 1), "bytes": len(blob)}
        print(f"[{arm}] {ckpt} {report['arms'][arm]['sec']}s {len(blob)//1024}KB")
    ssim = _ssim_bytes(blobs["a_bf16"], blobs["b_quant"])
    report["ssim"] = round(ssim, 4)
    report["gate"] = ("pass-gray" if ssim >= 0.90 else
                      "draft-only" if ssim >= 0.80 else "reject")
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"SSIM={report['ssim']} gate={report['gate']} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
