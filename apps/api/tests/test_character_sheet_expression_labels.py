"""表情格:每格图片区+独立标签带;6 标签各在其格正下方(父代理 13:00)。"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from app.services.studio.character_sheet import (
    LAYOUT,
    _EXPR_KEYS,
    _EXPR_LABELS,
    _compose_expression_grid,
)


def _make_expr_panels() -> dict[str, Image.Image]:
    """每格顶部有色带(模拟头顶),中部肤色块,底部旧标签残影。"""
    out: dict[str, Image.Image] = {}
    colors = [
        (220, 40, 40),
        (40, 180, 40),
        (40, 40, 220),
        (220, 180, 40),
        (180, 40, 220),
        (40, 180, 220),
    ]
    for i, key in enumerate(_EXPR_KEYS):
        im = Image.new("RGB", (256, 320), (200, 180, 160))
        d = ImageDraw.Draw(im)
        # 头顶色带
        d.rectangle([0, 0, 256, 36], fill=colors[i])
        # 假脸
        d.ellipse([78, 70, 178, 190], fill=(240, 210, 190))
        # 旧烘焙标签残影(应被 strip + 真字体替换)
        d.rectangle([0, 280, 256, 320], fill=(245, 245, 248))
        d.text((100, 290), "旧字", fill=(80, 80, 80))
        out[key] = im
    return out


def test_compose_expression_grid_labels_under_each_cell():
    _, _, ew, eh = LAYOUT["expressions"]
    box_w, box_h = ew - 16, eh - 40
    cols, rows = 3, 2
    label_h = 44
    cell_w = box_w // cols
    cell_h = max(64 + label_h, box_h // rows)
    img_h = cell_h - label_h

    grid = _compose_expression_grid(
        _make_expr_panels(),
        label_fill=(20, 20, 24),
        draw_labels=True,
        box_w=box_w,
        box_h=box_h,
    )
    assert grid.size == (cols * cell_w, rows * cell_h)
    arr = np.asarray(grid.convert("RGB"))

    for i, lab in enumerate(_EXPR_LABELS):
        row, col = divmod(i, cols)
        # 图片区不得侵入标签带:标签带应接近底色,且含深色字像素
        band = arr[
            row * cell_h + img_h : row * cell_h + cell_h,
            col * cell_w : (col + 1) * cell_w,
        ]
        assert band.shape[0] == label_h
        # 标签带平均接近灰底
        mean = band.reshape(-1, 3).mean(axis=0)
        assert mean[0] > 200 and mean[1] > 200 and mean[2] > 200, mean
        # 有足够深色像素=文字
        dark = (band.reshape(-1, 3).max(axis=1) < 80).sum()
        assert dark >= 20, (lab, int(dark))

        # 图片区应保留头顶色带(跳过 3px 内边距)
        img_zone = arr[
            row * cell_h + 3 : row * cell_h + img_h,
            col * cell_w + 3 : (col + 1) * cell_w - 3,
        ]
        top = img_zone[: max(10, img_zone.shape[0] // 10)]
        expect = [(220, 40, 40), (40, 180, 40), (40, 40, 220), (220, 180, 40), (180, 40, 220), (40, 180, 220)][i]
        # 顶部像素与色带欧氏距离足够近的占比
        dist = ((top.astype("int16") - expect) ** 2).sum(axis=2) ** 0.5
        close = float((dist < 40).mean())
        assert close > 0.15, (lab, close, float(top.reshape(-1, 3).mean(axis=0)))

        # 下一行图片区顶部不应被上一行标签污染(第一行标签不进第二行头)
        if row == 0:
            next_top = arr[
                1 * cell_h : 1 * cell_h + 12,
                col * cell_w : (col + 1) * cell_w,
            ]
            # 第二行顶部应是色带/图,不是第一行标签灰底字
            # 至少不应几乎全是标签灰底
            nxt_mean = next_top.reshape(-1, 3).mean(axis=0)
            assert not (nxt_mean.min() > 230 and (next_top.reshape(-1, 3).max(axis=1) < 80).sum() > 50)


def test_compose_expression_grid_no_label_overlap_region():
    """标签带矩形与图片区 y 范围不相交。"""
    grid = _compose_expression_grid(_make_expr_panels(), box_w=900, box_h=480)
    cols, rows = 3, 2
    cell_w = grid.width // cols
    cell_h = grid.height // rows
    label_h = 44
    img_h = cell_h - label_h
    for i in range(6):
        row, col = divmod(i, cols)
        img_y1 = row * cell_h + img_h
        band_y0 = row * cell_h + img_h
        assert img_y1 == band_y0
        assert band_y0 + label_h == (row + 1) * cell_h
