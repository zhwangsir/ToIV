"""设定卡拼版/裁切/拼贴(Pillow 固定版式)."""
from __future__ import annotations

import asyncio
import colorsys
import contextvars
import hashlib
import json
import logging
import math
import os
import re
import uuid
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from PIL import Image, ImageDraw, ImageFont

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

import app.services.studio.character_sheet.constants as _constants
globals().update({k: v for k, v in vars(_constants).items() if not k.startswith('__')})

import app.services.studio.character_sheet.templates as _templates
globals().update({k: v for k, v in vars(_templates).items() if not k.startswith('__')})
import app.services.studio.character_sheet.gates as _gates
globals().update({k: v for k, v in vars(_gates).items() if not k.startswith('__')})





def _fit(img: Image.Image, box: tuple[int, int, int, int], *, cover: bool=True, valign: str='center'):
    """contain 时 valign=top|center|bottom；cover 仍居中裁。"""
    x, y, w, h = box
    src = img.convert('RGBA')
    if cover:
        scale = max(w / src.width, h / src.height)
    else:
        scale = min(w / src.width, h / src.height)
    nw, nh = (max(1, int(src.width * scale)), max(1, int(src.height * scale)))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    if cover:
        left = max(0, (nw - w) // 2)
        top = max(0, (nh - h) // 2)
        src = src.crop((left, top, left + w, top + h))
        return (src, (x, y))
    ox = x + (w - src.width) // 2
    if valign == 'top':
        oy = y
    elif valign == 'bottom':
        oy = y + (h - src.height)
    else:
        oy = y + (h - src.height) // 2
    return (src, (ox, oy))

def _paste(canvas: Image.Image, img: Image.Image, box: tuple[int, int, int, int], *, cover: bool=True, valign: str='center') -> None:
    fitted, pos = _fit(img, box, cover=cover, valign=valign)
    canvas.paste(fitted, pos, fitted if fitted.mode == 'RGBA' else None)

def _text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font: ImageFont.ImageFont, fill: tuple[int, ...]=(30, 30, 36), max_width: int | None=None) -> int:
    if not text:
        return 0
    x, y = xy
    lines: list[str] = []
    if max_width is None:
        lines = text.split('\n')
    else:
        for para in text.split('\n'):
            line = ''
            for ch in para:
                trial = line + ch
                if draw.textlength(trial, font=font) <= max_width:
                    line = trial
                else:
                    if line:
                        lines.append(line)
                    line = ch
            lines.append(line)
    line_h = int(getattr(font, 'size', 24) * 1.35)
    for i, ln in enumerate(lines):
        draw.text((x, y + i * line_h), ln, font=font, fill=fill)
    return len(lines) * line_h

def extract_turnaround_view(sheet: Image.Image | bytes, key: str, *, strip_chrome: bool=True) -> bytes:
    """从整卡截取正/侧/背格，避开左侧身高尺(110px)，避免锁定后再画尺导致双尺。"""
    if key not in ('front', 'side', 'back'):
        raise CharacterSheetError(f'turnaround key 须为 front/side/back, 得到 {key}', status_code=422)
    im = sheet if isinstance(sheet, Image.Image) else Image.open(BytesIO(sheet))
    im = im.convert('RGB')
    tx, ty, tw, th = LAYOUT['turnaround']
    view_w = (tw - 140) // 3
    idx = {'front': 0, 'side': 1, 'back': 2}[key]
    x0 = tx + 110 + idx * view_w
    y0 = ty + 50
    cell = im.crop((x0, y0, x0 + view_w - 12, ty + th - 40))
    if strip_chrome:
        cell = strip_baked_panel_chrome(cell)
    buf = BytesIO()
    cell.save(buf, format='PNG')
    return buf.getvalue()

def strip_baked_panel_chrome(img: Image.Image, *, top_frac: float=0.12, max_top: int=56) -> Image.Image:
    """去掉锁定面板自带的标题条/内框，避免服饰栏多层嵌套标题。"""
    rgb = img.convert('RGB')
    w, h = rgb.size
    if h < 80 or w < 80:
        return rgb
    top = min(max_top, max(24, int(h * top_frac)))
    top_band = rgb.crop((0, 0, w, top))
    body = rgb.crop((0, top, w, min(h, top + max(top, 24))))

    def _mean(im: Image.Image) -> float:
        px = list(im.resize((32, 8), Image.Resampling.BOX).getdata())
        return sum((sum(c) for c in px)) / (len(px) * 3.0)
    try:
        mt, mb = (_mean(top_band), _mean(body))
    except Exception:
        return rgb
    if abs(mt - mb) < 12:
        top = min(40, top)
    inset = 2 if min(w, h) > 100 else 0
    return rgb.crop((inset, top, w - inset, h - inset))

def _draw_panel_frame(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], label: str, font: ImageFont.ImageFont, *, outline: tuple[int, ...], label_fill: tuple[int, ...]) -> None:
    x, y, w, h = box
    draw.rounded_rectangle([x, y, x + w, y + h], radius=12, outline=outline, width=2)
    if label:
        draw.text((x + 10, y + 8), label, font=font, fill=label_fill)

def _extract_palette(img: Image.Image, n: int=6, *, style: str='anime') -> list[str]:
    """从人物前景取色;剔除近背景/近黑,保证肤色(+古风金色)可用。"""
    rgb = img.convert('RGB')
    w, h = rgb.size
    corners = [rgb.getpixel((2, 2)), rgb.getpixel((w - 3, 2)), rgb.getpixel((2, h - 3)), rgb.getpixel((w - 3, h - 3))]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))
    crop = rgb.crop((int(w * 0.22), int(h * 0.04), int(w * 0.78), int(h * 0.55)))
    small = crop.resize((64, 64), Image.Resampling.BOX)
    colors = small.getcolors(64 * 64) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    out: list[str] = []
    skin_cands: list[tuple[int, tuple[int, int, int]]] = []
    gold_cands: list[tuple[int, tuple[int, int, int]]] = []
    for cnt, (r, g, b) in colors:
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 45:
            continue
        if max(r, g, b) < 28 or min(r, g, b) > 245:
            continue
        mx, mn = (max(r, g, b), min(r, g, b))
        if mx - mn < 12 and 70 <= mx <= 190:
            continue
        if r + g + b < 90:
            continue
        hx = f'#{r:02X}{g:02X}{b:02X}'
        if hx not in out:
            out.append(hx)
        if 90 < r < 245 and 60 < g < 210 and (45 < b < 190) and (r >= g - 5) and (g >= b - 15):
            skin_cands.append((cnt, (r, g, b)))
        if r > 140 and g > 100 and (b < 120) and (r - b > 40) and (g - b > 20):
            gold_cands.append((cnt, (r, g, b)))
        if len(out) >= n:
            break
    if style == 'ancient_realistic':
        fallback = ['#E8C4A8', '#D4AF37', '#1A1A1E', '#2C2C34', '#C9A227', '#8B7355']
    else:
        fallback = ['#E8C4A8', '#5A6A7A', '#D4D3D8', '#C98A7A', '#2C2C34', '#1A1A1E']
    if skin_cands:
        sr, sg, sb = skin_cands[0][1]
        skin_hx = f'#{sr:02X}{sg:02X}{sb:02X}'
        if skin_hx in out:
            out.remove(skin_hx)
        out.insert(0, skin_hx)
    elif fallback[0] not in out:
        out.insert(0, fallback[0])
    if style == 'ancient_realistic':
        if gold_cands:
            gr, gg, gb = gold_cands[0][1]
            gold_hx = f'#{gr:02X}{gg:02X}{gb:02X}'
            if gold_hx in out:
                out.remove(gold_hx)
            out.insert(min(1, len(out)), gold_hx)
        elif '#D4AF37' not in out:
            out.insert(min(1, len(out)), '#D4AF37')

    def _luma(hx: str) -> int:
        return int(hx[1:3], 16) + int(hx[3:5], 16) + int(hx[5:7], 16)
    dark_n = sum((1 for hx in out[:6] if _luma(hx) < 160))
    if dark_n >= 4 or len(out) < 3:
        out = list(fallback)
    for hx in fallback:
        if len(out) >= n:
            break
        if hx not in out:
            out.append(hx)
    return out[:n]

def sanitize_portrait_panel(img: Image.Image) -> Image.Image:
    """裁掉立绘底部已烘焙的名字/资料条,避免与 compose 的 name/profile 重复。"""
    rgb = img.convert('RGBA')
    w, h = rgb.size
    if h < 200 or w < 80:
        return rgb
    sample = rgb.convert('RGB').resize((64, max(32, h // 8)), Image.Resampling.BOX)
    sw, sh = sample.size
    cut_ratio = None
    for yi in range(sh - 1, int(sh * 0.55), -1):
        row = [sample.getpixel((xi, yi)) for xi in range(sw)]
        dark = sum((1 for r, g, b in row if r + g + b < 140))
        if dark >= int(sw * 0.55):
            cut_ratio = yi / sh * 0.98
            break
    if cut_ratio is None or cut_ratio < 0.55:
        return rgb
    cut_y = max(int(h * 0.55), int(h * cut_ratio))
    if cut_y >= h - 8:
        return rgb
    return rgb.crop((0, 0, w, cut_y))

def _strip_expr_label_band(img: Image.Image) -> Image.Image:
    """去掉表情格底部已烘焙标签带,改由后端真字体重绘。

    21:30：仅在检测到底部门禁标签带时裁切；干净方图（无烘焙标签）原样返回，
    禁止一律裁掉底 30%（会切掉嘴/下巴）或涂近白底条（白边门禁根因）。
    """
    rgba = img.convert('RGBA')
    w, h = rgba.size
    if h < 64:
        return rgba
    rgb = rgba.convert('RGB')
    band0 = int(h * 0.82)
    sample = rgb.resize((min(64, w), max(8, h - band0)), Image.Resampling.BILINEAR)
    sw, sh = sample.size
    cut_ratio = None
    for yi in range(sh):
        row = [sample.getpixel((xi, yi)) for xi in range(sw)]
        dark = sum((1 for r, g, b in row if r + g + b < 140))
        light = sum((1 for r, g, b in row if (r + g + b) / 3.0 >= 220 and abs(r - g) < 18 and (abs(g - b) < 18)))
        if dark >= int(sw * 0.35) and light >= int(sw * 0.25):
            cut_ratio = (band0 + yi * (h - band0) / float(max(1, sh))) / float(h)
            break
    if cut_ratio is None or cut_ratio < 0.72 or cut_ratio > 0.97:
        return rgba
    cut_y = max(int(h * 0.72), int(h * cut_ratio * 0.98))
    if cut_y >= h - 8:
        return rgba
    return rgba.crop((0, 0, w, cut_y))

def _draw_height_scale(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], height_cm: int, font: ImageFont.ImageFont, *, fill: tuple[int, ...]) -> None:
    x, y, w, h = box
    scale_x = x + 28
    top, bottom = (y + 60, y + h - 40)
    draw.line([(scale_x, top), (scale_x, bottom)], fill=fill, width=3)
    ticks = 8
    for i in range(ticks + 1):
        ty = top + int((bottom - top) * i / ticks)
        draw.line([(scale_x - 8, ty), (scale_x + 8, ty)], fill=fill, width=2)
        cm = int(height_cm * (1 - i / ticks))
        draw.text((scale_x + 14, ty - 8), f'{cm}', font=font, fill=fill)
    draw.text((scale_x - 10, bottom + 8), 'cm', font=font, fill=fill)

def _fit_cover_keep_crown(img: Image.Image, box: tuple[int, int, int, int]) -> tuple[Image.Image, tuple[int, int]]:
    """cover 填满,优先保留头顶:用脸框偏上裁,无脸时偏上 1/4 而非居中。"""
    x, y, w, h = box
    src = img.convert('RGBA')
    scale = max(w / src.width, h / src.height)
    nw, nh = (max(1, int(src.width * scale)), max(1, int(src.height * scale)))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - w) // 2)
    top = 0
    try:
        buf = BytesIO()
        src.convert('RGB').save(buf, format='PNG')
        bb = _detect_face_bbox_xyxy(buf.getvalue())
    except Exception:
        bb = None
    if bb is not None:
        _x1, y1, _x2, y2 = bb
        face_cy = (y1 + y2) / 2.0
        desired_top = int(face_cy - 0.45 * h)
        top = 0 if desired_top < 0 else min(desired_top, nh - h)
        face_cx = (_x1 + _x2) / 2.0
        left = max(0, min(int(face_cx - w / 2.0), nw - w))
    if left + w > nw:
        left = max(0, nw - w)
    if top + h > nh:
        top = max(0, nh - h)
    src = src.crop((left, top, left + w, top + h))
    return (src, (x, y))

def _expr_face_bbox_of(img: Image.Image) -> tuple[float, float, float, float] | None:
    """表情贴格用脸框：insightface → 启发式。"""
    rgb = img.convert('RGB')
    buf = BytesIO()
    rgb.save(buf, format='PNG')
    data = buf.getvalue()
    bb = _detect_face_bbox_xyxy(data)
    if bb is not None:
        return (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3]))
    try:
        hbb = _heuristic_skin_face_bbox(rgb)
    except Exception:
        hbb = None
    if hbb is None:
        return None
    return (float(hbb[0]), float(hbb[1]), float(hbb[2]), float(hbb[3]))

def _fit_expr_cell_face_fill(img: Image.Image, box: tuple[int, int, int, int], *, target_face_height_frac: float=FACE_HEIGHT_FRAC_TARGET, min_face_height_frac: float=FACE_HEIGHT_FRAC_MIN, max_face_height_frac: float=FACE_HEIGHT_FRAC_MAX, allow_studio_pad_for_face_gate: bool=False) -> tuple[Image.Image, tuple[int, int]]:
    """23:18：按脸框**扩大裁剪**→缩放到格尺寸铺满；禁止棚灰垫边缩小凑脸高。

    铺满优先：输出必须铺满 (tw,th)，四周不许垫边（content coverage=1.0）。
    face_height 0.55–0.65 尽量用扩大裁剪达到；与铺满冲突时以铺满为准。
    allow_studio_pad_for_face_gate 默认 False 且 23:18 起忽略（保留参数仅兼容旧调用）。
    """
    del allow_studio_pad_for_face_gate
    x, y, tw, th = [int(v) for v in box]
    tw = max(8, tw)
    th = max(8, th)
    src0 = img.convert('RGBA')
    aspect = tw / float(th)
    tgt = max(0.5, min(0.7, float(target_face_height_frac)))
    sw, sh = src0.size

    def _max_zero_pad_window(sw_: int, sh_: int) -> tuple[float, float]:
        if sw_ / float(max(1, sh_)) >= aspect:
            ch0 = float(sh_)
            cw0 = ch0 * aspect
        else:
            cw0 = float(sw_)
            ch0 = cw0 / aspect
        return (min(cw0, float(sw_)), min(ch0, float(sh_)))
    bb = _expr_face_bbox_of(src0)
    cw0, ch0 = _max_zero_pad_window(sw, sh)
    if bb is None:
        left = max(0.0, (sw - cw0) / 2.0)
        top = max(0.0, min(float(sh) - ch0, sh * 0.06))
        crop_w, crop_h = (cw0, ch0)
    else:
        fx1, fy1, fx2, fy2 = [float(v) for v in bb]
        fw = max(8.0, fx2 - fx1)
        fh = max(8.0, fy2 - fy1)
        fcx = (fx1 + fx2) / 2.0
        chin_y = fy2 + 0.1 * fh
        mouth_y = fy1 + 0.72 * fh
        want_h = max(fh / tgt, fw * 1.05 / max(aspect, 0.5), 64.0)
        want_w = want_h * aspect
        if want_w <= sw + 1e-06 and want_h <= sh + 1e-06:
            crop_w, crop_h = (want_w, want_h)
        else:
            crop_w, crop_h = (cw0, ch0)
        top = fy1 - 0.12 * crop_h
        if chin_y > top + crop_h * 0.96:
            top = chin_y - crop_h * 0.96
        if mouth_y > top + crop_h * 0.9:
            top = mouth_y - crop_h * 0.9
        left = fcx - crop_w / 2.0
        left = max(0.0, min(float(sw) - crop_w, left))
        top = max(0.0, min(float(sh) - crop_h, top))
        if mouth_y > top + crop_h * 0.92:
            top = max(0.0, min(float(sh) - crop_h, mouth_y - crop_h * 0.88))
        if chin_y > top + crop_h * 0.98:
            top = max(0.0, min(float(sh) - crop_h, chin_y - crop_h * 0.96))
    x0 = int(round(left))
    y0 = int(round(top))
    x1 = int(round(left + crop_w))
    y1 = int(round(top + crop_h))
    x0 = max(0, min(sw - 2, x0))
    y0 = max(0, min(sh - 2, y0))
    x1 = max(x0 + 2, min(sw, x1))
    y1 = max(y0 + 2, min(sh, y1))
    crop = src0.crop((x0, y0, x1, y1)).resize((tw, th), Image.Resampling.LANCZOS)
    if crop.mode == 'RGBA':
        solid = Image.new('RGBA', crop.size, (0, 0, 0, 0))
        solid.paste(crop, (0, 0), crop)
        alpha = solid.split()[-1]
        if alpha.getextrema()[0] < 250:
            corner = src0.convert('RGB').getpixel((min(2, sw - 1), min(2, sh - 1)))
            bg = Image.new('RGBA', crop.size, (*corner[:3], 255))
            bg.paste(solid, (0, 0), solid)
            crop = bg
        else:
            crop = solid.convert('RGBA')
    return (crop, (x, y))


def _compose_expression_grid_unified_face_scales(panels: dict[str, Image.Image]) -> float:
    """六格脸高占比中位数 → 统一 target_face_height_frac（约 0.55–0.62）。"""
    fracs: list[float] = []
    for key in _EXPR_KEYS:
        im = panels.get(key)
        if im is None:
            continue
        bb = _expr_face_bbox_of(im)
        if bb is None:
            continue
        _x1, y1, _x2, y2 = bb
        fh = max(1.0, float(y2) - float(y1))
        fracs.append(fh / float(max(1, im.size[1])))
    if not fracs:
        return 0.58
    fracs.sort()
    mid = fracs[len(fracs) // 2]
    if mid >= 0.62:
        return 0.56
    if mid <= 0.45:
        return 0.6
    return 0.58

def _compose_expression_grid(panels: dict[str, Image.Image], *, label_fill: tuple[int, ...]=(30, 30, 36), draw_labels: bool=True, box_w: int | None=None, box_h: int | None=None, grid_bg: tuple[int, ...]=(245, 245, 248, 255), label_band_bg: tuple[int, ...] | None=None) -> Image.Image:
    """2x3:每格=图片区+其下独立标签带;图片脸心 cover 保头顶;标签不与图重叠。

    古风可传深底 grid_bg/label_band_bg + 金字 label_fill；二次元保持浅底默认。
    单层面板：本函数不画「表情」标题（外框由 compose 画一次）。
    """
    cols, rows = (3, 2)
    label_h = 44 if draw_labels else 0
    if box_w is None or box_h is None:
        _, _, ew, eh = LAYOUT['expressions']
        box_w = box_w or ew - 16
        box_h = box_h or eh - 40
    cell_w = max(64, int(box_w) // cols)
    cell_h = max(64 + label_h, int(box_h) // rows)
    img_h = max(48, cell_h - label_h)
    assert label_h == 0 or img_h + label_h <= cell_h
    gbg = tuple(grid_bg) if len(grid_bg) == 4 else (*grid_bg[:3], 255)
    lbg = tuple(label_band_bg) if label_band_bg is not None else gbg
    if len(lbg) == 3:
        lbg = (*lbg, 255)
    grid = Image.new('RGBA', (cols * cell_w, rows * cell_h), gbg)
    draw = ImageDraw.Draw(grid)
    font = resolve_cjk_font(20) if draw_labels else None
    _clean_panels: dict[str, Image.Image] = {}
    for _k in _EXPR_KEYS:
        _im = panels.get(_k)
        if _im is None:
            raise CharacterSheetError(f'缺面板:{_k}', status_code=500)
        _clean_panels[_k] = _strip_expr_label_band(_im.convert('RGBA'))
    _tgt_face = _compose_expression_grid_unified_face_scales(_clean_panels)
    for i, key in enumerate(_EXPR_KEYS):
        img = _clean_panels[key]
        row, col = divmod(i, cols)
        cell_x0 = col * cell_w
        cell_y0 = row * cell_h
        ox = cell_x0 + 3
        oy = cell_y0 + 3
        iw = cell_w - 6
        ih = img_h - 6
        draw.rectangle([ox, oy, ox + iw - 1, oy + ih - 1], fill=(220, 220, 224, 255))
        fitted, pos = _fit_expr_cell_face_fill(img, (ox, oy, iw, ih), target_face_height_frac=_tgt_face)
        if fitted.height != ih or fitted.width != iw:
            fitted = fitted.resize((iw, ih), Image.Resampling.LANCZOS)
        _fbuf = BytesIO()
        fitted.convert('RGB').save(_fbuf, format='PNG')
        try:
            assert_expr_cell_face_height_frac(_fbuf.getvalue(), expr_key=key, min_face_height_frac=0.55, max_face_height_frac=0.65)
        except CharacterSheetError as _fh_err:
            logger.warning('expr compose face_height soft (fill-first 23:18): %s', _fh_err)
        assert_expr_cell_content_coverage(fitted, expr_key=key, min_coverage=1.0)
        _paste_im = fitted.convert('RGB').convert('RGBA')
        grid.paste(_paste_im, pos)
        if draw_labels and font is not None and (i < len(_EXPR_LABELS)):
            band_y0 = cell_y0 + img_h
            band_y1 = cell_y0 + cell_h
            draw.rectangle([cell_x0, band_y0, cell_x0 + cell_w, band_y1], fill=lbg)
            lab = _EXPR_LABELS[i]
            tw = draw.textlength(lab, font=font)
            lx = cell_x0 + (cell_w - tw) / 2.0
            try:
                bbox = font.getbbox(lab)
                th = bbox[3] - bbox[1]
            except Exception:
                th = 20
            ly = band_y0 + max(2, (label_h - th) // 2)
            draw.text((lx, ly), lab, font=font, fill=label_fill)
    return grid

def _zoom_face_for_area(data: bytes, *, size: int=768, target_area: float=0.18) -> bytes:
    """轻微围绕脸框放大，尽量把脸面积抬到 target_area（供表情底送模前）。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        return data
    x1, y1, x2, y2 = [float(v) for v in bb]
    fw = max(8.0, x2 - x1)
    fh = max(8.0, y2 - y1)
    area = fw * fh / float(max(1, w * h))
    if area + 1e-12 >= float(target_area):
        return data
    scale = (area / max(1e-06, float(target_area))) ** 0.5
    scale = max(0.55, min(0.92, scale))
    side = max(64, int(min(w, h) * scale))
    fcx = (x1 + x2) / 2.0
    fcy = (y1 + y2) / 2.0
    left = max(0, min(w - side, int(round(fcx - side / 2.0))))
    top = max(0, min(h - side, int(round(fcy - side / 2.0 - 0.05 * side))))
    crop = img.crop((left, top, left + side, top + side))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def _compose_expression_grid_raw(panels: dict[str, bytes] | dict[str, Image.Image], *, cell: int=512) -> bytes:
    """23:17：六表情底拼成无标签 2×3 宫格（送 Comfy/Qwen 一次编辑）。"""
    cols, rows = (3, 2)
    grid = Image.new('RGB', (cols * cell, rows * cell), (245, 245, 248))
    for i, key in enumerate(_EXPR_KEYS):
        raw = panels.get(key)
        if raw is None:
            raise CharacterSheetError(f'缺表情底:{key}', status_code=422)
        if isinstance(raw, Image.Image):
            im = raw.convert('RGB')
        else:
            im = Image.open(BytesIO(raw)).convert('RGB')
        im = im.resize((cell, cell), Image.Resampling.LANCZOS)
        row, col = divmod(i, cols)
        grid.paste(im, (col * cell, row * cell))
    buf = BytesIO()
    grid.save(buf, format='PNG')
    return buf.getvalue()

def _split_expression_grid(data: bytes, *, cell: int | None=None) -> dict[str, bytes]:
    """23:17：整张 2×3 六表情图按格裁成 expr_0..5（无标签带几何）。

    默认按图宽/3 × 图高/2 均分；若传入 cell 则按固定方格从左上裁。
    """
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    cols, rows = (3, 2)
    if cell is not None:
        cw = ch = int(cell)
    else:
        cw = max(1, w // cols)
        ch = max(1, h // rows)
    out: dict[str, bytes] = {}
    for i, key in enumerate(_EXPR_KEYS):
        row, col = divmod(i, cols)
        x0 = col * cw
        y0 = row * ch
        x1 = min(w, x0 + cw)
        y1 = min(h, y0 + ch)
        cell_im = img.crop((x0, y0, x1, y1))
        side = max(cell_im.size)
        canvas = Image.new('RGB', (side, side), (245, 245, 248))
        ox = (side - cell_im.width) // 2
        oy = (side - cell_im.height) // 2
        canvas.paste(cell_im, (ox, oy))
        canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
        buf = BytesIO()
        canvas.save(buf, format='PNG')
        out[key] = buf.getvalue()
    return out

def _compose_expression_feature_mask_grid(*, cell: int=512) -> Image.Image:
    """2×3 宫格眉眼嘴硬遮罩（白=可编辑）。每格复用 build_face_feature_mask，二值化防叠影。"""
    cols, rows = (3, 2)
    mask = Image.new('L', (cols * int(cell), rows * int(cell)), 0)
    cell_m = build_face_feature_mask(int(cell)).point(lambda v: 255 if v >= 96 else 0)
    for i in range(cols * rows):
        row, col = divmod(i, cols)
        mask.paste(cell_m, (col * int(cell), row * int(cell)))
    return mask

def apply_expression_grid_local_features(base_grid: bytes, edited_grid: bytes, *, cell: int=512, max_cell_mae: float=55.0, feather: int=10) -> bytes:
    """16:53：宫格局部五官重绘合成。

    遮罩边高斯羽化（内缩后模糊，羽化落在五官区内），消除头发外沿半透明重影；
    贴回必须用同一张底图同尺寸；遮罩外（含全部头发与胸口）强制用底图像素贴回；硬遮罩外强制底图像素逐点一致。
    """
    from PIL import ImageFilter
    base = Image.open(BytesIO(base_grid)).convert('RGB')
    edit = Image.open(BytesIO(edited_grid)).convert('RGB')
    if edit.size != base.size:
        edit = edit.resize(base.size, Image.Resampling.LANCZOS)
    cols, rows = (3, 2)
    cw = max(1, base.size[0] // cols)
    ch = max(1, base.size[1] // rows)
    fw = max(2, int(feather))
    hard = Image.new('L', base.size, 0)
    soft = Image.new('L', base.size, 0)
    for i in range(cols * rows):
        row, col = divmod(i, cols)
        cm = build_face_feature_mask(max(cw, ch)).point(lambda v: 255 if v >= 96 else 0)
        cm = cm.resize((cw, ch), Image.Resampling.NEAREST)
        hard.paste(cm, (col * cw, row * ch))
        try:
            erode_r = fw
            cm_e = cm.filter(ImageFilter.MinFilter(size=erode_r * 2 + 1))
            cm_s = cm_e.filter(ImageFilter.GaussianBlur(radius=fw))
        except Exception:
            cm_s = cm
        soft.paste(cm_s, (col * cw, row * ch))
    blended = Image.composite(edit, base, soft)
    out = Image.composite(blended, base, hard)
    for i in range(cols * rows):
        row, col = divmod(i, cols)
        box = (col * cw, row * ch, col * cw + cw, row * ch + ch)
        bc = base.crop(box)
        ec = edit.crop(box)
        try:
            pa = list(bc.resize((48, 48)).getdata())
            pb = list(ec.resize((48, 48)).getdata())
            mae = sum(((abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0 for a, b in zip(pa, pb))) / float(max(1, len(pa)))
        except Exception:
            mae = 999.0
        if mae > float(max_cell_mae):
            out.paste(bc, (box[0], box[1]))
    if out.size != base.size:
        out = out.resize(base.size, Image.Resampling.LANCZOS)
    buf = BytesIO()
    out.save(buf, format='PNG')
    return buf.getvalue()

def compose_reference_board(panels: dict[str, Image.Image | bytes], meta: SheetMeta, *, font_path_probe: bool=True) -> bytes:
    """P4 Toonflow 四视图参考板:特写+正面全身+右侧90°+背面全身 合一横排 PNG。

    设计来源 Toonflow(MIT)三视图参考板规范;缺任一面板抛 CharacterSheetError。
    """
    from PIL import ImageOps
    cells = (('face_front', '特写'), ('front', '正面全身'), ('side', '右侧90°'), ('back', '背面全身'))
    if not (meta.name or '').strip():
        raise CharacterSheetError('角色名为空', status_code=422)
    font_title = resolve_cjk_font(36) if font_path_probe else ImageFont.load_default()
    font_label = resolve_cjk_font(22) if font_path_probe else ImageFont.load_default()

    def _as_image(key: str) -> Image.Image:
        raw = panels.get(key)
        if raw is None:
            raise CharacterSheetError(f'缺面板:{key}', status_code=500)
        if isinstance(raw, Image.Image):
            return raw.convert('RGB')
        if isinstance(raw, (bytes, bytearray)):
            try:
                return Image.open(BytesIO(raw)).convert('RGB')
            except Exception as e:
                raise CharacterSheetError(f'面板损坏:{key}', status_code=500) from e
        raise CharacterSheetError(f'面板类型无效:{key}', status_code=500)
    cell_w, cell_h, gap, bar_h, label_h = (380, 860, 24, 72, 56)
    board_w = gap + len(cells) * (cell_w + gap)
    board_h = bar_h + gap + cell_h + label_h
    canvas = Image.new('RGB', (board_w, board_h), (24, 24, 28))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, board_w, bar_h], fill=(38, 38, 44))
    draw.text((gap, 18), f'Toonflow 四视图参考板 · {meta.name.strip()}', font=font_title, fill=(240, 240, 244))
    for i, (key, label) in enumerate(cells):
        x = gap + i * (cell_w + gap)
        src = _as_image(key)
        fitted = ImageOps.fit(src, (cell_w, cell_h), method=Image.Resampling.LANCZOS)
        canvas.paste(fitted, (x, bar_h + gap))
        draw.rectangle([x, bar_h + gap, x + cell_w - 1, bar_h + gap + cell_h - 1], outline=(90, 90, 100), width=2)
        draw.text((x + 12, bar_h + gap + cell_h + 14), label, font=font_label, fill=(220, 220, 228))
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

def compose_character_sheet(panels: dict[str, Image.Image | bytes], meta: SheetMeta, *, font_path_probe: bool=True) -> bytes:
    """程序化拼固定版式 PNG bytes。缺关键面板或字体 → CharacterSheetError。"""
    if not (meta.name or '').strip():
        raise CharacterSheetError('角色名为空', status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422)
    if font_path_probe:
        font_title = resolve_cjk_font(48)
        font_body = resolve_cjk_font(26)
        font_small = resolve_cjk_font(20)
        font_label = resolve_cjk_font(18)
    else:
        font_title = font_body = font_small = font_label = ImageFont.load_default()

    def _as_image(key: str) -> Image.Image:
        raw = panels.get(key)
        if raw is None:
            raise CharacterSheetError(f'缺面板:{key}', status_code=500)
        if isinstance(raw, Image.Image):
            return raw.convert('RGBA')
        if isinstance(raw, (bytes, bytearray)):
            try:
                return Image.open(BytesIO(raw)).convert('RGBA')
            except Exception as e:
                raise CharacterSheetError(f'面板损坏:{key}', status_code=500) from e
        raise CharacterSheetError(f'面板类型无效:{key}', status_code=500)
    theme = _THEME[meta.style]
    canvas = Image.new('RGBA', (SHEET_W, SHEET_H), theme['bg'])
    draw = ImageDraw.Draw(canvas)
    style_zh = '古风写实' if meta.style == 'ancient_realistic' else '二次元'
    draw.rectangle([0, 0, SHEET_W, 36], fill=theme['title_bar'])
    draw.text((48, 6), f'角色设定卡 · {style_zh}', font=font_label, fill=theme['title_text'])
    portrait = sanitize_portrait_panel(_as_image('portrait'))
    _paste(canvas, portrait, LAYOUT['portrait'], cover=True)
    _draw_panel_frame(draw, LAYOUT['portrait'], '立绘', font_label, outline=theme['outline'], label_fill=theme['text_dim'])
    nx, ny, nw, nh = LAYOUT['name']
    draw.rounded_rectangle([nx, ny, nx + nw, ny + nh], radius=8, fill=theme['name_bg'])
    name_fill = theme['text'] if meta.style == 'ancient_realistic' else (250, 250, 252)
    draw.text((nx + 20, ny + 12), meta.name.strip(), font=font_title, fill=name_fill)
    px, py, pw, ph = LAYOUT['profile']
    draw.rounded_rectangle([px, py, px + pw, py + ph], radius=10, outline=theme['outline'], width=2)
    role = meta.role or _guess_field(meta.description, '身份') or '—'
    personality = meta.personality or _guess_field(meta.description, '性格') or (meta.description[:40] or '—')
    rows = [('身高', f'{meta.height_cm} cm'), ('身份', role), ('性格', personality), ('风格', style_zh)]
    yy = py + 24
    for k, v in rows:
        draw.text((px + 24, yy), k, font=font_small, fill=theme['text_dim'])
        _text(draw, (px + 120, yy), str(v)[:48], font_body, fill=theme['text'], max_width=pw - 160)
        yy += 56
    tx, ty, tw, th = LAYOUT['turnaround']
    draw.rounded_rectangle([tx, ty, tx + tw, ty + th], radius=12, outline=theme['outline'], width=2)
    draw.text((tx + 16, ty + 12), '三视图', font=font_label, fill=theme['text_dim'])
    _draw_height_scale(draw, (tx, ty, 100, th), meta.height_cm, font_small, fill=theme['scale'])
    view_w = (tw - 140) // 3
    view_box_y = ty + 50
    view_h = th - 90
    for i, key in enumerate(('front', 'side', 'back')):
        box = (tx + 110 + i * view_w, view_box_y, view_w - 12, view_h)
        src = _as_image(key)
        buf = BytesIO()
        src.convert('RGB').save(buf, format='PNG')
        norm = Image.open(BytesIO(normalize_turnaround_figure(buf.getvalue(), out_w=box[2], out_h=box[3]))).convert('RGBA')
        _paste(canvas, norm, box, cover=False)
        label = {'front': '正', 'side': '侧', 'back': '背'}[key]
        draw.text((box[0] + view_w // 2 - 20, ty + th - 36), label, font=font_body, fill=theme['text'])
    _draw_panel_frame(draw, LAYOUT['faces'], '面部/发型', font_label, outline=theme['outline'], label_fill=theme['text_dim'])
    fx, fy, fw, fh = LAYOUT['faces']
    _fcx, _fcy, _fcw, _fch = (fx + 8, fy + 32, fw - 16, fh - 40)
    _fbg = theme['bg'][:3] if len(theme['bg']) >= 3 else (11, 14, 20)
    draw.rectangle([_fcx, _fcy, _fcx + _fcw, _fcy + _fch], fill=_fbg)
    _paste(canvas, _as_image('faces'), (_fcx, _fcy, _fcw, _fch), cover=False, valign='top')
    _draw_panel_frame(draw, LAYOUT['expressions'], '表情', font_label, outline=theme['outline'], label_fill=theme['text_dim'])
    ex, ey, ew, eh = LAYOUT['expressions']
    expr_imgs = {k: _as_image(k) for k in _EXPR_KEYS if k in panels}
    if len(expr_imgs) == 6:
        if meta.style == 'ancient_realistic':
            expr_grid_bg = (16, 18, 24, 255)
            expr_label_bg = (16, 18, 24, 255)
        else:
            expr_grid_bg = (245, 245, 248, 255)
            expr_label_bg = (245, 245, 248, 255)
        grid = _compose_expression_grid(expr_imgs, label_fill=theme['text'], box_w=ew - 16, box_h=eh - 40, grid_bg=expr_grid_bg, label_band_bg=expr_label_bg)
        _paste(canvas, grid, (ex + 8, ey + 32, ew - 16, eh - 40), cover=False)
    else:
        legacy = strip_baked_panel_chrome(_as_image('expressions'))
        _paste(canvas, legacy, (ex + 8, ey + 32, ew - 16, eh - 40), cover=False)
    _draw_panel_frame(draw, LAYOUT['costume'], '服饰/饰品', font_label, outline=theme['outline'], label_fill=theme['text_dim'])
    cx, cy, cw, ch = LAYOUT['costume']
    _costume_im = strip_baked_panel_chrome(_as_image('costume'))
    _paste(canvas, _costume_im, (cx + 8, cy + 32, cw - 16, ch - 40), cover=False)
    colors = list(meta.colors) if meta.colors else _extract_palette(portrait, style=meta.style)
    colors = [_normalize_hex(c) for c in colors if _normalize_hex(c)]
    if not colors:
        colors = _extract_palette(portrait, style=meta.style)
    if meta.style == 'ancient_realistic':
        if extract_ancient_costume_spec(meta)['colors']:
            colors = resolve_ancient_palette(meta, colors, source='sheet_compose')
        else:
            for must in ('#E8C4A8', '#D4AF37'):
                if must not in colors:
                    colors = [must] + [c for c in colors if c != must]
    else:
        for must in ('#E8C4A8', '#D4D3D8'):
            if must not in colors:
                colors = [must] + [c for c in colors if c != must]
    colors = colors[:6]
    plx, ply, plw, plh = LAYOUT['palette']
    _draw_panel_frame(draw, LAYOUT['palette'], '配色', font_label, outline=theme['outline'], label_fill=theme['text_dim'])
    n_colors = max(1, min(6, len(colors)))
    colors = colors[:n_colors]
    sw = (plw - 24) // n_colors
    swatch_font = font_label
    try:
        for sz in (18, 16, 14, 12, 11, 10):
            cand = resolve_cjk_font(sz)
            sample = '#E8C4A8'
            if draw.textlength(sample, font=cand) <= max(24, sw - 10):
                swatch_font = cand
                break
    except Exception:
        swatch_font = font_label
    label_boxes: list[tuple[int, int, int, int]] = []
    for i, hx in enumerate(colors):
        rgb = tuple((int(hx[j:j + 2], 16) for j in (1, 3, 5)))
        sx = plx + 12 + i * sw
        draw.rounded_rectangle([sx, ply + 40, sx + sw - 8, ply + plh - 36], radius=6, fill=rgb)
        label = hx
        if draw.textlength(label, font=swatch_font) > sw - 8:
            label = hx[1:]
        if draw.textlength(label, font=swatch_font) > sw - 8:
            label = hx[1:4] + '…'
        tw = int(draw.textlength(label, font=swatch_font))
        tx = sx + max(2, (sw - 8 - tw) // 2)
        ty = ply + plh - 30
        box = (tx, ty, tx + tw, ty + 18)
        if label_boxes:
            prev = label_boxes[-1]
            if box[0] < prev[2] + 2:
                tx = prev[2] + 2
                box = (tx, ty, tx + tw, ty + 18)
        if box[2] > plx + plw - 4:
            tx = max(sx + 2, plx + plw - 4 - tw)
            box = (tx, ty, tx + tw, ty + 18)
        draw.text((tx, ty), label, font=swatch_font, fill=theme['text_dim'])
        label_boxes.append(box)
    for a, b in zip(label_boxes, label_boxes[1:]):
        if a[2] > b[0]:
            raise CharacterSheetError(f'配色色号文字重叠: {a} vs {b}', status_code=500)
    nx2, ny2, nw2, nh2 = LAYOUT['notes']
    _draw_panel_frame(draw, LAYOUT['notes'], '设计说明', font_label, outline=theme['outline'], label_fill=theme['text_dim'])
    notes = build_design_notes(meta)
    _text(draw, (nx2 + 16, ny2 + 36), notes[:400], font_small, fill=theme['text'], max_width=nw2 - 32)
    ftx, fty, ftw, _ = LAYOUT['footer']
    draw.text((ftx, fty + 20), f'ToIV · {meta.name} · {style_zh} · Ref2VA', font=font_label, fill=theme['text_dim'])
    buf = BytesIO()
    canvas.convert('RGB').save(buf, format='PNG', optimize=True)
    return buf.getvalue()

def extract_locked_panels_from_sheet(sheet_bytes: bytes, *, existing: dict[str, bytes] | None=None) -> dict[str, bytes]:
    """从整卡按 LAYOUT 裁出缺失分格,含 expr_0..5。

    用途:panel-replace / regenerate 锁定时,磁盘无 expr_* 也不能用空白盖掉已有表情。
    existing 中已有的键原样保留,不覆盖。
    """
    locked: dict[str, bytes] = dict(existing or {})
    sim = Image.open(BytesIO(sheet_bytes)).convert('RGB')

    def _put(key: str, crop: Image.Image) -> None:
        if key in locked and locked[key]:
            return
        buf = BytesIO()
        crop.convert('RGB').save(buf, format='PNG')
        locked[key] = buf.getvalue()
    for k, box in LAYOUT.items():
        if k in ('canvas', 'name', 'profile', 'turnaround', 'palette', 'notes', 'footer', 'expressions'):
            continue
        if k in locked and locked[k]:
            continue
        x, y, w, h = box
        if k in ('faces', 'costume'):
            crop = sim.crop((x + 8, y + 32, x + w - 8, y + h - 8))
        else:
            crop = sim.crop((x, y, x + w, y + h))
        _put(k, crop)
    if any((k not in locked or not locked.get(k) for k in ('front', 'side', 'back'))):
        tx, ty, tw, th = LAYOUT['turnaround']
        view_w = (tw - 140) // 3
        for i, k in enumerate(('front', 'side', 'back')):
            if k in locked and locked[k]:
                continue
            box = (tx + 110 + i * view_w, ty + 50, tx + 110 + (i + 1) * view_w - 12, ty + th - 40)
            _put(k, sim.crop(box))
    ex, ey, ew, eh = LAYOUT['expressions']
    content = sim.crop((ex + 8, ey + 32, ex + ew - 8, ey + eh - 8))
    if 'expressions' not in locked or not locked.get('expressions'):
        _put('expressions', content)
    need_expr = sum((1 for k in _EXPR_KEYS if k in locked and locked.get(k))) < 6
    if need_expr:
        cols, rows = (3, 2)
        cw, ch = content.size
        cell_w = max(1, cw // cols)
        cell_h = max(1, ch // rows)
        label_h = 44
        img_h = max(48, cell_h - label_h)
        for i, ek in enumerate(_EXPR_KEYS):
            if ek in locked and locked.get(ek):
                continue
            row, col = divmod(i, cols)
            x0 = col * cell_w
            y0 = row * cell_h
            cell = content.crop((x0 + 3, y0 + 3, x0 + cell_w - 3, y0 + img_h - 3))
            _put(ek, cell)
    return locked

def save_sheet_png(data: bytes, *, character_id: str, style: str) -> str:
    from app.storage import drama_output_root
    out_dir = drama_output_root() / 'studio'
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f'{_CHAR_SHEET_MARK}{character_id[:8]}_{style}_{uuid.uuid4().hex[:12]}.png'
    (out_dir / name).write_bytes(data)
    return f'/api/studio/files/{name}'

def save_panel_png(data: bytes, *, character_id: str, style: str, key: str) -> str:
    from app.storage import drama_output_root
    out_dir = drama_output_root() / 'studio'
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f'{_CHAR_PANEL_MARK}{character_id[:8]}_{style}_{key}_{uuid.uuid4().hex[:10]}.png'
    (out_dir / name).write_bytes(data)
    return f'/api/studio/files/{name}'

def _trim_letterbox_bars(data: bytes, *, white_lum: float=232.0, min_strip_frac: float=0.92) -> bytes:
    """去掉上下左右整条近白 letterbox（1822/1830 底白条根因），保留棚灰中的人物。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    w, h = im.size
    px = im.load()

    def _row_white(y: int) -> bool:
        n = sum((1 for x in range(w) if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3.0 >= white_lum and abs(px[x, y][0] - px[x, y][1]) < 14 and (abs(px[x, y][1] - px[x, y][2]) < 14)))
        return n / float(max(1, w)) >= float(min_strip_frac)

    def _col_white(x: int) -> bool:
        n = sum((1 for y in range(h) if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3.0 >= white_lum and abs(px[x, y][0] - px[x, y][1]) < 14 and (abs(px[x, y][1] - px[x, y][2]) < 14)))
        return n / float(max(1, h)) >= float(min_strip_frac)
    top = 0
    while top < h - 8 and _row_white(top):
        top += 1
    bot = h - 1
    while bot > top + 8 and _row_white(bot):
        bot -= 1
    left = 0
    while left < w - 8 and _col_white(left):
        left += 1
    right = w - 1
    while right > left + 8 and _col_white(right):
        right -= 1
    if top == 0 and bot == h - 1 and (left == 0) and (right == w - 1):
        return data
    crop = im.crop((left, top, right + 1, bot + 1))
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def squareize_face_center_crop(data: bytes, size: int=768, *, min_face_height_frac: float=0.55, max_face_height_frac: float=0.65, require_mouth_in_frame: bool=True) -> bytes:
    """18:30 / 19:55：表情格方化 —— 去 letterbox 后按同尺度脸高约 0.55–0.65 裁切，嘴须在格内。

    1930 威严裁太近只剩眼睛=失败；目标头肩近景含嘴，非贴眼特写。
    """
    trimmed = _trim_letterbox_bars(data)
    last_err: Exception | None = None
    for tgt in (0.6, 0.58, 0.56, 0.62, 0.54):
        try:
            cropped = _crop_expr_face_same_scale(trimmed, size=int(size), target_face_height_frac=float(tgt), min_face_height_frac=float(min_face_height_frac), max_face_height_frac=float(max_face_height_frac))
            assert_face_closeup_framing(cropped, min_face_height_frac=float(min_face_height_frac), max_face_height_frac=float(max_face_height_frac), require_mouth_in_frame=bool(require_mouth_in_frame))
            return cropped
        except CharacterSheetError as e:
            last_err = e
            continue
    if last_err is not None:
        raise last_err
    raise CharacterSheetError('expr same-scale crop failed', status_code=422)

def crop_face_ref(portrait_bytes: bytes, size: int=768) -> bytes:
    """从立绘取头肩特写正方形参考,供表情 img2img(紧裁,避免半身站姿)。"""
    img = Image.open(BytesIO(portrait_bytes)).convert('RGB')
    w, h = img.size
    side = min(int(w * 0.72), int(h * 0.38), w, h)
    side = max(64, side)
    left = max(0, (w - side) // 2)
    top = max(0, int(h * 0.01))
    if top + side > h:
        top = max(0, h - side)
    crop = img.crop((left, top, left + side, top + side))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def crop_face_head_collarbone(data: bytes, *, size: int=768, max_zoom: float=1.5) -> bytes:
    """以脸为中心裁头顶略上到锁骨;放大不超过 max_zoom(父代理 12:34)。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        hbb = _heuristic_skin_face_bbox(img)
        if hbb is not None:
            bb = (float(hbb[0]), float(hbb[1]), float(hbb[2]), float(hbb[3]))
    if bb is None:
        side = min(w, int(h * 0.55))
        side = max(side, int(min(w, h) / max_zoom))
        left = max(0, (w - side) // 2)
        top = max(0, int(h * 0.02))
        if top + side > h:
            top = max(0, h - side)
        crop = img.crop((left, top, left + side, top + side))
    else:
        x1, y1, x2, y2 = bb
        fw = max(8.0, x2 - x1)
        fh = max(8.0, y2 - y1)
        cx = (x1 + x2) / 2.0
        top = y1 - 0.35 * fh
        bot = y2 + 0.55 * fh
        side = max(bot - top, fw * 1.25)
        min_side = min(w, h) / max(1.01, max_zoom)
        side = max(side, min_side)
        left = cx - side / 2.0
        if left < 0:
            left = 0
        if left + side > w:
            left = max(0.0, w - side)
        if top < 0:
            top = 0
        if top + side > h:
            top = max(0.0, h - side)
        side = min(side, w - left, h - top)
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def crop_head_from_figure(data: bytes, *, size: int=768, top_frac: float=0.34) -> bytes:
    """从全身/半身立绘裁头肩正方形,供面部角度锚定(尤其侧脸来自三视图侧格)。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    head = img.crop((int(w * 0.05), 0, int(w * 0.95), max(1, int(h * top_frac))))
    side = max(head.width, head.height, 8)
    canvas = Image.new('RGB', (side, side), (220, 220, 224))
    canvas.paste(head, ((side - head.width) // 2, (side - head.height) // 2))
    canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

def replace_costume_cell(costume_png: bytes, cell_idx: int, cell_png: bytes, *, n: int=4) -> bytes:
    """替换服饰横排某一格。"""
    im = Image.open(BytesIO(costume_png)).convert('RGB')
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    x0 = cell_idx * cell_w
    x1 = w if cell_idx == n - 1 else (cell_idx + 1) * cell_w
    cell = Image.open(BytesIO(cell_png)).convert('RGB')
    bw, bh = (x1 - x0, h)
    scale = min(bw / cell.width, bh / cell.height)
    nw, nh = (max(1, int(cell.width * scale)), max(1, int(cell.height * scale)))
    cell = cell.resize((nw, nh), Image.Resampling.LANCZOS)
    patch = Image.new('RGB', (bw, bh), (240, 240, 244))
    patch.paste(cell, ((bw - nw) // 2, (bh - nh) // 2))
    im.paste(patch, (x0, 0))
    buf = BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()

def ensure_costume_first_cell_filled(costume_png: bytes, *, portrait: bytes | None=None, front: bytes | None=None, min_ratio: float=0.12, n: int=4) -> bytes:
    """18:23：服饰空格 → 主立绘/正面雨衣（或下装/靴）局部替换，再 assert。

    父代理点名首格；其它空格同样用立绘分区裁切兜底，避免 assert 全格非空卡死。
    """
    ratios = costume_cell_content_ratios(costume_png, n=n)
    out = costume_png
    src = portrait or front
    bands = ((0.28, 0.18, 0.72, 0.36), (0.1, 0.42, 0.42, 0.6), (0.3, 0.55, 0.7, 0.78), (0.34, 0.8, 0.66, 0.995))
    for idx, r in enumerate(ratios):
        if r >= min_ratio:
            continue
        if not src:
            raise CharacterSheetError(f'costume cells empty/thin: idx={[idx]} ratios={[round(x, 3) for x in ratios]} 且无 portrait/front 可裁细节', status_code=422)
        img = Image.open(BytesIO(src)).convert('RGB')
        w, h = img.size
        x0, y0, x1, y1 = bands[idx % len(bands)]
        crop = img.crop((int(w * x0), int(h * y0), int(w * x1), int(h * y1)))
        side = max(crop.width, crop.height, 8)
        canvas = Image.new('RGB', (side, side), (240, 240, 244))
        canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
        buf = BytesIO()
        canvas.save(buf, format='PNG')
        out = replace_costume_cell(out, idx, buf.getvalue(), n=n)
        logger.info('costume cell%s empty ratio=%.3f → portrait band crop', idx, r)
    assert_costume_cells_nonempty(out, min_ratio=min_ratio, n=n)
    return out

def costume_cell_is_bad(cell_png: bytes, *, item_key: str='') -> bool:
    """19:01：服饰坏格——空/细条/多件重复/瓦片网格 → 删格补裁。

    不用整格均色判坏（单件雨衣大色块会误杀）；靠暗色 blob + 4×4 前景格计数。
    """
    try:
        ratios = costume_cell_content_ratios(cell_png, n=1)
        if ratios and ratios[0] < 0.12:
            return True
    except Exception:
        return True
    img = Image.open(BytesIO(cell_png)).convert('RGB').resize((64, 64))
    px = list(img.getdata())
    blobs = _count_dark_blobs(px)
    if item_key == 'boots' and blobs >= 4:
        return True
    if item_key == 'pants' and blobs >= 4:
        return True
    if blobs >= 8:
        return True
    if item_key in ('raincoat', 'umbrella', 'bag') and blobs >= 6:
        return True

    def _is_bg(r, g, b) -> bool:
        if r > 230 and g > 230 and (b > 230):
            return True
        if abs(r - g) < 8 and abs(g - b) < 8 and (140 < r < 210):
            return True
        return False
    filled = 0
    for ty in range(4):
        for tx in range(4):
            fg = 0
            for y in range(ty * 16, ty * 16 + 16):
                for x in range(tx * 16, tx * 16 + 16):
                    r, g, b = px[y * 64 + x]
                    if not _is_bg(r, g, b):
                        fg += 1
            if fg > 40:
                filled += 1
    gap_bg = gap_n = 0
    for x in (15, 16, 31, 32, 47, 48):
        for y in range(64):
            gap_n += 1
            if _is_bg(*px[y * 64 + x]):
                gap_bg += 1
    for y in (15, 16, 31, 32, 47, 48):
        for x in range(64):
            gap_n += 1
            if _is_bg(*px[y * 64 + x]):
                gap_bg += 1
    gap_ratio = gap_bg / max(1, gap_n)
    if filled >= 10 and gap_ratio >= 0.35:
        return True
    if item_key:
        try:
            if _costume_item_penalty(cell_png, item_key) >= 12.0:
                return True
        except Exception:
            pass
    return False

def ensure_costume_bad_cells_replaced(costume_png: bytes, *, portrait: bytes | None=None, front: bytes | None=None, min_ratio: float=0.12, n: int=4, item_keys: tuple[str, ...] | None=None) -> bytes:
    """19:01：删坏格并用主立绘分区裁切补上（先空格兜底，再坏格）。"""
    keys = item_keys or tuple((k for k, _ in _COSTUME_ITEMS))
    out = ensure_costume_first_cell_filled(costume_png, portrait=portrait, front=front, min_ratio=min_ratio, n=n)
    src = portrait or front
    if not src:
        return out
    im = Image.open(BytesIO(out)).convert('RGB')
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    bands = ((0.28, 0.18, 0.72, 0.36), (0.1, 0.42, 0.42, 0.6), (0.3, 0.55, 0.7, 0.78), (0.34, 0.8, 0.66, 0.995), (0.35, 0.4, 0.65, 0.72))
    for idx in range(n):
        x0 = idx * cell_w
        x1 = w if idx == n - 1 else (idx + 1) * cell_w
        cell = im.crop((x0, 0, x1, h))
        buf = BytesIO()
        cell.save(buf, format='PNG')
        key = keys[idx] if idx < len(keys) else ''
        if not costume_cell_is_bad(buf.getvalue(), item_key=key):
            continue
        pimg = Image.open(BytesIO(src)).convert('RGB')
        pw, ph = pimg.size
        bx0, by0, bx1, by1 = bands[idx % len(bands)]
        crop = pimg.crop((int(pw * bx0), int(ph * by0), int(pw * bx1), int(ph * by1)))
        side = max(crop.width, crop.height, 8)
        canvas = Image.new('RGB', (side, side), (240, 240, 244))
        canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
        cbuf = BytesIO()
        canvas.save(cbuf, format='PNG')
        out = replace_costume_cell(out, idx, cbuf.getvalue(), n=n)
        im = Image.open(BytesIO(out)).convert('RGB')
        logger.info('costume cell%s bad(%s) → portrait band crop', idx, key or '?')
    assert_costume_cells_nonempty(out, min_ratio=min_ratio, n=n)
    return out

def costume_cell_content_ratios(costume_png: bytes, n: int=4) -> list[float]:
    """服饰栏每格前景像素占比。白底不计；细灰条不计；近黑仅当整格几乎全黑时当空底。"""
    im = Image.open(BytesIO(costume_png)).convert('RGB')
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    ratios: list[float] = []
    for i in range(n):
        x0 = i * cell_w
        x1 = w if i == n - 1 else (i + 1) * cell_w
        cell = im.crop((x0, 0, x1, h))
        px = list(cell.getdata())
        near_black = 0
        fg = 0
        for r, g, b in px:
            if r > 230 and g > 230 and (b > 230):
                continue
            if abs(r - g) < 8 and abs(g - b) < 8 and (140 < r < 210):
                continue
            if r < 28 and g < 28 and (b < 32):
                near_black += 1
                continue
            fg += 1
        if near_black / max(1, len(px)) > 0.85:
            ratios.append(0.0)
        else:
            ratios.append((fg + near_black) / max(1, len(px)))
    return ratios

def _face_bbox_for_center(im: Image.Image) -> tuple[int, int, int, int] | None:
    """拼版用人脸框：优先 InsightFace，其次肤色启发式。"""
    bb = _detect_face_bbox_xyxy(im)
    if bb is not None:
        x0, y0, x1, y1 = (int(bb[0]), int(bb[1]), int(bb[2]), int(bb[3]))
        if x1 > x0 and y1 > y0:
            return (x0, y0, x1, y1)
    hbb = _heuristic_skin_face_bbox(im)
    if hbb is not None:
        x0, y0, x1, y1 = (int(hbb[0]), int(hbb[1]), int(hbb[2]), int(hbb[3]))
        if x1 > x0 and y1 > y0:
            return (x0, y0, x1, y1)
    return None

def _sample_edge_fill_color(im: Image.Image, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    """取源图边缘像素中位色，用于格内补满（18:38：边缘色/浅灰，格内不留白边）。"""
    w, h = im.size
    if w < 2 or h < 2:
        return fallback
    px = im.load()
    samples: list[tuple[int, int, int]] = []
    for x in range(w):
        samples.append(px[x, 0])
        samples.append(px[x, h - 1])
    for y in range(h):
        samples.append(px[0, y])
        samples.append(px[w - 1, y])
    if not samples:
        return fallback
    rs = sorted((c[0] for c in samples))
    gs = sorted((c[1] for c in samples))
    bs = sorted((c[2] for c in samples))
    mid = len(samples) // 2
    return (rs[mid], gs[mid], bs[mid])

def _trim_panel_edge_strips(im: Image.Image, *, max_frac: float=0.22) -> Image.Image:
    """裁掉源图四周纯色/灰边/近白分隔竖条（19:20）。

    1) 四边近均匀且与内侧色差>40，或近白/近灰信箱 → 裁
    2) 靠边的近白低方差分隔带（即便最外缘是噪点）→ 整带以外裁掉
    3) 再走内容包围盒 `_trim_letterbox_rgb` 兜底
    """
    rgb = im.convert('RGB')
    w, h = rgb.size
    if w < 16 or h < 16:
        return im
    px = rgb.load()

    def _col_stats(x: int) -> tuple[float, tuple[float, float, float]]:
        rs = gs = bs = 0.0
        for y in range(h):
            r, g, b = px[x, y]
            rs += r
            gs += g
            bs += b
        n = float(h)
        mean = (rs / n, gs / n, bs / n)
        var = 0.0
        for y in range(h):
            r, g, b = px[x, y]
            var += (r - mean[0]) ** 2 + (g - mean[1]) ** 2 + (b - mean[2]) ** 2
        return (var / (n * 3.0), mean)

    def _row_stats(y: int) -> tuple[float, tuple[float, float, float]]:
        rs = gs = bs = 0.0
        for x in range(w):
            r, g, b = px[x, y]
            rs += r
            gs += g
            bs += b
        n = float(w)
        mean = (rs / n, gs / n, bs / n)
        var = 0.0
        for x in range(w):
            r, g, b = px[x, y]
            var += (r - mean[0]) ** 2 + (g - mean[1]) ** 2 + (b - mean[2]) ** 2
        return (var / (n * 3.0), mean)

    def _delta(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
        return (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0

    def _is_letterbox(mean: tuple[float, float, float]) -> bool:
        r, g, b = mean
        mx, mn = (max(r, g, b), min(r, g, b))
        if r > 230 and g > 230 and (b > 230):
            return True
        if mx - mn < 16 and 60 <= mx <= 220:
            return True
        if mx < 28 and mx - mn < 12:
            return True
        return False

    def _is_white_sep(var: float, mean: tuple[float, float, float]) -> bool:
        return var < 100.0 and mean[0] > 220 and (mean[1] > 220) and (mean[2] > 220)
    max_x = max(2, int(w * max_frac))
    max_y = max(2, int(h * max_frac))
    left = 0
    while left < max_x:
        var, mean = _col_stats(left)
        _, inner = _col_stats(min(w - 1, left + 8))
        if var < 120.0 and _delta(mean, inner) > 40.0 or (var < 80.0 and _is_letterbox(mean)):
            left += 1
            continue
        break
    right = w
    while w - right < max_x and right > left + 8:
        var, mean = _col_stats(right - 1)
        _, inner = _col_stats(max(0, right - 9))
        if var < 120.0 and _delta(mean, inner) > 40.0 or (var < 80.0 and _is_letterbox(mean)):
            right -= 1
            continue
        break
    white_right = [x for x in range(max(left, w - max_x), right) if _is_white_sep(*_col_stats(x))]
    if white_right:
        right = min(white_right)
    white_left = [x for x in range(left, min(right, left + max_x)) if _is_white_sep(*_col_stats(x))]
    if white_left:
        left = max(white_left) + 1
    top = 0
    while top < max_y:
        var, mean = _row_stats(top)
        _, inner = _row_stats(min(h - 1, top + 8))
        if var < 120.0 and _delta(mean, inner) > 40.0 or (var < 80.0 and _is_letterbox(mean)):
            top += 1
            continue
        break
    bot = h
    while h - bot < max_y and bot > top + 8:
        var, mean = _row_stats(bot - 1)
        _, inner = _row_stats(max(0, bot - 9))
        if var < 120.0 and _delta(mean, inner) > 40.0 or (var < 80.0 and _is_letterbox(mean)):
            bot -= 1
            continue
        break
    if right - left < 16 or bot - top < 16:
        return im
    cropped = rgb.crop((left, top, right, bot))
    trimmed = _trim_letterbox_rgb(cropped)
    return trimmed if trimmed.size[0] >= 16 and trimmed.size[1] >= 16 else cropped

def _content_head_bbox(im: Image.Image) -> tuple[int, int, int, int] | None:
    """整头外轮廓（含发丝），跳过近白/近灰底；供侧脸格定位（19:42）。"""
    rgb = im.convert('RGB')
    w, h = rgb.size
    if w < 8 or h < 8:
        return None
    tw, th = (min(160, w), min(160, h))
    small = rgb.resize((tw, th), Image.Resampling.BILINEAR)
    sp = small.load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(th):
        for x in range(tw):
            r, g, b = sp[x, y]
            mx, mn = (max(r, g, b), min(r, g, b))
            if r > 235 and g > 235 and (b > 235):
                continue
            if mx - mn < 14 and 65 <= mx <= 210:
                continue
            if mx < 24 and mx - mn < 10:
                continue
            xs.append(x)
            ys.append(y)
    if len(xs) < 12:
        return None
    minx, maxx = (min(xs), max(xs))
    miny, maxy = (min(ys), max(ys))
    pad = 2
    minx, miny = (max(0, minx - pad), max(0, miny - pad))
    maxx, maxy = (min(tw - 1, maxx + pad), min(th - 1, maxy + pad))
    x0 = int(minx * w / tw)
    x1 = int((maxx + 1) * w / tw)
    y0 = int(miny * h / th)
    y1 = int((maxy + 1) * h / th)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return (x0, y0, x1, y1)

def _sample_edge_bg(im: Image.Image) -> tuple[int, int, int]:
    """兼容旧名：侧脸垫色改走左/上边缘背景中位色（20:22）。"""
    return _sample_profile_bg(im)

def _sample_profile_bg(im: Image.Image) -> tuple[int, int, int]:
    """取 R 源图左/上边缘低彩度背景中位色（约浅灰紫），避免深发角把垫色拉黑（20:22）。"""
    rgb = im.convert('RGB')
    ww, hh = rgb.size
    band = max(6, min(16, ww // 48, hh // 48))
    samples: list[tuple[int, int, int]] = []
    px = rgb.load()
    for y in range(hh):
        for x in range(band):
            samples.append(px[x, y])
    for y in range(band):
        for x in range(ww):
            samples.append(px[x, y])
    if not samples:
        return (228, 228, 234)
    bg: list[tuple[int, int, int]] = []
    for r, g, b in samples:
        mx, mn = (max(r, g, b), min(r, g, b))
        mean = (r + g + b) / 3.0
        if mx - mn < 36 and 170 <= mean <= 245:
            bg.append((r, g, b))
    use = bg if len(bg) >= 24 else samples
    use_sorted = sorted(use)
    mid = use_sorted[len(use_sorted) // 2]
    return (int(mid[0]), int(mid[1]), int(mid[2]))

def _feather_paste_rgb(canvas: Image.Image, src: Image.Image, xy: tuple[int, int], *, feather: int=12, sides: tuple[str, ...] | None=None) -> Image.Image:
    """把 src 贴到 canvas，在接缝处做 feather px 线性羽化，消除硬边（20:22/20:38）。

    sides: 限制羽化边；None=四边。fix45 侧脸只羽化鼻前侧（left/right），避免顶边羽化出浅底刀切线。
    """
    out = canvas.convert('RGB')
    s = src.convert('RGB')
    px, py = xy
    fw = max(0, int(feather))
    if fw <= 0:
        out.paste(s, (px, py))
        return out
    mask = Image.new('L', s.size, 255)
    mp = mask.load()
    sw, sh = s.size
    use = set(sides) if sides is not None else {'left', 'right', 'top', 'bottom'}
    for y in range(sh):
        for x in range(sw):
            dists: list[int] = []
            if 'left' in use:
                dists.append(x)
            if 'right' in use:
                dists.append(sw - 1 - x)
            if 'top' in use:
                dists.append(y)
            if 'bottom' in use:
                dists.append(sh - 1 - y)
            if not dists:
                continue
            d = min(dists)
            if d < fw:
                mp[x, y] = int(round(255 * (d + 1) / (fw + 1)))
    out.paste(s, (px, py), mask)
    return out

def _fit_profile_head_cell(img: Image.Image, box: tuple[int, int, int, int], *, face_height_frac: float=0.62, lead_margin: float=0.12, top_margin: float=0.0, min_face_height_frac: float=0.55, max_face_height_frac: float=0.75) -> tuple[Image.Image, tuple[int, int]]:
    """侧脸格：源图顶边对齐格顶（top_pad=0）；仅鼻前侧补背景色+12px羽化；贴底（20:38 fix45）。

    - 外框与 L/M 同为 box 尺寸
    - 禁止顶边垫色（消除发顶约 19% 浅底刀切线）
    - 鼻前留白 ≥ lead_margin；衣服贴格底（cover 无底垫 letterbox）
    - L/M 路径不走本函数
    """
    x, y, w, h = box
    src_rgb = img.convert('RGB')
    fill = _sample_profile_bg(src_rgb)
    face = _face_bbox_for_center(src_rgb)
    head = _content_head_bbox(src_rgb)
    if head is not None:
        hx0, hy0, hx1, hy1 = head
        if hx1 - hx0 >= src_rgb.width * 0.92 or hy1 - hy0 >= src_rgb.height * 0.92:
            head = None
    if face is None and head is None:
        return _fit_cover_keep_crown(src_rgb, box)
    if face is None and head is not None:
        hx0, hy0, hx1, hy1 = head
        face = (hx0, hy0, hx1, hy0 + max(8, int((hy1 - hy0) * 0.55)))
    assert face is not None
    fx0, fy0, fx1, fy1 = face
    fw = max(8.0, float(fx1 - fx0))
    fh = max(8.0, float(fy1 - fy0))
    if head is None:
        head = (int(max(0, fx0 - 0.4 * fw)), int(max(0, fy0 - 0.65 * fh)), int(min(src_rgb.width, fx1 + 0.55 * fw)), int(min(src_rgb.height, fy1 + 0.9 * fh)))
    hx0, hy0, hx1, hy1 = head
    facing_left = fx0 - hx0 <= hx1 - fx1
    nose_x = float(fx0 if facing_left else fx1)
    if facing_left:
        nose_x = float(min(nose_x, hx0 + 0.02 * max(8.0, hx1 - hx0)))
    else:
        nose_x = float(max(nose_x, hx1 - 0.02 * max(8.0, hx1 - hx0)))
    pad_t = 0
    _ = (face_height_frac, top_margin, min_face_height_frac, max_face_height_frac, fh)
    scale0 = max(w / float(src_rgb.width), h / float(src_rgb.height))
    place_lead = float(lead_margin) + 0.05
    lead_src = place_lead * w / max(1e-06, scale0)
    if facing_left:
        pad_l = max(0, int(math.ceil(lead_src - nose_x + 1e-06)))
        pad_r = 0
        feather_sides: tuple[str, ...] = ('left',)
    else:
        pad_l = 0
        pad_r = max(0, int(math.ceil(lead_src - (src_rgb.width - nose_x) + 1e-06)))
        feather_sides = ('right',)
    work_w = src_rgb.width + pad_l + pad_r
    work_h = src_rgb.height + pad_t
    work = Image.new('RGB', (work_w, work_h), fill)
    work = _feather_paste_rgb(work, src_rgb, (pad_l, pad_t), feather=12, sides=feather_sides)
    scale = max(w / float(work_w), h / float(work_h))
    nw = max(1, int(round(work_w * scale)))
    nh = max(1, int(round(work_h * scale)))
    scaled = work.resize((nw, nh), Image.Resampling.LANCZOS)
    nose_scaled = (nose_x + pad_l) * scale
    if facing_left:
        left = int(round(nose_scaled - place_lead * w))
    else:
        left = int(round(nose_scaled - (1.0 - place_lead) * w))
    left = max(0, min(left, max(0, nw - w)))
    top = 0
    if top + h > nh:
        top = max(0, nh - h)
    if left + w > nw:
        left = max(0, nw - w)
    out = scaled.crop((left, top, left + w, top + h))
    if out.size != (w, h):
        canvas = Image.new('RGB', (w, h), fill)
        px = 0 if facing_left else max(0, w - out.width)
        canvas = _feather_paste_rgb(canvas, out, (px, 0), feather=12, sides=feather_sides)
        out = canvas
    _fit_profile_head_cell.last_pad = {'top_pad': int(pad_t), 'pad_l': int(pad_l), 'pad_r': int(pad_r), 'facing_left': bool(facing_left), 'lead_margin': float(lead_margin)}
    return (out.convert('RGBA'), (x, y))

def collage_face_triplet_equal_width(faces: list[bytes], *, cell_w: int=256, cell_h: int=384, gap: int=12, bg: tuple[int, int, int]=(248, 248, 252), face_width_frac: float=0.7, face_height_frac: float=0.5, min_side_margin: float=0.1) -> bytes:
    """面部三格同宽同高横拼（19:20 / 20:38）。

    L/M：裁边缘杂条后按人脸 cover 铺满并保头顶（像素路径不动）。
    R（侧脸）：源图顶边对齐格顶（top_pad=0），仅鼻前≥12% 补背景色+羽化，贴底铺满 240×320。
    face_* 参数保留签名兼容。
    """
    if len(faces) != 3:
        raise CharacterSheetError(f'face triplet needs 3 images, got {len(faces)}')
    _ = (face_width_frac, face_height_frac, min_side_margin)
    canvas = Image.new('RGB', (3 * cell_w + 2 * gap, cell_h), bg)
    for i, raw in enumerate(faces):
        im = _trim_panel_edge_strips(Image.open(BytesIO(raw)).convert('RGB'))
        if i == 2:
            fitted, _pos = _fit_profile_head_cell(im, (0, 0, cell_w, cell_h))
        else:
            fitted, _pos = _fit_cover_keep_crown(im, (0, 0, cell_w, cell_h))
        canvas.paste(fitted.convert('RGB'), (i * (cell_w + gap), 0))
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

def measure_face_triplet_layout(faces_png: bytes, *, n: int=3, cell_w: int | None=None, gap: int=0) -> dict:
    """量测面部三格：几何格宽 + 人脸框宽/左右边距。"""
    im = Image.open(BytesIO(faces_png)).convert('RGB')
    w, h = im.size
    if cell_w is not None:
        cells = []
        for i in range(n):
            x0 = i * (cell_w + gap)
            cells.append(im.crop((x0, 0, x0 + cell_w, h)))
    else:
        cell = w // n
        cells = [im.crop((i * cell, 0, (i + 1) * cell if i < n - 1 else w, h)) for i in range(n)]
    face_widths: list[int] = []
    face_heights: list[int] = []
    face_height_fracs: list[float] = []
    margins: list[dict] = []
    for cim in cells:
        bb = _face_bbox_for_center(cim)
        if bb is None:
            face_widths.append(0)
            face_heights.append(0)
            face_height_fracs.append(0.0)
            margins.append({'left': 0.0, 'right': 0.0, 'bbox': None})
            continue
        x0, y0, x1, y1 = bb
        fh = y1 - y0
        face_widths.append(x1 - x0)
        face_heights.append(fh)
        face_height_fracs.append(fh / max(1, cim.height))
        margins.append({'left': x0 / max(1, cim.width), 'right': (cim.width - x1) / max(1, cim.width), 'bbox': [x0, y0, x1, y1]})
    return {'panel_size': [w, h], 'cell_widths': [c.width for c in cells], 'cell_heights': [c.height for c in cells], 'face_widths': face_widths, 'face_heights': face_heights, 'face_height_fracs': face_height_fracs, 'margins': margins}

def collage_costume_items(items: list[bytes], *, style: str) -> bytes:
    """单品横排拼成 costume 区图（4 或 5 格）；正方形格 + 包围盒 letterbox,不裁切。"""
    n = max(1, len(items))
    cell = 256
    pad = 8
    w = n * cell + pad * 2
    h = cell + pad * 2
    bg = (240, 240, 244) if sheet_uses_anime_xl(style) else (200, 200, 206)
    canvas = Image.new('RGB', (w, h), bg)
    for i, raw in enumerate(items):
        try:
            im = Image.open(BytesIO(raw)).convert('RGB')
        except Exception:
            continue
        im = _trim_object_bbox(im, style=style)
        box = (pad + i * cell + 4, pad + 4, cell - 8, cell - 8)
        _paste(canvas, im, box, cover=style in ('anime', '二次元'))
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

def compose_boot_pair(single_boot: bytes, *, style: str, size: int=768) -> bytes:
    """单靴 PNG → 左右一对(右靴镜像),保证服饰格正好两只。"""
    try:
        boot = Image.open(BytesIO(single_boot)).convert('RGB')
    except Exception:
        boot = Image.new('RGB', (size, size), (255, 255, 255))
    boot = _trim_object_bbox(boot, style=style, pad=8)
    bg = (255, 255, 255) if sheet_uses_anime_xl(style) else (200, 200, 206)
    canvas = Image.new('RGB', (size, size), bg)
    target_h = int(size * 0.78)
    ratio = target_h / max(1, boot.height)
    tw = max(1, int(boot.width * ratio))
    boot_r = boot.resize((tw, target_h), Image.Resampling.LANCZOS)
    boot_l = boot_r.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    gap = max(8, size // 40)
    total_w = boot_l.width + boot_r.width + gap
    x0 = max(0, (size - total_w) // 2)
    y0 = max(0, (size - target_h) // 2)
    canvas.paste(boot_l, (x0, y0))
    canvas.paste(boot_r, (x0 + boot_l.width + gap, y0))
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

def _trim_object_bbox(img: Image.Image, *, style: str, pad: int=12) -> Image.Image:
    """按物品包围盒裁切(去大片纯色底),供 letterbox 拼版。"""
    rgb = img.convert('RGB')
    w, h = rgb.size
    px = rgb.load()
    if sheet_uses_anime_xl(style):

        def _fg(r, g, b) -> bool:
            if r > 230 and g > 230 and (b > 230):
                return False
            if abs(r - g) < 14 and abs(g - b) < 14 and (r >= 185):
                return False
            if abs(r - g) < 8 and abs(g - b) < 8 and (140 < r < 210):
                return False
            return True
    else:

        def _fg(r, g, b) -> bool:
            if r < 45 and g < 45 and (b < 50):
                return False
            if abs(r - g) < 18 and abs(g - b) < 18 and (150 <= (r + g + b) // 3 <= 230):
                return False
            return True
    min_x, min_y, max_x, max_y = (w, h, 0, 0)
    found = False
    for y in range(h):
        for x in range(w):
            if _fg(*px[x, y]):
                found = True
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if not found or max_x <= min_x or max_y <= min_y:
        return rgb
    min_x = max(0, min_x - pad)
    min_y = max(0, min_y - pad)
    max_x = min(w - 1, max_x + pad)
    max_y = min(h - 1, max_y + pad)
    return rgb.crop((min_x, min_y, max_x + 1, max_y + 1))

def costume_cell_edge_density(cell: Image.Image | bytes) -> float:
    """15:52：边缘密度——灰度邻域差分的 RMS/255，纯色布≈0，缝线/褶皱/拉链偏高。"""
    if isinstance(cell, (bytes, bytearray)):
        im = Image.open(BytesIO(cell)).convert('L')
    else:
        im = cell.convert('L')
    im = im.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(im.getdata())
    w = h = 64
    acc2 = 0.0
    n = 0
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            dx = abs(int(px[y * w + x + 1]) - int(px[y * w + x - 1]))
            dy = abs(int(px[(y + 1) * w + x]) - int(px[(y - 1) * w + x]))
            g = (dx + dy) / 2.0
            acc2 += g * g
            n += 1
    return (acc2 / float(max(1, n))) ** 0.5 / 255.0

def normalize_turnaround_figure(data: bytes, *, out_w: int=768, out_h: int=1152) -> bytes:
    """裁掉大块灰/白底后按高度贴满到刻度(≈165cm):脚底贴底、头顶近顶。

    fix12:宽袖/横幅人物若按宽缩放会变矮(古风汉服常见);改为始终按高度铺满,
    超出宽度则水平居中裁切,禁止回落为矮小人形。
    """
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = small.load()
    ys, xs = ([], [])
    for y in range(64):
        for x in range(64):
            r, g, b = px[x, y]
            if r > 235 and g > 235 and (b > 235):
                continue
            if abs(r - g) < 14 and abs(g - b) < 14 and (150 <= r <= 235):
                continue
            if abs(r - g) < 12 and abs(g - b) < 12 and (35 <= r <= 110):
                continue
            ys.append(y)
            xs.append(x)
    if len(ys) < 30:
        fitted, _ = _fit(img.convert('RGBA'), (0, 0, out_w, out_h), cover=False)
        canvas = Image.new('RGB', (out_w, out_h), (230, 230, 234))
        canvas.paste(fitted.convert('RGB'), ((out_w - fitted.width) // 2, out_h - fitted.height))
        buf = BytesIO()
        canvas.save(buf, format='PNG')
        return buf.getvalue()
    top = max(0, int(min(ys) * h / 64) - 4)
    bottom = min(h, int(max(ys) * h / 64) + 8)
    left = max(0, int(min(xs) * w / 64) - 8)
    right = min(w, int(max(xs) * w / 64) + 8)
    crop = img.crop((left, top, right, bottom))
    scale = out_h / max(1, crop.height)
    nw, nh = (max(1, int(crop.width * scale)), out_h)
    crop = crop.resize((nw, nh), Image.Resampling.LANCZOS)
    if nw > out_w:
        left_c = (nw - out_w) // 2
        crop = crop.crop((left_c, 0, left_c + out_w, out_h))
        nw = out_w
    canvas = Image.new('RGB', (out_w, out_h), (230, 230, 234))
    canvas.paste(crop, ((out_w - nw) // 2, 0))
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()
