"""17:55：全身格覆盖率改纵向跨度；母版 front + 批准主立绘都必须过。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc

_OUT = Path.home() / "Desktop/ALLProject/toiv_report_sheet_anime_1703/out"
_APPROVED = _OUT / "approved_portrait_10031947.png"
_REJECTED = _OUT / "rejected_10031947_portrait.png"
_FRONT = _OUT / "override_front.png"


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _postage_stamp(canvas: int = 768, stamp: int = 248) -> bytes:
    out = Image.new("RGB", (canvas, canvas), (20, 22, 28))
    face = Image.new("RGB", (stamp, stamp), (180, 175, 170))
    d = ImageDraw.Draw(face)
    d.ellipse((stamp * 0.25, stamp * 0.18, stamp * 0.78, stamp * 0.72), fill=(220, 190, 170))
    ox = (canvas - stamp) // 2
    oy = (canvas - stamp) // 2
    out.paste(face, (ox, oy))
    return _png(out)


@pytest.mark.skipif(not _REJECTED.is_file(), reason="no rejected portrait artifact")
def test_approved_portrait_vertical_span_passes():
    src = _APPROVED if _APPROVED.is_file() else _REJECTED
    data = src.read_bytes()
    vspan = sheet_svc.panel_vertical_span(data)
    assert vspan >= 0.85, vspan
    ratio = sheet_svc.assert_panel_coverage(data, min_ratio=0.90)
    assert ratio >= 0.85


@pytest.mark.skipif(not _FRONT.is_file(), reason="no override front artifact")
def test_master_front_vertical_span_passes():
    data = _FRONT.read_bytes()
    vspan = sheet_svc.panel_vertical_span(data)
    assert vspan >= 0.85, vspan
    ratio = sheet_svc.assert_panel_coverage(data, min_ratio=0.90)
    assert ratio >= 0.85


def test_postage_stamp_vertical_span_fails():
    bad = _postage_stamp()
    vspan = sheet_svc.panel_vertical_span(bad)
    assert vspan < 0.85, vspan
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc.assert_panel_coverage(bad, min_ratio=0.90)
