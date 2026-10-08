"""古风色板以 spec 为准 + 饰品(木簪/油纸伞)门禁与提示词加固。

10/05 沈青禾(江南医女,~20,青色衣裙,木簪,油纸伞):存量色板 ['#1A1A1E','#D4AF37','#8B7355','#E8C4A8'] 黑金,
与 spec 青色冲突 → 须重生成为青色;主立绘出现金属环形发饰、伞漂浮在头后。
"""
from __future__ import annotations

import colorsys
import logging
from io import BytesIO
from types import SimpleNamespace

from PIL import Image, ImageDraw

from app.services.studio import character_sheet as cs
from app.services.studio import pipeline_c_render as pcr

_QING_SPEC = "江南医女，约二十岁，青色衣裙，发髻插木簪，手持油纸伞；沉静聪慧"
_BLACK_GOLD = ["#1A1A1E", "#D4AF37", "#8B7355", "#E8C4A8"]


def _meta(desc: str = _QING_SPEC, style: str = "ancient_realistic", **kw) -> cs.SheetMeta:
    return cs.SheetMeta(name="沈青禾", style=style, description=desc, **kw)


def _hue_deg(hx: str) -> float:
    r, g, b = (int(hx[i : i + 2], 16) / 255.0 for i in (1, 3, 5))
    return colorsys.rgb_to_hsv(r, g, b)[0] * 360.0


def test_palette_from_spec_teal_wood_no_black_gold():
    pal = cs.ancient_palette_from_spec(_meta())
    assert pal[0] == cs.ANCIENT_SKIN_HEX
    assert pal[1] == cs.ancient_spec_target_hex(_meta())
    assert 160 <= _hue_deg(pal[1]) <= 200  # 青
    assert "#A0764A" in pal  # 木簪木色
    assert "#E6D8B8" in pal  # 油纸伞浅米
    assert cs.ANCIENT_HAIR_HEX in pal
    assert not any(cs._is_near_black_hex(c) for c in pal)
    assert not any(cs._is_near_gold_hex(c) for c in pal)
    assert len(pal) <= 6


def test_black_gold_stored_vs_teal_spec_regenerates_to_teal(caplog):
    caplog.set_level(logging.WARNING, logger=cs.logger.name)
    reasons = cs.ancient_palette_conflict_reasons(_meta(), _BLACK_GOLD)
    assert any(r.startswith("near_black") for r in reasons)
    assert any(r.startswith("near_gold") for r in reasons)
    assert any(r.startswith("no_color_near_spec") for r in reasons)
    out = cs.resolve_ancient_palette(_meta(), _BLACK_GOLD, source="test")
    assert out == cs.ancient_palette_from_spec(_meta())
    assert "#1A1A1E" not in out and "#D4AF37" not in out
    assert 160 <= _hue_deg(out[1]) <= 200
    assert any("ancient palette conflict" in r.message and "regenerated from spec" in r.message for r in caplog.records)


def test_compatible_stored_palette_kept():
    stored = ["#E8C4A8", "#3A8C8C", "#7FB3B0", "#E6D8B8"]
    assert cs.ancient_palette_conflict_reasons(_meta(), stored) == []
    out = cs.resolve_ancient_palette(_meta(), stored)
    assert out[:2] == ["#E8C4A8", "#3A8C8C"]
    assert "#7FB3B0" in out


def test_black_gold_spec_keeps_black_gold():
    m = _meta("玄色长袍，金簪，威严")
    assert cs.ancient_palette_conflict_reasons(m, _BLACK_GOLD) == []
    assert "#1A1A1E" in cs.resolve_ancient_palette(m, _BLACK_GOLD)


def test_no_spec_color_and_anime_untouched():
    assert cs.ancient_palette_conflict_reasons(_meta("江南女子，温柔"), _BLACK_GOLD) == []
    assert cs.resolve_ancient_palette(_meta(style="anime"), _BLACK_GOLD) == _BLACK_GOLD
    assert cs.ancient_palette_conflict_reasons(_meta(style="anime"), _BLACK_GOLD) == []


def test_video_palette_spec_wins_only_on_conflict(caplog):
    caplog.set_level(logging.WARNING, logger=cs.logger.name)
    ch = SimpleNamespace(name="沈青禾", description=_QING_SPEC, visual_prompt="")
    out = pcr._spec_wins_palette(ch, list(_BLACK_GOLD))
    assert out == cs.ancient_palette_from_spec(_meta())
    assert any("source=video_palette" in r.message for r in caplog.records)
    ok = ["#3A8C8C", "#E8C4A8", "#7FB3B0"]
    assert pcr._spec_wins_palette(ch, list(ok)) == ok  # 无冲突:原样不重排


def test_accessory_prompt_fix_wood_and_umbrella_in_hand():
    fx = cs.ancient_accessory_prompt_fix(_meta())
    assert fx["wooden_hairpin"] and fx["umbrella_in_hand"]
    p = cs.build_panel_prompts(_meta())
    assert "wooden hair stick" in p["portrait"]
    assert "held in her hand" in p["portrait"]
    assert "wooden hair stick" in p["front"]
    neg = cs.ancient_spec_negative(_meta())
    assert "gold hairpin" in neg and "brass hair ring" in neg
    assert "floating umbrella" in neg and "umbrella floating behind head" in neg
    assert "black robe" in neg  # 原黑金负向仍在


def test_accessory_fix_absent_for_anime_and_other_hairpins():
    assert cs.ancient_accessory_prompt_fix(_meta(style="anime"))["pos"] == ""
    fx = cs.ancient_accessory_prompt_fix(_meta("青色衣裙，金簪"))
    assert fx["wooden_hairpin"] is False
    assert "gold hairpin" not in cs.ancient_spec_negative(_meta("青色衣裙，金簪"))


def _head(ornament) -> bytes:
    im = Image.new("RGB", (400, 600), (90, 90, 96))
    d = ImageDraw.Draw(im)
    d.ellipse([140, 60, 260, 150], fill=(30, 26, 24))  # 发髻
    d.rectangle([150, 130, 250, 260], fill=(225, 185, 155))  # 脸
    d.rectangle([110, 260, 290, 600], fill=(58, 140, 140))  # 青衣
    d.ellipse([175, 70, 225, 110], fill=ornament)
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_hairpin_gate_gold_fails_wood_passes(monkeypatch):
    monkeypatch.setattr(cs, "_face_bbox_for_center", lambda im: (150, 130, 250, 260))
    import pytest

    with pytest.raises(cs.CharacterSheetError) as e:
        cs.assert_hairpin_not_gold(_head((212, 175, 55)), _meta())
    assert "木簪" in str(e.value)
    st = cs.assert_hairpin_not_gold(_head((140, 100, 62)), _meta())
    assert st["frac"] is not None and st["frac"] <= cs.HAIRPIN_GOLD_MAX_FRAC
    # 非木簪 spec / 无脸 → 放行
    assert cs.assert_hairpin_not_gold(_head((212, 175, 55)), _meta("青色衣裙，金簪")).get("skipped")
    monkeypatch.setattr(cs, "_face_bbox_for_center", lambda im: None)
    assert cs.assert_hairpin_not_gold(_head((212, 175, 55)), _meta())["frac"] is None


# ---------------------------------------------------------------------------
# run3:饰品 VLM 是/否判官(复用表情专项问答的 Qwen-VL 图与 JSON 解析)
# ---------------------------------------------------------------------------


def test_accessory_qa_prompt_only_for_applicable_spec():
    p = cs.build_ancient_accessory_qa_prompt(_meta())
    assert p and "WOODEN" in p and "floating" in p and '"q1"' in p
    assert cs.build_ancient_accessory_qa_prompt(_meta(style="anime")) is None
    assert cs.build_ancient_accessory_qa_prompt(_meta("青色衣裙，素净")) is None
    only_hairpin = cs.build_ancient_accessory_qa_prompt(_meta("青色衣裙，木簪"))
    assert "q2: Always answer true." in only_hairpin


def test_accessory_qa_verdict_reasons():
    m = _meta()
    assert cs.ancient_accessory_qa_verdict({"q1": True, "q2": True}, m) == []
    rs = cs.ancient_accessory_qa_verdict({"q1": False, "q2": False}, m)
    assert any("hairpin_not_wooden" in r for r in rs)
    assert any("umbrella_not_held" in r for r in rs)
    # 金簪 spec 不判木质
    assert cs.ancient_accessory_qa_verdict({"q1": False, "q2": True}, _meta("青色衣裙，金簪，油纸伞")) == []


def test_classify_accessory_qa_parses_vlm_and_flags_floating_umbrella(monkeypatch):
    import asyncio

    calls: dict = {}

    class FakeClient:
        def __init__(self, url, timeout=0):
            calls["url"] = url

        async def upload_image(self, data, name):
            return name

        async def queue_prompt(self, graph, client_id=None):
            calls["prompt"] = graph["2"]["inputs"].get("text") or graph["2"]["inputs"].get("custom_prompt")
            return "pid1"

        async def get_history(self, pid):
            return {pid: {"outputs": {"3": {"text": ['{"q1": true, "q2": false}']}}, "status": {}}}

    import app.comfy.client as cc

    monkeypatch.setattr(cc, "ComfyUIClient", FakeClient)
    monkeypatch.setattr(cs, "_assert_sheet_worker_allowed", lambda u: None)
    monkeypatch.setattr(cs, "_VLM_STICKY_BACKEND", None)
    out = asyncio.run(
        cs.classify_ancient_accessory_qa(b"png", meta=_meta(), worker_url="http://w:8262")
    )
    assert out["q1"] is True and out["q2"] is False
    assert out["reasons"] == ["umbrella_not_held(伞漂浮头后/未握在手)"]
    assert "WOODEN" in calls["prompt"]
    skipped = asyncio.run(
        cs.classify_ancient_accessory_qa(b"png", meta=_meta(style="anime"), worker_url="http://w:8262")
    )
    assert skipped["skipped"] is True
