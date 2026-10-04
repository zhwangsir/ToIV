"""00:59 返工：侧面头高 25–50%+瞳色；遮罩外跳过徽标；服饰五格非空≥60%。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _side_master_fullbody(w: int = 832, h: int = 1216) -> bytes:
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    # body
    arr[int(h * 0.22) : int(h * 0.98), int(w * 0.30) : int(w * 0.70)] = (90, 106, 122)
    # head / face
    fy0, fy1 = int(h * 0.05), int(h * 0.20)
    fx0, fx1 = int(w * 0.38), int(w * 0.62)
    arr[fy0:fy1, fx0:fx1] = (220, 180, 150)
    arr[max(0, fy0 - 40) : fy0 + 15, fx0 - 15 : fx1 + 15] = (25, 25, 30)
    # blue iris blob
    ey = fy0 + int((fy1 - fy0) * 0.35)
    ex = fx0 + int((fx1 - fx0) * 0.55)
    arr[ey : ey + 10, ex : ex + 14] = (40, 110, 220)
    return _png(arr)


def _hires_eye_closeup_bad() -> bytes:
    """模拟不合格高分侧：几乎只有一只眼（脸高会 >50%）。"""
    s = 768
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    arr[:] = (230, 230, 235)
    arr[80:700, 60:700] = (220, 185, 155)
    arr[20:120, 40:720] = (20, 20, 28)
    # huge orange-blue eye dominating frame
    arr[250:450, 280:520] = (40, 90, 200)
    arr[250:350, 280:520] = (200, 120, 40)
    return _png(arr)


def _front_blue_eye() -> bytes:
    s = 768
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[120:520, 180:580] = (220, 180, 150)
    arr[60:160, 160:600] = (20, 20, 28)
    arr[250:290, 300:360] = (50, 120, 230)  # left blue
    arr[250:290, 420:480] = (50, 120, 230)  # right blue
    return _png(arr)


def test_side_crop_face_frac_in_25_50():
    master = _side_master_fullbody()
    out, meta = sheet_svc.crop_face_slot_from_master_with_meta(
        master, slot="face_three_quarter", size=768
    )
    assert Image.open(BytesIO(out)).size == (768, 768)
    frac = meta.get("face_frac")
    assert frac is not None, meta
    assert 0.25 - 1e-6 <= float(frac) <= 0.50 + 1e-6, meta
    assert meta.get("route") == "00:59_head_height_lanczos"
    assert meta.get("framing_ok") is True


def test_side_three_quarter_accept_rejects_eye_closeup():
    bad = _hires_eye_closeup_bad()
    ok, info = sheet_svc.side_three_quarter_accept(bad, front_face=_front_blue_eye())
    # either face too large or iris mismatch
    assert ok is False, info


def test_iris_hsv_mismatch_orange_vs_blue():
    front = _front_blue_eye()
    s = 768
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[120:520, 180:580] = (220, 180, 150)
    arr[60:160, 160:600] = (20, 20, 28)
    arr[250:300, 320:460] = (210, 120, 30)  # orange iris
    side = _png(arr)
    assert sheet_svc.iris_hsv_consistent(side, front) is False


def test_expression_exterior_unchanged_skips_emblem_gate():
    s = 256
    base = np.zeros((s, s, 3), dtype=np.uint8)
    base[:] = (200, 200, 205)
    base[40:180, 60:196] = (220, 180, 150)
    # plain chest
    base[180:250, 60:196] = (90, 106, 122)
    base_b = _png(base)
    # edited: only change eye region (inside feature mask), keep chest
    edited = base.copy()
    edited[70:110, 90:160] = (30, 30, 40)  # brows/eyes darker
    # plant a fake "badge" on chest of edited — but we'll composite with mask
    edited_raw = edited.copy()
    edited_raw[200:230, 110:150] = (220, 40, 40)  # chest badge in raw edit
    # local composite: exterior should restore base chest
    mask = sheet_svc.build_face_feature_mask(s).point(lambda v: 255 if v >= 96 else 0)
    from PIL import Image as I

    o = I.fromarray(base)
    e = I.fromarray(edited_raw)
    comp = I.composite(e, o, mask)
    buf = BytesIO()
    comp.save(buf, format="PNG")
    comp_b = buf.getvalue()
    assert sheet_svc.expression_mask_exterior_unchanged(base_b, comp_b, max_diff=0)
    # should NOT raise when skip_chest_emblem=True even if absolute emblem heuristic fires
    sheet_svc.assert_expression_identity_gates(
        comp_b, portrait_ref=base_b, expr_key="expr_1", skip_chest_emblem=True
    )


def test_costume_five_cells_nonempty_and_fg():
    """15:52 起改为四格；保留函数名兼容旧引用。"""
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (240, 240, 244)
    arr[int(h * 0.18) : int(h * 0.98), int(w * 0.22) : int(w * 0.78)] = (90, 106, 122)
    arr[int(h * 0.06) : int(h * 0.18), int(w * 0.36) : int(w * 0.64)] = (220, 180, 150)
    arr[int(h * 0.03) : int(h * 0.08), int(w * 0.34) : int(w * 0.66)] = (20, 20, 25)
    arr[int(h * 0.18) : int(h * 0.28), int(w * 0.30) : int(w * 0.70)] = (70, 82, 96)
    arr[int(h * 0.20) : int(h * 0.32), int(w * 0.49) : int(w * 0.51)] = (40, 40, 48)
    arr[int(h * 0.48) : int(h * 0.56), int(w * 0.18) : int(w * 0.26)] = (220, 180, 150)
    arr[int(h * 0.46) : int(h * 0.58), int(w * 0.16) : int(w * 0.22)] = (60, 70, 80)
    arr[int(h * 0.70) : int(h * 0.78), int(w * 0.28) : int(w * 0.72)] = (75, 88, 100)
    arr[int(h * 0.70) : int(h * 0.72), int(w * 0.30) : int(w * 0.70)] = (45, 45, 50)

    # 褶皱/缝线纹理（抬边缘密度）
    for yy in range(int(h * 0.60), int(h * 0.78), 6):
        arr[yy : yy + 2, int(w * 0.32) : int(w * 0.68)] = (55, 65, 75)
    for xx in range(int(w * 0.34), int(w * 0.66), 10):
        arr[int(h * 0.62) : int(h * 0.76), xx : xx + 2] = (50, 58, 68)
    arr[int(h * 0.78) : int(h * 0.96), int(w * 0.36) : int(w * 0.48)] = (40, 40, 45)
    arr[int(h * 0.78) : int(h * 0.96), int(w * 0.52) : int(w * 0.64)] = (40, 40, 45)
    portrait = _png(arr)
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=128, min_fg=0.45, min_edge_density=0.01
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=4)
    assert len(ratios) == 4
    assert all(r >= 0.12 for r in ratios), ratios
    bands = dict(sheet_svc._COSTUME_PORTRAIT_BANDS)
    assert bands["collar"][1] >= 0.15
    assert bands["collar"][3] <= bands["hem"][1] + 1e-9
    assert set(bands) == {"collar", "cuff", "hem", "boots"}
    im = Image.open(BytesIO(out)).convert("RGB")
    cell_w = im.size[0] // 4
    for i in range(4):
        cell = im.crop((i * cell_w, 0, (i + 1) * cell_w, im.size[1]))
        r = sheet_svc._costume_cell_fg_ratio(cell)
        assert r >= 0.20, (i, r)


def test_source_has_0059_rules():
    from pathlib import Path

    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "00:59_head_height_lanczos" in src
    assert "side_three_quarter_accept" in src
    assert "skip_chest_emblem" in src
    assert "expression_mask_exterior_unchanged" in src
    assert "iris_hsv_consistent" in src
    assert "_expr_grid_fallback" in src


def test_costume_real_portrait_0059_ratios():
    """01:16：对真实 0059 portrait 断言五格 ratio≥0.25，袖口框在灰条内，腿脚贴底。"""
    from pathlib import Path

    portrait_path = (
        Path(__file__).resolve().parents[3]
        / "tmp"
        / "toiv_report_sheet_anime_0059_portrait.png"
    )
    if not portrait_path.is_file():
        import pytest

        pytest.skip(f"missing real portrait {portrait_path}")
    portrait = portrait_path.read_bytes()
    img = Image.open(BytesIO(portrait)).convert("RGB")
    gx0, gx1 = sheet_svc._middle_gray_stripe_x_bounds(img)
    cuff = sheet_svc._wrist_cuff_box(img)
    legs = sheet_svc._legs_box(img)
    assert cuff[0] >= gx0 - 1e-6 and cuff[2] <= gx1 + 1e-6, (cuff, gx0, gx1)
    assert legs[0] >= gx0 - 1e-6 and legs[2] <= gx1 + 1e-6, (legs, gx0, gx1)
    assert legs[1] >= 0.75 and legs[3] >= 0.99, legs
    # 袖口不得落到左外框（旧 FAIL：x0≈0）
    assert cuff[0] >= 0.25, cuff
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=256, min_fg=0.50, min_edge_density=0.01
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=4)
    assert len(ratios) == 4
    assert all(r >= 0.25 for r in ratios), ratios
    im = Image.open(BytesIO(out)).convert("RGB")
    w, h = im.size
    cell_w = w // 4
    for i in range(4):
        cell = im.crop((i * cell_w, 0, (i + 1) * cell_w if i < 3 else w, h))
        top = cell.crop((0, 0, cell.size[0], max(1, cell.size[1] // 6)))
        r = sheet_svc._costume_cell_fg_ratio(top)
        assert r >= 0.08, (i, r, "large top blank")
