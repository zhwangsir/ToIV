"""FU2 深化件 1:旧 edit_pack/edit_edl 契约收编到 services/media 单一源。

断言:剪点语义(词边界分级/吸附/pad/取用区间)与打包格式化只有一份实现,
edit_* 是兼容面(内部改调新实现),语义与 media.{cut_rules,packed_transcript,edl} 一致。
"""
from __future__ import annotations

from app.services import edit_edl as edl_mod
from app.services import edit_pack as ep
from app.services.media import cut_rules, edl as media_edl
from app.services.media import packed_transcript as pt

SPANS_SRC = [
    {"start": 1.0, "end": 1.4, "word": "别"},
    {"start": 2.0, "end": 2.6, "word": "跟着"},
    {"start": 3.0, "end": 3.2, "word": "我"},
    {"start": 4.0, "end": 4.3, "word": "快"},
    {"start": 4.5, "end": 4.8, "word": "跑"},   # 0.2s 间隙 → usable
    {"start": 5.0, "end": 5.3, "word": "啊"},
    {"start": 5.4, "end": 5.7, "word": "呀"},   # 0.1s 间隙 → unsafe
]
SPANS = cut_rules.word_spans(SPANS_SRC)


# ---------------------------------------------------------------- 单一源(身份)

def test_edit_edl_cut_primitives_are_media_single_source():
    """旧 edit_edl 的剪点原语必须就是 media.cut_rules 的同一份实现(删重复保单一源)。"""
    assert edl_mod.word_spans is cut_rules.word_spans
    assert edl_mod.classify_edge is cut_rules.classify_edge
    assert edl_mod.snap_range is cut_rules.snap_range
    assert edl_mod.clamp_pad is cut_rules.clamp_pad
    assert edl_mod.PAD_MIN == cut_rules.PAD_MIN and edl_mod.PAD_MAX == cut_rules.PAD_MAX
    assert edl_mod.SAFE_SILENCE == cut_rules.SAFE_SILENCE
    assert edl_mod.USABLE_SILENCE == cut_rules.USABLE_SILENCE
    assert edl_mod.PAD_IN_DEFAULT == cut_rules.DEFAULT_PAD_IN
    assert edl_mod.PAD_OUT_DEFAULT == cut_rules.DEFAULT_PAD_OUT


def test_edit_pack_format_helpers_are_media_single_source():
    """packed md 的时间/时长格式化只留在 media.packed_transcript。"""
    assert ep.format_time is pt.format_time
    assert ep.format_duration is pt.format_duration
    assert ep.SILENCE_THRESHOLD == pt.SILENCE_THRESHOLD


# ---------------------------------------------------------------- 剪点语义(新家)

def test_classify_edge_three_tier_lives_in_cut_rules():
    assert cut_rules.classify_edge(1.2, SPANS)[0] == "midword"
    assert cut_rules.classify_edge(1.7, SPANS) == ("clean", 0.6)
    assert cut_rules.classify_edge(2.8, SPANS) == ("clean", 0.4)   # 恰好 400ms
    assert cut_rules.classify_edge(4.4, SPANS)[0] == "usable"      # 150-400ms 告警
    assert cut_rules.classify_edge(5.35, SPANS)[0] == "unsafe"     # <150ms 不安全
    assert cut_rules.classify_edge(1.23, []) == ("clean", 0.0)     # 无语音素材


def test_materialize_bounds_snap_then_pad_in_cut_rules():
    # 与旧 edit_edl.materialize_range 同口径:吸附整词 + pad 外扩
    assert cut_rules.materialize_bounds(1.2, 2.3, SPANS) == (1.0 - 0.05, 2.6 + 0.08)
    r = edl_mod.EdlRange(source="t", start=1.2, end=2.3, pad_in=0.9)
    assert edl_mod.materialize_range(r, SPANS) == cut_rules.materialize_bounds(
        1.2, 2.3, SPANS, pad_in=0.9, pad_out=None)


def test_media_edl_item_materialize_matches_old_contract():
    """新 EDL 模型(EdlItem.materialize)与旧 EdlRange 取用区间同语义。"""
    item = media_edl.EdlItem(source="t", start=1.2, end=2.3)
    r = edl_mod.EdlRange(source="t", start=1.2, end=2.3)
    assert item.materialize(SPANS) == edl_mod.materialize_range(r, SPANS)
    item_p = media_edl.EdlItem(source="t", start=1.2, end=2.3)
    r_p = edl_mod.EdlRange(source="t", start=1.2, end=2.3, pad_in=0.9, pad_out=0.01)
    assert item_p.materialize(SPANS, pad_in=0.9, pad_out=0.01) == edl_mod.materialize_range(r_p, SPANS)


# ---------------------------------------------------------------- edit_pack 收编

def _w(start, end, text, speaker=None):
    d = {"word": text, "start": start, "end": end}
    if speaker:
        d["speaker_id"] = speaker
    return d


def test_edit_pack_phrases_match_media_grouping():
    """旧 group_into_phrases = media.group_words 的键适配(语义统一到新实现)。"""
    words = ep.normalize_words([
        _w(0.0, 0.4, "甲一", speaker="speaker_0"), _w(0.5, 0.9, "甲二", speaker="speaker_0"),
        _w(2.0, 2.4, "甲三", speaker="speaker_0"),
        _w(2.5, 2.9, "乙一", speaker="speaker_1"),
    ])
    ph = ep.group_into_phrases(words)
    segs = pt.group_words([{"text": w["text"], "start": w["start"], "end": w["end"],
                            **({"speaker": w["speaker_id"]} if w.get("speaker_id") else {})}
                           for w in words])
    assert [(p["start"], p["end"], p["text"]) for p in ph] == \
           [(s["start"], s["end"], s["text"]) for s in segs]
    assert [p["speaker_id"] for p in ph] == ["speaker_0", "speaker_0", "speaker_1"]


def test_edit_pack_spacing_silence_still_breaks_phrase():
    """Scribe spacing 条目携带的静音断句:收编后由词边界差推得,语义不丢。"""
    words = ep.normalize_words([
        {"type": "word", "text": "你好", "start": 0.0, "end": 0.4},
        {"type": "spacing", "text": "", "start": 0.4, "end": 2.0},
        {"type": "word", "text": "世界", "start": 2.0, "end": 2.4},
    ])
    ph = ep.group_into_phrases(words)
    assert [p["text"] for p in ph] == ["你好", "世界"]


def test_edit_pack_audio_event_paren_wrapped():
    words = ep.normalize_words([
        {"type": "audio_event", "text": "door slam", "start": 0.0, "end": 0.5},
        {"type": "word", "text": "谁", "start": 0.6, "end": 0.9},
    ])
    ph = ep.group_into_phrases(words)
    assert ph[0]["text"] == "(door slam) 谁"
