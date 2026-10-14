"""Packed Transcript：词级 ASR → 短语级带时间戳 markdown（FU2 件 1）。

移植自 video-use(MIT, Copyright (c) 2026 Browser Use) helpers/pack_transcripts.py，
按 ToIV 现状改编：ASR 用自家 whisper 集群(openclaw :9310 四址故障转移,
word_timestamps verbatim)，不引 ElevenLabs Scribe(方案 R5)。词表形状同时兼容
whisper({word|text,start,end}) 与 Scribe({type,text,start,end,speaker_id})。

用途：媒体库生成视频入库时产出该视图，作为 LLM 检索/选片的唯一文本面——
一小时素材约 12KB，token 约为原始词级 JSON 的 1/10，且仅凭文本即有词边界精度。
"""
from __future__ import annotations

from typing import Any

# 短语切分静音门槛(video-use 默认 0.5s)
SILENCE_THRESHOLD = 0.5


def format_time(seconds: float) -> str:
    """固定 6 字符宽的秒表示，便于对齐(video-use 原样)。"""
    return f"{seconds:06.2f}"


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    m = int(seconds // 60)
    s = seconds - m * 60
    return f"{m}m {s:04.1f}s"


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


def group_into_phrases(words: list[dict], silence_threshold: float = SILENCE_THRESHOLD) -> list[dict]:
    """按「静音 ≥ 门槛 或 说话人变化」切短语；返回 [{start,end,text,speaker_id}]。

    与 video-use 同语义：Scribe 的 spacing 条目携带静音信息；whisper 无 spacing，
    静音由相邻词边界差推得(prev_end → start)。
    """
    phrases: list[dict] = []
    cur: list[dict] = []
    cur_start: float | None = None
    cur_speaker: str | None = None
    prev_end: float | None = None

    def flush() -> None:
        nonlocal cur, cur_start, cur_speaker
        if not cur:
            return
        parts: list[str] = []
        for w in cur:
            raw = (w.get("text") or "").strip()
            if not raw:
                continue
            if w.get("type") == "audio_event" and not raw.startswith("("):
                raw = f"({raw})"
            parts.append(raw)
        if parts:
            text = " ".join(parts)
            text = text.replace(" ,", ",").replace(" .", ".").replace(" ?", "?").replace(" !", "!")
            phrases.append({
                "start": cur_start,
                "end": cur[-1].get("end", cur[-1].get("start", cur_start or 0.0)),
                "text": text,
                "speaker_id": cur_speaker,
            })
        cur, cur_start, cur_speaker = [], None, None

    for w in words:
        if w.get("type") == "spacing":
            s, e = w.get("start"), w.get("end")
            if s is not None and e is not None and e - s >= silence_threshold:
                flush()
                prev_end = None
            continue
        start = w.get("start")
        if start is None:
            continue
        speaker = w.get("speaker_id")
        if cur_speaker is not None and speaker is not None and speaker != cur_speaker:
            flush()
            prev_end = None
        if prev_end is not None and start - prev_end >= silence_threshold:
            flush()
        if cur_start is None:
            cur_start = start
            cur_speaker = speaker
        cur.append(w)
        prev_end = w.get("end", start)
    flush()
    return phrases


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
