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
    seq = iter([0.18, 0.20])

    def fake_measure(_data):
        try:
            return next(seq)
        except StopIteration:
            return 0.20

    monkeypatch.setattr(impl, "measure_face_height_frac", fake_measure)
    monkeypatch.setattr(impl, "panel_vertical_span", lambda _d: 0.5)
    monkeypatch.setattr(impl, "side_crop_upscale_factor", lambda *a, **k: 1.0)
    monkeypatch.setattr(impl, "_lanczos_to_square", lambda im, size: im.resize((size, size)))
    monkeypatch.setattr(impl, "_hair_center_x", lambda *a, **k: 256.0)

    with pytest.raises(CharacterSheetError) as ei:
        impl.crop_face_slot_from_master_with_meta(raw, slot="face_front", size=512)
    assert "face height frac" in str(ei.value).lower()


def test_expr_base_face_area_near_miss_soft_ok(monkeypatch):
    """F5o: 0.139 < 0.15 近失警告放行（≥0.12）。"""
    from app.services.studio.character_sheet import gates as g

    monkeypatch.setattr(g, "measure_face_area_frac", lambda _d: 0.139)
    monkeypatch.setattr(g, "_zoom_face_for_area", lambda data, **k: data)
    out, area = g.assert_expr_base_face_area(b"fake-png", expr_key="expr_0", min_area=0.15)
    assert out == b"fake-png"
    assert area == pytest.approx(0.139)


def test_expr_base_face_area_too_small_still_hard_fail(monkeypatch):
    from app.services.studio.character_sheet import gates as g

    monkeypatch.setattr(g, "measure_face_area_frac", lambda _d: 0.10)
    monkeypatch.setattr(g, "_zoom_face_for_area", lambda data, **k: data)
    with pytest.raises(CharacterSheetError) as ei:
        g.assert_expr_base_face_area(b"fake-png", expr_key="expr_0", min_area=0.15)
    assert "表情底脸面积" in str(ei.value)


def _skin_face_png(*, canvas: int = 512, face_frac: float = 0.16) -> bytes:
    """Synthetic skin-tone square face centered; area ≈ face_frac² for heuristic bbox."""
    import numpy as np
    from PIL import Image

    arr = np.zeros((canvas, canvas, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    side = max(8, int(canvas * face_frac))
    x0 = (canvas - side) // 2
    y0 = int(canvas * 0.22)
    arr[y0 : y0 + side, x0 : x0 + side] = (220, 180, 150)
    # crude eyes so detectors prefer face region
    ey = y0 + side // 3
    arr[ey : ey + 6, x0 + side // 4 : x0 + side // 4 + 12] = (30, 30, 40)
    arr[ey : ey + 6, x0 + 3 * side // 5 : x0 + 3 * side // 5 + 12] = (30, 30, 40)
    buf = BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def test_expr_base_face_area_f5p_small_face_zooms_up():
    """F5p: ~0.025 area (old zoom → ~0.081 hard-reject) must lift ≥0.12 without lowering soft_floor."""
    from app.services.studio.character_sheet import gates as g
    from app.services.studio.character_sheet import layout as lay

    # face_frac=0.16 → area≈0.0256; with min_scale=0.55 would land ~0.084
    raw = _skin_face_png(face_frac=0.16)
    before = g.measure_face_area_frac(raw)
    assert before is not None and before < 0.10, before
    # aggressive zoom alone should clear soft floor
    zoomed = lay._zoom_face_for_area(raw, target_area=0.18, min_scale=0.35)
    after_zoom = g.measure_face_area_frac(zoomed)
    assert after_zoom is not None and after_zoom + 1e-12 >= 0.12, after_zoom
    # full assert path (may soft-ok in [0.12, 0.15) or hard pass ≥0.15)
    fixed, area = g.assert_expr_base_face_area(raw, expr_key="expr_0", min_area=0.15)
    assert fixed and area + 1e-12 >= 0.12, area


def test_crop_face_ref_face_bbox_targets_larger_area():
    """Portrait with small head → crop_face_ref should yield face area ≫ geometric-only ~0.025."""
    from app.services.studio.character_sheet import gates as g
    from app.services.studio.character_sheet import layout as lay
    import numpy as np
    from PIL import Image

    # full-body-ish canvas: tiny face near top
    H, W = 1024, 576
    arr = np.zeros((H, W, 3), dtype=np.uint8)
    arr[:] = (230, 230, 235)
    fw = fh = 70
    x0, y0 = (W - fw) // 2, 40
    arr[y0 : y0 + fh, x0 : x0 + fw] = (220, 180, 150)
    arr[y0 + 20 : y0 + 26, x0 + 15 : x0 + 28] = (30, 30, 40)
    arr[y0 + 20 : y0 + 26, x0 + 42 : x0 + 55] = (30, 30, 40)
    buf = BytesIO()
    Image.fromarray(arr, mode="RGB").save(buf, format="PNG")
    portrait = buf.getvalue()
    cropped = lay.crop_face_ref(portrait, size=768)
    area = g.measure_face_area_frac(cropped)
    assert area is not None and area + 1e-12 >= 0.15, area  # post F5p tight crop


def test_zoom_min_scale_floor_documented():
    """Guard: default min_scale must stay ≤0.40 so F5p ~0.025 can clear 0.15."""
    import inspect
    from app.services.studio.character_sheet import layout as lay

    src = inspect.getsource(lay._zoom_face_for_area)
    assert "min_scale: float=0.35" in src or "min_scale=0.35" in src
    assert "0.55" not in src.split("scale = max")[1][:80]
