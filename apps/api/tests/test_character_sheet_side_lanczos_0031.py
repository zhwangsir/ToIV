"""00:31：侧面原分辨率 Lanczos；可选高分侧母版路径；表情眉眼嘴局部宫格。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _hires_side_master(w: int = 1600, h: int = 2200) -> bytes:
    """足够大的侧母版：头区原生边长 ≥768，Lanczos 应为缩小。"""
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    # 身体
    arr[int(h * 0.18) : int(h * 0.98), int(w * 0.30) : int(w * 0.70)] = (90, 106, 122)
    # 头（上带，大块肤色脸）
    fy0, fy1 = int(h * 0.04), int(h * 0.22)
    fx0, fx1 = int(w * 0.38), int(w * 0.62)
    arr[fy0:fy1, fx0:fx1] = (220, 180, 150)
    arr[max(0, fy0 - 50) : fy0 + 20, fx0 - 20 : fx1 + 20] = (20, 20, 25)
    # 眼鼻暗示
    arr[fy0 + 40 : fy0 + 55, fx0 + 20 : fx0 + 50] = (30, 30, 40)
    return _png(arr)


def _lowres_side_master() -> bytes:
    """模拟 832×1216：头区裁后需放大。"""
    return _hires_side_master(832, 1216)


def test_lanczos_native_downscale_on_hires_master():
    master = _hires_side_master()
    out, meta = sheet_svc.crop_face_slot_from_master_with_meta(
        master, slot="face_three_quarter", size=768
    )
    assert Image.open(BytesIO(out)).size == (768, 768)
    assert meta["native_side"] >= 768 - 1e-6
    assert meta["upscale"] <= 1.0 + 1e-6
    assert meta.get("route") in ("00:31_lanczos_native", "00:59_head_height_lanczos")
    assert meta["readable"] is True


def test_lowres_master_marked_unreadable_needs_hires():
    """00:59：头高扩框后低分母版可能变为缩小（readable）；仍须 framing 25–50%。

    另造极小头区母版，确保仍会标 unreadable 以触发高分侧。
    """
    master = _lowres_side_master()
    out, meta = sheet_svc.crop_face_slot_from_master_with_meta(
        master, slot="face_three_quarter", size=768
    )
    assert Image.open(BytesIO(out)).size == (768, 768)
    frac = meta.get("face_frac")
    if frac is not None:
        assert 0.25 - 1e-6 <= float(frac) <= 0.50 + 1e-6, meta
    # 极小画布：头区原生边长必然 <768/1.08
    tiny = _hires_side_master(320, 480)
    out2, meta2 = sheet_svc.crop_face_slot_from_master_with_meta(
        tiny, slot="face_three_quarter", size=768
    )
    assert Image.open(BytesIO(out2)).size == (768, 768)
    assert meta2["upscale"] > 1.08
    assert meta2["readable"] is False


def test_prepare_hires_side_head_init_square():
    master = _lowres_side_master()
    init = sheet_svc.prepare_hires_side_head_init(master, out_size=1280)
    assert Image.open(BytesIO(init)).size == (1280, 1280)


def test_expression_grid_local_feature_hard_mask():
    s = 128
    base_panels = {}
    for i, k in enumerate(sheet_svc._EXPR_KEYS):
        arr = np.zeros((s, s, 3), dtype=np.uint8)
        arr[:] = (200, 200, 205)
        arr[30:90, 30:90] = (220, 180, 150)
        base_panels[k] = _png(arr)
    grid = sheet_svc._compose_expression_grid_raw(base_panels, cell=s)
    # 编辑：整图涂红（若软贴回会满红；硬遮罩应只改眉眼嘴区）
    edit = Image.open(BytesIO(grid)).convert("RGB")
    edit.paste((255, 0, 0), (0, 0, edit.size[0], edit.size[1]))
    buf = BytesIO()
    edit.save(buf, format="PNG")
    merged = sheet_svc.apply_expression_grid_local_features(grid, buf.getvalue(), cell=s)
    im = Image.open(BytesIO(merged)).convert("RGB")
    # 角落（非五官）应接近底色而非纯红
    corner = im.getpixel((2, 2))
    assert corner[0] < 240, corner
    # 中心五官区应偏红
    cx, cy = s // 2, s // 2  # first cell center-ish in feature band
    center = im.getpixel((cx, int(s * 0.40)))
    assert center[0] > 200, center


def test_source_has_0031_rules():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert ("00:31_lanczos_native" in src or "00:59_head_height_lanczos" in src or "00:31：原分辨率裁头" in src or "00:59：按头高" in src)
    assert "regenerate_hires_side_head_master" in src
    assert "apply_expression_grid_local_features" in src
    assert "只改每一格的眉毛" in src
    assert "TOIV_SHEET_SIDE_DEBLUR" in src
    # 默认仍关 deblur
    assert 'os.environ.get("TOIV_SHEET_SIDE_DEBLUR"' in src
