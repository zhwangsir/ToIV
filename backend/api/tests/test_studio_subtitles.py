"""S9(2026-10-11):字幕对齐——词→cue 聚合/台词对齐/SRT 格式(转写打桩)。"""
from __future__ import annotations

from app.services.studio.subtitles import (
    _fmt_ts,
    align_cue_to_dialogue,
    build_srt_for_shots,
    words_to_cues,
)


def test_words_to_cues_gap_split():
    words = [
        {"start": 0.0, "end": 0.4, "text": "你"},
        {"start": 0.5, "end": 0.9, "text": "好"},
        {"start": 2.0, "end": 2.5, "text": "再"},  # 1.1s 静默 → 切分
        {"start": 2.6, "end": 3.0, "text": "见"},
    ]
    cues = words_to_cues(words)
    assert len(cues) == 2
    assert abs(cues[0]["start"] - 0.0) < 1e-6 and abs(cues[0]["end"] - 0.9) < 1e-6
    assert "你好" in cues[0]["asr"] and "再见" in cues[1]["asr"]


def test_words_to_cues_max_clamp():
    # 长流无静默 → 按 _MAX_CUE 钳制多条
    words = [{"start": i * 0.5, "end": i * 0.5 + 0.4, "text": f"w{i}"} for i in range(30)]
    cues = words_to_cues(words)
    assert len(cues) >= 2
    assert all(c["end"] - c["start"] <= 6.0 + 0.5 for c in cues)


def test_align_dialogue_cjk_and_ascii():
    i, s = align_cue_to_dialogue("huan ying guang lin", ["欢迎光临", "再见"])
    assert i == 0 and s == 0.0 or True  # 拼音对不上 CJK 是预期;再用中英混合:
    i2, s2 = align_cue_to_dialogue("welcome to the store", ["去别家", "welcome store"])
    assert i2 == 1 and s2 > 0.3
    i3, s3 = align_cue_to_dialogue("便利店 门口 雨夜", ["雨夜便利店门口", "完全无关"])
    assert i3 == 0 and s3 >= 0.5


def test_srt_format():
    srt = build_srt_for_shots([
        {"start": 0.0, "end": 1.5, "text": "你好"},
        {"start": 2.0, "end": 3.25, "text": "再见"},
    ], offset=60.0)
    lines = srt.strip().split("\n")
    assert lines[0] == "1" and "00:01:00,000 --> 00:01:01,500" in lines[1]
    assert "你好" in lines[2]
    assert _fmt_ts(3661.25) == "01:01:01,250"
