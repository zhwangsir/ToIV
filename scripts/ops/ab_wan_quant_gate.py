#!/usr/bin/env python3
"""#23 视频系量化回顾门：同 seed 同提示词，现网 fp8_scaled 双专家 vs fp16 原件各出一条片。

用法(仓库根, backend/api venv):
  backend/api/.venv/bin/python scripts/ops/ab_wan_quant_gate.py \
    --worker http://192.168.71.127:8265 \
    --prompt "一只柴犬在城市街道上轻快奔跑，阳光明媚，电影感镜头" \
    --seed 20261015 --out-dir "$HOME/toiv-ops-logs/ab_quant/wan_t2v"

背景:wan2.2 t2v 自 2026-08-27 起默认 fp8_scaled 双专家(当时未做同 seed 门),
本脚本补回顾门:A=现网默认(fp8_scaled),B=fp16 原件。抽 t=2s 帧算 SSIM:
≥0.90 → 现网默认质量门通过(维持);0.80–0.90 → 记录为草稿级偏差并评估回退;
<0.80 → 建议回退 fp16 或重选变体。报告 json + 两帧 PNG 落 out-dir 供人工/VLM 复核。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

import numpy as np
from PIL import Image

from app.workflows.wan_t2v import WanT2VParams, build_wan_t2v_graph

FP8_HIGH = "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors"
FP8_LOW = "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"
FP16_HIGH = "wan2.2_t2v_high_noise_14B_fp16.safetensors"
FP16_LOW = "wan2.2_t2v_low_noise_14B_fp16.safetensors"


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


def _wait(worker: str, pid: str, timeout: int = 2400) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with urllib.request.urlopen(f"{worker}/history/{pid}", timeout=120) as x:
            hist = json.load(x)
        if pid in hist:
            return hist[pid]
        time.sleep(6)
    raise TimeoutError(f"{pid} {timeout}s 未出片")


def _fetch_video(worker: str, meta: dict) -> bytes:
    out = meta["outputs"]
    node = next(v for v in out.values() if v.get("gifs"))
    f = node["gifs"][0]
    q = urllib.parse.urlencode({
        "filename": f["filename"],
        "subfolder": f.get("subfolder", ""),
        "type": f.get("type", "output"),
    })
    with urllib.request.urlopen(f"{worker}/view?{q}", timeout=600) as x:
        return x.read()


def _mid_frame(video: bytes, out_png: Path) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_png.with_suffix(".mp4")
    tmp.write_bytes(video)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", "2", "-i", str(tmp),
         "-frames:v", "1", str(out_png)],
        check=True,
    )


def _ssim(a: Path, b: Path) -> float:
    ia = np.asarray(Image.open(a).convert("RGB"), dtype=np.float64)
    ib = np.asarray(Image.open(b).convert("RGB"), dtype=np.float64)
    if ia.shape != ib.shape:
        h = min(ia.shape[0], ib.shape[0])
        w = min(ia.shape[1], ib.shape[1])
        ia, ib = ia[:h, :w], ib[:h, :w]
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = ia.mean(), ib.mean()
    sa, sb = ia.std(), ib.std()
    sab = ((ia - mu_a) * (ib - mu_b)).mean()
    return float(((2 * mu_a * mu_b + c1) * (2 * sab + c2)) /
                 ((mu_a ** 2 + mu_b ** 2 + c1) * (sa ** 2 + sb ** 2 + c2)))


def _run_arm(worker: str, tag: str, high: str, low: str, prompt: str, seed: int, out: Path) -> dict:
    params = WanT2VParams(positive=prompt, high_unet=high, low_unet=low, seed=seed)
    graph = build_wan_t2v_graph(params)
    t0 = time.time()
    pid = _post(worker, graph, f"abwan-{tag}")
    entry = _wait(worker, pid)
    sec = round(time.time() - t0, 1)
    video = _fetch_video(worker, entry)
    png = out / f"{tag}_frame.png"
    _mid_frame(video, png)
    return {"tag": tag, "high_unet": high, "low_unet": low, "prompt_id": pid,
            "sec": sec, "bytes": len(video), "frame": str(png)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", default="http://192.168.71.127:8265")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seed", type=int, default=20261015)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    arms = {
        "a_fp8_prod": _run_arm(args.worker, "a_fp8_prod", FP8_HIGH, FP8_LOW, args.prompt, args.seed, out),
        "b_fp16_orig": _run_arm(args.worker, "b_fp16_orig", FP16_HIGH, FP16_LOW, args.prompt, args.seed, out),
    }
    ssim = _ssim(Path(arms["a_fp8_prod"]["frame"]), Path(arms["b_fp16_orig"]["frame"]))
    gate = "pass" if ssim >= 0.90 else ("draft-only" if ssim >= 0.80 else "reject")
    report = {"worker": args.worker, "seed": args.seed, "prompt": args.prompt,
              "arms": arms, "ssim": round(ssim, 4), "gate": gate,
              "note": "A=现网默认 fp8_scaled 双专家;B=fp16 原件;帧=t+2s"}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
