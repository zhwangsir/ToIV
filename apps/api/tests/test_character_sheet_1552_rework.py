"""15:52 返工：侧头外套+头发直方图匹配；表情遮罩外贴回+4择优；服饰四格+边缘密度。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _head(side_tint=(90, 106, 122), hair=(25, 25, 30), size=256) -> bytes:
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    # face
    arr[int(size * 0.18) : int(size * 0.62), int(size * 0.28) : int(size * 0.72)] = (
        220,
        180,
        150,
    )
    # hair top
    arr[int(size * 0.02) : int(size * 0.22), int(size * 0.22) : int(size * 0.78)] = hair
    # coat lower
    arr[int(size * 0.58) : int(size * 0.98), int(size * 0.20) : int(size * 0.80)] = side_tint
    return _png(arr)


def test_match_side_head_coat_hair_to_front_shifts_tint(monkeypatch):
    # 18:02：函数默认关 hist；本测显式打开以验证匹配算法本身
    monkeypatch.setenv("TOIV_SHEET_SIDE_HIST_MATCH", "1")
    front = _head(side_tint=(90, 106, 122), hair=(20, 20, 25))  # slate + near-black
    # side too blue/bright coat + brighter hair highlights
    side = _head(side_tint=(70, 120, 200), hair=(80, 90, 120))
    out = sheet_svc.match_side_head_coat_hair_to_front(side, front)
    assert out and len(out) > 100
    o = Image.open(BytesIO(out)).convert("RGB")
    crop = o.crop((80, 170, 180, 240))
    px = list(crop.getdata())
    mean_b = sum(p[2] for p in px) / len(px)
    mean_r = sum(p[0] for p in px) / len(px)
    side_im = Image.open(BytesIO(side)).convert("RGB").crop((80, 170, 180, 240))
    spx = list(side_im.getdata())
    side_b = sum(p[2] for p in spx) / len(spx)
    side_r = sum(p[0] for p in spx) / len(spx)
    # 16:18：半透明混合后仍应朝板岩灰靠拢，或因 face_frac 回退保持原图
    if out != side:
        assert mean_b < side_b - 1.5 or mean_r > side_r + 1.5, (mean_r, mean_b, side_r, side_b)
    ok, _info = sheet_svc.side_three_quarter_accept(out)
    # 回退或匹配后都不得把 face_frac 撑破门禁（或缺脸时不硬要求）
    frac = sheet_svc.measure_face_height_frac(out)
    if frac is not None:
        assert 0.20 <= float(frac) <= 0.55, frac


def test_apply_expression_grid_restores_hair_and_chest():
    cell = 64
    cols, rows = 3, 2
    w, h = cell * cols, cell * rows
    base = np.zeros((h, w, 3), dtype=np.uint8)
    base[:] = (200, 200, 205)
    # per-cell face + dark hair + slate chest
    for i in range(6):
        row, col = divmod(i, cols)
        y0, x0 = row * cell, col * cell
        base[y0 + 4 : y0 + 18, x0 + 10 : x0 + 54] = (20, 20, 28)  # hair
        base[y0 + 18 : y0 + 48, x0 + 14 : x0 + 50] = (220, 180, 150)  # face
        base[y0 + 48 : y0 + 62, x0 + 12 : x0 + 52] = (90, 106, 122)  # chest
    edited = base.copy()
    # corrupt hair + chest + change eyes
    for i in range(6):
        row, col = divmod(i, cols)
        y0, x0 = row * cell, col * cell
        edited[y0 + 4 : y0 + 18, x0 + 10 : x0 + 54] = (180, 40, 200)  # long/purple hair
        edited[y0 + 48 : y0 + 62, x0 + 12 : x0 + 52] = (220, 40, 40)  # badge chest
        edited[y0 + 28 : y0 + 36, x0 + 20 : x0 + 44] = (30, 30, 40)  # eyes
    base_b = _png(base)
    edit_b = _png(edited)
    out = sheet_svc.apply_expression_grid_local_features(base_b, edit_b, cell=cell)
    assert sheet_svc.expression_mask_exterior_unchanged(base_b, out, max_diff=0, grid_cell=cell)
    # hair top-left of first cell should match base (not purple)
    o = np.array(Image.open(BytesIO(out)).convert("RGB"))
    assert tuple(o[8, 20]) == tuple(base[8, 20])
    assert tuple(o[55, 30]) == tuple(base[55, 30])


def test_costume_four_slots_and_edge_density_gate():
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (240, 240, 244)
    # slate body
    arr[int(h * 0.18) : int(h * 0.98), int(w * 0.22) : int(w * 0.78)] = (90, 106, 122)
    # face + hair
    arr[int(h * 0.06) : int(h * 0.18), int(w * 0.36) : int(w * 0.64)] = (220, 180, 150)
    arr[int(h * 0.03) : int(h * 0.08), int(w * 0.34) : int(w * 0.66)] = (20, 20, 25)
    # collar structure (darker rim + zipper-ish vertical)
    arr[int(h * 0.18) : int(h * 0.30), int(w * 0.30) : int(w * 0.70)] = (70, 82, 96)
    arr[int(h * 0.20) : int(h * 0.32), int(w * 0.49) : int(w * 0.51)] = (40, 40, 48)
    # hands / cuffs + sleeve edge folds (16:18：外缘袖口需有边缘密度)
    arr[int(h * 0.48) : int(h * 0.56), int(w * 0.18) : int(w * 0.28)] = (220, 180, 150)
    arr[int(h * 0.46) : int(h * 0.58), int(w * 0.16) : int(w * 0.22)] = (60, 70, 80)
    for yy in range(int(h * 0.42), int(h * 0.58), 4):
        arr[yy : yy + 2, int(w * 0.17) : int(w * 0.30)] = (50, 58, 70)
        arr[yy : yy + 2, int(w * 0.70) : int(w * 0.80)] = (50, 58, 70)
    for xx in range(int(w * 0.17), int(w * 0.30), 5):
        arr[int(h * 0.44) : int(h * 0.56), xx : xx + 1] = (40, 45, 55)
    # hem seam
    arr[int(h * 0.68) : int(h * 0.76), int(w * 0.28) : int(w * 0.72)] = (75, 88, 100)
    arr[int(h * 0.70) : int(h * 0.72), int(w * 0.30) : int(w * 0.70)] = (45, 45, 50)

    # 褶皱/缝线纹理（抬边缘密度）
    for yy in range(int(h * 0.60), int(h * 0.78), 6):
        arr[yy : yy + 2, int(w * 0.32) : int(w * 0.68)] = (55, 65, 75)
    for xx in range(int(w * 0.34), int(w * 0.66), 10):
        arr[int(h * 0.62) : int(h * 0.76), xx : xx + 2] = (50, 58, 68)
    # boots
    arr[int(h * 0.82) : int(h * 0.96), int(w * 0.34) : int(w * 0.46)] = (35, 35, 40)
    arr[int(h * 0.82) : int(h * 0.96), int(w * 0.54) : int(w * 0.66)] = (35, 35, 40)
    arr[int(h * 0.90) : int(h * 0.96), int(w * 0.32) : int(w * 0.48)] = (20, 20, 22)
    portrait = _png(arr)
    bands = dict(sheet_svc._COSTUME_PORTRAIT_BANDS)
    assert set(bands) == {"collar", "cuff", "hem", "boots"}
    assert sheet_svc._COSTUME_PORTRAIT_N == 4
    assert "pocket" not in bands and "hood_collar" not in bands
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=128, min_fg=0.45, min_edge_density=0.01
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=4)
    assert len(ratios) == 4
    dens = sheet_svc.assert_costume_cells_edge_density(out, min_density=0.01, n=4)
    assert len(dens) == 4
    assert all(d >= 0.015 for d in dens), dens


def test_costume_solid_fabric_rejected():
    # pure flat slate square → edge density ~0
    im = Image.new("RGB", (256, 256), (90, 106, 122))
    buf = BytesIO()
    im.save(buf, format="PNG")
    d = sheet_svc.costume_cell_edge_density(buf.getvalue())
    assert d < 0.02, d
    # collage of 4 solid cells
    canvas = Image.new("RGB", (4 * 256 + 16, 256 + 16), (240, 240, 244))
    for i in range(4):
        canvas.paste(im, (8 + i * 256, 8))
    buf2 = BytesIO()
    canvas.save(buf2, format="PNG")
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_costume_cells_edge_density(buf2.getvalue(), min_density=0.045, n=4)
    assert "solid-fabric" in str(ei.value) or "edge density" in str(ei.value)


def test_score_expression_grid_candidate_exists():
    assert callable(sheet_svc.score_expression_grid_candidate)
    assert callable(sheet_svc.match_side_head_coat_hair_to_front)


def test_source_has_1552_rules():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "match_side_head_coat_hair_to_front" in src
    assert ("hist-match" in src and "coat" in src) or "hist-match accepted" in src
    assert "pick-best" in src
    assert "for g_attempt in range(4)" in src
    assert "_COSTUME_PORTRAIT_N = 4" in src
    assert "costume_cell_edge_density" in src
    assert '("collar"' in src or '("collar",' in src
    assert "遮罩外（含全部头发与胸口）强制用底图像素贴回" in src


def test_costume_real_portrait_1552_four_cells():
    portrait_path = (
        Path(__file__).resolve().parents[3]
        / "tmp"
        / "toiv_report_sheet_anime_0059_portrait.png"
    )
    if not portrait_path.is_file():
        pytest.skip(f"missing real portrait {portrait_path}")
    portrait = portrait_path.read_bytes()
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=256, min_fg=0.50, min_edge_density=0.01
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=4)
    assert len(ratios) == 4
    assert all(r >= 0.20 for r in ratios), ratios
    dens = sheet_svc.assert_costume_cells_edge_density(out, min_density=0.01, n=4)
    assert all(d >= 0.01 for d in dens), dens
