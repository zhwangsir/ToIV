#!/usr/bin/env python3
"""c_hybrid vs splice2 metrics table (CPU-only, read-only; never touches the DB or GPU workers).

Per shot:
  - online face score: candidate_pick.score_video_face(...)['face_mean'] (same as the product auto-pick)
  - experiment facecrop: same logic as h3_long_exp/scripts_facecrop_gate.py
      (buffalo_l; crop pad 0.35 → upscale ≥512 → re-embed; cosine vs linxia_front;
       only front / three-quarter poses are scored; frames first/mid/last)
  - seam SSIM: previous shot's last frame vs next shot's first frame (grayscale 256x144)
  - RapidOCR: text boxes on 8 sampled frames (score ≥0.6; any hit = burned-in subtitle / sign text risk)
  - silence: ffmpeg silencedetect -40dB/0.5s total seconds
  - duration: ffprobe
Usage:
  python chybrid_rain_cmp_metrics.py --splice2-only                   # splice2 baseline only
  python chybrid_rain_cmp_metrics.py --progress tmp/chybrid_rain_cmp/progress.json
Outputs: <out>/metrics.json, <out>/metrics.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

DEPLOY_ROOT = Path(os.environ.get("TOIV_DEPLOY_ROOT", "/home/merlin/toiv"))
CODE_ROOT = Path(os.environ.get("CODE_ROOT", str(DEPLOY_ROOT / "api")))
STUDIO = Path("/mnt/toiv-nas/toiv/outputs/drama/final/studio")
REF_FRONT = STUDIO / "sample_linxia_front.png"
SPLICE2 = {
    "label": "splice2",
    "final": STUDIO / "final-v3-facev5-VO-rainbed-splice2-4252418024475267717-5a4fb68ab56f.mp4",
    "shots": [
        STUDIO / "rain_shot0_face_v5_4252418024475267717_03315ca63cc5.mp4",
        STUDIO / "v6_shot1_c1_37005.mp4",
        STUDIO / "v8_shot2_c1_6997_trim.mp4",
        STUDIO / "v8_shot3_c1_20075.mp4",
    ],
}


def _load_env():
    envf = DEPLOY_ROOT / "deploy/.env"
    if envf.is_file():
        for line in envf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    sys.path.insert(0, str(CODE_ROOT))


# ───────── video helpers ─────────

def duration(p: Path) -> float | None:
    try:
        return float(subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
            text=True).strip())
    except Exception:
        return None


def frame_at(p: Path, t: float | None, last: bool = False) -> np.ndarray | None:
    with tempfile.NamedTemporaryFile(suffix=".png") as tf:
        if last:
            cmd = ["ffmpeg", "-y", "-v", "error", "-sseof", "-0.5", "-i", str(p), "-update", "1", tf.name]
        else:
            cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, t or 0.0):.3f}", "-i", str(p),
                   "-frames:v", "1", tf.name]
        subprocess.run(cmd, capture_output=True, timeout=120)
        img = cv2.imread(tf.name)
    return img


def silence_total(p: Path) -> float | None:
    r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(p), "-af", "silencedetect=noise=-40dB:d=0.5",
                        "-f", "null", "-"], capture_output=True, text=True, timeout=300)
    if "Audio:" not in r.stderr:
        return None
    return round(sum(float(x) for x in re.findall(r"silence_duration: ([0-9.]+)", r.stderr)), 2)


def seam_ssim(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    if a is None or b is None:
        return None
    from skimage.metrics import structural_similarity
    ga = cv2.cvtColor(cv2.resize(a, (256, 144)), cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(cv2.resize(b, (256, 144)), cv2.COLOR_BGR2GRAY)
    return round(float(structural_similarity(ga, gb)), 4)


# ───────── facecrop (scripts_facecrop_gate.py logic) ─────────

_FA = None


def face_app():
    global _FA
    if _FA is None:
        from insightface.app import FaceAnalysis
        _FA = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        _FA.prepare(ctx_id=-1, det_size=(640, 640))
    return _FA


def _largest(faces):
    return sorted(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)[0]


def yaw_from_kps(kps):
    if kps is None or len(kps) < 3:
        return None
    le, re_, nose = kps[0], kps[1], kps[2]
    off = (nose[0] - 0.5 * (le[0] + re_[0])) / (abs(re_[0] - le[0]) + 1e-6)
    return float(np.clip(off, -1.5, 1.5) * 60.0)


def pose_label(y):
    if y is None:
        return "unknown"
    a = abs(y)
    return "front" if a <= 25 else "three_quarter" if a <= 55 else "side" if a <= 80 else "backish"


def crop_up(img, bbox, min_side=512, pad=0.35):
    h, w = img.shape[:2]
    x1, y1, x2, y2 = [float(v) for v in bbox]
    side = max(x2 - x1, y2 - y1) * (1 + pad)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    c = img[max(0, int(cy - side / 2)):min(h, int(cy + side / 2)),
            max(0, int(cx - side / 2)):min(w, int(cx + side / 2))]
    if c.size == 0:
        return None
    ch, cw = c.shape[:2]
    if min(ch, cw) < min_side:
        s = min_side / max(1, min(ch, cw))
        c = cv2.resize(c, (max(min_side, int(cw * s)), max(min_side, int(ch * s))), interpolation=cv2.INTER_CUBIC)
    return c


def facecrop_score(img, ref_emb) -> dict:
    if img is None:
        return {"scored": False, "reason": "no_frame"}
    fa = face_app()
    faces = fa.get(img)
    if not faces:
        return {"scored": False, "reason": "no_face"}
    f = _largest(faces)
    yaw = yaw_from_kps(getattr(f, "kps", None))
    lab = pose_label(yaw)
    c = crop_up(img, f.bbox)
    emb = f.normed_embedding
    if c is not None:
        cf = fa.get(c)
        if cf:
            emb = _largest(cf).normed_embedding
    sim = float(np.dot(ref_emb, emb) / (np.linalg.norm(ref_emb) * np.linalg.norm(emb) + 1e-9))
    scored = lab in ("front", "three_quarter")
    return {"scored": scored, "pose": lab, "yaw": yaw, "sim": round(sim, 4) if scored else None,
            "sim_raw": round(sim, 4)}


# ───────── OCR ─────────

_OCR = None


def ocr_hits(p: Path, dur: float | None, n: int = 8) -> list[str]:
    global _OCR
    if _OCR is None:
        from rapidocr_onnxruntime import RapidOCR
        _OCR = RapidOCR()
    hits = []
    d = dur or 1.0
    for k in range(n):
        img = frame_at(p, d * (k + 0.5) / n)
        if img is None:
            continue
        res, _ = _OCR(img)
        for box in res or []:
            txt, score = box[1], float(box[2])
            if score >= 0.6 and len(txt.strip()) >= 1:
                hits.append(f"{k}:{txt.strip()}")
    return hits


# ───────── main ─────────

def eval_set(label: str, shots: list[Path], final: Path | None, ref_emb, online: bool) -> dict:
    score_video_face = None
    if online:
        try:
            from app.services.studio.candidate_pick import score_video_face  # noqa: F811
        except Exception as e:  # noqa: BLE001
            print("online face scorer unavailable:", e, file=sys.stderr)
    rows = []
    firsts, lasts = [], []
    for i, p in enumerate(shots):
        r: dict = {"idx": i, "video": p.name, "exists": p.is_file()}
        if not p.is_file():
            rows.append(r)
            firsts.append(None)
            lasts.append(None)
            continue
        d = duration(p)
        r["duration"] = round(d, 2) if d else None
        f0 = frame_at(p, 0.0)
        fm = frame_at(p, (d or 0) / 2)
        fl = frame_at(p, None, last=True)
        firsts.append(f0)
        lasts.append(fl)
        fc = [facecrop_score(x, ref_emb) for x in (f0, fm, fl)]
        r["facecrop_frames"] = fc
        sc = [x["sim"] for x in fc if x.get("scored") and x.get("sim") is not None]
        r["facecrop_mean"] = round(float(np.mean(sc)), 4) if sc else None
        if score_video_face is not None:
            try:
                r["online_face"] = (score_video_face(p, REF_FRONT) or {}).get("face_mean")
            except Exception as e:  # noqa: BLE001
                r["online_face_err"] = str(e)[:200]
        r["ocr_hits"] = ocr_hits(p, d)
        r["silence_s"] = silence_total(p)
        rows.append(r)
        print(label, i, {k: r.get(k) for k in ("duration", "facecrop_mean", "online_face", "silence_s")},
              "ocr", len(r["ocr_hits"]), flush=True)
    seams = [seam_ssim(lasts[i], firsts[i + 1]) for i in range(len(shots) - 1)]
    fcs = [r["facecrop_mean"] for r in rows if r.get("facecrop_mean") is not None]
    ofs = [r["online_face"] for r in rows if r.get("online_face") is not None]
    out = {
        "label": label,
        "shots": rows,
        "seam_ssim": seams,
        "facecrop_mean": round(float(np.mean(fcs)), 4) if fcs else None,
        "online_face_mean": round(float(np.mean(ofs)), 4) if ofs else None,
        "ocr_hit_total": sum(len(r.get("ocr_hits") or []) for r in rows),
        "shots_duration": round(sum(r.get("duration") or 0 for r in rows), 2),
    }
    if final is not None and final.is_file():
        fd = duration(final)
        out["final"] = {"video": final.name, "duration": round(fd, 2) if fd else None,
                        "silence_s": silence_total(final), "ocr_hits": ocr_hits(final, fd, n=16)}
    return out


def table(sets: list[dict]) -> str:
    L = ["| 指标 | " + " | ".join(s["label"] for s in sets) + " |",
         "|---|" + "---|" * len(sets)]

    def row(name, fn):
        L.append(f"| {name} | " + " | ".join(str(fn(s)) for s in sets) + " |")

    n = max(len(s["shots"]) for s in sets)
    row("facecrop 均值(实验口径)", lambda s: s.get("facecrop_mean"))
    for i in range(n):
        row(f"  镜{i} facecrop", lambda s, i=i: (s["shots"][i].get("facecrop_mean") if i < len(s["shots"]) else "-"))
    row("线上 face_mean 均值", lambda s: s.get("online_face_mean"))
    for i in range(n):
        row(f"  镜{i} 线上 face", lambda s, i=i: (
            (round(s["shots"][i]["online_face"], 4) if s["shots"][i].get("online_face") is not None else None)
            if i < len(s["shots"]) else "-"))
    row("接缝 SSIM", lambda s: ", ".join(str(x) for x in s["seam_ssim"]))
    row("OCR 命中(分镜合计)", lambda s: s.get("ocr_hit_total"))
    row("静音秒(分镜合计)", lambda s: round(sum((r.get("silence_s") or 0) for r in s["shots"]), 2))
    row("分镜总时长 s", lambda s: s.get("shots_duration"))
    row("成片时长 s", lambda s: (s.get("final") or {}).get("duration", "-"))
    row("成片 OCR 命中", lambda s: len((s.get("final") or {}).get("ocr_hits", [])) if s.get("final") else "-")
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--progress", default="", help="driver 的 progress.json")
    ap.add_argument("--splice2-only", action="store_true")
    ap.add_argument("--final", default="", help="c_hybrid 成片（可选，合成后填）")
    ap.add_argument("--no-online", action="store_true", help="跳过 score_video_face")
    ap.add_argument("--out", default=str(DEPLOY_ROOT / "tmp/chybrid_rain_cmp"))
    args = ap.parse_args()
    _load_env()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ref = cv2.imread(str(REF_FRONT))
    rf = face_app().get(ref)
    assert rf, "参考图无脸"
    ref_emb = _largest(rf).normed_embedding
    sets = [eval_set("splice2", SPLICE2["shots"], SPLICE2["final"], ref_emb, not args.no_online)]
    if not args.splice2_only:
        prog = json.loads(Path(args.progress).read_text(encoding="utf-8"))
        shots = []
        for k in sorted(prog.get("shots", {}), key=int):
            u = prog["shots"][k].get("video_url") or ""
            shots.append(STUDIO / u.rsplit("/", 1)[-1])
        sets.append(eval_set("c_hybrid", shots, Path(args.final) if args.final else None, ref_emb,
                             not args.no_online))
    md = table(sets)
    (out / ("metrics_splice2.json" if args.splice2_only else "metrics.json")).write_text(
        json.dumps(sets, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    (out / ("metrics_splice2.md" if args.splice2_only else "metrics.md")).write_text(md + "\n", encoding="utf-8")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
