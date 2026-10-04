"""05:30：嘴部放大复判——整格问答漏判小 O 形嘴（0505 expr_2）后的二次 VLM 门禁。"""
from __future__ import annotations

import inspect
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _face_png(size: int = 768) -> bytes:
    im = Image.new("RGB", (size, size), (176, 175, 181))
    d = ImageDraw.Draw(im)
    d.ellipse((234, 150, 534, 560), fill=(250, 232, 220))
    d.ellipse((370, 470, 400, 495), fill=(120, 20, 30))  # 小 O 形嘴
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_mouth_zoom_prompt_registered_and_strict():
    p = sheet_svc._EXPR_QA_PROMPTS["mouth_zoom"]
    assert "ZOOMED" in p and "FULLY CLOSED" in p
    for k in ("small oval", "dark or red", "teeth"):
        assert k in p


def test_crop_mouth_zoom_uses_lower_center_of_face(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_detect_face_bbox_xyxy", lambda _b: (234.0, 150.0, 534.0, 560.0))
    out = sheet_svc.crop_mouth_zoom(_face_png())
    im = Image.open(BytesIO(out)).convert("RGB")
    assert im.width == 512
    # 裁区 x 279..489、y 314..622 → 宽高比约 210:308
    assert abs(im.height / im.width - 308 / 210) < 0.03
    # 小 O 嘴必须落在放大图里
    px = [im.getpixel((x, y)) for x in range(0, im.width, 4) for y in range(0, im.height, 4)]
    assert any(r < 160 and g < 60 and b < 70 for r, g, b in px)


def test_crop_mouth_zoom_no_face_raises(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_detect_face_bbox_xyxy", lambda _b: None)
    monkeypatch.setattr(sheet_svc, "_heuristic_skin_face_bbox", lambda _im: None)
    with pytest.raises(sheet_svc.CharacterSheetError, match="测不到脸"):
        sheet_svc.crop_mouth_zoom(_face_png())


def test_crop_mouth_zoom_tiny_region_raises(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_detect_face_bbox_xyxy", lambda _b: (10.0, 10.0, 30.0, 25.0))
    with pytest.raises(sheet_svc.CharacterSheetError, match="裁区过小"):
        sheet_svc.crop_mouth_zoom(_face_png())


@pytest.mark.parametrize(
    "q1,q2,ok",
    [(True, True, True), (False, True, False), (True, False, False), (None, True, False), ("true", True, False)],
)
def test_assert_mouth_zoom_closed(q1, q2, ok):
    if ok:
        assert sheet_svc.assert_mouth_zoom_closed("expr_2", {"q1": q1, "q2": q2})["pass"] is True
    else:
        with pytest.raises(sheet_svc.CharacterSheetError, match="嘴部放大复判未过"):
            sheet_svc.assert_mouth_zoom_closed("expr_2", {"q1": q1, "q2": q2})


def test_pipeline_runs_mouth_zoom_after_expression_qa_and_before_ok_write():
    src = inspect.getsource(sheet_svc)
    i_qa = src.index("assert_expression_qa_match(ek, qa_result)")
    i_mz = src.index("assert_mouth_zoom_closed(ek, mz_result)")
    i_ok = src.index('f"{ek}_qedit_ok_{int(seed or 0)}.png"')
    assert i_qa < i_mz < i_ok
    assert 'expr_key="mouth_zoom"' in src[i_qa:i_mz]
