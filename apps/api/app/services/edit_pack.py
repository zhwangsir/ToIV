"""Packed Transcript(旧契约兼容面;FU2 深化收编)。

打包/断句/格式化已统一到 services/media/packed_transcript.py 单一源;
本模块保留既有调用方依赖的词表形状({type,text,start,end,speaker_id},
兼容 whisper segments 与 Scribe 条目)与 group_into_phrases/pack_takes 入口,
断句改调 media.group_words,不再重复实现 video-use 同类逻辑。

ASR 用自家 whisper 集群(TOIV_WHISPER_URL 四址故障转移,word_timestamps verbatim),
不引 ElevenLabs Scribe(方案 R5)。
"""
from __future__ import annotations

from typing import Any

from app.services.media.packed_transcript import (
    SILENCE_THRESHOLD,
    format_duration,
    format_time,
    group_words,
)

__all__ = [
    "SILENCE_THRESHOLD", "format_time", "format_duration",
    "normalize_words", "group_into_phrases", "pack_takes",
]


def normalize_words(payload: Any) -> list[dict]:
    """把 whisper / Scribe 两种词级负载归一成 {type,text,start,end,speaker_id}。

    whisper(faster-whisper 系)给 segments[].words[] = {word,start,end}，无 spacing
    条目、无说话人；Scribe 给 type=word|spacing|audio_event + speaker_id。
    归一后 group_into_phrases 对两者同语义。
    """
    out: list[dict] = []
    if isinstance(payload, dict):
        words = payload.get("words") or []
        if not words:  # faster-whisper 风格:segments[].words[]
            for seg in payload.get("segments") or []:
                for w in seg.get("words") or []:
                    words.append(w)
    elif isinstance(payload, list):
        words = payload
    else:
        return out
    for w in words:
        if not isinstance(w, dict):
            continue
        text = w.get("text") if w.get("text") is not None else w.get("word")
        start = w.get("start")
        if start is None:
            continue
        out.append({
            "type": w.get("type") or "word",
            "text": (text or "").strip(),
            "start": float(start),
            "end": float(w.get("end", start)),
            "speaker_id": w.get("speaker_id"),
        })
    out.sort(key=lambda w: w["start"])
    return out


def group_into_phrases(
    words: list[dict], silence_threshold: float = SILENCE_THRESHOLD
) -> list[dict]:
    """按「静音 ≥ 门槛 或 说话人变化」切短语;返回 [{start,end,text,speaker_id}]。

    收编后断句改调 media.group_words(单一源):Scribe spacing 条目携带的静音
    由相邻词边界差推得(等价语义),audio_event 文本先括注,输出键适配回 speaker_id。
    """
    adapted: list[dict] = []
    for w in words or []:
        if w.get("type") == "spacing":
            continue
        raw = (w.get("text") or "").strip()
        if w.get("type") == "audio_event" and raw and not raw.startswith("("):
            raw = f"({raw})"
        entry = {"text": raw, "start": w.get("start"), "end": w.get("end", w.get("start"))}
        if entry["start"] is None:
            continue
        if w.get("speaker_id") is not None:
            entry["speaker"] = w["speaker_id"]
        adapted.append(entry)
    return [
        {"start": s["start"], "end": s["end"], "text": s["text"],
         "speaker_id": s.get("speaker")}
        for s in group_words(adapted, silence_threshold=silence_threshold)
    ]


def pack_takes(takes: list[dict], silence_threshold: float = SILENCE_THRESHOLD) -> str:
    """takes=[{name, words(原始负载或已归一列表)}] → takes_packed.md 文本。"""
    lines = [
        "# Packed transcripts",
        "",
        f"Phrase-level, grouped on silences ≥ {silence_threshold:.1f}s or speaker change.",
        "Use `[start-end]` ranges to address cuts in the EDL.",
        "",
    ]
    for take in takes:
        words = take.get("words")
        if not (isinstance(words, list) and words and isinstance(words[0], dict) and "type" in words[0]):
            words = normalize_words(words)
        phrases = group_into_phrases(words, silence_threshold)
        duration = (phrases[-1]["end"] - phrases[0]["start"]) if phrases else 0.0
        lines.append(f"## {take.get('name') or 'take'}  "
                     f"(duration: {format_duration(duration)}, {len(phrases)} phrases)")
        if not phrases:
            lines.append("  _no speech detected_")
            lines.append("")
            continue
        for p in phrases:
            spk = p.get("speaker_id")
            tag = ""
            if spk is not None:
                spk_str = str(spk)
                if spk_str.startswith("speaker_"):
                    spk_str = spk_str[len("speaker_"):]
                tag = f" S{spk_str}"
            lines.append(f"  [{format_time(p['start'])}-{format_time(p['end'])}]{tag} {p['text']}")
        lines.append("")
    return "\n".join(lines)
