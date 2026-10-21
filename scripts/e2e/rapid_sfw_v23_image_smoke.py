#!/usr/bin/env python3
"""Light IMAGE_SMOKE for gate Rapid SFW-v23 on :8196 (≤~3–5 min typical).

Reuses the Wave M1② successful API graph (8 steps, 768², euler/sgm_uniform).
Label: IMAGE_SMOKE — not FULL_VIDEO / not Acc-8Step video.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

CST = timezone(timedelta(hours=8))
DEFAULT_BASE = "http://192.168.71.127:8196"
CKPT = "Qwen-Rapid-AIO-SFW-v23.safetensors"


def build_graph(seed: int, prefix: str) -> dict:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": seed,
                "steps": 8,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "sgm_uniform",
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
                "denoise": 1.0,
            },
        },
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 768, "height": 768, "batch_size": 1},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "cinematic portrait of a young woman in a sunlit cafe, soft natural light, highly detailed face, 85mm lens",
                "clip": ["4", 1],
            },
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "blurry, low quality, watermark, text, deformed hands",
                "clip": ["4", 1],
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": prefix},
        },
    }


def post(base: str, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(base: str, path: str, timeout: float = 90) -> dict:
    # Checkpoint load can stall HTTP briefly; keep generous read timeout.
    last_err = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(base + path, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 — smoke helper
            last_err = e
            time.sleep(2)
    raise last_err  # type: ignore[misc]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--seed", type=int, default=2026102205)
    ap.add_argument("--prefix", default="Continue_IMAGE_SFWv23")
    ap.add_argument("--timeout", type=int, default=720, help="poll timeout seconds")
    ap.add_argument("--out", default="test-results/continue_sfw_v23_image_smoke.json")
    args = ap.parse_args()

    # queue guard
    q = get(args.base, "/queue")
    running = len(q.get("queue_running") or [])
    pending = len(q.get("queue_pending") or [])
    started = datetime.now(CST).isoformat()
    print(f"queue running={running} pending={pending} at {started}")
    if running or pending:
        print("ABORT: queue not empty")
        return 2

    graph = build_graph(args.seed, args.prefix)
    t0 = time.time()
    resp = post(args.base, "/prompt", {"prompt": graph})
    prompt_id = resp.get("prompt_id")
    print("submitted", prompt_id, resp)
    if not prompt_id:
        return 3

    status = "timeout"
    outputs = None
    while time.time() - t0 < args.timeout:
        try:
            hist = get(args.base, f"/history/{prompt_id}")
        except Exception as poll_err:  # noqa: BLE001
            print("poll_retry", type(poll_err).__name__, poll_err)
            time.sleep(5)
            continue
        if prompt_id in hist:
            entry = hist[prompt_id]
            status_obj = entry.get("status") or {}
            # Comfy marks completed in status or just has outputs
            outputs = entry.get("outputs")
            st = status_obj.get("status_str") or status_obj.get("completed")
            if outputs or st in ("success", True) or status_obj.get("completed") is True:
                status = "success"
                break
            msgs = status_obj.get("messages") or []
            if any(m and m[0] == "execution_error" for m in msgs):
                status = "error"
                outputs = entry
                break
        time.sleep(3)

    elapsed = round(time.time() - t0, 2)
    images = []
    if isinstance(outputs, dict):
        for node_out in outputs.values():
            for img in node_out.get("images") or []:
                images.append(img)

    report = {
        "kind": "IMAGE_SMOKE",
        "ckpt": CKPT,
        "base": args.base,
        "prompt_id": prompt_id,
        "seed": args.seed,
        "prefix": args.prefix,
        "status": status,
        "elapsed_sec": elapsed,
        "started_at": started,
        "finished_at": datetime.now(CST).isoformat(),
        "images": images,
        "queue_at_submit": {"running": running, "pending": pending},
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if status == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
