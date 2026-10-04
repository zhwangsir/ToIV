"""古风(ancient_realistic)服装 spec:中文→加权英文 tag、去雨衣措辞、spec 色门禁。

沈青禾(江南医女,~20,青色衣裙,木簪,油纸伞)曾出黑袍金边金发饰。
"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as cs

_QING_SPEC = "沈青禾，江南医女，约20岁，青色衣裙，木簪，油纸伞"


def _meta(desc: str = _QING_SPEC, style: str = "ancient_realistic", **kw) -> cs.SheetMeta:
    return cs.SheetMeta(name="沈青禾", style=style, description=desc, **kw)


def _figure(robe, trim=None, size=(256, 384), bg=(38, 40, 46)) -> bytes:
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    d.rectangle([70, 40, 190, 360], fill=robe)
    if trim:
        d.rectangle([70, 120, 190, 132], fill=trim)
        d.rectangle([70, 330, 190, 345], fill=trim)
        d.rectangle([124, 120, 136, 360], fill=trim)
    d.rectangle([100, 50, 160, 110], fill=(220, 180, 150))
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_spec_extraction_qing_wooden_hairpin_umbrella():
    sp = cs.extract_ancient_costume_spec(_meta())
    assert [c["zh"] for c in sp["colors"]] == ["青"]
    assert sp["colors"][0]["hex"] == cs.ancient_spec_target_hex(_meta())
    assert "(wooden hairpin:1.2)" in sp["accessory_tags"]
    assert any("oil-paper umbrella" in t for t in sp["accessory_tags"])
    assert sp["black_gold"] is False


def test_hair_black_not_treated_as_garment_color():
    sp = cs.extract_ancient_costume_spec(_meta("黑发，青丝，青色长袍，金字招牌"))
    assert [c["en"] for c in sp["colors"]] == ["teal"]


def test_prompts_have_english_weighted_tags():
    p = cs.build_panel_prompts(_meta())
    for key in ("portrait", "front", "side", "back"):
        assert "(teal qingse ruqun dress:1.3)" in p[key], key
        assert "(wooden hairpin:1.2)" in p[key], key
        assert "oil-paper umbrella" in p[key], key
    assert "hair ornaments optional" not in p["front"]
    base = cs._character_base(_meta())
    assert "青色衣裙" not in base and "木簪" not in base
    assert ", 20," not in base


def test_ancient_prompts_have_no_raincoat_wording():
    p = cs.build_panel_prompts(_meta())
    for key, txt in p.items():
        low = txt.lower()
        assert "hooded raincoat" not in low, key
        assert "bare raincoat fabric" not in low, key
        assert "slate" not in low, key
    assert "identical teal ruqun dress style and color as main portrait" in p["front"]
    assert "oil-paper umbrella" in p["costume"]


def test_ancient_no_spec_front_has_no_raincoat_wording():
    p = cs.build_panel_prompts(_meta("江南女子，温柔"))
    assert "hooded raincoat" not in p["front"].lower()
    assert "hair ornaments optional" not in p["front"]


def test_anime_front_keeps_raincoat_wording():
    p = cs.build_panel_prompts(_meta("young woman, slate raincoat", style="anime"))
    assert "identical hooded raincoat style and color as main portrait" in p["front"]
    assert p["costume"].startswith(cs._COSTUME_FORCE)


def test_negative_black_gold_only_when_spec_color_not_black_gold():
    assert "gold trim" in cs.ancient_spec_negative(_meta())
    assert "black robe" in cs.ancient_spec_negative(_meta())
    assert cs.ancient_spec_negative(_meta("玄色衣袍，金簪")) == ""
    assert cs.ancient_spec_negative(_meta("江南女子，温柔")) == ""
    assert cs.ancient_spec_negative(_meta(style="anime")) == ""


def test_negative_ctx_applied_to_ancient_graph_only():
    tok = cs._ANCIENT_SPEC_NEG_CTX.set(cs.ancient_spec_negative(_meta()))
    try:
        assert "gold trim" in cs._with_ancient_spec_negative("blurry", "ancient_realistic")
        assert cs._with_ancient_spec_negative("blurry", "anime") == "blurry"
    finally:
        cs._ANCIENT_SPEC_NEG_CTX.reset(tok)
    assert cs._with_ancient_spec_negative("blurry", "ancient_realistic") == "blurry"


def test_costume_items_follow_spec():
    items_t = cs.ancient_costume_items(_meta())
    assert [k for k, _ in items_t] == [k for k, _ in cs._COSTUME_ITEMS_ANCIENT]
    items = dict(items_t)
    assert "jet black" not in items["beizi"] and "gold trim and gold" not in items["beizi"]
    assert "teal" in items["beizi"]
    assert "wooden hairpin" in items["hairpin"]
    assert "oil-paper umbrella" in items["fan"]
    assert cs.ancient_costume_items(_meta("江南女子，温柔")) == cs._COSTUME_ITEMS_ANCIENT


def test_gate_rejects_black_gold_image():
    data = _figure((22, 22, 26), trim=(212, 175, 55))
    with pytest.raises(cs.CharacterSheetError) as ei:
        cs.assert_garment_near_spec_color(data, cs.ancient_spec_target_hex(_meta()), label="主立绘")
    assert "颜色门禁" in str(ei.value)


def test_gate_rejects_gold_dominant_image():
    with pytest.raises(cs.CharacterSheetError):
        cs.assert_garment_near_spec_color(_figure((150, 110, 30)), cs.ancient_spec_target_hex(_meta()))


@pytest.mark.parametrize("robe", [(40, 140, 140), (60, 160, 150), (30, 110, 125)])
def test_gate_accepts_teal_image(robe):
    st = cs.assert_garment_near_spec_color(_figure(robe), cs.ancient_spec_target_hex(_meta()))
    assert st["near_frac"] >= cs.SPEC_COLOR_MIN_NEAR_FRAC


def test_no_color_spec_does_not_gate():
    assert cs.ancient_spec_target_hex(_meta("江南女子，温柔，油纸伞")) is None
    assert cs.ancient_spec_target_hex(_meta(style="anime")) is None


def test_design_notes_use_spec_colors():
    notes = cs.build_design_notes(_meta())
    assert "深底金字" not in notes
    assert "青" in notes and "木簪" in notes
    assert "便利店员" not in notes
    assert "深底金字" not in cs.build_design_notes(_meta("江南女子，温柔"))


def test_palette_uses_spec_color_no_gold():
    m = _meta(colors=["#E8C4A8", "#D4AF37", "#1A1A1E", "#C9A227"])
    out = cs.ancient_spec_palette(m, list(m.colors))
    assert out[:2] == ["#E8C4A8", cs.ancient_spec_target_hex(m)]
    assert "#D4AF37" not in out and "#C9A227" not in out and "#1A1A1E" in out
    keep = cs.ancient_spec_palette(_meta("玄色衣袍，金簪"), ["#D4AF37"])
    assert "#D4AF37" in keep
    assert cs.ancient_spec_palette(_meta("江南女子"), ["#D4AF37"]) == ["#D4AF37"]
