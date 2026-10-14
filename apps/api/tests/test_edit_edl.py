"""FU2 件 2+3:EDL 契约与词边界剪规硬规则(video-use MIT SKILL 硬规则 6/7)。"""
from __future__ import annotations

from app.services import edit_edl as edl_mod
from app.services.edit_edl import Edl, EdlRange

SPANS_SRC = [
    {"start": 1.0, "end": 1.4, "word": "别"},
    {"start": 2.0, "end": 2.6, "word": "跟着"},
    {"start": 3.0, "end": 3.2, "word": "我"},
    {"start": 4.0, "end": 4.3, "word": "快"},
    {"start": 4.5, "end": 4.8, "word": "跑"},   # 0.2s 间隙 → usable
    {"start": 5.0, "end": 5.3, "word": "啊"},
    {"start": 5.4, "end": 5.7, "word": "呀"},   # 0.1s 间隙 → unsafe
]
SPANS = edl_mod.word_spans(SPANS_SRC)


def test_classify_edge_buckets():
    assert edl_mod.classify_edge(1.2, SPANS)[0] == "midword"
    assert edl_mod.classify_edge(1.7, SPANS) == ("clean", 0.6)      # 0.6s 静音
    assert edl_mod.classify_edge(2.8, SPANS) == ("clean", 0.4)      # 恰好 400ms 算干净
    assert edl_mod.classify_edge(4.4, SPANS)[0] == "usable"         # 200ms
    assert edl_mod.classify_edge(5.35, SPANS)[0] == "unsafe"        # 100ms


def test_snap_expands_to_whole_words():
    assert edl_mod.snap_range(1.2, 2.3, SPANS) == (1.0, 2.6)
    assert edl_mod.snap_range(1.0, 2.6, SPANS) == (1.0, 2.6)  # 已在边界不动


def test_pad_clamped_to_working_window():
    assert edl_mod.clamp_pad(None, edl_mod.PAD_IN_DEFAULT) == 0.05
    assert edl_mod.clamp_pad(0.001, 0.05) == edl_mod.PAD_MIN
    assert edl_mod.clamp_pad(9.0, 0.05) == edl_mod.PAD_MAX


def test_materialize_snap_then_pad():
    r = EdlRange(source="t", start=1.2, end=2.3)
    assert edl_mod.materialize_range(r, SPANS) == (1.0 - 0.05, 2.6 + 0.08)


def test_validate_flags_midword_and_unknown_source():
    e = Edl(sources={"t": "x.mp4"},
            ranges=[EdlRange(source="t", start=1.2, end=2.3),
                    EdlRange(source="nope", start=0.0, end=1.0)])
    issues = edl_mod.validate_edl(e, {"t": SPANS_SRC})
    kinds = {(i["kind"], i.get("range")) for i in issues}
    assert ("midword_cut", 0) in kinds and ("unknown_source", 1) in kinds
    assert sum(1 for i in issues if i["kind"] == "midword_cut") == 2  # start+end 都词内


def test_validate_clean_edges_produce_no_violations():
    e = Edl(sources={"t": "x.mp4"},
            ranges=[EdlRange(source="t", start=1.7, end=2.8)])  # 两端都在 600/400ms 静音
    issues = edl_mod.validate_edl(e, {"t": SPANS_SRC})
    assert [i["kind"] for i in issues] == []


def test_validate_usable_gap_is_warning_not_blocker():
    e = Edl(sources={"t": "x.mp4"},
            ranges=[EdlRange(source="t", start=4.4, end=4.4 + 0.0)])  # end<=start 另判
    e.ranges[0].end = 4.9
    kinds = {i["kind"] for i in edl_mod.validate_edl(e, {"t": SPANS_SRC})}
    assert "needs_visual_check" in kinds and "midword_cut" not in kinds


def test_validate_pad_out_of_window_reported_but_clamped_at_render():
    r = EdlRange(source="t", start=1.7, end=2.8, pad_in=0.9)
    e = Edl(sources={"t": "x.mp4"}, ranges=[r])
    kinds = {i["kind"] for i in edl_mod.validate_edl(e, {"t": SPANS_SRC})}
    assert "pad_out_of_window" in kinds
    assert edl_mod.materialize_range(r, SPANS)[0] == 1.7 - edl_mod.PAD_MAX
