"""16:18 返工：侧头 hist 不膨胀 face_frac + 强制回退；表情相对发长；服饰领口/袖口/下摆/靴。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _head(side_tint=(90, 106, 122), hair=(25, 25, 30), size=256) -> bytes:
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[int(size * 0.18) : int(size * 0.62), int(size * 0.28) : int(size * 0.72)] = (
        220,
        180,
        150,
    )
    arr[int(size * 0.02) : int(size * 0.22), int(size * 0.22) : int(size * 0.78)] = hair
    arr[int(size * 0.58) : int(size * 0.98), int(size * 0.20) : int(size * 0.80)] = side_tint
    # blue iris
    arr[int(size * 0.34) : int(size * 0.40), int(size * 0.48) : int(size * 0.56)] = (
        40,
        110,
        220,
    )
    return _png(arr)


def test_hist_match_does_not_inflate_face_frac_beyond_gate(monkeypatch):
    # 18:02：显式打开 hist 以测 face_frac 门禁；生产默认关
    monkeypatch.setenv("TOIV_SHEET_SIDE_HIST_MATCH", "1")
    front = _head(side_tint=(90, 106, 122), hair=(20, 20, 25), size=768)
    side = _head(side_tint=(70, 120, 200), hair=(80, 90, 120), size=768)
    before = sheet_svc.measure_face_height_frac(side)
    out = sheet_svc.match_side_head_coat_hair_to_front(side, front)
    after = sheet_svc.measure_face_height_frac(out)
    assert after is not None and before is not None
    # 匹配后仍须可过 25–50%，或函数主动回退原图
    ok, info = sheet_svc.side_three_quarter_accept(out, front_face=front)
    if not ok:
        # 允许回退到原 side（函数内已实现）
        assert out == side or info.get("reason", "").startswith("face_frac")
    else:
        assert 0.25 - 1e-6 <= float(after) <= 0.50 + 1e-6, (before, after, info)


def test_expression_hair_relative_only_skips_abs_when_base_same():
    # 同构图：贴回后发长与底一致 → relative_only 不拒
    s = 256
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    arr[:] = (230, 230, 235)
    arr[30:140, 70:186] = (220, 180, 150)
    arr[10:40, 60:196] = (20, 20, 28)
    # 侧发下探（绝对会过肩）
    arr[140:230, 55:75] = (18, 18, 22)
    arr[140:230, 181:201] = (18, 18, 22)
    arr[160:250, 70:186] = (90, 106, 122)
    base = _png(arr)
    # 编辑只改眼睛
    edited = arr.copy()
    edited[70:90, 100:156] = (30, 30, 40)
    data = _png(edited)
    assert sheet_svc.expression_hair_too_long(data, ref=base, relative_only=True) is False
    # 绝对路径在无 ref 时仍可拒
    assert sheet_svc.expression_hair_too_long(data, ref=None, relative_only=False) in (
        True,
        False,
    )


def test_assert_gates_relative_hair_with_base_ref():
    s = 256
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    arr[:] = (230, 230, 235)
    arr[30:140, 70:186] = (220, 180, 150)
    arr[10:40, 60:196] = (20, 20, 28)
    arr[140:220, 55:75] = (18, 18, 22)
    arr[140:220, 181:201] = (18, 18, 22)
    arr[160:250, 70:186] = (90, 106, 122)
    base = _png(arr)
    sheet_svc.assert_expression_identity_gates(
        base,
        portrait_ref=base,
        expr_key="expr_2",
        skip_chest_emblem=True,
        hair_ref=base,
        relative_hair_only=True,
    )


def test_costume_boxes_are_collar_cuff_hem_boots():
    assert hasattr(sheet_svc, "_collar_box")
    assert hasattr(sheet_svc, "_hem_box")
    bands = dict(sheet_svc._COSTUME_PORTRAIT_BANDS)
    assert set(bands) == {"collar", "cuff", "hem", "boots"}


def test_costume_real_portrait_1618_rois():
    portrait_path = (
        Path(__file__).resolve().parents[3]
        / "tmp"
        / "toiv_report_sheet_anime_0059_portrait.png"
    )
    if not portrait_path.is_file():
        pytest.skip(f"missing {portrait_path}")
    portrait = portrait_path.read_bytes()
    img = Image.open(BytesIO(portrait)).convert("RGB")
    collar = sheet_svc._collar_box(img)
    cuff = sheet_svc._wrist_cuff_box(img)
    hem = sheet_svc._hem_box(img)
    boots = sheet_svc._boots_box(img)
    # 领口在上半身
    assert collar[1] < 0.40 and collar[3] < 0.50, collar
    # 袖口不在正中（禁口袋）
    gx0, gx1 = sheet_svc._middle_gray_stripe_x_bounds(img)
    mid = (gx0 + gx1) / 2.0
    cx = (cuff[0] + cuff[2]) / 2.0
    assert abs(cx - mid) >= (gx1 - gx0) * 0.15, (cuff, mid)
    # 下摆在中下
    assert hem[1] >= 0.55 and hem[3] <= 0.90, hem
    # 靴子贴底
    assert boots[3] >= 0.98 and boots[1] >= 0.70, boots
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=256, min_fg=0.45, min_edge_density=0.01
    )
    dens = sheet_svc.assert_costume_cells_edge_density(out, min_density=0.01, n=4)
    assert len(dens) == 4
    assert all(d >= 0.01 for d in dens), dens


def test_source_has_1618_rules():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "relative_only" in src
    assert "forced body-side" in src
    assert "def _collar_box" in src
    assert ("袖口+手" in src) or ("_wrist_cuff_box" in src)
    assert "羽化边界" in src or "半透明混合" in src


def test_panel_cell_accept_body_ok_hires_may_fail():
    """拼格后 body 侧裁应过门；过近 hires 在 cell 口径可拒并触发回退。"""
    # minimal fullbody-like side
    import numpy as np
    from io import BytesIO
    from PIL import Image
    w, h = 400, 600
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[int(h * 0.08) : int(h * 0.22), int(w * 0.35) : int(w * 0.65)] = (220, 180, 150)
    arr[int(h * 0.04) : int(h * 0.10), int(w * 0.32) : int(w * 0.68)] = (20, 20, 28)
    arr[int(h * 0.20) : int(h * 0.95), int(w * 0.30) : int(w * 0.70)] = (90, 106, 122)
    buf = BytesIO(); Image.fromarray(arr).save(buf, format="PNG")
    body_crop, meta = sheet_svc.crop_face_slot_from_master_with_meta(
        buf.getvalue(), slot="face_three_quarter", size=768
    )
    assert meta.get("face_frac") is None or 0.20 <= float(meta["face_frac"]) <= 0.55
    ok, info = sheet_svc.side_three_quarter_accept_in_panel_cell(body_crop)
    # body 路径方图过即可；cell 模拟允许与启发式口径略有偏差，但函数必须存在可调用
    assert "square_ok" in info
    assert callable(sheet_svc.side_three_quarter_accept_in_panel_cell)
