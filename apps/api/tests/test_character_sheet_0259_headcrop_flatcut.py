"""02:42：发顶≥0.6×fh 裁切 + 发顶平切门禁；0150 a0/a5 为负例。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _resolve_0150_rejects() -> Path:
    cands = [
        Path.home() / "Desktop/ALLProject/toiv_report_sheet_anime_0150/out/rejects",
        Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_0150/out/rejects"),
        Path("/Users/wangzhenyu/Desktop/ALLProject/toiv_report_sheet_anime_0150/out/rejects"),
    ]
    for c in cands:
        if (c / "expr_2_qedit_headcrop_10050150_a0.png").is_file():
            return c
    return cands[0]


_REJ = _resolve_0150_rejects()


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _clean_round_hair(size: int = 768) -> bytes:
    """正例：圆润发顶 + 顶留白约 10%，无水平平切。"""
    im = Image.new("RGB", (size, size), (160, 160, 165))
    d = ImageDraw.Draw(im)
    # bumpy/round hair crown
    for cx, cy, rx, ry in (
        (size * 0.50, size * 0.14, size * 0.22, size * 0.12),
        (size * 0.38, size * 0.16, size * 0.12, size * 0.10),
        (size * 0.62, size * 0.16, size * 0.12, size * 0.10),
        (size * 0.50, size * 0.22, size * 0.28, size * 0.22),
    ):
        d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=(28, 30, 45))
    # face ~45% height
    face_top = size * 0.28
    face_bot = face_top + size * 0.45
    d.ellipse(
        (size * 0.30, face_top, size * 0.70, face_bot),
        fill=(220, 185, 160),
    )
    d.ellipse((size * 0.38, size * 0.42, size * 0.46, size * 0.50), fill=(40, 50, 140))
    d.ellipse((size * 0.54, size * 0.42, size * 0.62, size * 0.50), fill=(40, 50, 140))
    d.ellipse((size * 0.46, size * 0.58, size * 0.54, size * 0.64), fill=(160, 90, 90))
    return _png(im)


def _synth_flat_cut(size: int = 768) -> bytes:
    """负例：发顶水平直线 + 其上大片灰底。"""
    im = Image.new("RGB", (size, size), (158, 156, 162))
    d = ImageDraw.Draw(im)
    y0 = int(size * 0.24)
    d.rectangle((size * 0.22, y0, size * 0.78, size * 0.55), fill=(28, 30, 45))
    d.ellipse((size * 0.22, y0, size * 0.78, size * 0.62), fill=(28, 30, 45))
    d.ellipse((size * 0.32, size * 0.32, size * 0.68, size * 0.72), fill=(220, 185, 160))
    return _png(im)


def test_0259_crop_defaults_use_0_6_hair_and_0_45_face():
    import inspect

    sig = inspect.signature(sheet_svc.crop_expr_head_closeup)
    assert float(sig.parameters["hair_above_face_frac"].default) >= 0.60
    assert abs(float(sig.parameters["target_face_height_frac"].default) - 0.45) < 1e-6
    assert 0.08 <= float(sig.parameters["top_margin_frac"].default) <= 0.12


def test_0259_contemplative_prompts_concrete_actions():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "视线下垂偏一侧" in src
    assert "眉头微蹙" in src
    assert "lips closed" in sheet_svc._EXPR_EDIT_INSTRUCTIONS[2] or "嘴唇闭合" in sheet_svc._EXPR_EDIT_INSTRUCTIONS[2]
    qa = sheet_svc._EXPR_QA_PROMPTS["expr_2"]
    assert "looking down and to one side" in qa or "视线下垂偏一侧" in qa
    assert "furrowed" in qa or "眉头微蹙" in qa
    assert "closed" in qa.lower() or "闭合" in qa
    # gentle unchanged intent
    g = sheet_svc._EXPR_QA_PROMPTS["expr_3"]
    assert "mouth corners up" in g
    assert "NOT required" in g or "弯月眼" in g


def test_0259_flat_cut_synth_rejected_round_passes():
    bad = _synth_flat_cut()
    with pytest.raises(sheet_svc.CharacterSheetError, match="发顶平切"):
        sheet_svc.assert_no_flat_hairline_cut(bad, expr_key="expr_2")
    info = sheet_svc.measure_flat_hairline_cut(bad)
    assert info["reject"] is True
    assert info["max_flat_run"] >= 40

    good = _clean_round_hair()
    ok = sheet_svc.assert_no_flat_hairline_cut(good, expr_key="expr_2")
    assert ok["reject"] is False


def test_0259_0150_a0_a5_headcrop_are_negative():
    """0150 沉思 headcrop a0/a5：发顶平切负例必须拒。"""
    needed = [
        _REJ / "expr_2_qedit_headcrop_10050150_a0.png",
        _REJ / "expr_2_qedit_headcrop_10050150_a5.png",
    ]
    if not all(p.is_file() for p in needed):
        pytest.skip("0150 headcrop evidence missing")
    for p in needed:
        with pytest.raises(sheet_svc.CharacterSheetError, match="发顶平切"):
            sheet_svc.assert_no_flat_hairline_cut(p.read_bytes(), expr_key="expr_2")


def test_0259_0150_locked_good_passes_flat_gate():
    p = _REJ / "expr_0_locked_10050150.png"
    if not p.is_file():
        pytest.skip("0150 locked missing")
    info = sheet_svc.assert_no_flat_hairline_cut(p.read_bytes(), expr_key="expr_0")
    assert info["reject"] is False


def test_0259_qa_assert_both_true_still():
    ok = sheet_svc.assert_expression_qa_match("expr_2", {"q1": True, "q2": True})
    assert ok["pass"] is True
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc.assert_expression_qa_match("expr_2", {"q1": True, "q2": False})


def test_0259_crop_short_headroom_does_not_raise():
    """脸贴顶的源图：贴顶实裁，不抛错（平切由门禁拦，禁止上垫灰逻辑在 crop 内）。"""
    size = 512
    im = Image.new("RGB", (size, size), (170, 170, 175))
    d = ImageDraw.Draw(im)
    d.ellipse((size * 0.30, 2, size * 0.70, size * 0.40), fill=(220, 185, 160))
    d.ellipse((size * 0.38, size * 0.12, size * 0.46, size * 0.20), fill=(40, 50, 140))
    d.ellipse((size * 0.54, size * 0.12, size * 0.62, size * 0.20), fill=(40, 50, 140))
    raw = _png(im)
    out = sheet_svc.crop_expr_head_closeup(raw, size=768)
    assert out[:4] == b"\x89PNG"
    o = Image.open(BytesIO(out))
    assert o.size == (768, 768)
