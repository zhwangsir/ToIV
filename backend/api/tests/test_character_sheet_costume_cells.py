"""服饰栏每格非空 / 内容像素占比门禁。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _row(cells: list[Image.Image], pad: int = 8) -> bytes:
    cell = 256
    n = len(cells)
    canvas = Image.new("RGB", (n * cell + pad * 2, cell + pad * 2), (240, 240, 244))
    for i, im in enumerate(cells):
        canvas.paste(im.resize((cell - 8, cell - 8)), (pad + i * cell + 4, pad + 4))
    return _png(canvas)


def test_costume_cells_block_gray_bars():
    # 细灰条：几乎无前景
    bars = []
    for _ in range(5):
        im = Image.new("RGB", (256, 256), (240, 240, 244))
        d = ImageDraw.Draw(im)
        d.rectangle((120, 20, 136, 236), fill=(180, 180, 182))
        bars.append(im)
    bad = _row(bars)
    ratios = sheet_svc.costume_cell_content_ratios(bad, n=5)
    assert all(r < 0.12 for r in ratios), ratios
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc.assert_costume_cells_nonempty(bad, min_ratio=0.12, n=5)


def test_costume_cells_pass_filled_items():
    cells = []
    for color in ((20, 20, 25), (30, 30, 35), (15, 15, 20), (40, 40, 45), (25, 25, 30)):
        im = Image.new("RGB", (256, 256), (240, 240, 244))
        d = ImageDraw.Draw(im)
        d.rectangle((40, 40, 216, 216), fill=color)
        cells.append(im)
    good = _row(cells)
    ratios = sheet_svc.assert_costume_cells_nonempty(good, min_ratio=0.12, n=5)
    assert all(r >= 0.12 for r in ratios), ratios
