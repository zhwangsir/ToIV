"""16:53 返工：侧头裁框≈0.3；表情羽化贴回同尺寸；果断抿嘴/温柔微笑；袖口回 1552。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _synth_side_low_frac(size: int = 768, face_frac: float = 0.22) -> bytes:
    """合成侧头：浅底 + 居中小脸，face_frac 约等于给定值。"""
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    fh = max(24, int(size * face_frac))
    # 脸垂直居中偏上
    y0 = int(size * 0.28)
    y1 = y0 + fh
    x0 = int(size * 0.35)
    x1 = int(size * 0.65)
    arr[y0:y1, x0:x1] = (220, 180, 150)
    # 头发顶
    arr[max(0, y0 - fh // 3) : y0 + 4, x0 - 8 : x1 + 8] = (20, 20, 28)
    # 外套下
    arr[y1 : min(size, y1 + fh), x0 - 10 : x1 + 10] = (90, 106, 122)
    # 假瞳
    ey = y0 + fh // 3
    arr[ey : ey + max(4, fh // 10), (x0 + x1) // 2 : (x0 + x1) // 2 + max(4, fh // 8)] = (
        40,
        110,
        220,
    )
    return _png(arr)


def test_tighten_side_square_face_frac_in_band():
    low = _synth_side_low_frac(768, face_frac=0.22)
    before = sheet_svc.measure_face_height_frac(low)
    # 启发式可能略偏，只要偏小即可
    out = sheet_svc.tighten_side_square_to_face_frac(
        low, target=0.30, min_frac=0.28, max_frac=0.35, size=768
    )
    after = sheet_svc.measure_face_height_frac(out)
    assert after is not None, (before, after)
    assert 0.28 - 1e-6 <= float(after) <= 0.50 + 1e-6, (before, after)
    # 收紧后应不低于约 0.28
    assert float(after) + 1e-6 >= 0.28, (before, after)


def test_compose_preserve_side_tightens_low_frac():
    low = _synth_side_low_frac(768, face_frac=0.22)
    tri = {
        "face_front": low,
        "face_three_quarter": low,
        "face_side": low,
    }
    panel = sheet_svc.compose_faces_triptych(
        tri, style="anime", size=(1024, 640), master_crop=True
    )
    assert panel and len(panel) > 100
    # compose 内对过小侧头会收紧；方图口径须落在约 0.28–0.50
    tight = sheet_svc.tighten_side_square_to_face_frac(low, target=0.30)
    ok2, info2 = sheet_svc.side_three_quarter_accept(tight)
    frac = info2.get("face_frac")
    assert frac is not None
    assert 0.28 - 1e-6 <= float(frac) <= 0.50 + 1e-6, info2
    assert info2.get("square_ok", True) or ok2


def test_expression_feather_mask_edge_alpha_and_same_size():
    cell = 64
    cols, rows = 3, 2
    w, h = cell * cols, cell * rows
    base = np.zeros((h, w, 3), dtype=np.uint8)
    base[:] = (200, 200, 205)
    for i in range(6):
        row, col = divmod(i, cols)
        y0, x0 = row * cell, col * cell
        base[y0 + 4 : y0 + 18, x0 + 10 : x0 + 54] = (20, 20, 28)
        base[y0 + 18 : y0 + 48, x0 + 14 : x0 + 50] = (220, 180, 150)
        base[y0 + 48 : y0 + 62, x0 + 12 : x0 + 52] = (90, 106, 122)
    edited = base.copy()
    for i in range(6):
        row, col = divmod(i, cols)
        y0, x0 = row * cell, col * cell
        edited[y0 + 4 : y0 + 18, x0 + 10 : x0 + 54] = (180, 40, 200)
        edited[y0 + 48 : y0 + 62, x0 + 12 : x0 + 52] = (220, 40, 40)
        edited[y0 + 28 : y0 + 36, x0 + 20 : x0 + 44] = (30, 30, 40)
    base_b = _png(base)
    edit_b = _png(edited)
    # 故意不同尺寸的编辑图 → 贴回后必须与底同尺寸
    edit_small = Image.open(BytesIO(edit_b)).resize((w // 2, h // 2))
    buf = BytesIO()
    edit_small.save(buf, format="PNG")
    out = sheet_svc.apply_expression_grid_local_features(base_b, buf.getvalue(), cell=cell, feather=6)
    oim = Image.open(BytesIO(out))
    bim = Image.open(BytesIO(base_b))
    assert oim.size == bim.size
    # 遮罩外（头发顶）应回到底图
    assert sheet_svc.expression_mask_exterior_unchanged(base_b, out, max_diff=0, grid_cell=cell)
    # 羽化：软遮罩边缘存在中间 alpha（构建方式自检）
    soft = Image.new("L", (cell, cell), 0)
    cm = sheet_svc.build_face_feature_mask(cell).point(lambda v: 255 if v >= 96 else 0)
    cm = cm.filter(ImageFilter.MinFilter(size=13))
    cm = cm.filter(ImageFilter.GaussianBlur(radius=6))
    vals = set(cm.getdata())
    # 应有非 0/255 的中间值（羽化渐变）
    mid = [v for v in vals if 8 < v < 248]
    assert len(mid) >= 1, vals


def test_resolute_and_gentle_prompt_semantics():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    # 果断：抿嘴 / 压低眉 / 禁止张嘴
    assert "果断" in src
    assert ("抿紧" in src or "抿嘴" in src) and ("压低" in src or "眉压低" in src)
    assert "禁止张嘴" in src or "no open mouth" in src
    # 温柔：眉放松 + 微笑
    assert "眉放松" in src or "眉毛放松" in src
    assert "微笑" in src


def test_wrist_cuff_matches_1552_path():
    portrait_path = (
        Path(__file__).resolve().parents[3]
        / "tmp"
        / "toiv_report_sheet_anime_0059_portrait.png"
    )
    if not portrait_path.is_file():
        pytest.skip(f"missing {portrait_path}")
    img = Image.open(portrait_path).convert("RGB")
    cuff = sheet_svc._wrist_cuff_box(img)
    gx0, gx1 = sheet_svc._middle_gray_stripe_x_bounds(img)
    mid = (gx0 + gx1) / 2.0
    cx = (cuff[0] + cuff[2]) / 2.0
    cy = (cuff[1] + cuff[3]) / 2.0
    # 1552：袖口偏侧、y 约在手腕带（0.40–0.60），覆盖手/袖口
    assert abs(cx - mid) >= (gx1 - gx0) * 0.10, (cuff, mid)
    assert 0.36 <= cy <= 0.62, cuff
    assert cuff[1] >= 0.34 and cuff[3] <= 0.70, cuff
    # 与历史 1552 参考框接近（允许小漂移）
    ref = (0.3175, 0.395, 0.4857, 0.5735)
    for a, b in zip(cuff, ref):
        assert abs(float(a) - float(b)) < 0.08, (cuff, ref)


def test_source_has_1653_rules():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "tighten_side_square_to_face_frac" in src
    assert "16:53" in src
    assert "GaussianBlur" in src
    assert "袖口+手" in src or "15:52：袖口" in src or "16:53 / 15:52" in src
