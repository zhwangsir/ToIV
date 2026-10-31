"""FU1 词锚定时间轴（hypit 投影语义的 ToIV 实现）。

拍结构 beats = [{text, cues: [str], anchor_words: str}]，与 svml_lite.Beat 同形。
- 时间投影：按字数估时（与 svml_lite 同口径 4.2 字/s，夹在 2–15s），
  得到每拍 start/end 与镜头总时长。
- 改词重排：改台词后按新文本长度比例重分各拍时长，锚/cue 附着关系不变；
  声明源是 beats 文本，时间只是投影，不把覆盖值当事实源。
"""

from __future__ import annotations

from typing import Any

_CHARS_PER_SEC = 4.2
_MIN_BEAT_SEC = 2.0
_MAX_BEAT_SEC = 15.0
_MIN_SHOT_SEC = 3
_MAX_SHOT_SEC = 60


def _norm_beats(raw: Any) -> list[dict]:
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        cues = item.get("cues") or []
        if not isinstance(cues, list):
            cues = []
        anchor = str(item.get("anchor_words") or "").strip()
        # 空白编辑仍是一拍，不能改变索引或丢掉 cue 附着关系。
        beat = {
            "text": text,
            "cues": [str(c) for c in cues if str(c).strip()],
            "anchor_words": anchor,
        }
        if item.get("kind") in ("v", "d"):
            beat["kind"] = item["kind"]
            beat["block"] = item.get("block", 0)
        out.append(beat)
    return out


def estimate_beat_sec(text: str, *, anchors: str = "") -> float:
    """锚词是 text 的标注而非额外对白；清空文本后也不重新念出旧锚。"""
    n = len((text or "").strip())
    if n <= 0:
        return _MIN_BEAT_SEC
    sec = max(_MIN_BEAT_SEC, min(_MAX_BEAT_SEC, n / _CHARS_PER_SEC))
    return sec


def project_timeline(beats: Any, *, total_sec: int | None = None) -> dict:
    """唯一时间投影。2–15s 仅约束估时权重，总长优先且末拍精确对齐。"""
    items = _norm_beats(beats)
    weights = [estimate_beat_sec(b["text"]) for b in items]
    raw_total = sum(weights)
    target = round(raw_total) if total_sec is None else int(total_sec)
    target = max(_MIN_SHOT_SEC, min(_MAX_SHOT_SEC, target))
    projected: list[dict] = []
    cursor = cumulative = 0.0
    for i, (beat, weight) in enumerate(zip(items, weights)):
        cumulative += weight
        # 累积边界取整而非逐拍舍入；高精度保证 200 拍/3s 仍有正时长。
        end = float(target) if i == len(items) - 1 else round(target * cumulative / raw_total, 6)
        projected.append({
            **beat, "start_sec": cursor, "end_sec": end,
            "est_sec": round(end - cursor, 6),
        })
        cursor = end
    return {"duration_sec": target, "beats": projected}


def reflow_beats(beats: Any, *, new_texts: list[str] | None = None, total_sec: int | None = None) -> dict:
    """改词重排。

    - new_texts：与 beats 等长时按序替换 text（cues/anchor_words 保留）。
    - total_sec：给定时把总时长夹到该值并按拍等比重排；缺省按新文本重估。
    返回 project_timeline 形状 + duration_sec。
    """
    items = _norm_beats(beats)
    if new_texts is not None:
        if len(new_texts) != len(items):
            raise ValueError(f"new_texts 长度 {len(new_texts)} != beats {len(items)}")
        for b, t in zip(items, new_texts):
            b["text"] = str(t or "").strip()
    return project_timeline(items, total_sec=total_sec)


def bind_beat_channels(beats: list[dict], *, dialogue: str, prompt: str) -> list[dict]:
    """旧的无通道声明只在整段唯一匹配时绑定，不能猜测视觉文字是对白。"""
    items = _norm_beats(beats)
    if all(b.get("kind") in ("v", "d") for b in items):
        return items
    original = " ".join(" ".join(b["text"].split()) for b in items).strip()
    matches = [kind for kind, text in (("d", dialogue), ("v", prompt))
               if original and original == " ".join(text.split())]
    if len(matches) != 1 or any(b.get("kind") for b in items):
        raise ValueError("拍缺少视觉/对白通道且无法唯一匹配，请重新导入 SVML 后改词")
    return [{**b, "kind": matches[0], "block": 0} for b in items]


def beat_text_fields(beats: list[dict]) -> dict[str, str]:
    """按 SVML 拼接规则生成消费文本：拍用空格，视觉块用逗号，对白块用空格。"""
    fields: dict[str, str] = {}
    for kind, field, separator in (("v", "prompt", ", "), ("d", "dialogue", " ")):
        groups: dict[int, list[str]] = {}
        for beat in beats:
            if beat.get("kind") == kind:
                groups.setdefault(beat.get("block", 0), []).append(beat["text"])
        if groups:
            blocks = [" ".join(t for t in texts if t) for texts in groups.values()]
            fields[field] = separator.join(block for block in blocks if block)
    return fields


def parse_beats_json(raw: str | None) -> list[dict]:
    import json

    if not raw:
        return []
    try:
        return _norm_beats(json.loads(raw))
    except (ValueError, TypeError):
        return []
