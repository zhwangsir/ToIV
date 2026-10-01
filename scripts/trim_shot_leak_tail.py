#!/usr/bin/env python3
"""Trim store→black-bg rain-hood face leak from H3 drama shot clips.

Detects first sustained edge-luminance collapse (black studio bg) and keeps
only frames before that cut. Writes *_trim.mp4 next to source by default.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def probe_fps_n(path: Path):
    import cv2

    cap = cv2.VideoCapture(str(path))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 24)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    return fps, n


def find_black_bg_cut(path: Path, start_scan: float = 2.0, edge_thr: float = 45.0, jump: float = 40.0):
    import cv2
    import numpy as np

    cap = cv2.VideoCapture(str(path))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 24)
    prev_edge = None
    i = 0
    cut = None
    while True:
        ok, f = cap.read()
        if not ok:
            break
        t = i / fps
        if t >= start_scan:
            gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
            h, w = gray.shape
            edge = np.concatenate(
                [
                    gray[: h // 10, :].ravel(),
                    gray[-h // 10 :, :].ravel(),
                    gray[:, : w // 10].ravel(),
                    gray[:, -w // 10 :].ravel(),
                ]
            )
            e = float(edge.mean())
            if prev_edge is not None and (prev_edge - e) > jump and e < edge_thr:
                cut = (i, t, e, prev_edge)
                break
            prev_edge = e
        i += 1
    cap.release()
    return fps, cut


def trim_to(src: Path, dst: Path, cut_t: float):
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-t",
        f"{cut_t:.6f}",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-an",
        str(dst),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("-o", "--out", default="")
    ap.add_argument("--meta", default="")
    args = ap.parse_args()
    src = Path(args.src)
    if not src.exists():
        print(f"missing {src}", file=sys.stderr)
        sys.exit(2)
    fps, cut = find_black_bg_cut(src)
    if cut is None:
        print(json.dumps({"ok": False, "reason": "no_black_bg_cut", "src": str(src)}))
        sys.exit(1)
    cut_i, cut_t, e, prev = cut
    out = Path(args.out) if args.out else src.with_name(src.stem + "_trim" + src.suffix)
    trim_to(src, out, cut_t)
    meta = {
        "ok": True,
        "src": str(src),
        "out": str(out),
        "fps": fps,
        "cut_frame": cut_i,
        "cut_pts_time": cut_t,
        "trim_duration_sec": cut_t,
        "edge_before": prev,
        "edge_after": e,
    }
    if args.meta:
        Path(args.meta).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
