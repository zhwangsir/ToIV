"""Packed Transcript:词级 ASR → 带 [start-end] 时间戳的短语级 markdown。

ported from video-use (MIT) — helpers/pack_transcripts.py
(MIT License, Copyright (c) 2026 Browser Use)。

改造点(对源实现):
  - 输入契约收敛为 whisper word_timestamps verbatim 口径 [{word,start,end,speaker?}]
    (可包一层 {words:[...]}),不再读 Scribe 的 spacing/audio_event 条目——
    静音信息一律由相邻词边界差(prev_end→start)推得;
  - 断句规则=静音阈值(默认 0.5s,同源)+换人断句(同源)+最大段长上限
    (max_segment_seconds,防单短语过长,词边界处断);
  - 输出为 pack 结构 PackedTranscript(segments=[{start,end,text,speaker?}]
    + to_markdown()),不再是写盘脚本。

用途:LLM 选片/剪辑决策的唯一文本面——1 小时素材约 12KB,
token 约为原始词级 JSON 的 1/10,且仅凭文本即有词边界精度。
"""
from __future__ import annotations

from dataclasses import dataclass, field

# 短语切分静音门槛(video-use 默认 0.5s)
SILENCE_THRESHOLD = 0.5
# 最大段长(秒):超限在词边界断句(源实现无此上限,ToIV 适配)
MAX_SEGMENT_SECONDS = 30.0


def format_time(seconds: float) -> str:
    """固定 6 字符宽的秒表示 "NNN.NN",便于对齐(video-use 原样)。"""
    return f"{seconds:06.2f}"


def format_duration(seconds: float) -> str:
    """格式化时长为 "Xs" 或 "Xm XXs"(video-use 原样)。"""
    if seconds < 60:
        return f"{seconds:.1f}s"
    m = int(seconds // 60)
    s = seconds - m * 60
    return f"{m}m {s:04.1f}s"


def _normalize_words(payload: list | dict) -> list[dict]:
    """归一成 [{text,start,end,speaker?}];兼容 {words:[...]} 包装与 text/speaker_id 别名。"""
    if isinstance(payload, dict):
        raw_words = payload.get("words") or []
    elif isinstance(payload, list):
        raw_words = payload
    else:
        raise ValueError("词级转写必须是 [{word,start,end,speaker?}] 或 {words:[...]}")
    out: list[dict] = []
    for w in raw_words:
        if not isinstance(w, dict):
            continue
        start = w.get("start")
        if start is None:
            continue
        text = w.get("word")
        if text is None:
            text = w.get("text") or ""
        speaker = w.get("speaker")
        if speaker is None:
            speaker = w.get("speaker_id")
        entry = {
            "text": str(text).strip(),
            "start": float(start),
            "end": float(w.get("end", start)),
        }
        if speaker is not None:
            entry["speaker"] = speaker
        out.append(entry)
    return out


def _join_text(parts: list[str]) -> str:
    text = " ".join(p for p in parts if p)
    return text.replace(" ,", ",").replace(" .", ".").replace(" ?", "?").replace(" !", "!")


def group_words(
    words: list[dict],
    *,
    silence_threshold: float = SILENCE_THRESHOLD,
    max_segment_seconds: float = MAX_SEGMENT_SECONDS,
) -> list[dict]:
    """按「静音 ≥ 阈值 或 换人 或 超最大段长」把归一词表切成短语段。

    返回 [{start,end,text,speaker?}];段文本由词表拼接并做标点贴靠清理。
    """
    segments: list[dict] = []
    cur: list[dict] = []
    cur_start: float | None = None
    cur_speaker = None
    prev_end: float | None = None

    def flush() -> None:
        nonlocal cur, cur_start, cur_speaker
        if not cur:
            return
        seg = {
            "start": cur_start,
            "end": cur[-1]["end"],
            "text": _join_text([w["text"] for w in cur]),
        }
        if cur_speaker is not None:
            seg["speaker"] = cur_speaker
        segments.append(seg)
        cur, cur_start, cur_speaker = [], None, None

    for w in words:
        start, end = w["start"], w["end"]
        speaker = w.get("speaker")
        if cur_speaker is not None and speaker is not None and speaker != cur_speaker:
            flush()
        if prev_end is not None and start - prev_end >= silence_threshold:
            flush()
        if cur and max_segment_seconds and end - cur_start > max_segment_seconds:
            flush()
        if cur_start is None:
            cur_start = start
            cur_speaker = speaker
        cur.append(w)
        prev_end = end
    flush()
    return segments


@dataclass
class PackedTranscript:
    """pack 结构:短语级 segments + markdown 序列化。"""

    segments: list[dict] = field(default_factory=list)
    silence_threshold: float = SILENCE_THRESHOLD

    def to_markdown(self) -> str:
        lines = [
            "# Packed transcript",
            "",
            f"Phrase-level, grouped on silences ≥ {self.silence_threshold:.1f}s or speaker change.",
            "Use [start-end] ranges to address cuts in the EDL.",
            "",
        ]
        for seg in self.segments:
            spk = seg.get("speaker")
            tag = ""
            if spk is not None:
                spk_str = str(spk)
                if spk_str.startswith("speaker_"):
                    spk_str = spk_str[len("speaker_"):]
                tag = f" S{spk_str}"
            lines.append(
                f"  [{format_time(seg['start'])}-{format_time(seg['end'])}]{tag} {seg['text']}"
            )
        return "\n".join(lines)


def pack_transcript(
    payload: list | dict,
    *,
    silence_threshold: float = SILENCE_THRESHOLD,
    max_segment_seconds: float = MAX_SEGMENT_SECONDS,
) -> PackedTranscript:
    """词级转写 JSON → pack 结构(断句 + to_markdown)。"""
    words = _normalize_words(payload)
    return PackedTranscript(
        segments=group_words(
            words,
            silence_threshold=silence_threshold,
            max_segment_seconds=max_segment_seconds,
        ),
        silence_threshold=silence_threshold,
    )
