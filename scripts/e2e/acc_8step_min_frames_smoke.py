#!/usr/bin/env python3
"""Acc-8Step min-frames VIDEO smoke skeleton (H3 :8264).

Status: SKELETON — does NOT queue a Comfy job.

Why skeleton (2026-10-22 CONTINUE wrap):
  - Acc-8Step is a *LoRA overlay* on MiniMax-H3 Ref2VA / FL2VA, not a standalone
    short t2v graph like Rapid IMAGE_SMOKE.
  - Existing e2e paths are either:
      * IMAGE_SMOKE (Rapid SFW-v23 :8196) — still image only
      * h3_core_e2e / e2e_h3_check — H3 t2v via core, min length=22 (~0.9s) but
        still multi-minute cold / no Acc LoRA wiring
      * longcat_smoke — Wan LongCat t2v, default 49 frames / timeout 1800s
  - Historical H3 FL2VA smoke alone was ~224s; Acc+Ref2VA with refs is a
    FULL_VIDEO-class job (often >>15min). This continue streak forbids starting
    a 30min+ clip without an existing <15min workflow.

Visibility already PASS (Wave M):
  - :8264 LoraLoader lists:
      MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors
      MiniMax-H3-FL2VA-Acc-8Step_pruned_comfy.safetensors
  - Production UNET remains pruned_int8 (must NOT be replaced by Acc).

Required inputs before this can grow into a real smoke (exit 2 until present):
  1) --ref-image  local PNG/JPG for Ref2VA (or FL2VA first/last frames)
  2) --unet       H3 diffusion name visible on :8264 (default int8 production)
  3) --lora       Acc-8Step LoRA name (see above)
  4) --prompt     short positive; length must stay on 17k+5 grid (min 22)

Usage (today):
  python3 scripts/e2e/acc_8step_min_frames_smoke.py
  → exit 2, prints needs-asset lines; probes :8264 health/queue/LoRA visibility

When assets exist + operator explicitly allows FULL_VIDEO:
  extend build_graph() from backend/api/app/workflows/h3_video.py Ref2VA/FL2VA
  templates, inject Acc LoRA via LoraLoader, length=22 steps=8, then queue.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_BASE = "http://192.168.71.127:8264"
ACC_LORAS = (
    "MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors",
    "MiniMax-H3-FL2VA-Acc-8Step_pruned_comfy.safetensors",
)
PROD_UNET_HINT = "minimax_h3_ref2va_pruned_int8_convrot.safetensors  # or FL2VA int8 twin"


def get_json(url: str, timeout: float = 8.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def probe(base: str) -> dict:
    out: dict = {"base": base, "ok": False}
    try:
        stats = get_json(f"{base.rstrip('/')}/system_stats")
        queue = get_json(f"{base.rstrip('/')}/queue")
        out["comfy"] = (stats.get("system") or {}).get("comfyui_version")
        out["running"] = len(queue.get("queue_running") or [])
        out["pending"] = len(queue.get("queue_pending") or [])
        out["ok"] = True
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out
    # LoRA visibility
    try:
        info = get_json(f"{base.rstrip('/')}/object_info/LoraLoader", timeout=20.0)
        node = info.get("LoraLoader") or next(iter(info.values()))
        req = (node.get("input") or {}).get("required") or {}
        raw = req.get("lora_name")
        names = raw[0] if isinstance(raw, list) and raw and isinstance(raw[0], list) else (raw or [])
        found = [n for n in ACC_LORAS if n in names]
        out["acc_loras_visible"] = found
        out["acc_loras_missing"] = [n for n in ACC_LORAS if n not in names]
    except Exception as e:  # noqa: BLE001 — probe only
        out["lora_probe_error"] = f"{type(e).__name__}: {e}"
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=DEFAULT_BASE, help="Comfy Acc/H3 worker (default :8264)")
    ap.add_argument("--ref-image", type=Path, default=None, help="Ref2VA reference still (required for real run)")
    ap.add_argument("--unet", default="", help="H3 UNET filename on worker")
    ap.add_argument("--lora", default=ACC_LORAS[0], help="Acc-8Step LoRA name")
    ap.add_argument("--prompt", default="", help="positive prompt")
    ap.add_argument("--length", type=int, default=22, help="H3 17k+5 grid; min practical=22")
    ap.add_argument("--steps", type=int, default=8, help="Acc-8Step implies low steps; still FULL_VIDEO class")
    args = ap.parse_args()

    print("=== Acc-8Step min-frames smoke (SKELETON) ===")
    print(f"base={args.base}")
    probe_info = probe(args.base)
    print(json.dumps(probe_info, ensure_ascii=False, indent=2))

    missing: list[str] = []
    if not probe_info.get("ok"):
        missing.append("needs worker reachable at --base (system_stats/queue)")
    if probe_info.get("acc_loras_missing"):
        missing.append(f"needs Acc LoRA on worker: {probe_info['acc_loras_missing']}")
    if args.ref_image is None or not Path(args.ref_image).is_file():
        missing.append("needs asset --ref-image (PNG/JPG for Ref2VA / FL2VA)")
    if not (args.unet or "").strip():
        missing.append(f"needs asset --unet (H3 diffusion; hint: {PROD_UNET_HINT})")
    if not (args.prompt or "").strip():
        missing.append("needs --prompt (non-empty positive)")
    if args.length < 22:
        missing.append("needs --length >= 22 (H3 17k+5 grid)")

    if missing:
        print("\nSTOP — not queuing FULL_VIDEO Acc job. Gaps:")
        for m in missing:
            print(f"  · {m}")
        print("\nLabel: SKELETON / not FULL_VIDEO. Re-run after assets + explicit GO.")
        return 2

    print("All CLI assets present, but build_graph() is intentionally unimplemented.")
    print("Wire h3_video Ref2VA/FL2VA + Acc LoRA under an explicit FULL_VIDEO GO.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
