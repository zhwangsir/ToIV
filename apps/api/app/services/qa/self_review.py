"""渲染后自评闭环:剪点 ±1.5s 自检 + 响度 + 修复建议 + 闭环状态机(FU2b 成片 QA 包)。

ported from video-use (MIT, Copyright (c) 2026 Browser Use) helpers/grade.py + render.py
的 QA/响度部分理念,按 ToIV 改造:
- 每个剪点 ±window 自检三类:跳帧(帧差突变)/爆音(样本峰值削波)/字幕遮挡
  (底部安全区亮度文字区,简化启发式);
- 响度优先 ebur128(ffmpeg 可用时),否则 RMS 降级;无音频时 loudness_lufs=None;
- 返回 {checks:[{t,kind,severity,detail}], loudness_lufs, pass};
- 修复建议生成(adjust EDL item 边界 / pad);
- run_review_loop(steps) 纯状态机:evaluate→fix→re-render,最多 3 轮,收敛提前停,
  steps 是注入回调,不真跑 ffmpeg。
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

from . import timeline_view

# 响度目标(social-ready,同 video-use render.py loudnorm 口径:-14 LUFS ±3)
LOUDNESS_TARGET = -14.0
LOUDNESS_TOLERANCE = 3.0
# 修复步长:边界调整/pad 值(edit_edl PAD 窗 0.03–0.20 内)
FIX_STEP = 0.08
# RMS 降级采样率(与 timeline_view 抽 wav 一致)
SAMPLE_RATE = 16000


# ---- 检测器(纯函数:合成帧/波形即可测) ---------------------------------------


def _to_gray(frame: Any) -> np.ndarray:
    """帧 → 灰度 float(0..255)。接受 PIL 图 / HxW / HxWx3 数组。"""
    if hasattr(frame, "convert"):
        arr = np.asarray(frame.convert("L"), dtype=np.float64)
    else:
        arr = np.asarray(frame, dtype=np.float64)
        if arr.ndim == 3:
            arr = arr.mean(axis=2)
    if arr.size and arr.max() <= 1.0:
        arr = arr * 255.0
    return arr


def detect_jump_frames(
    frames: Sequence[Any], fps: float = 8.0, threshold: float = 0.25, t0: float = 0.0,
) -> list[dict]:
    """帧差突变(跳帧)检测。返回 [{t, score}],t=突变后帧的绝对时间。"""
    grays = [_to_gray(f) for f in frames]
    if len(grays) < 2 or fps <= 0:
        return []
    scores = [
        float(np.mean(np.abs(grays[i + 1] - grays[i]))) / 255.0
        for i in range(len(grays) - 1)
    ]
    baseline = float(np.median(scores))
    hits = []
    for i, s in enumerate(scores):
        if s < threshold:
            continue
        if baseline > 0 and s < 4 * baseline:
            continue
        hits.append({"t": t0 + (i + 1) / fps, "score": round(s, 4)})
    return hits


def detect_audio_clipping(
    samples: Any, sample_rate: float, peak: float = 0.98, min_run: int = 3, t0: float = 0.0,
) -> list[dict]:
    """爆音(削波)检测:|s|≥peak 的连续段。返回 [{t, duration, peak}]。"""
    x = np.asarray(samples)
    if x.dtype.kind in "iu":
        x = x.astype(np.float64) / float(2 ** (x.dtype.itemsize * 8 - 1))
    x = np.abs(np.asarray(x, dtype=np.float64).ravel())
    if x.size == 0 or sample_rate <= 0:
        return []
    clipped = x >= peak
    hits: list[dict] = []
    i = 0
    while i < clipped.size:
        if clipped[i]:
            j = i
            while j < clipped.size and clipped[j]:
                j += 1
            if j - i >= min_run:
                hits.append({
                    "t": t0 + i / sample_rate,
                    "duration": round((j - i) / sample_rate, 4),
                    "peak": round(float(x[i:j].max()), 4),
                })
            i = j
        else:
            i += 1
    return hits


def detect_subtitle_occlusion(
    frames: Sequence[Any], fps: float = 8.0, safe_zone: float = 0.28,
    bright_level: float = 200.0, min_bright_frac: float = 0.03, t0: float = 0.0,
) -> list[dict]:
    """字幕遮挡启发式:底部安全区(平台 UI 遮挡带)出现文字样亮像素即命中。

    ACT: 简化启发式——亮像素占比 + 行集中 + 对比度三条件,不做真 OCR;
    满白/满亮帧(std≈0)不命中,代价是密集描边字幕可能漏检。
    """
    hits = []
    for i, f in enumerate(frames):
        gray = _to_gray(f)
        if gray.size == 0:
            continue
        band = gray[-max(1, int(gray.shape[0] * safe_zone)):, :]
        bright = band >= bright_level
        frac = float(bright.mean())
        row_conc = bool((bright.mean(axis=1) >= 0.15).any()) if bright.size else False
        if frac >= min_bright_frac and row_conc and float(band.std()) >= 12.0:
            hits.append({"t": t0 + i / fps, "frac": round(frac, 4)})
    return hits


# ---- 响度(ebur128 优先,RMS 降级) --------------------------------------------


def rms_lufs(samples: Any) -> float:
    """RMS 近似 LUFS(ACT: 不做 K 加权,单声道近似,误差约 ±1 LU)。"""
    x = np.asarray(samples, dtype=np.float64).ravel()
    if x.size == 0:
        return -120.0
    if x.max() > 1.5:  # 整型 PCM 样值
        x = x / 32768.0
    rms = float(np.sqrt(np.mean(x ** 2)))
    return 20.0 * float(np.log10(rms + 1e-12))


def extract_pcm(
    video: Path | str, start: float = 0.0, end: float | None = None,
) -> np.ndarray | None:
    """抽 [start,end] 单声道 16k PCM(0..1 float)。无音轨/失败返回 None。"""
    import tempfile
    import wave

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav = Path(f.name)
    try:
        cmd = ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(video)]
        if end is not None:
            cmd += ["-t", f"{max(end - start, 0.01):.3f}"]
        cmd += ["-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(wav)]
        r = subprocess.run(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
        )
        if r.returncode != 0 or not wav.exists() or wav.stat().st_size == 0:
            return None
        with wave.open(str(wav), "rb") as w:
            data = w.readframes(w.getnframes())
        pcm = np.frombuffer(data, dtype=np.int16).astype(np.float64) / 32768.0
        return pcm if pcm.size else None
    except (subprocess.SubprocessError, OSError):
        return None
    finally:
        wav.unlink(missing_ok=True)


_EBUR_RE = re.compile(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS")


def measure_loudness_lufs(video: Path | str) -> float | None:
    """成片响度:ebur128(ffmpeg)→ 失败/无音轨 RMS 降级 → None。"""
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(video),
             "-map", "0:a:0", "-af", "ebur128", "-f", "null", "-"],
            capture_output=True, text=True, timeout=300,
        )
        ms = _EBUR_RE.findall(r.stderr or "")
        if ms:
            return float(ms[-1])
    except (subprocess.SubprocessError, OSError, ValueError):
        pass
    pcm = extract_pcm(video)
    return rms_lufs(pcm) if pcm is not None else None


# ---- 综合自评 ---------------------------------------------------------------


def review_cut_points(
    cut_points: Sequence[float],
    *,
    frames: Sequence[Any] | None = None,
    samples: Any | None = None,
    sample_rate: float | None = None,
    fps: float = 8.0,
    window: float = 1.5,
    t0: float = 0.0,
    loudness_lufs: float | None = None,
    loudness_target: float = LOUDNESS_TARGET,
    loudness_tolerance: float = LOUDNESS_TOLERANCE,
) -> dict:
    """对剪点 ±window 内的检测结果汇总 {checks, loudness_lufs, pass}。

    frames/samples 为 t0 起的整段时间线;window 外的发现被过滤。
    loudness_lufs 未给且有 samples 时用 rms_lufs 降级;无音频→None。
    pass = 无 severity=error/warn 的检查项。
    """
    cuts = [float(c) for c in cut_points]

    def _in_window(t: float) -> bool:
        return any(abs(t - c) <= window for c in cuts)

    checks: list[dict] = []
    if frames is not None:
        for h in detect_jump_frames(frames, fps=fps, t0=t0):
            if _in_window(h["t"]):
                checks.append({
                    "t": h["t"], "kind": "jump_frame", "severity": "error",
                    "detail": f"frame-diff spike score={h['score']:.2f}",
                })
        for h in detect_subtitle_occlusion(frames, fps=fps, t0=t0):
            if _in_window(h["t"]):
                checks.append({
                    "t": h["t"], "kind": "subtitle_occlusion", "severity": "warn",
                    "detail": f"bright text-like pixels frac={h['frac']:.2f} in bottom safe zone",
                })
    if samples is not None:
        rate = float(sample_rate or SAMPLE_RATE)
        for h in detect_audio_clipping(samples, rate, t0=t0):
            if _in_window(h["t"]):
                checks.append({
                    "t": h["t"], "kind": "audio_clip", "severity": "error",
                    "detail": f"clipped run {h['duration']:.3f}s peak={h['peak']:.2f}",
                })
        if loudness_lufs is None:
            loudness_lufs = rms_lufs(samples)
    if loudness_lufs is not None and abs(loudness_lufs - loudness_target) > loudness_tolerance:
        checks.append({
            "t": min(cuts) if cuts else 0.0, "kind": "loudness", "severity": "warn",
            "detail": f"{loudness_lufs:.1f} LUFS outside target {loudness_target:.0f}±{loudness_tolerance:.0f}",
        })
    checks.sort(key=lambda c: (c["t"], c["kind"]))
    passed = not any(c["severity"] in ("error", "warn") for c in checks)
    return {"checks": checks, "loudness_lufs": loudness_lufs, "pass": passed}


def review_render(
    video: Path | str,
    cut_points: Sequence[float],
    *,
    fps: float = 8.0,
    window: float = 1.5,
) -> dict:
    """对成片每个剪点 ±window 抽帧/抽样自检(需 ffmpeg)。"""
    cuts = sorted(float(c) for c in cut_points)
    if not cuts:
        raise ValueError("cut_points 不能为空")
    span0 = max(0.0, cuts[0] - window)
    span1 = cuts[-1] + window
    n = max(2, int(round((span1 - span0) * fps)))
    frames = timeline_view.extract_frames(video, span0, span1, n)
    pcm = extract_pcm(video, span0, span1)
    return review_cut_points(
        cuts, frames=frames, samples=pcm, sample_rate=SAMPLE_RATE,
        fps=fps, window=window, t0=span0,
        loudness_lufs=measure_loudness_lufs(video),
    )


# ---- 修复建议(adjust EDL item 边界 / pad) -----------------------------------


def suggest_fixes(
    review: dict,
    cut_points: Sequence[float] = (),
    edl_items: Sequence[dict] | None = None,
) -> list[dict]:
    """由检查项生成 EDL 修复建议:adjust(边界挪 FIX_STEP)/pad(pad_in/pad_out)。

    cut_points[k] 视为 item k 与 item k+1 之间的边界;发现落在剪点后修下一
    item 的头(start/pad_in),否则修上一 item 的尾(end/pad_out)。
    """
    cuts = [float(c) for c in cut_points]
    fixes: list[dict] = []
    for c in review.get("checks", []):
        t = float(c.get("t", 0.0))
        kind = str(c.get("kind", ""))
        if kind == "loudness":
            lufs = review.get("loudness_lufs")
            if lufs is not None:
                fixes.append({
                    "op": "adjust", "item": None, "field": "loudnorm_gain",
                    "delta": round(LOUDNESS_TARGET - float(lufs), 2),
                    "reason": kind, "t": t,
                })
            continue
        if kind not in ("jump_frame", "audio_clip", "subtitle_occlusion"):
            continue
        if kind == "subtitle_occlusion":
            fixes.append({
                "op": "adjust", "item": None, "field": "subtitle_margin_v",
                "delta": 0.04, "reason": kind, "t": t,
            })
            continue
        if not cuts:
            fixes.append({
                "op": "adjust", "item": None, "field": "end",
                "delta": FIX_STEP, "reason": kind, "t": t,
            })
            continue
        k = min(range(len(cuts)), key=lambda i: abs(cuts[i] - t))
        after = t > cuts[k]
        if kind == "jump_frame":
            if after:
                fixes.append({"op": "adjust", "item": k + 1, "field": "start",
                              "delta": -FIX_STEP, "reason": kind, "t": t})
            else:
                fixes.append({"op": "adjust", "item": k, "field": "end",
                              "delta": FIX_STEP, "reason": kind, "t": t})
        else:  # audio_clip
            if after:
                fixes.append({"op": "pad", "item": k + 1, "field": "pad_in",
                              "value": FIX_STEP, "reason": kind, "t": t})
            else:
                fixes.append({"op": "pad", "item": k, "field": "pad_out",
                              "value": FIX_STEP, "reason": kind, "t": t})
    return fixes


# ---- 闭环状态机(evaluate→fix→re-render) -------------------------------------


def _resolve(steps: Any, name: str) -> Callable | None:
    if isinstance(steps, dict):
        fn = steps.get(name)
    else:
        fn = getattr(steps, name, None)
    return fn if callable(fn) else None


def run_review_loop(
    steps: Any,
    max_rounds: int = 3,
    cut_points: Sequence[float] = (),
    edl_items: Sequence[dict] | None = None,
) -> dict:
    """纯状态机闭环:evaluate→(不过则)fix→re-render,最多 max_rounds 轮。

    steps 为注入回调(对象属性或 dict):evaluate()→review dict;
    fix(suggestions)→bool(是否落修复);render()→任意(重渲产物)。
    收敛(evaluate pass)提前停;fix 拒绝/无建议也提前停。
    返回 {ok, rounds, reason, history, fixes_applied}。
    """
    if max_rounds < 1:
        raise ValueError("max_rounds 必须 ≥ 1")
    evaluate = _resolve(steps, "evaluate")
    if evaluate is None:
        raise ValueError("steps 必须提供 evaluate 回调")
    fix = _resolve(steps, "fix")
    render = _resolve(steps, "render")

    history: list[dict] = []
    fixes_applied = 0
    ok = False
    reason = "max_rounds"
    for round_idx in range(1, max_rounds + 1):
        review = evaluate()
        history.append(review)
        if bool(review.get("pass")):
            ok, reason = True, "converged"
            break
        suggestions = suggest_fixes(review, cut_points, edl_items)
        if not suggestions:
            reason = "no_fix"
            break
        if round_idx == max_rounds:
            break  # reason 保持 "max_rounds"
        if fix is not None and not fix(suggestions):
            reason = "fix_rejected"
            break
        fixes_applied += 1
        if render is not None:
            render()
    return {
        "ok": ok,
        "rounds": len(history),
        "reason": reason,
        "history": history,
        "fixes_applied": fixes_applied,
    }
