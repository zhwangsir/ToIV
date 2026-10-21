"""F5: 定妆门禁产品解阻 — windbreaker→slate 中和 + face_front 近失 soft-ok。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio.character_sheet import templates as tpl
from app.services.studio.character_sheet import _impl as impl
from app.services.studio.character_sheet.gates import CharacterSheetError


def test_character_base_neutralizes_black_windbreaker_to_slate():
    meta = tpl.SheetMeta(
        name="林夏",
        style="anime",
        visual_prompt="young East Asian woman Lin Xia, black windbreaker, wet hair",
        description="黑色冲锋衣，湿发贴额",
    )
    base = tpl._character_base(meta)
    low = base.lower()
    assert "black windbreaker" not in low
    assert "黑色冲锋衣" not in base
    assert "slate" in low
    assert "#5a6a7a" in low


def test_face_front_near_miss_soft_ok(monkeypatch):
    """0.30–0.35 近失不再硬拒（对齐 face_side soft-ok）。"""
    img = Image.new("RGB", (512, 768), (200, 200, 200))
    d = ImageDraw.Draw(img)
    d.ellipse((180, 40, 330, 220), fill=(220, 180, 150))
    buf = BytesIO()
    img.save(buf, format="PNG")
    raw = buf.getvalue()

    seq = iter([0.32, 0.324])

    def fake_measure(_data):
        try:
            return next(seq)
        except StopIteration:
            return 0.324

    monkeypatch.setattr(impl, "measure_face_height_frac", fake_measure)
    monkeypatch.setattr(impl, "panel_vertical_span", lambda _d: 0.5)
    monkeypatch.setattr(impl, "side_crop_upscale_factor", lambda *a, **k: 1.0)
    monkeypatch.setattr(impl, "_lanczos_to_square", lambda im, size: im.resize((size, size)))
    monkeypatch.setattr(impl, "_hair_center_x", lambda *a, **k: 256.0)

    out, meta = impl.crop_face_slot_from_master_with_meta(raw, slot="face_front", size=512)
    assert out
    assert meta.get("face_frac") == pytest.approx(0.324, abs=1e-6)
    assert meta.get("readable") is True


def test_face_front_too_small_still_hard_fail(monkeypatch):
    img = Image.new("RGB", (512, 768), (200, 200, 200))
    buf = BytesIO()
    img.save(buf, format="PNG")
    raw = buf.getvalue()
    seq = iter([0.20, 0.22])

    def fake_measure(_data):
        try:
            return next(seq)
        except StopIteration:
            return 0.22

    monkeypatch.setattr(impl, "measure_face_height_frac", fake_measure)
    monkeypatch.setattr(impl, "panel_vertical_span", lambda _d: 0.5)
    monkeypatch.setattr(impl, "side_crop_upscale_factor", lambda *a, **k: 1.0)
    monkeypatch.setattr(impl, "_lanczos_to_square", lambda im, size: im.resize((size, size)))
    monkeypatch.setattr(impl, "_hair_center_x", lambda *a, **k: 256.0)

    with pytest.raises(CharacterSheetError) as ei:
        impl.crop_face_slot_from_master_with_meta(raw, slot="face_front", size=512)
    assert "face height frac" in str(ei.value).lower()
