"""FU2a 成片剪辑包并码测试:packed_transcript / edl / cut_rules。

覆盖:断句正确、markdown 快照含时间戳、EDL 校验拒绝越界/词内切、
pad 边界(30-200ms)、静音切点判定(≥400ms)、build_filter_graph 顺序、concat 模板结构。
"""
from __future__ import annotations

import json

import pytest

from app.services.media import cut_rules, edl, packed_transcript as pt


def _w(start, end, word, speaker=None):
    d = {"word": word, "start": start, "end": end}
    if speaker is not None:
        d["speaker"] = speaker
    return d


# ---------------------------------------------------------------- 断句

WORDS = [
    _w(0.0, 0.4, "别"),
    _w(0.5, 0.9, " 跟着"),
    _w(2.0, 2.4, " 他", speaker="speaker_0"),
    _w(2.5, 2.9, " 走", speaker="speaker_1"),
]


def test_group_breaks_on_silence_and_speaker():
    segs = pt.pack_transcript(WORDS).segments
    assert [s["text"] for s in segs] == ["别 跟着", "他", "走"]
    assert segs[0]["start"] == 0.0 and segs[0]["end"] == 0.9
    assert segs[1]["start"] == 2.0 and segs[1]["speaker"] == "speaker_0"
    assert segs[2]["speaker"] == "speaker_1"
    assert "speaker" not in segs[0]  # speaker? 可选:无说话人则省略


def test_group_keeps_short_gaps_inside_phrase():
    segs = pt.pack_transcript([_w(0.0, 0.4, "一"), _w(0.8, 1.2, "二")]).segments
    assert len(segs) == 1 and segs[0]["text"] == "一 二"


def test_group_breaks_on_max_segment_length_at_word_boundary():
    words = [_w(0.0, 0.5, "甲"), _w(0.6, 1.2, "乙"), _w(1.4, 2.2, "丙")]
    segs = pt.pack_transcript(words, max_segment_seconds=2.0).segments
    assert [s["text"] for s in segs] == ["甲 乙", "丙"]  # 丙 会把段撑到 2.2s > 2.0 → 词边界断


def test_pack_accepts_dict_payload():
    segs = pt.pack_transcript({"words": [_w(0.0, 0.4, "好")]}).segments
    assert segs == [{"start": 0.0, "end": 0.4, "text": "好"}]


# ---------------------------------------------------------------- markdown 快照

def test_markdown_snapshot_with_timestamps():
    md = pt.pack_transcript(WORDS).to_markdown()
    assert md == (
        "# Packed transcript\n"
        "\n"
        "Phrase-level, grouped on silences ≥ 0.5s or speaker change.\n"
        "Use [start-end] ranges to address cuts in the EDL.\n"
        "\n"
        "  [000.00-000.90] 别 跟着\n"
        "  [002.00-002.40] S0 他\n"
        "  [002.50-002.90] S1 走"
    )


def test_markdown_punctuation_cleanup():
    md = pt.pack_transcript([_w(0.0, 0.4, "你好 ,"), _w(0.5, 0.9, "世界 .")]).to_markdown()
    assert "你好, 世界." in md


# ---------------------------------------------------------------- EDL

def _edl(*items):
    return edl.Edl(items=[edl.EdlItem(*it) for it in items])


def test_edl_json_roundtrip():
    e = _edl(("a.mp4", 1.0, 2.0))
    e.items[0].beat, e.items[0].quote, e.items[0].reason = "b", "q", "r"
    payload = json.loads(e.to_json())
    assert payload == {"items": [
        {"source": "a.mp4", "start": 1.0, "end": 2.0, "beat": "b", "quote": "q", "reason": "r"},
    ]}
    assert edl.Edl.from_json(e.to_json()) == e


def test_edl_from_json_rejects_malformed():
    with pytest.raises(ValueError):
        edl.Edl.from_json("not json")
    with pytest.raises(ValueError):
        edl.Edl.from_json('{"items": 3}')
    with pytest.raises(ValueError):
        edl.Edl.from_json('{"items": [{"source": "a"}]}')  # 缺 start/end
    with pytest.raises(ValueError):
        edl.Edl.from_json('{"items": [{"source": "", "start": 0, "end": 1}]}')  # 空 source


def test_edl_validate_rejects_out_of_range():
    e = _edl(("a.mp4", 9.0, 11.0), ("a.mp4", -0.1, 1.0), ("a.mp4", 2.0, 1.0))
    issues = e.validate(source_durations={"a.mp4": 10.0})
    kinds = {i["kind"] for i in issues}
    assert "out_of_range" in kinds       # 11.0 > 10.0 区间越界
    assert "invalid_time" in kinds       # start < 0
    assert "empty_range" in kinds        # end <= start
    assert all(i["kind"] != "midword_cut" for i in issues)


def test_edl_validate_rejects_midword_cut():
    e = _edl(("a.mp4", 1.5, 3.0))  # start 落在词 (1.0, 2.0) 内
    issues = e.validate(words_by_source={"a.mp4": [{"word": "你", "start": 1.0, "end": 2.0}]})
    assert [i["kind"] for i in issues] == ["midword_cut"]
    assert issues[0]["edge"] == "start" and issues[0]["at"] == 1.5
    # 切边正好压在词边界上 = 合法
    assert _edl(("a.mp4", 2.0, 3.0)).validate(
        words_by_source={"a.mp4": [{"word": "你", "start": 1.0, "end": 2.0}]} ) == []


def test_edl_validate_frame_legality():
    e = _edl(("a.mp4", 1.0, 1.01))  # 30fps 下不足 1 帧
    issues = e.validate(fps=30.0)
    assert [i["kind"] for i in issues] == ["subframe_range"]
    assert _edl(("a.mp4", 1.0, 1.1)).validate(fps=30.0) == []
    with pytest.raises(ValueError):
        e.validate(fps=0)


# ---------------------------------------------------------------- cut_rules:pad

def test_pad_bounds_clamps_to_30_200ms():
    lo, hi = cut_rules.pad_bounds(1.0, 2.0, pad_in=0.005, pad_out=0.5)
    assert lo == pytest.approx(0.97)   # pad_in 夹到 30ms 下限
    assert hi == pytest.approx(2.20)   # pad_out 夹到 200ms 上限


def test_pad_bounds_respects_media_bounds():
    lo, hi = cut_rules.pad_bounds(0.05, 2.0, pad_in=0.2, pad_out=0.08, duration=2.02)
    assert lo == 0.0        # 不越出素材头
    assert hi == 2.02       # 不越出素材尾


# ---------------------------------------------------------------- cut_rules:静音切点

GAP_WORDS = [_w(0.0, 0.4, "甲"), _w(0.5, 0.9, "乙"), _w(2.0, 2.4, "丙")]


def test_silence_cut_point_needs_400ms():
    assert not cut_rules.is_safe_cut_point(0.45, GAP_WORDS)  # 0.4-0.5s 间隙仅 100ms
    assert cut_rules.is_safe_cut_point(1.45, GAP_WORDS)     # 0.9-2.0s 间隙 1.1s
    assert not cut_rules.is_safe_cut_point(0.2, GAP_WORDS)  # 词内
    assert cut_rules.is_safe_cut_point(0.9, GAP_WORDS)      # 词边界且处安全间隙内


def test_cut_points_only_in_safe_gaps():
    pts = cut_rules.cut_points(GAP_WORDS)
    assert pts == pytest.approx([1.45])  # 唯一 ≥400ms 间隙的中点
    for t in pts:
        assert cut_rules.is_safe_cut_point(t, GAP_WORDS)


# ---------------------------------------------------------------- cut_rules:ffmpeg 模板

def test_build_filter_graph_subtitles_burned_last():
    graph = cut_rules.build_filter_graph(
        scale="scale=1920:-2", grade="eq=contrast=1.03",
        subtitles="/edit/master.srt", subtitle_style="FontName=Helvetica,FontSize=18",
    )
    assert graph.startswith("scale=1920:-2,eq=contrast=1.03,subtitles=")  # 字幕滤镜在链尾
    assert graph.index("subtitles=") > graph.index("eq=")
    no_sub = cut_rules.build_filter_graph(grade="eq=contrast=1.03")
    assert "subtitles" not in no_sub


def test_build_filter_graph_escapes_special_chars():
    graph = cut_rules.build_filter_graph(subtitles="/tmp/a:b,c'.srt")
    # 转义后滤镜串内不再有裸的选项分隔符(: 与 ,)
    assert graph == "subtitles=filename=/tmp/a\\:b\\,c\\'.srt"
    assert cut_rules.escape_filter_value("x'y") == "x\\'y"
    assert cut_rules.escape_filter_value("a\\b") == "a\\\\b"


def test_concat_template_is_lossless_copy():
    argv = cut_rules.concat_command("out.mp4", list_file="segments.txt")
    assert argv[0] == "ffmpeg"
    assert argv[1:5] == ["-y", "-f", "concat", "-safe"]
    assert argv[6:9] == ["-i", "segments.txt", "-c"]
    assert argv[9] == "copy" and argv[10] == "out.mp4"  # 无损拼接:-c copy
    listing = cut_rules.concat_list_content(["seg_00.mp4", "seg_01.mp4"])
    assert listing.splitlines() == ["file 'seg_00.mp4'", "file 'seg_01.mp4'"]
    assert cut_rules.concat_list_line("a'b.mp4") == "file 'a'\\''b.mp4'"


def test_segment_extract_args_seek_before_input():
    argv = cut_rules.segment_extract_args("src.mp4", 1.0, 3.5, "seg.mp4")
    assert argv.index("-ss") < argv.index("-i")          # 快速精确 seek
    assert argv[argv.index("-ss") + 1] == "1.000"
    assert argv[argv.index("-t") + 1] == "2.500"
    af = argv[argv.index("-af") + 1]
    assert af.startswith("afade=t=in:st=0:d=0.03")       # 段边界 30ms 淡入淡出
