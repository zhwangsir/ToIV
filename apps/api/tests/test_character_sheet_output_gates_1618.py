"""16:18 出图门禁：矩形色块 / 蓝灰肤色 / 禁强制着色。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio.character_sheet import (
    CharacterSheetError,
    assert_no_large_uniform_rect,
    assert_skin_not_blue_gray,
    force_slate_garment_tint,
)


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_force_slate_garment_tint_disabled():
    img = Image.new("RGB", (128, 192), (200, 180, 160))
    with pytest.raises(CharacterSheetError, match="已禁用整图着色"):
        force_slate_garment_tint(_png(img))


def test_uniform_rect_rejected():
    img = Image.new("RGB", (256, 384), (240, 240, 240))
    d = ImageDraw.Draw(img)
    # 胸口大块板岩灰矩形
    d.rectangle([90, 110, 166, 200], fill=(0x5A, 0x6A, 0x7A))
    with pytest.raises(CharacterSheetError, match="均匀"):
        assert_no_large_uniform_rect(_png(img), label="主立绘")


def test_normal_gradient_passes_rect_gate():
    img = Image.new("RGB", (256, 384), (240, 240, 240))
    px = img.load()
    for y in range(384):
        for x in range(256):
            px[x, y] = (180 + (x % 40), 150 + (y % 30), 140 + ((x + y) % 25))
    assert_no_large_uniform_rect(_png(img), label="主立绘")


def test_blue_gray_skin_rejected():
    img = Image.new("RGB", (256, 384), (230, 230, 230))
    d = ImageDraw.Draw(img)
    # 头肩蓝灰色块
    d.ellipse([80, 20, 176, 140], fill=(120, 130, 160))
    with pytest.raises(CharacterSheetError, match="蓝灰"):
        assert_skin_not_blue_gray(_png(img), label="主立绘")


def test_warm_skin_passes():
    img = Image.new("RGB", (256, 384), (230, 230, 230))
    d = ImageDraw.Draw(img)
    d.ellipse([80, 20, 176, 140], fill=(210, 170, 145))
    assert_skin_not_blue_gray(_png(img), label="主立绘")
