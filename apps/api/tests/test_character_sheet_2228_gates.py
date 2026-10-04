"""22:28：贴格脸高 0.55–0.65 硬门禁 + 温柔 VLM 微笑第二问 + 沉思侧面底图。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image | np.ndarray) -> bytes:
    if isinstance(img, np.ndarray):
        img = Image.fromarray(img.astype(np.uint8), mode="RGB")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _synth_face(size: int = 384, *, mouth_y_frac: float = 0.62) -> Image.Image:
    arr = np.full((size, size, 3), 200, dtype=np.uint8)
    arr[8:70, 40 : size - 40] = (25, 28, 36)
    arr[55 : int(size * 0.65), int(size * 0.18) : int(size * 0.82)] = (220, 185, 160)
    mid = size // 2
    arr[int(size * 0.32) : int(size * 0.40), mid - 60 : mid - 20] = (55, 70, 170)
    arr[int(size * 0.32) : int(size * 0.40), mid + 20 : mid + 60] = (55, 70, 170)
    my = int(size * mouth_y_frac)
    arr[my : my + 12, mid - 35 : mid + 35] = (150, 80, 80)
    arr[int(size * 0.65) : int(size * 0.85), int(size * 0.22) : int(size * 0.78)] = (
        90,
        106,
        122,
    )
    return Image.fromarray(arr, mode="RGB")


def test_assert_expr_cell_face_height_frac_rejects_oob():
    # tiny face → below 0.55
    tiny = Image.new("RGB", (256, 256), (200, 200, 204))
    d = ImageDraw.Draw(tiny)
    d.ellipse((100, 40, 156, 90), fill=(220, 185, 160))  # small face high up
    with pytest.raises(sheet_svc.CharacterSheetError, match="脸高|face_height"):
        sheet_svc.assert_expr_cell_face_height_frac(_png(tiny), expr_key="expr_0")
    # oversized face
    huge = Image.new("RGB", (256, 256), (200, 200, 204))
    d = ImageDraw.Draw(huge)
    d.ellipse((20, 5, 236, 250), fill=(220, 185, 160))
    with pytest.raises(sheet_svc.CharacterSheetError, match="脸高|face_height|越界"):
        sheet_svc.assert_expr_cell_face_height_frac(_png(huge), expr_key="expr_1")


def test_fit_wide_cell_face_height_in_0_55_0_65():
    """宽格贴格后脸高须落入 0.55–0.65（必要时棚灰垫边满足硬门禁）。"""
    im = _synth_face(512)
    fitted, _ = sheet_svc._fit_expr_cell_face_fill(
        im, (0, 0, 315, 190), target_face_height_frac=0.58
    )
    assert fitted.size == (315, 190)
    buf = BytesIO()
    fitted.convert("RGB").save(buf, format="PNG")
    info = sheet_svc.assert_expr_cell_face_height_frac(
        buf.getvalue(), expr_key="expr_0"
    )
    assert 0.55 <= info["face_height_frac"] <= 0.65


def test_compose_grid_asserts_face_height_gate():
    panels = {f"expr_{i}": _synth_face(512) for i in range(6)}
    grid = sheet_svc._compose_expression_grid(
        panels, box_w=980 - 16, box_h=520 - 40, draw_labels=True
    )
    cols, rows = 3, 2
    cw, ch = grid.size[0] // cols, grid.size[1] // rows
    label_h = 44
    img_h = ch - label_h
    for i in range(6):
        row, col = divmod(i, cols)
        cell = grid.crop(
            (
                col * cw + 3,
                row * ch + 3,
                col * cw + cw - 3,
                row * ch + img_h - 3,
            )
        ).convert("RGB")
        buf = BytesIO()
        cell.save(buf, format="PNG")
        sheet_svc.assert_expr_cell_face_height_frac(
            buf.getvalue(), expr_key=f"expr_{i}"
        )


def test_vlm_prompt_asks_smiling_second_question():
    p = sheet_svc._EXPR_VLM_PROMPT
    assert "smiling" in p.lower()
    assert "soft closed-eye smile" in p.lower() or "closed-eye smile" in p.lower()


def test_parse_vlm_smiling_yes_no():
    raw = (
        '{"label":"温柔","scores":{"威严":0,"冷酷":0,"沉思":0,"温柔":1,'
        '"惊恐":0,"果断":0},"smiling":true}'
    )
    parsed = sheet_svc._parse_vlm_expression_json(raw)
    assert parsed["label"] == "温柔"
    assert parsed["smiling"] is True

    raw_no = (
        '{"label":"温柔","scores":{"威严":0,"冷酷":0,"沉思":0,"温柔":1,'
        '"惊恐":0,"果断":0},"smiling":false}'
    )
    assert sheet_svc._parse_vlm_expression_json(raw_no)["smiling"] is False

    raw_cn = (
        '{"label":"温柔","scores":{"威严":0,"冷酷":0,"沉思":0,"温柔":1,'
        '"惊恐":0,"果断":0},"smiling":"是"}'
    )
    assert sheet_svc._parse_vlm_expression_json(raw_cn)["smiling"] is True


def test_gentle_vlm_requires_smiling_true():
    cell = _png(_synth_face(256))
    ok = {
        "label": "温柔",
        "scores": {
            "威严": 0.0,
            "冷酷": 0.0,
            "沉思": 0.0,
            "温柔": 1.0,
            "惊恐": 0.0,
            "果断": 0.0,
        },
        "smiling": True,
        "model": "mock",
    }
    info = sheet_svc.assert_expression_vlm_match(cell, "expr_3", ok)
    assert info["smiling"] is True

    bad = dict(ok, smiling=False)
    with pytest.raises(sheet_svc.CharacterSheetError, match="第二问|smiling"):
        sheet_svc.assert_expression_vlm_match(cell, "expr_3", bad)

    missing = {k: v for k, v in ok.items() if k != "smiling"}
    with pytest.raises(sheet_svc.CharacterSheetError, match="第二问|smiling"):
        sheet_svc.assert_expression_vlm_match(cell, "expr_3", missing)


def test_gentle_inpaint_prompt_soft_closed_eye_smile():
    assert "soft closed-eye smile" in sheet_svc._EXPR_INPAINT_PROMPTS[3].lower()
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "0.70" in src and "expr_3" in src
    assert "side-head base" in src or "side_head" in src or "侧面头" in src


def test_contemplative_side_base_contract_in_source():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "22:28" in src
    assert "expr_2" in src and "face_three_quarter" in src
    assert "require_mouth=(ek != \"expr_2\")" in src or "require_mouth=False" in src
    assert "assert_expr_cell_face_height_frac" in src
