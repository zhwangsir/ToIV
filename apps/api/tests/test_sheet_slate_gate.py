"""15:40：设定卡板岩灰 #5A6A7A 色差门禁 + 中调灰覆盖率不误杀。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from app.services.studio import character_sheet as cs


def _png(color: tuple[int, int, int], size=(256, 384)) -> bytes:
    im = Image.new("RGB", size, color)
    # 加肤色脸块，避免纯色
    for y in range(40, 100):
        for x in range(90, 160):
            im.putpixel((x, y), (220, 180, 150))
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_slate_gray_passes():
    # #5A6A7A = (90, 106, 122)
    data = _png((90, 106, 122))
    hx = cs.assert_garment_near_slate_gray(data)
    assert hx.startswith("#")


def test_near_white_fails():
    data = _png((220, 220, 225))
    with pytest.raises(cs.CharacterSheetError) as ei:
        cs.assert_garment_near_slate_gray(data)
    assert "过浅" in str(ei.value) or "色差" in str(ei.value) or "颜色门禁" in str(ei.value)


def test_coverage_slate_on_light_gray_bg():
    """人物板岩灰衣服 + 浅灰背景：覆盖率不应落到 0.035。"""
    im = Image.new("RGB", (256, 384), (210, 210, 214))
    # 全身板岩灰块
    for y in range(20, 360):
        for x in range(70, 190):
            im.putpixel((x, y), (90, 106, 122))
    buf = BytesIO()
    im.save(buf, format="PNG")
    area = cs.panel_content_coverage(buf.getvalue())
    assert area >= 0.50, area
