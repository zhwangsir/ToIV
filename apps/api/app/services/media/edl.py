"""EDL JSON 中间表示:LLM 不碰视频、只产 EDL 的声明式契约。

ported from video-use (MIT) — EDL 契约思想见 helpers/render.py
(MIT License, Copyright (c) 2026 Browser Use);数据模型按 ToIV 收敛为
{items:[{source,start,end,beat,quote,reason}]}。

- item=一条取用决策:source 素材 + [start,end) 区间 + beat/quote/reason 可追溯;
- validate():帧/时间合法 + 区间不越界(+可选词内切拒绝),违规清单空=可渲染;
- to_json/from_json:LLM ↔ 渲染器的稳定交换格式。
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field

from app.services.media import cut_rules

# 越界容差(秒):浮点时间戳噪声
EPS = 1e-6


@dataclass
class EdlItem:
    """一条取用决策:{source,start,end,beat,quote,reason}。"""

    source: str
    start: float
    end: float
    beat: str = ""
    quote: str = ""
    reason: str = ""

    def materialize(
        self,
        spans: list[tuple[float, float]],
        *,
        pad_in: float | None = None,
        pad_out: float | None = None,
    ) -> tuple[float, float]:
        """吸附整词 + pad 外扩后的取用区间(与旧 edit_edl.materialize_range 同语义)。"""
        return cut_rules.materialize_bounds(
            self.start, self.end, spans, pad_in=pad_in, pad_out=pad_out)


@dataclass
class Edl:
    """EDL 声明式契约:items 序列即成片取用决策表。"""

    items: list[EdlItem] = field(default_factory=list)

    # ------------------------------------------------------------ 序列化

    def to_json(self) -> str:
        return json.dumps({"items": [asdict(it) for it in self.items]}, ensure_ascii=False)

    @classmethod
    def from_json(cls, text: str) -> "Edl":
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, TypeError) as exc:
            raise ValueError(f"EDL JSON 解析失败: {exc}") from exc
        return cls.from_dict(payload)

    @classmethod
    def from_dict(cls, payload: object) -> "Edl":
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise ValueError("EDL 必须是 {items:[...]} 结构")
        items: list[EdlItem] = []
        for i, raw in enumerate(payload["items"]):
            if not isinstance(raw, dict):
                raise ValueError(f"items[{i}] 不是对象")
            src = raw.get("source")
            if not isinstance(src, str) or not src.strip():
                raise ValueError(f"items[{i}].source 必须是非空字符串")
            for key in ("start", "end"):
                v = raw.get(key)
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                    raise ValueError(f"items[{i}].{key} 必须是有限数值")
            items.append(EdlItem(
                source=src,
                start=float(raw["start"]),
                end=float(raw["end"]),
                beat=str(raw.get("beat") or ""),
                quote=str(raw.get("quote") or ""),
                reason=str(raw.get("reason") or ""),
            ))
        return cls(items=items)

    # ------------------------------------------------------------ 校验

    def validate(
        self,
        *,
        source_durations: dict[str, float] | None = None,
        fps: float | None = None,
        words_by_source: dict[str, list[dict]] | None = None,
    ) -> list[dict]:
        """硬规则体检,返回违规清单,空=可渲染。

        - 帧/时间合法:start/end 有限、非负、end>start;给 fps 时区间须 ≥1 帧;
        - 区间不越界:end 不得超出素材时长(给 source_durations 时);
        - 给 words_by_source 时拒绝词内切(硬规则:绝不词内切)。
        """
        if fps is not None and (isinstance(fps, bool) or not isinstance(fps, (int, float)) or fps <= 0):
            raise ValueError("fps 必须为正数")
        issues: list[dict] = []
        for i, it in enumerate(self.items):
            if not math.isfinite(it.start) or not math.isfinite(it.end):
                issues.append({"item": i, "kind": "invalid_time", "source": it.source,
                               "message": "start/end 必须是有限数值"})
                continue
            if it.start < 0:
                issues.append({"item": i, "kind": "invalid_time", "field": "start",
                               "source": it.source, "at": it.start,
                               "message": "start 不能为负"})
                continue
            if it.end <= it.start:
                issues.append({"item": i, "kind": "empty_range", "source": it.source,
                               "start": it.start, "end": it.end,
                               "message": f"end({it.end}) 须大于 start({it.start})"})
                continue
            if fps is not None and (it.end - it.start) * fps < 1 - EPS:
                issues.append({"item": i, "kind": "subframe_range", "source": it.source,
                               "fps": fps, "start": it.start, "end": it.end,
                               "message": f"区间 {(it.end - it.start) * 1000:.0f}ms 不足 1 帧({fps}fps)"})
            dur = (source_durations or {}).get(it.source)
            if dur is not None and it.end > float(dur) + EPS:
                issues.append({"item": i, "kind": "out_of_range", "source": it.source,
                               "end": it.end, "duration": float(dur),
                               "message": f"end({it.end}) 越出素材时长 {dur}"})
            if words_by_source is not None:
                spans = cut_rules.word_spans(words_by_source.get(it.source, []))
                for edge_name, at in (("start", it.start), ("end", it.end)):
                    if cut_rules.is_midword(at, spans):
                        issues.append({"item": i, "kind": "midword_cut", "edge": edge_name,
                                       "source": it.source, "at": at,
                                       "message": "切边落在词内(硬规则:绝不词内切)"})
        return issues
