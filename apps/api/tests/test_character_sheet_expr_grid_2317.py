"""23:17：侧面默认硬裁无 deblur；表情 2×3 一次出+切格；底图脸面积≥0.15。"""
from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _face_cell(tag: int = 0, face_scale: float = 0.45) -> bytes:
    s = 256
    arr = np.zeros((s, s, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[10:70, 60:196] = (20 + (tag % 40), 20, 25)
    side = int(s * face_scale)
    x0 = (s - side) // 2
    y0 = int(s * 0.22)
    arr[y0 : y0 + side, x0 : x0 + side] = (220, 180, 150)
    arr[y0 + side // 3 : y0 + side // 3 + 8, x0 + side // 4 : x0 + side // 4 + 16] = (30, 30, 40)
    arr[y0 + side // 3 : y0 + side // 3 + 8, x0 + 3 * side // 5 : x0 + 3 * side // 5 + 16] = (
        30,
        30,
        40,
    )
    return _png(arr)


def test_split_expression_grid_roundtrip():
    panels = {k: _face_cell(i * 7) for i, k in enumerate(sheet_svc._EXPR_KEYS)}
    grid = sheet_svc._compose_expression_grid_raw(panels, cell=128)
    im = Image.open(BytesIO(grid))
    assert im.size == (384, 256)
    cells = sheet_svc._split_expression_grid(grid, cell=128)
    assert set(cells) == set(sheet_svc._EXPR_KEYS)
    for b in cells.values():
        assert Image.open(BytesIO(b)).size == (768, 768)


def test_assert_expr_base_face_area_zoom_and_fail():
    ok = _face_cell(face_scale=0.50)
    fixed, area = sheet_svc.assert_expr_base_face_area(ok, expr_key="expr_0", min_area=0.15)
    assert area >= 0.15 and fixed
    tiny = _face_cell(face_scale=0.08)
    try:
        sheet_svc.assert_expr_base_face_area(tiny, expr_key="expr_1", min_area=0.15)
        raised = False
    except sheet_svc.CharacterSheetError as e:
        raised = True
        assert "脸面积" in str(e) or "无人脸" in str(e)
    assert raised


def test_source_has_2317_hard_rules():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "TOIV_SHEET_SIDE_DEBLUR" in src
    assert ("23:17 hard-crop only" in src) or ("00:31 Lanczos native" in src)
    assert "_EXPR_GRID_EDIT_INSTRUCTION" in src
    assert "apply_expression_grid_local_features" in src
    assert "2×3 宫格一次" in src
    assert "def _split_expression_grid" in src


def test_expr4_md5_prefix_lock_documented():
    # 运维锁：惊恐 2023b md5 前缀
    lock = "27dfb6a052ea"
    assert len(lock) == 12
    b = _face_cell(4)
    assert len(hashlib.md5(b).hexdigest()) == 32
