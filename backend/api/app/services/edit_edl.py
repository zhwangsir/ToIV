"""EDL 中间表示(旧契约兼容面)+ 词边界剪规(FU2 深化收编)。

剪点语义已统一到 services/media/cut_rules.py 单一源(分级/吸附/pad/取用区间),
EDL 取用语义与 services/media/edl.py 的 EdlItem.materialize 同口径;
本模块保留既有调用方依赖的 pydantic 契约(sources/ranges/grade/subtitles)与
validate_edl/materialize_range 入口,原语一律改调 media.cut_rules,不重复实现。

硬规则出处(移植自 video-use(MIT, Copyright (c) 2026 Browser Use) SKILL 剪辑指引):
  - 绝不词内切:切边吸附到词边界;
  - 每个切边 pad,工作窗 30–200ms(ASR 时间戳漂 50–100ms,pad 吸收漂移);
  - 静音 ≥400ms 是最干净的切点;150–400ms 可用但需视觉复核;<150ms 不安全;
  - 段边界 30ms 音频淡入淡出(渲染件负责,见 edit_render);字幕最后烧。
LLM 只产 EDL 声明决策表,不碰视频;渲染器消费 EDL——runner 与合成端的标准解耦协议。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.services.media.cut_rules import (
    PAD_MAX,
    PAD_MIN,
    SAFE_SILENCE,
    USABLE_SILENCE,
    classify_edge,
    clamp_pad,
    materialize_bounds,
    snap_range,
    word_spans,
)
from app.services.media.cut_rules import DEFAULT_PAD_IN as PAD_IN_DEFAULT
from app.services.media.cut_rules import DEFAULT_PAD_OUT as PAD_OUT_DEFAULT

__all__ = [
    "Edl", "EdlRange", "PAD_MIN", "PAD_MAX", "PAD_IN_DEFAULT", "PAD_OUT_DEFAULT",
    "SAFE_SILENCE", "USABLE_SILENCE", "word_spans", "classify_edge", "snap_range",
    "clamp_pad", "materialize_range", "validate_edl",
]


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


def materialize_range(rng: EdlRange, spans: list[tuple[float, float]]) -> tuple[float, float]:
    """吸附 + pad 后的实际取用区间(改调 media.cut_rules.materialize_bounds 单一源)。"""
    return materialize_bounds(
        rng.start, rng.end, spans, pad_in=rng.pad_in, pad_out=rng.pad_out)


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
