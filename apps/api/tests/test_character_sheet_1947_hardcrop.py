"""19:47：脸格硬裁比例 + 服饰主立绘五局部。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _figure() -> bytes:
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (240, 240, 244)
    arr[int(h * 0.16) : int(h * 0.98), int(w * 0.18) : int(w * 0.82)] = (90, 106, 122)
    fy0, fy1 = int(h * 0.08), int(h * 0.22)
    fx0, fx1 = int(w * 0.38), int(w * 0.62)
    arr[fy0:fy1, fx0:fx1] = (220, 180, 150)
    arr[max(0, fy0 - 40) : fy0 + 10, fx0 - 10 : fx1 + 10] = (20, 20, 25)
    return _png(arr)


def test_hard_crop_same_size_and_min_head():
    portrait = _figure()
    tri = sheet_svc.build_faces_tri_from_masters(
        portrait=portrait, front=portrait, side=_figure(), back=_figure(), size=256
    )
    for k, b in tri.items():
        im = Image.open(BytesIO(b))
        assert im.size == (256, 256), (k, im.size)


def test_costume_from_portrait_five_cells():
    portrait = _figure()
    out = sheet_svc.build_costume_collage_from_portrait(portrait, style="anime", size=128)
    ratios = sheet_svc.costume_cell_content_ratios(out, n=5)
    assert len(ratios) == 5
    assert all(r >= 0.05 for r in ratios), ratios


def test_expr_edit_威严_果断_differ():
    a, b = sheet_svc._EXPR_EDIT_INSTRUCTIONS[0], sheet_svc._EXPR_EDIT_INSTRUCTIONS[5]
    assert "皱眉" in a or "抿" in a
    assert "侧" in b
    assert a != b
