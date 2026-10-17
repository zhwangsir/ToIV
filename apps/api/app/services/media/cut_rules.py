"""词边界剪规硬规则:纯函数,LLM/渲染器共用同一口径。

ported from video-use (MIT) — SKILL.md 硬规则 6/7、剪辑指引与 helpers/render.py
的抽取/拼接/滤镜链顺序(MIT License, Copyright (c) 2026 Browser Use)。

硬规则:
  - 绝不词内切:cut_points 只落在词边界 + 安全间隙(≥400ms 静音窗)内;
  - 切边 pad 30–200ms:吸收 ASR 时间戳 50–100ms 漂移,超窗夹值;
  - 静音 ≥400ms 才算安全切点;<400ms 间隙不产出切点;
  - 字幕最后烧:build_filter_graph 顺序约束 scale/tonemap → grade → subtitles;
  - 分段抽取(30ms 音频淡入淡出)+ concat demuxer -c copy 无损拼接;
  - ffmpeg 滤镜串中的插值(字幕路径/样式)一律转义,禁裸拼。
"""
from __future__ import annotations

# 切边 pad 工作窗(30–200ms)
PAD_MIN, PAD_MAX = 0.03, 0.20
DEFAULT_PAD_IN, DEFAULT_PAD_OUT = 0.05, 0.08
# 静音切点门槛:≥400ms 才算安全切点
SAFE_SILENCE = 0.40
# 段边界音频淡入淡出时长(防爆音)
AUDIO_FADE = 0.03


# ---------------------------------------------------------------- 词边界

def word_spans(words: list[dict]) -> list[tuple[float, float]]:
    spans: list[tuple[float, float]] = []
    for w in words or []:
        if not isinstance(w, dict):
            continue
        s = w.get("start")
        if s is None:
            continue
        spans.append((float(s), float(w.get("end", s))))
    spans.sort()
    return spans


def is_midword(t: float, spans: list[tuple[float, float]]) -> bool:
    """严格落在某词起止之间=词内(压在词边界上不算词内)。"""
    return any(s < t < e for s, e in spans)


def gap_windows(
    words: list[dict],
    *,
    duration: float | None = None,
) -> list[tuple[float, float]]:
    """相邻词之间的静音窗;词表前/后的空档仅在已知素材时长时给出尾窗。"""
    spans = word_spans(words)
    gaps: list[tuple[float, float]] = []
    if not spans:
        if duration is not None:
            gaps.append((0.0, float(duration)))
        return gaps
    if spans[0][0] > 0:
        gaps.append((0.0, spans[0][0]))
    for (_s1, e1), (s2, _e2) in zip(spans, spans[1:]):
        if s2 > e1:
            gaps.append((e1, s2))
    if duration is not None and spans[-1][1] < duration:
        gaps.append((spans[-1][1], float(duration)))
    return gaps


def safe_cut_windows(
    words: list[dict],
    *,
    min_silence: float = SAFE_SILENCE,
    duration: float | None = None,
) -> list[tuple[float, float]]:
    """静音 ≥ min_silence 的间隙窗:窗内任意点(含端点)都是安全切点。"""
    return [
        (gs, ge)
        for gs, ge in gap_windows(words, duration=duration)
        if ge - gs >= min_silence
    ]


def is_safe_cut_point(
    t: float,
    words: list[dict],
    *,
    min_silence: float = SAFE_SILENCE,
    duration: float | None = None,
) -> bool:
    """切点合法性:不在词内,且所处静音窗 ≥ min_silence(默认 400ms)。"""
    if is_midword(t, word_spans(words)):
        return False
    return any(
        gs <= t <= ge
        for gs, ge in safe_cut_windows(words, min_silence=min_silence, duration=duration)
    )


def cut_points(
    words: list[dict],
    *,
    min_silence: float = SAFE_SILENCE,
    duration: float | None = None,
) -> list[float]:
    """推荐切点=各安全间隙的中点;绝不落在词内(构造保证)。"""
    return [
        round((gs + ge) / 2, 3)
        for gs, ge in safe_cut_windows(words, min_silence=min_silence, duration=duration)
    ]


# ---------------------------------------------------------------- 切边 pad

def clamp_pad(value: float) -> float:
    """pad 夹进 30–200ms 工作窗。"""
    return min(max(float(value), PAD_MIN), PAD_MAX)


def pad_bounds(
    start: float,
    end: float,
    *,
    pad_in: float = DEFAULT_PAD_IN,
    pad_out: float = DEFAULT_PAD_OUT,
    duration: float | None = None,
) -> tuple[float, float]:
    """切边各外扩一个 pad(夹值后),且不越出素材头尾。"""
    lo = max(0.0, start - clamp_pad(pad_in))
    hi = end + clamp_pad(pad_out)
    if duration is not None:
        hi = min(hi, float(duration))
    return lo, hi


# ---------------------------------------------------------------- ffmpeg 模板

def escape_filter_value(value: str) -> str:
    """转义滤镜选项值里的 \\ ' : , ; [ ] —— 裸拼路径/样式会截断或污染滤镜图。"""
    out: list[str] = []
    for ch in str(value):
        if ch in "\\':,;[]":
            out.append("\\")
        out.append(ch)
    return "".join(out)


def build_filter_graph(
    *,
    scale: str | None = None,
    grade: str | None = None,
    subtitles: str | None = None,
    subtitle_style: str | None = None,
) -> str:
    """生成单链滤镜串;顺序约束:scale/tonemap → grade → subtitles(字幕最后烧)。

    scale/grade 是调用方给的滤镜片段(预设),不二次转义;
    subtitles 路径与 force_style 样式经 escape_filter_value 转义。
    """
    parts: list[str] = []
    if scale:
        parts.append(scale)
    if grade:
        parts.append(grade)
    if subtitles:
        sub = f"subtitles=filename={escape_filter_value(subtitles)}"
        if subtitle_style:
            sub += f":force_style={escape_filter_value(subtitle_style)}"
        parts.append(sub)  # 字幕最后烧(顺序约束,勿前移)
    return ",".join(parts)


def segment_extract_args(
    source: str,
    start: float,
    end: float,
    out: str,
    *,
    audio_fade: float = AUDIO_FADE,
) -> list[str]:
    """分段抽取参数模板:-ss 在 -i 前快速精确 seek;段边界 30ms 音频淡入淡出。"""
    dur = end - start
    if dur <= 0:
        raise ValueError("end 必须大于 start")
    fade_out = max(0.0, dur - audio_fade)
    return [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", source,
        "-t", f"{dur:.3f}",
        "-af", f"afade=t=in:st=0:d={audio_fade:.3f},afade=t=out:st={fade_out:.3f}:d={audio_fade:.3f}",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-movflags", "+faststart",
        out,
    ]


def concat_list_line(path: str) -> str:
    """concat demuxer 列表行;内嵌单引号按 '\\'' 转义。"""
    escaped = str(path).replace("'", "'\\''")
    return f"file '{escaped}'"


def concat_list_content(paths: list[str]) -> str:
    return "\n".join(concat_list_line(p) for p in paths) + "\n"


def concat_command(output: str, list_file: str = "segments.txt") -> list[str]:
    """无损拼接参数模板:concat demuxer + -c copy(分段已同参抽取,不二次转码)。"""
    return ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", output]
