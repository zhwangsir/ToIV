"""FU2 件 1:Packed Transcript(移植 video-use MIT,适配 whisper 词表形状)。"""
from __future__ import annotations

from app.services import edit_pack as ep


def _w(start, end, text, speaker=None):
    d = {"word": text, "start": start, "end": end}
    if speaker:
        d["speaker_id"] = speaker
    return d


def test_normalize_words_from_whisper_segments():
    payload = {"segments": [{"words": [_w(0.5, 0.9, "别"), _w(1.0, 1.4, "跟着")]}]}
    out = ep.normalize_words(payload)
    assert [(w["text"], w["start"], w["type"]) for w in out] == [("别", 0.5, "word"), ("跟着", 1.0, "word")]


def test_group_breaks_on_silence_and_speaker():
    words = ep.normalize_words([
        _w(0.0, 0.4, "甲一", speaker="speaker_0"), _w(0.5, 0.9, "甲二", speaker="speaker_0"),
        _w(2.0, 2.4, "甲三", speaker="speaker_0"),          # 1.1s 静音 → 断
        _w(2.5, 2.9, "乙一", speaker="speaker_1"),          # 换人 → 断
    ])
    ph = ep.group_into_phrases(words)
    assert [p["text"] for p in ph] == ["甲一 甲二", "甲三", "乙一"]
    assert ph[1]["start"] == 2.0 and ph[0]["speaker_id"] == "speaker_0"
    assert ph[2]["speaker_id"] == "speaker_1"


def test_group_keeps_short_gaps_inside_phrase():
    words = ep.normalize_words([_w(0.0, 0.4, "一"), _w(0.8, 1.2, "二")])  # 0.4s < 0.5
    ph = ep.group_into_phrases(words)
    assert len(ph) == 1 and ph[0]["text"] == "一 二"


def test_punctuation_cleanup_and_markdown_shape():
    words = ep.normalize_words([_w(0.0, 0.4, "你好 ,"), _w(0.5, 0.9, "世界 .")])
    md = ep.pack_takes([{"name": "take_a", "words": words}])
    assert "你好, 世界." in md
    assert "[000.00-000.90]" in md
    assert "## take_a" in md and "1 phrases" in md


def test_pack_empty_take_says_no_speech():
    md = ep.pack_takes([{"name": "silent", "words": []}])
    assert "_no speech detected_" in md
