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
# 150–400ms 间隙:可用但需视觉复核;<150ms 不安全(SKILL 剪辑指引分级)
USABLE_SILENCE = 0.15
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


def classify_edge(edge: float, spans: list[tuple[float, float]]) -> tuple[str, float]:
    """切边落在哪(收编自旧 edit_edl,分级口径唯一源):('midword',0) /
    ('clean'|'usable'|'unsafe', 所处静音窗宽度)。

    无语音素材(纯音乐/空镜)没有要保护的词边界 → 一律 clean。
    词内(严格落在某词起止之间)= midword;否则看它所处静音窗(prev_end→next_start)宽度:
    切边正好压在词起点/终点上时窗口就是相邻静音,属最安全的一类;
    窗 <150ms 说明切点贴着词尾/词头,ASR 漂移会把字切坏 → unsafe。
    """
    if not spans:
        return "clean", 0.0
    for s, e in spans:
        if s < edge < e:
            return "midword", 0.0
    before = [e for s, e in spans if e <= edge]
    after = [s for s, e in spans if s >= edge]
    if not before or not after:  # 首词之前/末词之后:没有会被切坏的邻居
        return "clean", 0.0
    gap = round(min(after) - max(before), 3)
    if gap >= SAFE_SILENCE:
        return "clean", gap
    if gap >= USABLE_SILENCE:
        return "usable", gap
    return "unsafe", gap


def snap_range(start: float, end: float, spans: list[tuple[float, float]]) -> tuple[float, float]:
    """词内切边外扩到整词:start 吸附到所在词起点,end 吸附到所在词终点(宁多勿切)。"""
    for s, e in spans:
        if s < start < e:
            start = s
            break
    for s, e in reversed(spans):
        if s < end < e:
            end = e
            break
    return start, end


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

def clamp_pad(value: float | None, default: float = DEFAULT_PAD_IN) -> float:
    """pad 夹进 30–200ms 工作窗;None 用 default(收编自旧 edit_edl 两参口径)。"""
    return min(max(default if value is None else float(value), PAD_MIN), PAD_MAX)


def materialize_bounds(
    start: float,
    end: float,
    spans: list[tuple[float, float]],
    *,
    pad_in: float | None = None,
    pad_out: float | None = None,
) -> tuple[float, float]:
    """吸附整词 + pad 外扩后的实际取用区间(渲染件与校验器共用同一函数,口径不分裂)。"""
    s, e = snap_range(start, end, spans)
    return max(0.0, s - clamp_pad(pad_in, DEFAULT_PAD_IN)), e + clamp_pad(pad_out, DEFAULT_PAD_OUT)


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
