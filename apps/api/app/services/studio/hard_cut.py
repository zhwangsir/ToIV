"""c_hybrid 硬切规则（2026-10-05 雨夜 shot0 候选2：第 9 帧由首帧定妆图硬切进场景）。

规则：
  · 逐帧检测硬切（160×90 灰度逐帧平均绝对差 + HSV 直方图相关 + 局部中位数比 + 排除单帧闪光）。
  · 硬切落在首帧锚定区（第 0..anchor_frames 帧）或首 1 秒内 → 自动在切点裁掉片头
    （视频按帧裁、音频按同一时刻按采样点裁，时长/音画同步校验），记录裁掉的帧数/秒数。
    片尾不变，故下一镜的尾帧首帧与 MotionContext latent 续写仍然有效。
  · 1 秒后（且在锚定区外）的硬切：选优打分扣分（每处 HARD_CUT_LATE_PENALTY，封顶 CAP）。
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

HARD_CUT_MIN_MAD = 30.0  # 160×90 灰度逐帧平均绝对差（0~255）
HARD_CUT_MAX_HIST_CORR = 0.95  # HSV 直方图相关须低于此
HARD_CUT_LOCAL_RATIO = 6.0  # 须 ≥ 局部（±LOCAL_WIN 帧）中位数 × ratio
HARD_CUT_LOCAL_WIN = 12
HARD_CUT_FLASH_RATIO = 0.5  # 帧 i+1 对 i-1 的差仍须 ≥ ratio × mad（排除单帧闪光/闪电）
HEAD_TRIM_MAX_SECONDS = 1.0
HARD_CUT_LATE_PENALTY = 0.05
HARD_CUT_LATE_PENALTY_CAP = 0.20
HEAD_TRIM_SUFFIX = "_ht"
_STUDIO_MARKER = "/api/studio/files/"


class HardCutError(RuntimeError):
    """裁片头失败（ffmpeg/校验）。"""


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    if not s:
        return 0.0
    m = len(s) // 2
    return s[m] if len(s) % 2 else 0.5 * (s[m - 1] + s[m])


def detect_hard_cuts(video_path: str | Path) -> dict[str, Any]:
    """返回 {fps, n_frames, cuts:[{frame,t,mad,hist_corr,local_median,flash_mad}], error}。

    frame = 切后第一帧序号（裁片头时裁掉 0..frame-1，共 frame 帧）。
    """
    out: dict[str, Any] = {"fps": None, "n_frames": 0, "cuts": [], "error": ""}
    p = Path(video_path)
    if not p.is_file():
        out["error"] = "missing_video"
        return out
    try:
        import cv2
        import numpy as np
    except Exception as e:  # noqa: BLE001
        out["error"] = f"cv2_unavailable:{type(e).__name__}"
        return out
    cap = cv2.VideoCapture(str(p))
    if not cap.isOpened():
        out["error"] = "open_failed"
        return out
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0) or 24.0
        out["fps"] = fps
        grays: list[Any] = []
        mads: list[float] = [0.0]
        hcs: list[float] = [1.0]
        flash: list[float] = [0.0]
        prev_h = None
        while True:
            ok, fr = cap.read()
            if not ok or fr is None:
                break
            s = cv2.resize(fr, (160, 90), interpolation=cv2.INTER_AREA)
            g = cv2.cvtColor(s, cv2.COLOR_BGR2GRAY).astype(np.float32)
            hsv = cv2.cvtColor(s, cv2.COLOR_BGR2HSV)
            h = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
            cv2.normalize(h, h)
            if grays:
                mads.append(float(np.abs(g - grays[-1]).mean()))
                hcs.append(float(cv2.compareHist(h, prev_h, cv2.HISTCMP_CORREL)))
            if len(grays) >= 2:
                # 帧 i=len-1 的闪光校验：当前帧(i+1) vs i-1
                flash.append(float(np.abs(g - grays[-2]).mean()))
            grays.append(g)
            prev_h = h
            if len(grays) > 3:
                grays.pop(0)
        n = len(mads)
        out["n_frames"] = n
        flash.append(float("inf"))  # 末帧无 i+1：不做闪光排除
        while len(flash) < n:
            flash.append(float("inf"))
        for i in range(1, n):
            mad, hc = mads[i], hcs[i]
            if mad < HARD_CUT_MIN_MAD or hc >= HARD_CUT_MAX_HIST_CORR:
                continue
            lo, hi = max(1, i - HARD_CUT_LOCAL_WIN), min(n, i + HARD_CUT_LOCAL_WIN + 1)
            local = [mads[j] for j in range(lo, hi) if j != i]
            lm = _median(local)
            if lm > 0 and mad < HARD_CUT_LOCAL_RATIO * lm:
                continue
            fl = flash[i] if i < len(flash) else float("inf")
            if fl < HARD_CUT_FLASH_RATIO * mad:
                continue  # 帧 i 是单帧闪光（i+1 回到 i-1）
            back2 = flash[i - 1] if i >= 2 else float("inf")  # |帧 i − 帧 i-2|
            if back2 < HARD_CUT_FLASH_RATIO * mad:
                continue  # 帧 i 是闪光后的回落
            out["cuts"].append(
                {
                    "frame": i,
                    "t": round(i / fps, 4),
                    "mad": round(mad, 2),
                    "hist_corr": round(hc, 4),
                    "local_median": round(lm, 2),
                    "flash_mad": None if fl == float("inf") else round(fl, 2),
                }
            )
        return out
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}:{e}"
        return out
    finally:
        cap.release()


# 2026-10-05 雨夜 shot1：931f 镜内 3 处、3c40 镜内 6 处硬切仍入选/候选。
# 裁片头处理后仍有 ≥2 处镜内硬切 → 候选不得入选（选优门禁），出片后同条件换 seed。
HARD_CUT_INELIGIBLE_MIN = 2


def late_cut_count(cuts: list[dict[str, Any]], fps: float, anchor_frames: int = 0) -> int:
    """裁片头后剩余的镜内硬切数（=classify_cuts 的 late 数；片头切点会被裁掉不计）。"""
    _head, late = classify_cuts(cuts, fps, anchor_frames)
    return len(late)


def classify_cuts(
    cuts: list[dict[str, Any]], fps: float, anchor_frames: int = 0
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """→ (片头切点 | None, 1 秒后切点列表)。片头切点 = 锚定区内或首 1 秒内的最后一个切点。"""
    fps = float(fps or 24.0)
    head_limit = max(int(anchor_frames or 0), int(round(HEAD_TRIM_MAX_SECONDS * fps)))
    head = [c for c in cuts if int(c["frame"]) <= head_limit]
    late = [c for c in cuts if int(c["frame"]) > head_limit]
    return (head[-1] if head else None), late


def _probe(path: Path) -> dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "error", "-count_packets",
        "-show_entries",
        "stream=index,codec_type,codec_name,r_frame_rate,nb_read_packets,duration,sample_rate,channels",
        "-show_entries", "format=duration", "-of", "json", str(path),
    ]
    r = subprocess.run(cmd, check=True, capture_output=True, timeout=60)
    d = json.loads(r.stdout or b"{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)

    def _f(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    return {
        "video_duration": _f((v or {}).get("duration")),
        "video_frames": int((v or {}).get("nb_read_packets") or 0) if v else 0,
        "audio": a is not None,
        "audio_duration": _f((a or {}).get("duration")) if a else None,
        "sample_rate": int((a or {}).get("sample_rate") or 0) if a else 0,
        "channels": int((a or {}).get("channels") or 0) if a else 0,
        "format_duration": _f((d.get("format") or {}).get("duration")),
    }


def _last_frame_mad(a: Path, b: Path) -> float | None:
    try:
        import cv2
        import numpy as np
    except Exception:  # noqa: BLE001
        return None

    def _last(p: Path):
        cap = cv2.VideoCapture(str(p))
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, n - 1))
        ok, fr = cap.read()
        cap.release()
        return fr if ok else None

    fa, fb = _last(a), _last(b)
    if fa is None or fb is None or fa.shape != fb.shape:
        return None
    return float(np.abs(fa.astype("float32") - fb.astype("float32")).mean())


def trim_video_head(
    src: str | Path, dst: str | Path, frames: int, fps: float
) -> dict[str, Any]:
    """裁掉片头 frames 帧；有音轨则按同一时刻（frames/fps 秒，按采样点）裁音频。

    校验：输出帧数 = 原帧数 − frames；音画时长差与原片一致（容差 1 帧 + 1 个 AAC 帧）；
    片尾末帧与原片一致（平均差 ≤ 3，重编码误差）。失败抛 HardCutError，dst 删除。
    """
    src, dst = Path(src), Path(dst)
    frames = int(frames)
    fps = float(fps or 24.0)
    if frames <= 0:
        raise HardCutError("frames must be > 0")
    before = _probe(src)
    start_s = frames / fps
    fc = f"[0:v]trim=start_frame={frames},setpts=PTS-STARTPTS[v]"
    maps = ["-map", "[v]"]
    a_args: list[str] = ["-an"]
    if before["audio"]:
        sr = before["sample_rate"] or 48000
        start_sample = int(round(start_s * sr))
        end_part = ""
        if before["audio_duration"]:
            # 尾部与原片同点结束（只去片头），避免 AAC 尾帧补零让音轨比原片多出一截
            end_part = f":end_sample={int(round(before['audio_duration'] * sr))}"
        fc += f";[0:a]atrim=start_sample={start_sample}{end_part},asetpts=PTS-STARTPTS[a]"
        maps += ["-map", "[a]"]
        a_args = ["-c:a", "aac", "-b:a", "192k", "-ar", str(sr)]
        if before["channels"]:
            a_args += ["-ac", str(before["channels"])]
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-filter_complex", fc, *maps,
        "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p",
        "-r", f"{fps:g}", *a_args, "-movflags", "+faststart", str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=600)
        after = _probe(dst)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError) as e:
        dst.unlink(missing_ok=True)
        err = getattr(e, "stderr", b"") or b""
        raise HardCutError(f"ffmpeg 裁片头失败:{e} {err[-300:]!r}") from e

    info: dict[str, Any] = {
        "frames": frames,
        "seconds": round(start_s, 4),
        "fps": fps,
        "src_frames": before["video_frames"],
        "trimmed_frames": after["video_frames"],
        "src_video_duration": before["video_duration"],
        "trimmed_video_duration": after["video_duration"],
        "audio": before["audio"],
        "src_audio_duration": before["audio_duration"],
        "trimmed_audio_duration": after["audio_duration"],
    }
    problems: list[str] = []
    if before["video_frames"] and after["video_frames"] != before["video_frames"] - frames:
        problems.append(f"frames {after['video_frames']}!={before['video_frames']}-{frames}")
    if before["audio"]:
        if not after["audio"] or after["audio_duration"] is None:
            problems.append("audio_lost")
        else:
            d0 = (before["video_duration"] or 0) - (before["audio_duration"] or 0)
            d1 = (after["video_duration"] or 0) - (after["audio_duration"] or 0)
            sr = before["sample_rate"] or 48000
            tol = 1.0 / fps + 1024.0 / sr
            info["av_drift_src"] = round(d0, 4)
            info["av_drift_trimmed"] = round(d1, 4)
            if abs(d1 - d0) > tol:
                problems.append(f"av_drift {d1:.4f} vs src {d0:.4f} > {tol:.4f}")
    tail = _last_frame_mad(src, dst)
    info["tail_frame_mad"] = None if tail is None else round(tail, 3)
    if tail is not None and tail > 3.0:
        problems.append(f"tail_changed mad={tail:.2f}")
    if problems:
        dst.unlink(missing_ok=True)
        raise HardCutError("裁片头校验失败:" + "; ".join(problems))
    return info


def trimmed_url_for(url: str, dst: Path) -> str:
    u = str(url or "")
    if _STUDIO_MARKER in u:
        return u.split(_STUDIO_MARKER, 1)[0] + _STUDIO_MARKER + dst.name
    return str(dst)


def apply_hard_cut_rule(
    c: dict[str, Any],
    path: str | Path,
    *,
    anchor_frames: int = 0,
    detect_fn=None,
    trim_fn=None,
) -> dict[str, Any]:
    """对单个候选执行硬切规则，原地写入候选字段并返回 {path, penalty, skip_until_frame}。

    写入：hard_cuts（全部切点帧号）、hard_cut_detect（fps/帧数/error）、head_trim（裁片头记录）、
    url_untrimmed / url（裁后）、hard_cut_late、hard_cut_penalty。
    已裁过（head_trim 存在）的候选不重复裁。
    """
    path = Path(path)
    res = {"path": path, "penalty": 0.0, "skip_until_frame": int(anchor_frames or 0)}
    det = (detect_fn or detect_hard_cuts)(path)
    cuts = list(det.get("cuts") or [])
    fps = float(det.get("fps") or 24.0)
    c["hard_cut_detect"] = {
        "fps": det.get("fps"),
        "n_frames": det.get("n_frames"),
        "error": det.get("error") or "",
    }
    c["hard_cuts"] = [int(x["frame"]) for x in cuts]
    if det.get("error"):
        return res
    already = bool(c.get("head_trim"))
    head, late = classify_cuts(cuts, fps, 0 if already else anchor_frames)
    if head is not None and not already:
        frames = int(head["frame"])
        dst = path.with_name(f"{path.stem}{HEAD_TRIM_SUFFIX}{frames}{path.suffix or '.mp4'}")
        try:
            info = (trim_fn or trim_video_head)(path, dst, frames, fps)
        except HardCutError as e:
            c["head_trim_error"] = str(e)[:300]
            logger.warning("hard_cut head trim failed %s: %s", path.name, e)
        else:
            info.update(
                cut_frame=frames,
                cut_t=head.get("t"),
                in_anchor_zone=frames <= int(anchor_frames or 0),
                anchor_frames=int(anchor_frames or 0),
                file=dst.name,
            )
            c["head_trim"] = info
            c["url_untrimmed"] = c.get("url")
            c["url"] = trimmed_url_for(str(c.get("url") or ""), dst)
            res["path"] = dst
            res["skip_until_frame"] = max(0, int(anchor_frames or 0) - frames)
            logger.info(
                "hard_cut head trimmed %s → %s frames=%s (%.3fs)",
                path.name, dst.name, frames, frames / fps,
            )
    elif already:
        res["skip_until_frame"] = max(
            0, int(anchor_frames or 0) - int(c["head_trim"].get("frames") or 0)
        )
    c["hard_cut_late"] = [{"frame": int(x["frame"]), "t": x.get("t")} for x in late]
    pen = min(HARD_CUT_LATE_PENALTY_CAP, HARD_CUT_LATE_PENALTY * len(late))
    c["hard_cut_penalty"] = round(pen, 4)
    res["penalty"] = pen
    return res
