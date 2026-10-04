"""00:30：脸部羽化贴回 + 专项问答契约（沉思/温柔）。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _portrait_with_chest_mark(size: int = 768) -> Image.Image:
    """胸口有明显色块徽标的头肩图。"""
    im = Image.new("RGB", (size, size), (210, 205, 200))
    d = ImageDraw.Draw(im)
    d.ellipse((size * 0.25, size * 0.12, size * 0.75, size * 0.62), fill=(220, 180, 155))
    d.ellipse((size * 0.35, size * 0.30, size * 0.43, size * 0.38), fill=(40, 50, 140))
    d.ellipse((size * 0.57, size * 0.30, size * 0.65, size * 0.38), fill=(40, 50, 140))
    d.ellipse((size * 0.42, size * 0.48, size * 0.58, size * 0.55), fill=(160, 90, 90))
    d.rectangle((size * 0.20, size * 0.70, size * 0.80, size), fill=(70, 90, 110))
    d.rectangle((size * 0.42, size * 0.78, size * 0.58, size * 0.90), fill=(220, 40, 40))
    return im


def _edited_with_new_chest_logo(base: Image.Image) -> Image.Image:
    im = base.copy()
    d = ImageDraw.Draw(im)
    s = im.size[0]
    d.ellipse((s * 0.34, s * 0.33, s * 0.44, s * 0.37), fill=(20, 20, 40))
    d.ellipse((s * 0.56, s * 0.33, s * 0.66, s * 0.37), fill=(20, 20, 40))
    d.rectangle((s * 0.40, s * 0.76, s * 0.60, s * 0.92), fill=(255, 220, 40))
    d.rectangle((s * 0.45, s * 0.80, s * 0.55, s * 0.88), fill=(10, 10, 10))
    return im


def test_0030_paste_keeps_chest_pixels():
    base = _portrait_with_chest_mark(768)
    edited = _edited_with_new_chest_logo(base)
    out = sheet_svc.paste_qedit_face_onto_portrait(_png(base), _png(edited), size=768)
    o = Image.open(BytesIO(out)).convert("RGB")
    s = 768
    ox = base.getpixel((s // 2, int(s * 0.84)))
    nx = o.getpixel((s // 2, int(s * 0.84)))
    assert ox == nx, (ox, nx)
    ey = o.getpixel((int(s * 0.39), int(s * 0.35)))
    by = base.getpixel((int(s * 0.39), int(s * 0.35)))
    assert ey != by or abs(sum(ey) - sum(by)) > 30


def test_0030_paste_mask_bottom_not_past_chin():
    bb = (100.0, 80.0, 400.0, 420.0)
    m = sheet_svc.build_face_paste_mask(512, face_bbox=bb)
    assert m.getpixel((256, 450)) == 0
    assert m.getpixel((250, 200)) > 64


def test_0030_qa_assert_both_true():
    ok = sheet_svc.assert_expression_qa_match("expr_2", {"q1": True, "q2": True})
    assert ok["pass"] is True
    with pytest.raises(sheet_svc.CharacterSheetError, match="专项问答未过"):
        sheet_svc.assert_expression_qa_match("expr_2", {"q1": True, "q2": False})
    with pytest.raises(sheet_svc.CharacterSheetError, match="专项问答未过"):
        sheet_svc.assert_expression_qa_match("expr_3", {"q1": False, "q2": True})


def test_0030_parse_qa_json():
    r = sheet_svc._parse_expr_qa_json('{"q1": true, "q2": "是"}')
    assert r["q1"] is True and r["q2"] is True
    r2 = sheet_svc._parse_expr_qa_json("```json\n{\"q1\": false, \"q2\": false}\n```")
    assert r2["q1"] is False and r2["q2"] is False


def test_0030_source_contract():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "paste_qedit_face_onto_portrait" in src
    assert "classify_expression_qa" in src
    assert "for attempt in range(6)" in src
    assert "_EXPR_QA_PROMPTS" in src
    assert "00:30" in src
    assert "half-closed" in src.lower() or "眼睛向下看且眼皮半闭" in src
    # 01:50：温柔不再强制闭眼；旧贴回函数仍保留兼容
    assert "gentle smile" in src.lower() or "closed-eye smile" in src.lower() or "闭眼微笑" in src or "弯月眼" in src
