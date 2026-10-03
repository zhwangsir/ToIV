"""15:40：设定卡板岩灰 #5A6A7A 色差门禁 + 中调灰覆盖率不误杀。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from app.services.studio import character_sheet as cs


def _png_figure(coat: tuple[int, int, int], size=(256, 384), bg=(210, 210, 214)) -> bytes:
    im = Image.new("RGB", size, bg)
    # 全身板岩灰块
    for y in range(40, 360):
        for x in range(70, 190):
            im.putpixel((x, y), coat)
    # 肤色脸块
    for y in range(50, 110):
        for x in range(100, 160):
            im.putpixel((x, y), (220, 180, 150))
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_slate_gray_passes():
    data = _png_figure((90, 106, 122))
    hx = cs.assert_garment_near_slate_gray(data)
    assert hx.startswith("#")


def test_near_white_fails():
    data = _png_figure((220, 220, 225))
    with pytest.raises(cs.CharacterSheetError) as ei:
        cs.assert_garment_near_slate_gray(data)
    assert "过浅" in str(ei.value) or "色差" in str(ei.value) or "颜色门禁" in str(ei.value)


def test_coverage_slate_on_light_gray_bg():
    """人物板岩灰衣服 + 浅灰背景：覆盖率不应落到 0.035。"""
    data = _png_figure((90, 106, 122))
    area = cs.panel_content_coverage(data)
    assert area >= 0.50, area


def test_force_tint_light_coat():
    data = _png_figure((200, 200, 205))
    tinted = cs.force_slate_garment_tint(data)
    hx = cs.assert_garment_near_slate_gray(tinted, max_dist=95)
    assert hx.startswith("#")
