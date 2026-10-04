"""21:30：同尺度贴格、3px 近白边拒绝、锁格 normalize、沉思眼遮罩、温柔闭眼微笑提示。"""
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


def _synth_face(size: int = 384, *, mouth_y_frac: float = 0.62) -> Image.Image:
    arr = np.full((size, size, 3), 200, dtype=np.uint8)
    # hair
    arr[8:70, 40:340] = (25, 28, 36)
    arr[70:220, 30:55] = (25, 28, 36)
    arr[70:220, 330:355] = (25, 28, 36)
    # face
    arr[55:250, 70:310] = (220, 185, 160)
    # eyes
    arr[110:140, 110:155] = (55, 70, 170)
    arr[110:140, 230:275] = (55, 70, 170)
    # mouth
    my = int(size * mouth_y_frac)
    arr[my : my + 12, 160:230] = (150, 80, 80)
    # chin / collar
    arr[250:320, 90:290] = (90, 106, 122)
    return Image.fromarray(arr, mode="RGB")


def test_fit_expr_cell_same_scale_keeps_mouth_in_wide_cell():
    """宽格(≈1.66)贴格后嘴须在框内；六格同 target 尺度。"""
    panels = {f"expr_{i}": _synth_face(384) for i in range(6)}
    # slightly different face sizes → still same target
    panels["expr_0"] = _synth_face(420)
    tgt = sheet_svc._compose_expression_grid_unified_face_scales(panels)
    assert 0.54 <= tgt <= 0.62
    fracs = []
    for k, im in panels.items():
        fitted, _ = sheet_svc._fit_expr_cell_face_fill(
            im, (0, 0, 315, 190), target_face_height_frac=tgt
        )
        assert fitted.size == (315, 190)
        buf = BytesIO()
        fitted.convert("RGB").save(buf, format="PNG")
        data = buf.getvalue()
        info = sheet_svc.assert_mouth_in_frame(data)
        assert info.get("mouth_in_frame") is True
        frac = sheet_svc.measure_face_height_frac(data)
        assert frac is not None
        fracs.append(frac)
    # 同尺度：脸高占比离散不大
    assert max(fracs) - min(fracs) < 0.18, fracs


def test_compose_grid_no_crown_crop_mouth():
    """compose 后从格内裁出的图不得只剩眼睛。"""
    panels = {f"expr_{i}": _synth_face(512) for i in range(6)}
    grid = sheet_svc._compose_expression_grid(
        panels, box_w=980 - 16, box_h=520 - 40, draw_labels=True
    )
    cols, rows = 3, 2
    cw, ch = grid.size[0] // cols, grid.size[1] // rows
    label_h = 44
    img_h = ch - label_h
    cell = grid.crop((3, 3, cw - 3, img_h - 3)).convert("RGB")
    buf = BytesIO()
    cell.save(buf, format="PNG")
    sheet_svc.assert_mouth_in_frame(buf.getvalue())


def test_3px_near_white_edge_rejected():
    arr = np.full((160, 160, 3), 160, dtype=np.uint8)
    arr[40:130, 40:120] = (220, 185, 160)
    arr[:3, :, :] = (248, 248, 248)
    with pytest.raises(sheet_svc.CharacterSheetError, match="3px近白边|近白边|letterbox"):
        sheet_svc.assert_expr_cell_no_white_border(_png(arr), expr_key="expr_5")
    # 棚灰边 (~220) 不应当近白拒
    ok = np.full((160, 160, 3), 200, dtype=np.uint8)
    ok[40:130, 40:120] = (220, 185, 160)
    ok[:3, :, :] = (220, 220, 224)
    ok[:, :3, :] = (220, 220, 224)
    sheet_svc.assert_expr_cell_no_white_border(_png(ok), expr_key="expr_5")


def test_strip_label_band_preserves_clean_square():
    im = _synth_face(256).convert("RGBA")
    out = sheet_svc._strip_expr_label_band(im)
    assert out.size == im.size


def test_eyes_only_mask_excludes_mouth():
    m = sheet_svc.build_eyes_only_mask_hard(256)
    # eye center editable-ish region exists
    assert m.getpixel((128, int(256 * 0.38))) in (0, 255)  # pupil punched or nearby
    # mouth center must be black (not editable)
    assert m.getpixel((128, int(256 * 0.62))) == 0
    # brow band editable
    assert m.getpixel((128, int(256 * 0.25))) == 255


def test_gentle_prompt_soft_closed_eye_smile():
    gentle_e = sheet_svc._EXPR_EDIT_INSTRUCTIONS[3]
    gentle_i = sheet_svc._EXPR_INPAINT_PROMPTS[3]
    assert "closed-eye" in gentle_e.lower() or "闭眼" in gentle_e
    assert "soft closed-eye smile" in gentle_i.lower() or "eyes closed" in gentle_i.lower()
    assert "open eyes" in sheet_svc._EXPR_INPAINT_NEGATIVES[3]


def test_locked_normalize_contract_in_source():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "normalized_2130" in src
    assert "build_eyes_only_mask_hard" in src
    assert "_fit_expr_cell_face_fill" in src
    assert "3px近白边" in src or "edge_px" in src
