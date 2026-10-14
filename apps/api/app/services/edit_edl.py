"""EDL 中间表示 + 词边界剪规硬规则（FU2 件 2+3）。

移植自 video-use(MIT, Copyright (c) 2026 Browser Use)：EDL 契约见 helpers/render.py
（sources/ranges/grade/subtitles），剪规硬规则见 SKILL.md 硬规则 6/7 与剪辑指引：
  - 绝不词内切：切边吸附到词边界；
  - 每个切边 pad，工作窗 30–200ms（ASR 时间戳漂 50–100ms，pad 吸收漂移）；
  - 静音 ≥400ms 是最干净的切点；150–400ms 可用但需视觉复核；<150ms 不安全；
  - 段边界 30ms 音频淡入淡出（渲染件负责，见 edit_render）；字幕最后烧。
LLM 只产 EDL 声明决策表，不碰视频；渲染器消费 EDL——runner 与合成端的标准解耦协议。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# 切边 pad 工作窗(SKILL 硬规则 7)
PAD_MIN, PAD_MAX = 0.03, 0.20
# _launch 视频实测值(SKILL 剪辑指引):首词前 50ms、末词后 80ms
PAD_IN_DEFAULT, PAD_OUT_DEFAULT = 0.05, 0.08
# 静音切点分级(SKILL 剪辑指引)
SAFE_SILENCE = 0.40
USABLE_SILENCE = 0.15


class EdlRange(BaseModel):
    """一段取用决策:{source,start,end} + 可追溯的 beat/quote/reason。"""

    source: str
    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)
    beat: str = ""
    quote: str = ""
    reason: str = ""
    pad_in: float | None = None  # None=渲染时用 PAD_IN_DEFAULT;显式给值须在窗口内
    pad_out: float | None = None


class Edl(BaseModel):
    sources: dict[str, str] = Field(default_factory=dict)  # name → 媒体 url/路径
    ranges: list[EdlRange] = Field(default_factory=list)
    grade: str = "auto"  # 预设名 / 原始 ffmpeg filter / auto(渲染件逐段分析)
    subtitles: str | None = None
    overlays: list[dict[str, Any]] = Field(default_factory=list)


def word_spans(words: list[dict]) -> list[tuple[float, float]]:
    out = []
    for w in words or []:
        s = w.get("start")
        if s is None:
            continue
        out.append((float(s), float(w.get("end", s))))
    out.sort()
    return out


def classify_edge(edge: float, spans: list[tuple[float, float]]) -> tuple[str, float]:
    """切边落在哪：('midword',0) / ('clean'|'usable'|'unsafe', 所在静音窗宽度)。"""
    for s, e in spans:
        if s < edge < e:
            return "midword", 0.0
    before = [e for s, e in spans if e <= edge]
    after = [s for s, e in spans if s >= edge]
    gap_start = max(before) if before else edge
    gap_end = min(after) if after else edge
    gap = round(gap_end - gap_start, 3)  # 毫秒精度:避开 3.0-2.6=0.39999… 的浮点陷阱
    if gap >= SAFE_SILENCE:
        return "clean", gap
    if gap >= USABLE_SILENCE:
        return "usable", gap
    return "unsafe", gap


def snap_range(start: float, end: float, spans: list[tuple[float, float]]) -> tuple[float, float]:
    """词内切边外扩到整词：start 吸附到所在词起点，end 吸附到所在词终点(宁多勿切)。"""
    for s, e in spans:
        if s < start < e:
            start = s
            break
    for s, e in reversed(spans):
        if s < end < e:
            end = e
            break
    return start, end


def clamp_pad(value: float | None, default: float) -> float:
    v = default if value is None else value
    return min(max(v, PAD_MIN), PAD_MAX)


def materialize_range(rng: EdlRange, spans: list[tuple[float, float]]) -> tuple[float, float]:
    """吸附 + pad 后的实际取用区间(渲染件与校验器共用同一函数,口径不分裂)。"""
    start, end = snap_range(rng.start, rng.end, spans)
    start = max(0.0, start - clamp_pad(rng.pad_in, PAD_IN_DEFAULT))
    end = end + clamp_pad(rng.pad_out, PAD_OUT_DEFAULT)
    return start, end


def validate_edl(edl: Edl, words_by_source: dict[str, list[dict]]) -> list[dict]:
    """对**请求边**(未吸附未 pad)做硬规则体检;返回违规/告警清单,空=可渲染。

    midword / unsafe = 违规(渲染会切字或爆音);usable = 告警(需视觉复核,不拦)。
    """
    issues: list[dict] = []
    for i, rng in enumerate(edl.ranges):
        spans = word_spans(words_by_source.get(rng.source, []))
        if rng.source not in edl.sources:
            issues.append({"range": i, "kind": "unknown_source", "source": rng.source,
                           "message": f"sources 里没有 {rng.source}"})
            continue
        if rng.end <= rng.start:
            issues.append({"range": i, "kind": "empty_range", "source": rng.source,
                           "message": f"end({rng.end}) 须大于 start({rng.start})"})
            continue
        for edge_name, edge in (("start", rng.start), ("end", rng.end)):
            kind, gap = classify_edge(edge, spans)
            if kind == "midword":
                issues.append({"range": i, "kind": "midword_cut", "edge": edge_name,
                               "source": rng.source, "at": edge,
                               "message": "切边落在词内(硬规则 6:绝不词内切)"})
            elif kind == "unsafe":
                issues.append({"range": i, "kind": "unsafe_gap", "edge": edge_name,
                               "source": rng.source, "at": edge, "gap": round(gap, 3),
                               "message": f"切边所在静音 {gap*1000:.0f}ms <150ms,不安全"})
            elif kind == "usable":
                issues.append({"range": i, "kind": "needs_visual_check", "edge": edge_name,
                               "source": rng.source, "at": edge, "gap": round(gap, 3),
                               "message": f"静音 {gap*1000:.0f}ms 在 150-400ms,需视觉复核"})
        for pname, pval in (("pad_in", rng.pad_in), ("pad_out", rng.pad_out)):
            if pval is not None and not (PAD_MIN <= pval <= PAD_MAX):
                issues.append({"range": i, "kind": "pad_out_of_window", "edge": pname,
                               "source": rng.source, "at": pval,
                               "message": f"{pname}={pval} 超出 30-200ms 工作窗(已按窗口夹值渲染)"})
    return issues
