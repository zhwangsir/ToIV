"""EDL 渲染器：分段抽取(30ms 音频淡入淡出) + 无损 concat（FU2 件 2 的渲染半边）。

移植自 video-use(MIT, Copyright (c) 2026 Browser Use) helpers/render.py 的管线次序：
  1. 每段抽取时烘入调色 + 段边界 30ms 音频淡入淡出(否则每个切点爆音,硬规则 3)
  2. concat demuxer `-c copy` 无损拼接(硬规则:分段抽取无损拼接)
  3. 字幕/叠层在最后一次 filter graph 里烧(本件暂不接叠层,字幕留 grade 件之后)
与 video-use 的差异:全输出统一帧率在抽取前定死(混帧率源会让 -c copy 拼接裂开);
切边先经 edit_edl.materialize_range(吸附整词+pad)再抽,校验不过不渲染。
质量梯:final=1080p crf20 fast / preview=1080p crf22 medium / draft=720p crf28 ultrafast。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from app.services.edit_edl import Edl, materialize_range, validate_edl, word_spans

AFade_MS = 0.03  # 硬规则 3:段边界音频淡入淡出,防爆音


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def probe_fps(src: Path) -> str | None:
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=avg_frame_rate", "-of", "json", str(src)]
    try:
        out = json.loads(subprocess.run(cmd, capture_output=True, text=True,
                                        timeout=60, check=True).stdout)
        rate = (out.get("streams") or [{}])[0].get("avg_frame_rate") or ""
        if "/" in rate:
            num, den = rate.split("/")
            if float(den):
                return f"{float(num) / float(den):.3f}".rstrip("0").rstrip(".")
        return rate or None
    except Exception:  # noqa: BLE001 — 探不到就走 24
        return None


def _is_portrait(src: Path) -> bool:
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height", "-of", "json", str(src)]
    try:
        out = json.loads(subprocess.run(cmd, capture_output=True, text=True,
                                        timeout=60, check=True).stdout)
        s = (out.get("streams") or [{}])[0]
        return bool(s.get("height")) and s["height"] > s.get("width", 0)
    except Exception:  # noqa: BLE001
        return False


def extract_segment(src: Path, start: float, duration: float, out_path: Path, *,
                    grade_filter: str = "", preview: bool = False, draft: bool = False,
                    rate: str = "24") -> None:
    portrait = _is_portrait(src)
    if draft:
        scale = "scale=-2:1280" if portrait else "scale=1280:-2"
        venc = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"]
    elif preview:
        scale = "scale=-2:1920" if portrait else "scale=1920:-2"
        venc = ["-c:v", "libx264", "-preset", "medium", "-crf", "22"]
    else:
        scale = "scale=-2:1920" if portrait else "scale=1920:-2"
        venc = ["-c:v", "libx264", "-preset", "fast", "-crf", "20"]
    vf = ",".join(p for p in (scale, grade_filter) if p)
    fade_out = max(0.0, duration - AFade_MS)
    af = f"afade=t=in:st=0:d={AFade_MS},afade=t=out:st={fade_out:.3f}:d={AFade_MS}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{duration:.3f}",
        "-vf", vf, "-af", af, "-r", rate,
        *venc, "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", str(out_path),
    ]
    _run(cmd)


def concat_segments(seg_paths: list[Path], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lst = out_path.with_suffix(".concat.txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in seg_paths), encoding="utf-8")
    _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
          "-c", "copy", "-movflags", "+faststart", str(out_path)])
    lst.unlink(missing_ok=True)


def render_edl(edl: Edl, words_by_source: dict[str, list[dict]], resolve_path,
               out_dir: Path, *, preview: bool = False, draft: bool = False,
               fps: str | None = None, grade_filter: str = "") -> dict:
    """校验 → 吸附+pad → 分段抽取 → 无损 concat。校验有违规直接不渲染(硬规则前置)。"""
    issues = [i for i in validate_edl(edl, words_by_source)
              if i["kind"] not in ("needs_visual_check",)]
    if issues:
        return {"ok": False, "issues": issues, "out": None, "segments": []}
    rate = fps or (probe_fps(resolve_path(edl.sources[edl.ranges[0].source])) if edl.ranges else None) or "24"
    seg_dir = out_dir / ("clips_draft" if draft else ("clips_preview" if preview else "clips_graded"))
    segs: list[Path] = []
    for i, rng in enumerate(edl.ranges):
        src = resolve_path(edl.sources[rng.source])
        start, end = materialize_range(rng, word_spans(words_by_source.get(rng.source, [])))
        out = seg_dir / f"seg_{i:02d}_{rng.source}.mp4"
        extract_segment(src, start, max(0.05, end - start), out,
                        grade_filter=grade_filter, preview=preview, draft=draft, rate=rate)
        segs.append(out)
    out_path = out_dir / ("preview.mp4" if preview else ("draft.mp4" if draft else "final.mp4"))
    concat_segments(segs, out_path)
    return {"ok": True, "issues": [], "out": str(out_path),
            "segments": [str(s) for s in segs], "fps": rate}
