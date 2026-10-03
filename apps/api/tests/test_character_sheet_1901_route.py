"""19:01：脸格头高≥35%自动拉近 + 服饰坏格删补。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_costume_tiled_cell_is_bad():
    # 4x4 repeated hoodie tiles
    cell = Image.new("RGB", (256, 256), (245, 245, 248))
    d = ImageDraw.Draw(cell)
    for y in range(4):
        for x in range(4):
            d.rectangle((x * 64 + 8, y * 64 + 8, x * 64 + 56, y * 64 + 56), fill=(180, 200, 220))
    assert sheet_svc.costume_cell_is_bad(_png(cell), item_key="raincoat") is True


def test_costume_single_item_not_bad():
    cell = Image.new("RGB", (256, 256), (245, 245, 248))
    d = ImageDraw.Draw(cell)
    d.rectangle((40, 30, 216, 220), fill=(90, 106, 122))  # one raincoat slab
    assert sheet_svc.costume_cell_is_bad(_png(cell), item_key="raincoat") is False


def test_ensure_costume_bad_cells_replaced_fills():
    # collage: cell0 tiled bad, others ok-ish dark
    n, side = 5, 128
    canvas = Image.new("RGB", (n * side, side), (245, 245, 248))
    d = ImageDraw.Draw(canvas)
    # bad tiled cell0
    for y in range(4):
        for x in range(4):
            d.rectangle((x * 32 + 2, y * 32 + 2, x * 32 + 28, y * 32 + 28), fill=(170, 190, 210))
    for i in range(1, n):
        d.rectangle((i * side + 20, 20, i * side + side - 20, side - 20), fill=(40, 40, 45))
    portrait = Image.new("RGB", (512, 768), (230, 230, 234))
    pd = ImageDraw.Draw(portrait)
    pd.rectangle((120, 200, 390, 700), fill=(90, 106, 122))
    out = sheet_svc.ensure_costume_bad_cells_replaced(
        _png(canvas), portrait=_png(portrait), n=n
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=n)
    assert all(r >= 0.12 for r in ratios)
