"""设定卡门禁与阈值常量(待办#3 snapshot 保留在此)."""
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







def _hex_hsv(hx: str) -> tuple[float, float, float]:
    r, g, b = (int(hx[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
    return colorsys.rgb_to_hsv(r, g, b)

def _hsv_hex(h: float, s: float, v: float) -> str:
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, max(0.0, min(1.0, s)), max(0.0, min(1.0, v)))
    return f'#{round(r * 255):02X}{round(g * 255):02X}{round(b * 255):02X}'

def _is_near_black_hex(hx: str) -> bool:
    return max(int(hx[1:3], 16), int(hx[3:5], 16), int(hx[5:7], 16)) < 40

def _is_near_gold_hex(hx: str) -> bool:
    return _hex_dist(hx, _ANCIENT_GOLD_HEX) < 90

def _near_spec_hue(hx: str, target: str, max_deg: float | None=None) -> bool:
    if max_deg is None:
        max_deg = SPEC_COLOR_MAX_HUE_DEG
    h, s, v = _hex_hsv(hx)
    th, _ts, _tv = _hex_hsv(target)
    if s < 0.15 or v < 0.18:
        return False
    d = abs(h - th) * 360.0
    return min(d, 360.0 - d) <= max_deg

HAIRPIN_GOLD_MAX_FRAC = 0.06

def hair_ornament_gold_frac(data: bytes) -> dict[str, Any]:
    """主立绘头顶发饰区(脸框上方)金色/黄铜色像素占比;找不到脸 → frac=None(不门禁)。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    bb = _face_bbox_for_center(im)
    if bb is None:
        return {'frac': None, 'box': None}
    x0, y0, x1, y1 = bb
    fw, fh = (max(1, x1 - x0), max(1, y1 - y0))
    w, h = im.size
    box = (max(0, int(x0 - 0.35 * fw)), max(0, int(y0 - 0.75 * fh)), min(w, int(x1 + 0.35 * fw)), min(h, int(y0 + 0.2 * fh)))
    if box[2] <= box[0] or box[3] <= box[1]:
        return {'frac': None, 'box': box}
    reg = im.crop(box)
    reg.thumbnail((128, 128))
    n = gold = 0
    for r, g, b in list(reg.getdata()):
        n += 1
        hh, ss, vv = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        if 36.0 <= hh * 360.0 <= 60.0 and ss >= 0.4 and (vv >= 0.5):
            gold += 1
    return {'frac': gold / n if n else 0.0, 'box': box}

def assert_hairpin_not_gold(data: bytes, meta: SheetMeta, *, label: str='主立绘') -> dict[str, Any]:
    """木簪 spec:发饰区金色占比 > 上限 → CharacterSheetError(422)。非木簪/无脸 → 放行。"""
    if not ancient_accessory_prompt_fix(meta)['wooden_hairpin']:
        return {'frac': None, 'skipped': True}
    st = hair_ornament_gold_frac(data)
    frac = st.get('frac')
    if frac is not None and frac > HAIRPIN_GOLD_MAX_FRAC:
        raise CharacterSheetError(f'饰品门禁失败:{label}发饰区金色占比{frac:.3f}>{HAIRPIN_GOLD_MAX_FRAC}(spec 木簪),重出', status_code=422)
    return st

ACCESSORY_QA_HARD_ATTEMPTS = 4

SPEC_COLOR_MAX_HUE_DEG = 40.0

SPEC_COLOR_MIN_NEAR_FRAC = 0.25

SPEC_COLOR_MAX_DARK_FRAC = 0.45

SPEC_COLOR_ACHROMATIC_MAX_DIST = 110

def _garment_roi_pixels(data: bytes) -> list[tuple[int, int, int]]:
    """与 _panel_garment_dominant_hex 同 ROI/背景/肤色规则取服装像素。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    corners = [img.getpixel((2, 2)), img.getpixel((w - 3, 2)), img.getpixel((2, h - 3)), img.getpixel((w - 3, h - 3))]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))
    crop = img.crop((int(w * 0.22), int(h * 0.28), int(w * 0.78), int(h * 0.78)))
    small = crop.resize((48, 48), Image.Resampling.BOX)
    out: list[tuple[int, int, int]] = []
    for r, g, b in small.getdata():
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 22:
            continue
        if min(r, g, b) > 235:
            continue
        if 90 < r < 245 and 60 < g < 210 and (45 < b < 190) and (r >= g - 5) and (g >= b - 15):
            continue
        out.append((r, g, b))
    return out

def garment_spec_color_stats(data: bytes, target: str) -> dict[str, Any]:
    px = _garment_roi_pixels(data)
    tr, tg, tb = (int(target[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
    th, ts, _tv = colorsys.rgb_to_hsv(tr, tg, tb)
    n = len(px)
    dark = near = 0
    for r, g, b in px:
        hh, ss, vv = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        if vv < 0.2:
            dark += 1
            continue
        if ss >= 0.15 and vv >= 0.18:
            d = abs(hh - th) * 360.0
            if min(d, 360.0 - d) <= SPEC_COLOR_MAX_HUE_DEG:
                near += 1
    return {'n': n, 'dark_frac': dark / n if n else 1.0, 'near_frac': near / n if n else 0.0, 'dominant': _panel_garment_dominant_hex(data), 'chromatic': ts >= 0.2}

def assert_garment_near_spec_color(data: bytes, target: str, *, label: str='主立绘') -> dict[str, Any]:
    """古风:服装主色须贴近 spec 颜色(参照 anime 板岩灰门禁);不过 → 422 重出(不着色)。"""
    st = garment_spec_color_stats(data, target)
    if st['n'] < 40:
        raise CharacterSheetError(f'颜色门禁失败:{label}无法取服装像素', status_code=422)
    if st['chromatic']:
        if st['dark_frac'] > SPEC_COLOR_MAX_DARK_FRAC:
            raise CharacterSheetError(f"颜色门禁失败:{label}服装近黑占比{st['dark_frac']:.2f}>{SPEC_COLOR_MAX_DARK_FRAC}(主色{st['dominant']}),须 spec 色{target},重出", status_code=422)
        if st['near_frac'] < SPEC_COLOR_MIN_NEAR_FRAC:
            raise CharacterSheetError(f"颜色门禁失败:{label}服装贴近 spec 色{target}占比{st['near_frac']:.2f}<{SPEC_COLOR_MIN_NEAR_FRAC}(主色{st['dominant']}),重出", status_code=422)
        return st
    hx = st['dominant']
    if not hx or _hex_dist(hx, target) > SPEC_COLOR_ACHROMATIC_MAX_DIST:
        raise CharacterSheetError(f'颜色门禁失败:{label}服装主色{hx}距 spec 色{target}>{SPEC_COLOR_ACHROMATIC_MAX_DIST},重出', status_code=422)
    return st

def _panel_garment_dominant_hex(data: bytes) -> str | None:
    """从立绘/三视图躯干 ROI 按面积取服装主色（跳过肤色/近背景）。"""
    try:
        img = Image.open(BytesIO(data)).convert('RGB')
    except Exception:
        return None
    w, h = img.size
    corners = [img.getpixel((2, 2)), img.getpixel((w - 3, 2)), img.getpixel((2, h - 3)), img.getpixel((w - 3, h - 3))]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))
    crop = img.crop((int(w * 0.22), int(h * 0.28), int(w * 0.78), int(h * 0.78)))
    small = crop.resize((48, 48), Image.Resampling.BOX)
    colors = small.getcolors(48 * 48) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    best = None
    best_cnt = 0
    for cnt, (r, g, b) in colors:
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 22:
            continue
        if r + g + b < 40:
            if best is None:
                best, best_cnt = ((r, g, b), cnt)
            continue
        if min(r, g, b) > 235:
            continue
        if 90 < r < 245 and 60 < g < 210 and (45 < b < 190) and (r >= g - 5) and (g >= b - 15):
            continue
        if cnt > best_cnt:
            best, best_cnt = ((r, g, b), cnt)
    if best is None:
        return None
    r, g, b = best
    return f'#{r:02X}{g:02X}{b:02X}'

def _hex_luma(hx: str) -> float:
    return (int(hx[1:3], 16) + int(hx[3:5], 16) + int(hx[5:7], 16)) / 3.0

def _hex_dist(a: str, b: str) -> float:
    ar, ag, ab = (int(a[1:3], 16), int(a[3:5], 16), int(a[5:7], 16))
    br, bg, bb = (int(b[1:3], 16), int(b[3:5], 16), int(b[5:7], 16))
    return abs(ar - br) + abs(ag - bg) + abs(ab - bb)

SLATE_GRAY_TARGET = '#5A6A7A'

SLATE_GRAY_MAX_DIST = 85

SLATE_GRAY_MAX_LUMA = 175.0

FACE_HEIGHT_FRAC_MIN = 0.55

FACE_HEIGHT_FRAC_MAX = 0.65

FACE_HEIGHT_FRAC_TARGET = 0.58

def sheet_gate_threshold_snapshot() -> dict:
    """质量门魔法数快照(标定/审计用;改阈值须同步测试边界夹具)。"""
    return {'slate_gray_target': SLATE_GRAY_TARGET, 'slate_gray_max_dist': SLATE_GRAY_MAX_DIST, 'slate_gray_max_luma': SLATE_GRAY_MAX_LUMA, 'face_height_frac_min': FACE_HEIGHT_FRAC_MIN, 'face_height_frac_max': FACE_HEIGHT_FRAC_MAX, 'face_height_frac_target': FACE_HEIGHT_FRAC_TARGET, 'spec_color_max_hue_deg': SPEC_COLOR_MAX_HUE_DEG, 'spec_color_min_near_frac': SPEC_COLOR_MIN_NEAR_FRAC, 'spec_color_max_dark_frac': SPEC_COLOR_MAX_DARK_FRAC, 'spec_color_achromatic_max_dist': SPEC_COLOR_ACHROMATIC_MAX_DIST, 'hairpin_gold_max_frac': HAIRPIN_GOLD_MAX_FRAC, 'garment_consistency_max_dist_default': 90, 'notes': {'toonflow_board': '五格(portrait+四视图);跳过表情格脸高门;anime 主立绘仍走板岩灰绝对色门(无 front 母版时)', 'delivery': '零质量通过真机样本=未交付(E-3);本快照仅钉死现行阈值供离线标定'}}

def force_slate_garment_tint(data: bytes, *, target: str=SLATE_GRAY_TARGET, strength: float=0.85) -> bytes:
    """16:18：已禁用。整图着色/矩形铺色路径删除，不留开关。"""
    raise CharacterSheetError('已禁用整图着色(force_slate_garment_tint)，须重出而非程序上色', status_code=422)
    '把人物内容框内服装区主色拉向板岩灰（保留明暗结构）。img2img 重染失败时的硬兜底。'
    tr, tg, tb = (int(target[1:3], 16), int(target[3:5], 16), int(target[5:7], 16))
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    px = img.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))
    small = img.resize((64, 64), Image.Resampling.BOX)
    sp = list(small.getdata())

    def _is_bg_s(r, g, b, tol=18):
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < tol
    rows = []
    for y in range(64):
        fg = sum((1 for x in range(64) if not _is_bg_s(*sp[y * 64 + x], 22)))
        rows.append(fg / 64.0)
    cols = []
    for x in range(64):
        fg = sum((1 for y in range(64) if not _is_bg_s(*sp[y * 64 + x], 22)))
        cols.append(fg / 64.0)
    top = next((i for i, v in enumerate(rows) if v > 0.06), 0)
    bot = next((i for i, v in enumerate(reversed(rows)) if v > 0.06), 0)
    left = next((i for i, v in enumerate(cols) if v > 0.06), 0)
    right = next((i for i, v in enumerate(reversed(cols)) if v > 0.06), 0)
    y0 = max(0, int(h * top / 64) - 2)
    y1 = min(h, int(h * (64 - bot) / 64) + 2)
    x0 = max(0, int(w * left / 64) - 2)
    x1 = min(w, int(w * (64 - right) / 64) + 2)
    if y1 - y0 < h * 0.2 or x1 - x0 < w * 0.15:
        x0, x1, y0, y1 = (int(w * 0.18), int(w * 0.82), int(h * 0.22), int(h * 0.92))
    s = max(0.0, min(1.0, float(strength)))
    face_y1 = y0 + int((y1 - y0) * 0.28)
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 14:
                continue
            if y < face_y1 and 95 < r < 250 and (70 < g < 220) and (55 < b < 200) and (r >= g - 8):
                continue
            luma = (r + g + b) / 3.0
            mid = (tr + tg + tb) / 3.0
            delta = max(-0.18, min(0.18, (luma - mid) / 255.0))
            nr = int(max(0, min(255, tr * (1.0 + delta))))
            ng = int(max(0, min(255, tg * (1.0 + delta))))
            nb = int(max(0, min(255, tb * (1.0 + delta))))
            local_s = s
            if luma > 170:
                local_s = min(1.0, s + 0.12)
            px[x, y] = (int(r * (1 - local_s) + nr * local_s), int(g * (1 - local_s) + ng * local_s), int(b * (1 - local_s) + nb * local_s))
    buf = BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()

def assert_garment_near_slate_gray(data: bytes, *, target: str=SLATE_GRAY_TARGET, max_dist: float=SLATE_GRAY_MAX_DIST, label: str='主立绘') -> str:
    """衣服区域主色须贴近板岩灰 #5A6A7A，否则 422 重出。"""
    hx = _panel_garment_dominant_hex(data)
    if not hx:
        raise CharacterSheetError(f'颜色门禁失败:{label}无法取服装主色', status_code=422)
    dist = _hex_dist(hx, target)
    luma = _hex_luma(hx)
    if luma > SLATE_GRAY_MAX_LUMA:
        raise CharacterSheetError(f'颜色门禁失败:{label}服装主色过浅近白({hx} luma={luma:.0f})，须板岩灰{target}', status_code=422)
    if dist > float(max_dist):
        raise CharacterSheetError(f'颜色门禁失败:{label}服装主色{hx}距{target}={dist:.0f}>{max_dist}，须重出', status_code=422)
    return hx

def assert_fullbody_portrait_face_ok(data: bytes) -> None:
    """全身主立绘人脸门禁。

    二次元立绘 insightface 常检不出；人物又常偏画幅下半。
    策略：能检出脸更好；否则按内容框上半裁头肩做启发式；再退到
    「非空白 + 内容框上缘有肤色/五官色块」。
    """
    if _panel_is_blank_or_glitch(data):
        raise CharacterSheetError('主立绘人脸门禁失败:空白/花屏', status_code=422)
    try:
        assert_face_visible(data, min_face_area=0.003)
        return
    except CharacterSheetError:
        pass
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    small = img.resize((64, 64), Image.Resampling.BOX)
    px = list(small.getdata())
    corners = [px[1 * 64 + 1], px[1 * 64 + 62], px[62 * 64 + 1], px[62 * 64 + 62]]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))

    def _bg(r, g, b):
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 28
    top_row = 0
    for y in range(64):
        if sum((1 for x in range(64) if not _bg(*px[y * 64 + x]))) / 64.0 > 0.08:
            top_row = y
            break
    y0 = max(0, int(h * (top_row / 64.0) - 0.02 * h))
    y1 = min(h, y0 + int(h * 0.45))
    x0, x1 = (int(w * 0.15), int(w * 0.85))
    head = img.crop((x0, y0, x1, y1))
    buf = BytesIO()
    head.save(buf, format='PNG')
    head_b = buf.getvalue()
    try:
        assert_face_visible(head_b, min_face_area=0.02)
        return
    except CharacterSheetError:
        pass
    if face_crop_looks_ok(head_b):
        return
    hs = head.resize((48, 48), Image.Resampling.BILINEAR)
    hp = list(hs.getdata())
    faceish = 0
    for r, g, b in hp:
        if 90 < r < 250 and 70 < g < 230 and (60 < b < 210) and (r >= g - 10):
            faceish += 1
        elif abs(r - g) < 18 and abs(g - b) < 18 and (70 < r < 230):
            faceish += 0.5
    if faceish / max(1, len(hp)) >= 0.06 and fill_h >= 0.25:
        return
    raise CharacterSheetError('主立绘人脸门禁失败:无可辨识人脸/头肩', status_code=422)

def dump_rejected_panel(data: bytes | None, *, seed: int | None, panel: str, gate: str, detail: str, dump_dir: str | Path | None=None) -> Path | None:
    """17:47：失败必须落盘拒图 + 门禁名/数值 JSON。"""
    if not data:
        return None
    root = Path(dump_dir or os.environ.get('TOIV_SHEET_REJECT_DIR') or '/tmp/toiv_sheet_rejects')
    root.mkdir(parents=True, exist_ok=True)
    tag = f"rejected_{(seed if seed is not None else 'noseed')}_{panel}"
    png_path = root / f'{tag}.png'
    json_path = root / f'{tag}.json'
    try:
        png_path.write_bytes(data)
        try:
            img = Image.open(BytesIO(data)).convert('RGB')
            w, h = img.size
            draw = ImageDraw.Draw(img)
            draw.rectangle([int(w * 0.35), int(h * 0.32), int(w * 0.65), int(h * 0.52)], outline=(255, 64, 64), width=3)
            thumb = img.copy()
            thumb.thumbnail((512, 512))
            thumb.save(root / f'{tag}_box.jpg', quality=85)
        except Exception:
            pass
        json_path.write_text(json.dumps({'seed': seed, 'panel': panel, 'gate': gate, 'detail': detail, 'bytes': len(data)}, ensure_ascii=False, indent=2), encoding='utf-8')
        return png_path
    except Exception as e:
        logger.warning('dump_rejected_panel fail %s: %s', tag, e)
        return None

def _chest_emblem_scores(data: bytes, *, below_face: bool=False) -> tuple[int, int, int]:
    """胸口 ROI 的 (bright, chroma, n)。失败返回 (0,0,0)。

    18:23 below_face=True：近景表情脸占上半幅时，ROI 改到脸框下方（下巴~锁骨），
    避免眼睛/嘴唇高 chroma 被误判成胸口徽标。
    22:20：ROI 严格脸框下沿以下；检测器无脸框则画高 45% 以下（不用会吞胸口的肤色启发式）。
    """
    try:
        img = Image.open(BytesIO(data)).convert('RGB')
    except Exception:
        return (0, 0, 0)
    w, h = img.size
    if below_face:
        bb = _detect_face_bbox_xyxy(data)
        x0, x1 = (int(w * 0.28), int(w * 0.72))
        if bb is None:
            y0, y1 = (int(h * 0.45), int(h * 0.98))
        else:
            _x1, _y1, _x2, y2 = [float(v) for v in bb]
            chin = float(y2)
            if chin / float(h) > 0.62:
                y0, y1 = (int(h * 0.45), int(h * 0.98))
            else:
                y0 = int(min(h - 2, chin + max(2.0, 0.02 * float(h))))
                y1 = int(h * 0.98)
                if y1 <= y0 + 8:
                    y0, y1 = (int(h * 0.45), int(h * 0.98))
    else:
        x0, x1 = (int(w * 0.35), int(w * 0.65))
        y0, y1 = (int(h * 0.32), int(h * 0.52))
    crop = img.crop((x0, y0, x1, y1)).resize((64, 48), Image.Resampling.BILINEAR)
    px = list(crop.getdata())
    if not px:
        return (0, 0, 0)
    import statistics
    lumas = [(r + g + b) / 3 for r, g, b in px]
    med = statistics.median(lumas)
    bright = sum((1 for v in lumas if v > med + 45))
    chroma = sum((1 for r, g, b in px if max(r, g, b) - min(r, g, b) > 40 and (r + g + b) / 3 > 40))
    return (bright, chroma, len(px))

def _chest_emblem_chroma_peak(data: bytes, *, below_face: bool=False, win: int=12) -> int:
    """below_face ROI 内最大局部 chroma 窗像素数（64x48 网格）。"""
    try:
        img = Image.open(BytesIO(data)).convert('RGB')
    except Exception:
        return 0
    w, h = img.size
    if below_face:
        bb = _detect_face_bbox_xyxy(data)
        x0, x1 = (int(w * 0.28), int(w * 0.72))
        if bb is None or float(bb[3]) / float(h) > 0.62:
            y0, y1 = (int(h * 0.45), int(h * 0.98))
        else:
            y0 = int(min(h - 2, float(bb[3]) + max(2.0, 0.02 * float(h))))
            y1 = int(h * 0.98)
            if y1 <= y0 + 8:
                y0, y1 = (int(h * 0.45), int(h * 0.98))
    else:
        x0, x1 = (int(w * 0.35), int(w * 0.65))
        y0, y1 = (int(h * 0.32), int(h * 0.52))
    crop = img.crop((x0, y0, x1, y1)).resize((64, 48), Image.Resampling.BILINEAR)
    px = list(crop.getdata())
    if not px:
        return 0
    mask = [1 if max(r, g, b) - min(r, g, b) > 40 and (r + g + b) / 3 > 40 else 0 for r, g, b in px]
    peak = 0
    for yy in range(0, 48 - win + 1, 2):
        for xx in range(0, 64 - win + 1, 2):
            s = 0
            for dy in range(win):
                row = (yy + dy) * 64
                s += sum(mask[row + xx:row + xx + win])
            if s > peak:
                peak = s
    return int(peak)

def portrait_has_chest_emblem(data: bytes, *, ref: bytes | None=None, below_face: bool=False) -> bool:
    """主立绘胸口贴标/徽标启发式：中上躯干高对比小团块。

    17:14：若提供已过目检母版正面 ref，则仅当立绘明显比母版更「花」才判命中，
    避免板岩灰雨衣高光/拉链把合格母版与同款编辑立绘误杀。
    18:23 below_face：表情近景用脸下 ROI。
    22:20 below_face：只认「局部色斑」；禁止几乎整 ROI 高 chroma 的漫布皮肤误杀；
    禁用宽条件 chroma≥12% and bright≥8%。
    """
    bright, chroma, n = _chest_emblem_scores(data, below_face=below_face)
    if n <= 0:
        return False
    abs_hit = False
    if below_face:
        if chroma > int(n * 0.4):
            abs_hit = False
        else:
            peak = _chest_emblem_chroma_peak(data, below_face=True)
            if chroma >= 8 and 10 <= bright <= int(n * 0.18) and (8 <= chroma <= int(n * 0.28)):
                abs_hit = True
            elif 20 <= chroma <= int(n * 0.22) and peak >= 100 and (peak <= int(n * 0.18)) and (bright <= int(n * 0.12)):
                abs_hit = True
    else:
        if chroma >= 6 and (8 <= bright <= int(n * 0.22) or 6 <= chroma <= int(n * 0.18)):
            abs_hit = True
        if chroma >= int(n * 0.12) and bright >= int(n * 0.08):
            abs_hit = True
    if ref:
        rb, rc, rn = _chest_emblem_scores(ref, below_face=below_face)
        if rn > 0:
            worse = chroma >= rc + 8 or bright >= max(rb * 1.6, rb + 20)
            if below_face:
                return bool(abs_hit and worse)
            return bool(abs_hit and worse) if abs_hit else worse and (chroma >= 6 or bright >= int(n * 0.05))
    return abs_hit

def _uniform_rect_hit_stats(data: bytes) -> tuple[int, float]:
    """返回 (hits, last_stdev)。hits>=2 表示绝对路径会拒。"""
    import statistics
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    slate = (int(SLATE_GRAY_TARGET[1:3], 16), int(SLATE_GRAY_TARGET[3:5], 16), int(SLATE_GRAY_TARGET[5:7], 16))
    win_w, win_h = (max(24, int(w * 0.18)), max(20, int(h * 0.12)))
    y_lo, y_hi = (int(h * 0.22), int(h * 0.62))
    x_lo, x_hi = (int(w * 0.22), int(w * 0.78))
    step_x, step_y = (max(8, win_w // 3), max(8, win_h // 3))
    hits = 0
    last_stdev = 99.0
    for y0 in range(y_lo, max(y_lo + 1, y_hi - win_h + 1), step_y):
        for x0 in range(x_lo, max(x_lo + 1, x_hi - win_w + 1), step_x):
            crop = img.crop((x0, y0, x0 + win_w, y0 + win_h))
            small = crop.resize((24, 18), Image.Resampling.BILINEAR)
            px = list(small.getdata())
            if len(px) < 10:
                continue
            lumas = [(r + g + b) / 3.0 for r, g, b in px]
            try:
                stdev = statistics.pstdev(lumas)
            except statistics.StatisticsError:
                continue
            mean_rgb = tuple((sum((c[i] for c in px)) / len(px) for i in range(3)))
            dist = sum((abs(mean_rgb[i] - slate[i]) for i in range(3)))
            if stdev < 8.0 and dist < 45:
                hits += 2
                last_stdev = stdev
            elif stdev < 3.5:
                hits += 1
                last_stdev = stdev
            if hits >= 2:
                return (hits, last_stdev)
    return (hits, last_stdev)

def assert_no_large_uniform_rect(data: bytes, *, label: str='面板', ref: bytes | None=None) -> None:
    """16:18②：检测大块均匀矩形色块（程序铺色痕迹）→ 拒。

    17:14：若提供母版 ref 且母版本身也命中（二次元雨衣平涂），则放行，
    只拦相对母版新出现的程序矩形铺色。
    """
    hits, stdev = _uniform_rect_hit_stats(data)
    if hits < 2:
        return
    if ref is not None:
        rh, _ = _uniform_rect_hit_stats(ref)
        if rh >= 2:
            return
    raise CharacterSheetError(f'出图门禁失败:{label}检出大块均匀矩形色块(stdev={stdev:.1f})', status_code=422)

def _face_cool_metrics(data: bytes) -> tuple[float, float] | None:
    """返回 (b-r, chroma)；不足样本则 None。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    head = img.crop((int(w * 0.25), int(h * 0.06), int(w * 0.75), int(h * 0.38)))
    small = head.resize((48, 48), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    cands = []
    for r, g, b in px:
        luma = (r + g + b) / 3.0
        if 90 <= luma <= 210:
            cands.append((r, g, b))
    if len(cands) < 20:
        return None
    mean_r = sum((c[0] for c in cands)) / len(cands)
    mean_b = sum((c[2] for c in cands)) / len(cands)
    mean_chroma = sum((max(c) - min(c) for c in cands)) / len(cands)
    return (mean_b - mean_r, mean_chroma)

def assert_skin_not_blue_gray(data: bytes, *, label: str='面板', ref: bytes | None=None) -> None:
    """16:18②：脸部被整图着色染成灰蓝 → 拒。

    有参考图（旧正面）时只拦「比参考更冷」；无参考时用极端阈值，避免二次元冷调误杀。
    """
    cur = _face_cool_metrics(data)
    if cur is None:
        return
    br, chroma = cur
    if ref is not None:
        base = _face_cool_metrics(ref)
        if base is not None:
            if br - base[0] >= 12 and chroma <= base[1] + 4 and (br >= 22):
                raise CharacterSheetError(f'出图门禁失败:{label}脸部相对参考偏蓝灰(b-r={br:.1f} vs {base[0]:.1f})', status_code=422)
            return
    if br >= 32 and chroma <= 18:
        raise CharacterSheetError(f'出图门禁失败:{label}脸部肤色偏蓝灰(b-r={br:.1f},chroma={chroma:.1f})', status_code=422)

def assert_turnaround_pose(data: bytes, key: str) -> None:
    """16:18③：侧/背姿态门禁——侧须侧脸或高 yaw；背须无明显正脸。"""
    if key not in ('side', 'back'):
        return
    yaw = estimate_face_yaw_deg(data)
    if key == 'side':
        if yaw is not None and abs(yaw) < 28:
            raise CharacterSheetError(f'姿态门禁失败:side 仍偏正面(yaw={yaw:.1f}<28)', status_code=422)
        if yaw is None:
            try:
                assert_face_visible(data, min_face_area=0.01)
                raise CharacterSheetError('姿态门禁失败:side 检出正脸且无有效 yaw', status_code=422)
            except CharacterSheetError as e:
                if '姿态门禁' in str(e):
                    raise
                return
    if key == 'back':
        try:
            assert_face_visible(data, min_face_area=0.012)
        except CharacterSheetError:
            return
        if yaw is None or abs(yaw) < 55:
            raise CharacterSheetError(f'姿态门禁失败:back 仍可见正脸(yaw={yaw})', status_code=422)

def assert_panel_output_gates(data: bytes, *, label: str, key: str | None=None, ref: bytes | None=None) -> None:
    """16:18 组合出图门禁：矩形色块 + 肤色 + 侧背姿态。

    F5: 三视图传入主立绘 ref 时，雨衣平涂相对母版放行（与 assert_no_large_uniform_rect 17:14 一致）。
    """
    assert_no_large_uniform_rect(data, label=label, ref=ref)
    if key in (None, 'portrait', 'front', 'side') or (key and key.startswith('expr_')):
        assert_skin_not_blue_gray(data, label=label, ref=ref)
    if key in ('side', 'back'):
        assert_turnaround_pose(data, key)

def assert_sheet_garment_consistency(panels: dict[str, bytes], *, max_dist: int=90, style: str='anime', skip_keys: set[str] | None=None) -> None:
    """13:16②：主立绘 vs 三视图服装主色差超阈或主立绘贴标 → 不得过审。

    16:18：禁止矩形铺色去标；检出贴标直接 422 重出。
    """
    skip = set(skip_keys or ())
    portrait = panels.get('portrait')
    if not portrait:
        raise CharacterSheetError('一致性门禁失败:缺主立绘', status_code=422)
    if style in ('anime', '二次元') and portrait_has_chest_emblem(portrait, ref=panels.get('front')):
        raise CharacterSheetError('一致性门禁失败:主立绘胸口检出贴标/徽标', status_code=422)
    assert_no_large_uniform_rect(portrait, label='主立绘', ref=panels.get('front'))
    assert_skin_not_blue_gray(portrait, label='主立绘', ref=panels.get('front'))
    for key in ('front', 'side', 'back'):
        data = panels.get(key)
        if not data:
            continue
        if key != 'back':
            assert_skin_not_blue_gray(data, label=key)
    p_hex = _panel_garment_dominant_hex(portrait)
    if not p_hex:
        raise CharacterSheetError('一致性门禁失败:主立绘无法取服装主色', status_code=422)
    if style in ('anime', '二次元'):
        if _hex_luma(p_hex) < 35:
            raise CharacterSheetError(f'一致性门禁失败:主立绘服装主色过黑({p_hex})，须板岩灰素面', status_code=422)
        if _hex_luma(p_hex) > SLATE_GRAY_MAX_LUMA:
            raise CharacterSheetError(f'一致性门禁失败:主立绘服装主色过浅近白({p_hex})', status_code=422)
    for key in ('front', 'side', 'back'):
        data = panels.get(key)
        if not data:
            continue
        t_hex = _panel_garment_dominant_hex(data)
        if not t_hex:
            raise CharacterSheetError(f'一致性门禁失败:三视图 {key} 无法取服装主色', status_code=422)
        dist = _hex_dist(p_hex, t_hex)
        if dist > max_dist:
            raise CharacterSheetError(f'一致性门禁失败:主立绘({p_hex})与{key}({t_hex})色差={dist}>{max_dist}', status_code=422)

def expr_cell_content_coverage(img: Image.Image | bytes) -> float:
    """23:18：表情格内容铺满比。

    贴格路径已 LANCZOS 输出满格像素；本门禁专拦「小图+四周棚灰(220)垫边」邮票缩水。
    源图自带浅底/噪声边不算未铺满（避免 fill_w 误杀）。
    """
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    pad = _studio_pad_edge_frac(img)
    if stamp and pad > 0.04:
        return float(min(area, max(0.0, 1.0 - pad), fill_h, fill_w))
    if pad > 0.1:
        return float(max(0.0, 1.0 - pad))
    return 1.0

def assert_expr_cell_content_coverage(img: Image.Image | bytes, *, expr_key: str='expr', min_coverage: float=1.0) -> float:
    """23:18：表情格须全铺满（coverage=1.0）；禁四周棚灰垫边缩小塞格。"""
    cov = expr_cell_content_coverage(img)
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    pad = _studio_pad_edge_frac(img)
    if cov + 1e-09 < float(min_coverage):
        raise CharacterSheetError(f'{expr_key}表情格未全铺满 coverage={cov:.3f} (need {min_coverage:.2f}) stamp={stamp} pad={pad:.3f} area={area:.3f} fill_h={fill_h:.3f} fill_w={fill_w:.3f}', status_code=422)
    return cov

def assert_expr_cell_face_height_frac(data: bytes, *, expr_key: str='expr', min_face_height_frac: float=FACE_HEIGHT_FRAC_MIN, max_face_height_frac: float=FACE_HEIGHT_FRAC_MAX) -> dict:
    """22:28：贴格/方化后脸高占格高硬门禁 0.55–0.65；越界拒收该格。"""
    frac = measure_face_height_frac(data)
    if frac is None:
        raise CharacterSheetError(f'{expr_key}贴格脸高门禁失败：无人脸', status_code=422)
    lo = float(min_face_height_frac)
    hi = float(max_face_height_frac)
    if frac + 1e-12 < lo or frac - 1e-12 > hi:
        raise CharacterSheetError(f'{expr_key}贴格脸高越界 face_height_frac={frac:.3f} not in [{lo:.2f},{hi:.2f}]', status_code=422)
    return {'expr_key': expr_key, 'face_height_frac': float(frac), 'min': lo, 'max': hi}

def measure_face_area_frac(data: bytes) -> float | None:
    """insightface/启发式脸面积占图画面积；无人脸返回 None。"""
    try:
        img = Image.open(BytesIO(data)).convert('RGB')
    except Exception:
        return None
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        return None
    x1, y1, x2, y2 = [float(v) for v in bb]
    fw = max(1.0, x2 - x1)
    fh = max(1.0, y2 - y1)
    return fw * fh / float(max(1, w * h))

def assert_expr_base_face_area(data: bytes, *, expr_key: str, min_area: float=0.15) -> tuple[bytes, float]:
    """22:45/23:17：表情底裁后 insightface 脸面积须 ≥0.15；略低时先 zoom 一次，仍不足直接停。

    返回 (可能被放大后的 bytes, area)。
    """
    cur = data
    area = measure_face_area_frac(cur)
    if area is not None and area + 1e-12 < float(min_area):
        cur = _zoom_face_for_area(cur, target_area=max(float(min_area) + 0.03, 0.18))
        area = measure_face_area_frac(cur)
    if area is None:
        raise CharacterSheetError(f'{expr_key} 表情底无人脸(area=None)，停', status_code=422)
    if area + 1e-12 < float(min_area):
        raise CharacterSheetError(f'{expr_key} 表情底脸面积 {area:.3f} < {min_area:.2f}，停', status_code=422)
    return (cur, float(area))

def _normalize_hex(c: str) -> str | None:
    s = (c or '').strip()
    if re.fullmatch('#[0-9A-Fa-f]{6}', s):
        return s.upper()
    if re.fullmatch('[0-9A-Fa-f]{6}', s):
        return f'#{s.upper()}'
    return None

def assert_expr_cell_no_white_border(data: bytes, *, expr_key: str='expr', max_strip_frac: float=0.08, white_lum: float=232.0, edge_px: int=3, max_edge_near_white_frac: float=0.35) -> float:
    """表情格不得含整条近白 letterbox（格外白底）；棚灰人物边不算。

    测四边：若某边连续条带（厚≈4%边长）行/列近白占比≥92%，计入 strip 厚度占比。
    21:30 硬检查：四边 edge_px（默认 3px）内近白像素占比不得超过 max_edge_near_white_frac；
    棚灰(~220)不算近白（阈值 white_lum 默认 232）。
    """
    im = Image.open(BytesIO(data)).convert('RGB')
    w, h = im.size
    px = im.load()
    band = max(8, int(min(w, h) * 0.3))

    def _near_white(rgb: tuple[int, int, int]) -> bool:
        r, g, b = rgb
        return (r + g + b) / 3.0 >= float(white_lum) and abs(r - g) < 14 and (abs(g - b) < 14)

    def _row_white(y: int) -> bool:
        n = sum((1 for x in range(w) if _near_white(px[x, y])))
        return n / float(max(1, w)) >= 0.92

    def _col_white(x: int) -> bool:
        n = sum((1 for y in range(h) if _near_white(px[x, y])))
        return n / float(max(1, h)) >= 0.92
    top = 0
    while top < band and _row_white(top):
        top += 1
    bot = 0
    while bot < band and _row_white(h - 1 - bot):
        bot += 1
    left = 0
    while left < band and _col_white(left):
        left += 1
    right = 0
    while right < band and _col_white(w - 1 - right):
        right += 1
    strip = max(top, bot, left, right) / float(max(1, min(w, h)))
    if strip > float(max_strip_frac):
        raise CharacterSheetError(f'{expr_key}表情格含格外白底 letterbox_strip={strip:.3f}>{max_strip_frac} (T{top}B{bot}L{left}R{right})', status_code=422)
    ep = max(1, int(edge_px))
    edge_stats: dict[str, float] = {}
    for name, ys in (('T', range(0, min(ep, h))), ('B', range(max(0, h - ep), h))):
        n = 0
        tot = 0
        for yy in ys:
            for xx in range(w):
                tot += 1
                if _near_white(px[xx, yy]):
                    n += 1
        edge_stats[name] = n / float(max(1, tot))
    for name, xs in (('L', range(0, min(ep, w))), ('R', range(max(0, w - ep), w))):
        n = 0
        tot = 0
        for xx in xs:
            for yy in range(h):
                tot += 1
                if _near_white(px[xx, yy]):
                    n += 1
        edge_stats[name] = n / float(max(1, tot))
    worst = max(edge_stats.values()) if edge_stats else 0.0
    if worst > float(max_edge_near_white_frac):
        raise CharacterSheetError(f"{expr_key}表情格{ep}px近白边超标 edge_near_white={worst:.3f}>{max_edge_near_white_frac} stats={{{', '.join((f'{k}:{v:.2f}' for k, v in edge_stats.items()))}}}", status_code=422)
    return max(strip, worst)

def assert_expression_identity_gates(data: bytes, *, portrait_ref: bytes | None, expr_key: str, skip_chest_emblem: bool=False, hair_ref: bytes | None=None, relative_hair_only: bool | None=None) -> None:
    """表情格：相对主立绘新徽标/字样 → 拒；发长过线 → 拒。

    徽标检测用 below_face ROI，避免近景五官误杀。
    19:15：发长只和同格 base_expr（hair_ref，同裁同尺度）比；禁止用主立绘全身比例。
    00:59：遮罩外与底图一致 → skip_chest_emblem；16:18：此时发长只比相对 delta。
    """
    _skip_emblem = bool(skip_chest_emblem) or (mouth_appears_open(data) and expr_key == 'expr_4')
    if not _skip_emblem and portrait_ref and portrait_has_chest_emblem(data, ref=portrait_ref, below_face=True):
        raise CharacterSheetError(f'{expr_key}胸口相对主立绘出现新徽标/字样', status_code=422)
    if not _skip_emblem and portrait_ref is None and portrait_has_chest_emblem(data, below_face=True):
        raise CharacterSheetError(f'{expr_key}胸口检出徽标/字样', status_code=422)
    chin_only = expr_key == 'expr_3'
    href = hair_ref
    rel_only = bool(skip_chest_emblem) if relative_hair_only is None else bool(relative_hair_only)
    if href is None and (not rel_only) and portrait_ref:
        try:
            href = crop_face_ref(portrait_ref, size=768)
        except Exception:
            href = portrait_ref
    if expression_hair_too_long(data, ref=href, chin_only=chin_only, relative_only=rel_only):
        raise CharacterSheetError(f"{expr_key}发长相对同格表情底过长（{('须齐下巴' if chin_only else '发梢不过肩')}；须同裁同尺度）", status_code=422)

def uniform_bottom_band_frac(data: bytes, *, std_thr: float=4.0) -> float:
    """04:30：底部整行近乎纯色（行内灰度标准差 < std_thr）的连续行数占高比例。"""
    import numpy as np
    a = np.asarray(Image.open(BytesIO(data)).convert('L'), dtype=np.float32)
    h = a.shape[0]
    rs = a.std(axis=1)
    n = 0
    for y in range(h - 1, -1, -1):
        if rs[y] < std_thr:
            n += 1
        else:
            break
    return n / float(h)

def assert_no_uniform_bottom_band(data: bytes, *, expr_key: str, max_frac: float=0.06) -> float:
    """04:30：头肩格底部不得有整条纯色垫块（灰垫/白条）；头肩构图底行必穿过衣服。"""
    frac = uniform_bottom_band_frac(data)
    if frac > max_frac:
        raise CharacterSheetError(f'{expr_key}底部纯色垫块门禁: band={frac:.3f}>{max_frac:.2f}（禁止灰色填充）', status_code=422)
    return frac

def assert_expr_frame_match(data: bytes, frame: dict, *, expr_key: str, tol_face: float=0.07, tol_top: float=0.07) -> dict:
    """04:30：新表情格构图须与锁定格同比例（脸高、头顶留白）。"""
    m = measure_expr_frame(data)
    if m is None:
        raise CharacterSheetError(f'{expr_key}构图门禁: 测不到脸', status_code=422)
    d_face = abs(m['face_frac'] - float(frame['face_frac']))
    d_top = abs(m['face_top_frac'] - float(frame['face_top_frac']))
    if d_face > tol_face or d_top > tol_top:
        raise CharacterSheetError(f"{expr_key}构图门禁: 与锁定格不同比例 face={m['face_frac']:.3f} vs {frame['face_frac']:.3f}, top={m['face_top_frac']:.3f} vs {frame['face_top_frac']:.3f}", status_code=422)
    return {**m, 'd_face': d_face, 'd_top': d_top}

def assert_no_flat_hairline_cut(data: bytes, *, expr_key: str='expr', min_run_px: int=40) -> dict:
    """02:42：发顶平切门禁——顶部发际 ≥40px 水平直线（其上灰底）即 FAIL。"""
    info = measure_flat_hairline_cut(data, min_run_px=min_run_px)
    info['expr_key'] = expr_key
    if info.get('reject'):
        raise CharacterSheetError(f"{expr_key}发顶平切门禁: 发际水平直线 run={info['max_flat_run']}px≥{min_run_px} y={info['flat_y']}({info.get('flat_y_frac')})", status_code=422)
    return info

def assert_no_hard_seam_contour(data: bytes, *, expr_key: str='expr', size: int=768, stage: str='raw') -> dict:
    """01:50：接缝门禁——椭圆/矩形硬边（闭合轮廓梯度突变）即拒。"""
    info = measure_hard_seam_contour(data, size=size, stage=stage)
    info['expr_key'] = expr_key
    if info.get('reject'):
        raise CharacterSheetError(f"{expr_key}接缝门禁: 检测到椭圆/矩形硬边 (stage={info.get('stage')} mask_p75={info['mask_p75']:.1f} strong={info['mask_strong']:.2f} ell={info['ell_score']:.1f}/{info['ell_frac']:.2f} rect={info['rectish']})", status_code=422)
    return info

def assert_iris_hue_match(cell_data: bytes, ref_data: bytes, *, expr_key: str='expr', max_hue_diff: float=40.0) -> dict:
    """01:45：瞳色漂移门禁——生成格眼带主色相须与编辑底一致（0110 实证红瞳假通过 hue 差 127°，蓝系互差≤2°）。"""
    got = measure_iris_hue(cell_data)
    ref = measure_iris_hue(ref_data)
    if got is None or ref is None:
        return {'expr_key': expr_key, 'skipped': True, 'got': got, 'ref': ref}
    diff = abs(got[0] - ref[0]) % 360.0
    diff = min(diff, 360.0 - diff)
    if diff > float(max_hue_diff):
        raise CharacterSheetError(f'{expr_key}瞳色漂移门禁: 眼带色相 {got[0]:.0f}° vs 底 {ref[0]:.0f}° (diff {diff:.0f}°>{max_hue_diff:.0f}°)', status_code=422)
    return {'expr_key': expr_key, 'hue': got[0], 'ref_hue': ref[0], 'diff': diff}

def assert_mouth_zoom_closed(expr_key: str, qa: dict) -> dict:
    """05:30：嘴部放大复判两问皆须为是（闭嘴且看得到嘴），否则 FAIL 换 seed。"""
    q1 = qa.get('q1')
    q2 = qa.get('q2')
    info = {'expr_key': expr_key, 'q1': q1, 'q2': q2, 'pass': False}
    if q1 is not True or q2 is not True:
        raise CharacterSheetError(f'{expr_key}嘴部放大复判未过: 闭嘴={q1!r} 可见={q2!r}（张嘴/小O形/口腔可见一律拒）', status_code=422)
    info['pass'] = True
    return info

def assert_expression_qa_match(expr_key: str, qa: dict) -> dict:
    """沉思/温柔专项两问皆须为是。"""
    if expr_key not in ('expr_2', 'expr_3'):
        raise CharacterSheetError(f'专项问答不支持 {expr_key}', status_code=422)
    q1 = qa.get('q1')
    q2 = qa.get('q2')
    want = _EXPR_KEY_TO_VLM_LABEL.get(expr_key, expr_key)
    info = {'expr_key': expr_key, 'want': want, 'q1': q1, 'q2': q2, 'pass': False}
    if q1 is not True or q2 is not True:
        raise CharacterSheetError(f'{expr_key}{want}专项问答未过: q1={q1!r} q2={q2!r}（两问皆须是）', status_code=422)
    info['pass'] = True
    return info

def assert_mouth_in_frame(data: bytes, *, face_bbox: tuple[float, float, float, float] | None=None, margin_frac: float=0.04) -> dict:
    """嘴须在格内：估算嘴部 y 不得贴/出底；脸框下沿也不得贴底（禁只剩眼睛）。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    _w, h = img.size
    bb = face_bbox
    if bb is None:
        bb = _detect_face_bbox_xyxy(data)
        if bb is None:
            bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        raise CharacterSheetError('mouth-in-frame: no face', status_code=422)
    x1, y1, x2, y2 = [float(v) for v in bb]
    fh = max(1.0, y2 - y1)
    mouth_y = y1 + 0.72 * fh
    chin_y = y2
    bottom_lim = float(h) * (1.0 - float(margin_frac))
    if mouth_y >= bottom_lim:
        raise CharacterSheetError(f'mouth near/below bottom mouth_y={mouth_y:.1f} h={h} (overcropped eyes-only)', status_code=422)
    if chin_y >= float(h) * (1.0 - float(margin_frac) * 0.5):
        raise CharacterSheetError(f'face/chin clipped at bottom chin_y={chin_y:.1f} h={h}', status_code=422)
    if y2 / float(max(1, h)) < 0.48:
        raise CharacterSheetError(f'face bottom too high y2/h={y2 / float(h):.3f} (eyes-only crop)', status_code=422)
    return {'mouth_y': float(mouth_y), 'chin_y': float(chin_y), 'mouth_in_frame': True}

def assert_expression_vlm_match(cell_bytes: bytes, expr_key: str, vlm_result: dict) -> dict:
    """目标标签必须是 scores argmax 且 label 命中；否则 CharacterSheetError。"""
    del cell_bytes
    want = _EXPR_KEY_TO_VLM_LABEL.get(expr_key)
    if not want:
        raise CharacterSheetError(f'未知表情键 {expr_key}', status_code=422)
    if not isinstance(vlm_result, dict):
        raise CharacterSheetError('VLM 结果非 dict', status_code=502)
    label = str(vlm_result.get('label') or '').strip()
    scores = vlm_result.get('scores') or {}
    if not isinstance(scores, dict) or not scores:
        raise CharacterSheetError(f'{expr_key} VLM 无 scores: {vlm_result!r}', status_code=502)
    try:
        argmax = max(scores.items(), key=lambda kv: float(kv[1]))[0]
    except Exception as e:
        raise CharacterSheetError(f'{expr_key} VLM scores 不可比: {e}', status_code=502) from e
    info = {'expr_key': expr_key, 'want': want, 'label': label, 'argmax': argmax, 'scores': scores, 'model': vlm_result.get('model')}
    if label != want:
        raise CharacterSheetError(f'{expr_key} VLM 判错: want={want} got={label} scores={scores}', status_code=422)
    if argmax != want:
        raise CharacterSheetError(f'{expr_key} VLM argmax 非目标: want={want} argmax={argmax} scores={scores}', status_code=422)
    if expr_key == 'expr_3':
        smiling = vlm_result.get('smiling')
        info['smiling'] = smiling
        if smiling is not True:
            raise CharacterSheetError(f'{expr_key}温柔第二问未通过: smiling={smiling!r}（须为是/true）', status_code=422)
    return info

def assert_expression_semantic(data: bytes, *, expr_key: str, neutral_ref: bytes | None=None) -> dict:
    """19:15：表情语义硬校验。威严=眉压低+嘴闭紧；温柔=眉舒展+嘴角微扬。"""
    info: dict = {'expr_key': expr_key}
    open_m = mouth_appears_open(data)
    lift = _mouth_corner_lift(data)
    press = _brow_press_delta(data, neutral_ref)
    info.update({'mouth_open': open_m, 'mouth_lift': float(lift), 'brow_press': press})
    if expr_key == 'expr_0':
        if open_m:
            raise CharacterSheetError(f'{expr_key}威严语义失败：须闭嘴（检测到张嘴）', status_code=422)
        if press is not None and press < -0.04:
            raise CharacterSheetError(f'{expr_key}威严语义失败：眉须压低，检测到上挑 press={press:.3f}', status_code=422)
        if lift > 0.35 and (press is None or press < 0.02):
            raise CharacterSheetError(f'{expr_key}威严语义失败：嘴须闭紧，禁微笑上扬 lift={lift:.3f}', status_code=422)
    elif expr_key == 'expr_3':
        wide = mouth_appears_wide_open(data)
        info['mouth_wide_open'] = wide
        info['mouth_dark'] = float(mouth_dark_ratio(data))
        if wide:
            raise CharacterSheetError(f"{expr_key}温柔语义失败：禁大张嘴 dark={info['mouth_dark']:.3f}", status_code=422)
        if press is not None and press > 0.05:
            raise CharacterSheetError(f'{expr_key}温柔语义失败：眉须舒展，禁皱眉/压眉 press={press:.3f}', status_code=422)
    return info

def assert_expression_diversity(data: bytes, *, expr_key: str, neutral_ref: bytes | None, other_exprs: dict[str, bytes] | None=None, min_vs_neutral: float=6.0, min_pairwise: float=4.0) -> None:
    """20:23：与中性脸眉眼嘴 ROI 像素差 ≥ 阈值；两两也 ≥ 阈值；惊恐须张嘴。"""
    if expr_key == 'expr_4' and (not mouth_appears_open(data)):
        raise CharacterSheetError(f'{expr_key}惊恐未检测到张嘴', status_code=422)
    if neutral_ref:
        d = expression_roi_pixel_diff(data, neutral_ref)
        if d + 1e-12 < float(min_vs_neutral):
            raise CharacterSheetError(f'{expr_key}相对中性脸表情差过弱 diff={d:.2f}<{min_vs_neutral}', status_code=422)
    if other_exprs:
        for ok, ob in other_exprs.items():
            if ok == expr_key or not ob:
                continue
            d2 = expression_roi_pixel_diff(data, ob)
            if d2 + 1e-12 < float(min_pairwise):
                raise CharacterSheetError(f'{expr_key}与{ok}表情过于相似 diff={d2:.2f}<{min_pairwise}', status_code=422)

def _panel_content_metrics(img: Image.Image | bytes, *, bg_tol: int=40, uniform_frac: float=0.92) -> tuple[float, bool, float, float]:
    """返回 (area_ratio, is_postage_stamp, fill_h, fill_w)。"""
    if isinstance(img, (bytes, bytearray)):
        im = Image.open(BytesIO(img)).convert('RGB')
    else:
        im = img.convert('RGB')
    w, h = im.size
    if w < 8 or h < 8:
        return (0.0, True, 0.0, 0.0)
    small = im.resize((64, 64), Image.Resampling.BOX)
    sw, sh = small.size
    px = list(small.getdata())

    def _pix(x: int, y: int) -> tuple[int, int, int]:
        return px[y * sw + x]
    corners = [_pix(1, 1), _pix(sw - 2, 1), _pix(1, sh - 2), _pix(sw - 2, sh - 2)]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))

    def _is_bg(r: int, g: int, b: int) -> bool:
        dist = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
        luma = (r + g + b) / 3.0
        tol = bg_tol
        if 40 <= luma <= 190:
            tol = max(12, bg_tol // 2)
        if dist < tol:
            return True
        if r > 235 and g > 235 and (b > 235):
            return True
        return False

    def _row_bg_frac(y: int) -> float:
        return sum((1 for x in range(sw) if _is_bg(*_pix(x, y)))) / float(sw)

    def _col_bg_frac(x: int) -> float:
        return sum((1 for y in range(sh) if _is_bg(*_pix(x, y)))) / float(sh)
    top = 0
    while top < sh // 2 and _row_bg_frac(top) >= uniform_frac:
        top += 1
    bot = 0
    while bot < sh // 2 and _row_bg_frac(sh - 1 - bot) >= uniform_frac:
        bot += 1
    left = 0
    while left < sw // 2 and _col_bg_frac(left) >= uniform_frac:
        left += 1
    right = 0
    while right < sw // 2 and _col_bg_frac(sw - 1 - right) >= uniform_frac:
        right += 1
    cw = max(0, sw - left - right)
    ch = max(0, sh - top - bot)
    area = float(max(0.0, min(1.0, cw * ch / float(sw * sh))))
    stamp = left >= 6 and right >= 6 and (top >= 6) and (bot >= 6)
    fill_h = ch / float(sh)
    fill_w = cw / float(sw)
    return (area, stamp, fill_h, fill_w)

def panel_vertical_span(img: Image.Image | bytes, *, bg_tol: int=40, uniform_frac: float=0.92, var_thresh: float=8.0) -> float:
    """17:55：人物头顶→脚底占画高比例。

    四角取背景色；横向均匀灰条（低方差且近背景）不算人物行。
    """
    import statistics as _stats
    if isinstance(img, (bytes, bytearray)):
        im = Image.open(BytesIO(img)).convert('RGB')
    else:
        im = img.convert('RGB')
    w, h = im.size
    if w < 8 or h < 8:
        return 0.0
    small = im.resize((64, 64), Image.Resampling.BOX)
    sw, sh = small.size
    px = list(small.getdata())

    def _pix(x: int, y: int) -> tuple[int, int, int]:
        return px[y * sw + x]
    corners = [_pix(1, 1), _pix(sw - 2, 1), _pix(1, sh - 2), _pix(sw - 2, sh - 2)]
    bg = tuple((sum((c[i] for c in corners)) // 4 for i in range(3)))

    def _is_bg(r: int, g: int, b: int) -> bool:
        dist = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
        luma = (r + g + b) / 3.0
        tol = bg_tol
        if 40 <= luma <= 190:
            tol = max(12, bg_tol // 2)
        if dist < tol:
            return True
        if r > 235 and g > 235 and (b > 235):
            return True
        return False
    person_rows: list[int] = []
    for y in range(sh):
        row = [_pix(x, y) for x in range(sw)]
        non_bg = sum((1 for r, g, b in row if not _is_bg(r, g, b))) / float(sw)
        lumas = [(r + g + b) / 3.0 for r, g, b in row]
        diffs = [abs(lumas[i] - lumas[i + 1]) for i in range(sw - 1)]
        mean_diff = sum(diffs) / float(len(diffs))
        var = float(_stats.pstdev(lumas)) if len(lumas) > 1 else 0.0
        if non_bg >= 1.0 - uniform_frac or var >= var_thresh or mean_diff >= 4.0:
            person_rows.append(y)
    if not person_rows:
        return 0.0
    return float(person_rows[-1] - person_rows[0] + 1) / float(sh)

def panel_content_coverage(img: Image.Image | bytes, *, bg_tol: int=40, uniform_frac: float=0.92) -> float:
    """全身格以纵向跨度为主(17:55)；邮票缩水仍回落面积比。"""
    area, stamp, fill_h, fill_w = _panel_content_metrics(img, bg_tol=bg_tol, uniform_frac=uniform_frac)
    vspan = panel_vertical_span(img, bg_tol=bg_tol, uniform_frac=uniform_frac)
    if vspan >= 0.85:
        return float(max(vspan, 0.9))
    if stamp:
        return area
    if fill_h >= 0.82 or fill_w >= 0.82:
        return float(max(area, 0.9))
    return float(max(area, vspan))

def assert_panel_coverage(img: Image.Image | bytes, min_ratio: float=0.9) -> float:
    """17:55：全身格硬门槛=纵向跨度≥0.85；邮票缩水仍按面积拦。"""
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    vspan = panel_vertical_span(img)
    if vspan + 1e-09 >= 0.85:
        return float(max(vspan, 0.9))
    if stamp:
        if area + 1e-09 < float(min_ratio):
            raise CharacterSheetError(f'panel coverage {area:.3f} < {min_ratio:.2f} (shrunk/padded panel)', status_code=422)
        return area
    if fill_h >= 0.82 or fill_w >= 0.82 or area >= float(min_ratio):
        return float(max(area, 0.9 if fill_h >= 0.82 or fill_w >= 0.82 else area))
    if area + 1e-09 < 0.5:
        raise CharacterSheetError(f'panel coverage {area:.3f} < 0.50 (empty/near-empty panel)', status_code=422)
    if vspan + 1e-09 < 0.85 and area + 1e-09 < float(min_ratio):
        raise CharacterSheetError(f'panel coverage vspan={vspan:.3f} area={area:.3f} < {min_ratio:.2f} (shrunk/padded panel)', status_code=422)
    return float(max(area, vspan))

def assert_face_visible(data: bytes, *, min_face_area: float=0.04, face_key: str | None=None) -> tuple[float, float, float, float]:
    """锁定/输出前:格内必须有可检测人脸,且脸面积占比足够(拦下巴耳裁切)。

    返回人脸 bbox (x1,y1,x2,y2)。insightface 优先,启发式回退;都无则报错。
    """
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        raise CharacterSheetError('panel face missing (no detectable face)', status_code=422)
    x1, y1, x2, y2 = [float(v) for v in bb]
    fw = max(1.0, x2 - x1)
    fh = max(1.0, y2 - y1)
    area = fw * fh / float(max(1, w * h))
    if area + 1e-12 < float(min_face_area):
        raise CharacterSheetError(f'panel face area {area:.3f} < {min_face_area:.2f} (face cropped away)', status_code=422)
    fcx = (x1 + x2) / 2.0
    fcy = (y1 + y2) / 2.0
    if not 0.12 * w <= fcx <= 0.88 * w or not 0.08 * h <= fcy <= 0.72 * h:
        raise CharacterSheetError('panel face off-center (chin/ear crop)', status_code=422)
    if face_key == 'side' and fw / float(w) < 0.18:
        raise CharacterSheetError('panel side face too narrow (face cropped)', status_code=422)
    return (x1, y1, x2, y2)

def assert_face_closeup_framing(data: bytes, *, min_face_height_frac: float=0.35, max_face_height_frac: float=0.8, min_face_area: float=0.04, face_key: str | None=None, require_mouth_in_frame: bool=False) -> dict:
    """16:45：近景脸格门禁——有人脸，且脸高占格高约 25%–70%（替代 coverage 0.90）。

    17:47：上限 0.80（父代理）；吸收 reframe 测量余量，近景头肩而非贴脸裁切。
    19:01：下限改为 0.35（脸格头高≥35%）；过小则先 auto_tighten 再验。
    19:55：表情格可收紧到 0.55–0.65，并可选要求嘴在框内（禁贴/出底）。

    全身格仍走 assert_panel_coverage；本函数只用于 faces / expr_*。
    """
    img = Image.open(BytesIO(data)).convert('RGB')
    _w, h = img.size
    area = float(min_face_area)
    if face_key in ('face_three_quarter', 'face_side'):
        area = min(area, 0.02)
    bb = assert_face_visible(data, min_face_area=area, face_key=face_key)
    x1, y1, x2, y2 = bb
    face_h = max(1.0, float(y2) - float(y1))
    frac = face_h / float(max(1, h))
    if frac + 1e-12 < float(min_face_height_frac):
        raise CharacterSheetError(f'face height frac {frac:.3f} < {min_face_height_frac:.2f} (face too small in cell)', status_code=422)
    if frac - 1e-12 > float(max_face_height_frac):
        raise CharacterSheetError(f'face height frac {frac:.3f} > {max_face_height_frac:.2f} (face too large / overcropped)', status_code=422)
    info = {'bbox': bb, 'face_height_frac': frac, 'min': float(min_face_height_frac), 'max': float(max_face_height_frac)}
    if require_mouth_in_frame:
        info.update(assert_mouth_in_frame(data, face_bbox=bb))
    return info

def assert_expression_inpaint_exterior(original: bytes, edited: bytes, mask: Image.Image | None=None, *, max_mae: float=2.5, expr_key: str='expr') -> float:
    """门禁1：遮罩外与底图差值近 0（真 inpaint 天然对齐；位移贴回必 fail）。"""
    mae = expression_mask_exterior_mae(original, edited, mask)
    if mae > float(max_mae):
        raise CharacterSheetError(f'{expr_key} inpaint 遮罩外差过大 mae={mae:.2f}>{max_mae}', status_code=422)
    return mae

def assert_expression_eyes_mouth_in_mask(data: bytes, mask: Image.Image | None=None, *, expr_key: str='expr', require_mouth: bool=True) -> dict[str, float | bool | str]:
    """18:30 门禁：遮罩区内必须检出眼睛和嘴（landmark 优先，启发式兜底）。

    21:30：沉思眼部-only 遮罩可设 require_mouth=False（嘴不在可编辑区内属预期）。
    """
    im = Image.open(BytesIO(data)).convert('RGB')
    if mask is None:
        mask = build_face_feature_mask_hard(min(im.size))
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    mp = mask.load()
    w, h = im.size
    kps = _insightface_face_kps_xy(data)
    info: dict[str, float | bool | str] = {'route': 'none'}
    if kps is not None:
        le, re, _nose, lm, rm = kps
        mouth = ((lm[0] + rm[0]) / 2.0, (lm[1] + rm[1]) / 2.0)
        checks = [('left_eye', le), ('right_eye', re)]
        if require_mouth:
            checks.append(('mouth', mouth))
        missing: list[str] = []
        for name, (x, y) in checks:
            xi = int(round(x))
            yi = int(round(y))
            if not (0 <= xi < w and 0 <= yi < h) or mp[xi, yi] < 96:
                missing.append(name)
            info[f'{name}_xy'] = float(xi) + float(yi) * 0.0
            info[f'{name}_in'] = 1.0 if 0 <= xi < w and 0 <= yi < h and (mp[xi, yi] >= 96) else 0.0
        info['route'] = 'insightface_kps'
        info['require_mouth'] = bool(require_mouth)
        if missing:
            raise CharacterSheetError(f"{expr_key}遮罩区内未检出{'/'.join(missing)}", status_code=422)
        if float(info.get('left_eye_in', 0)) < 0.5 or float(info.get('right_eye_in', 0)) < 0.5:
            raise CharacterSheetError(f'{expr_key}遮罩区内未检出眼睛', status_code=422)
        if require_mouth and float(info.get('mouth_in', 0)) < 0.5:
            raise CharacterSheetError(f'{expr_key}遮罩区内未检出嘴', status_code=422)
        return info
    eyes_ok, mouth_ok, hinfo = _heuristic_eyes_mouth_in_mask(data, mask)
    info.update(hinfo)
    info['route'] = 'heuristic'
    info['eyes_ok'] = eyes_ok
    info['mouth_ok'] = mouth_ok
    info['require_mouth'] = bool(require_mouth)
    if not eyes_ok:
        raise CharacterSheetError(f'{expr_key}遮罩区内未检出眼睛', status_code=422)
    if require_mouth and (not mouth_ok):
        raise CharacterSheetError(f'{expr_key}遮罩区内未检出嘴', status_code=422)
    return info

def assert_expression_no_gray_smear(original: bytes, edited: bytes, mask: Image.Image | None=None, *, min_var_ratio: float=0.12, min_sat_ratio: float=0.25, min_abs_var: float=80.0, min_abs_sat: float=0.025, max_gray_mean_dist: float=18.0, expr_key: str='expr') -> dict[str, float]:
    """门禁2：脸部区域无灰色涂抹。

    17:38b：二次元 cel 平滑会压低相对方差，改「绝对低方差/低饱和 + 相对骤降」双条件；
    18:30：追加「遮罩区均值距 0.5 灰(128)」——VAEEncodeForInpaint 残留灰块必拒；
    均匀灰涂 (var≈0/sat≈0) 仍必拒，正常 anime inpaint 不误杀。
    """
    bv, bs = _face_region_var_sat(original, mask)
    ev, es = _face_region_var_sat(edited, mask)
    mr, mg, mb = _face_region_mean_rgb(edited, mask)
    gray_dist = (((mr - 128.0) ** 2 + (mg - 128.0) ** 2 + (mb - 128.0) ** 2) / 3.0) ** 0.5
    info = {'base_var': bv, 'edit_var': ev, 'base_sat': bs, 'edit_sat': es, 'var_ratio': ev / bv if bv > 1e-06 else 1.0, 'sat_ratio': es / bs if bs > 1e-06 else 1.0, 'mean_r': mr, 'mean_g': mg, 'mean_b': mb, 'gray_mean_dist': gray_dist}
    if gray_dist < float(max_gray_mean_dist) and ev < 450.0:
        raise CharacterSheetError(f'{expr_key}脸部灰涂抹(贴近0.5灰) dist={gray_dist:.1f} var={ev:.1f} mean=({mr:.0f},{mg:.0f},{mb:.0f})', status_code=422)
    gray_var = ev < float(min_abs_var) or (bv > 8.0 and ev + 1e-09 < bv * float(min_var_ratio) and (ev < 200.0))
    if gray_var:
        raise CharacterSheetError(f"{expr_key}脸部灰涂抹(方差过低) var={ev:.1f}/{bv:.1f} ratio={info['var_ratio']:.2f}", status_code=422)
    gray_sat = es < float(min_abs_sat) or (bs > 0.04 and es + 1e-09 < bs * float(min_sat_ratio) and (es < 0.04))
    if gray_sat:
        raise CharacterSheetError(f"{expr_key}脸部灰涂抹(饱和度过低) sat={es:.3f}/{bs:.3f} ratio={info['sat_ratio']:.2f}", status_code=422)
    return info

def measure_face_height_frac(data: bytes) -> float | None:
    """脸高占格高；无人脸返回 None。"""
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            img = Image.open(BytesIO(data)).convert('RGB')
            bb = _heuristic_skin_face_bbox(img)
        except Exception:
            bb = None
    if bb is None:
        return None
    img = Image.open(BytesIO(data))
    _w, h = img.size
    x1, y1, x2, y2 = bb
    return max(1.0, float(y2) - float(y1)) / float(max(1, h))

def face_crop_looks_ok(data: bytes) -> bool:
    """目检启发式:禁半脸(顶缘裁掉额头或底缘贴下巴截断);允许头顶少量留白。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    small = img.resize((32, 32), Image.Resampling.BILINEAR)
    px = list(small.getdata())

    def _fg(r, g, b) -> bool:
        mx, mn = (max(r, g, b), min(r, g, b))
        if r > 235 and g > 235 and (b > 235):
            return False
        if mx - mn < 12 and 80 <= mx <= 210:
            return False
        return True

    def _band_fg(y0, y1):
        return sum((1 for x in range(6, 26) for y in range(y0, y1) if _fg(*px[y * 32 + x])))
    top_fg = _band_fg(0, 5)
    bot_fg = _band_fg(27, 32)
    mid_fg = _band_fg(8, 24)
    if top_fg >= 90 and mid_fg < 40:
        return False
    if mid_fg < 25:
        return False
    if bot_fg >= 85 and top_fg >= 85 and (mid_fg > 120):
        return False
    return True

def estimate_face_yaw_deg(data: bytes) -> float | None:
    """估计人脸 yaw(度绝对值 0~90)。优先 insightface;否则左右不对称启发式。"""
    try:
        import numpy as np
        import cv2
        from insightface.app import FaceAnalysis
        import os
        arr = np.frombuffer(data, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is not None:
            global _YAW_FACE_APP
            app = _YAW_FACE_APP
            if app is None:
                root = os.environ.get('INSIGHTFACE_HOME') or os.path.expanduser('~/.insightface')
                app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'], root=root)
                app.prepare(ctx_id=-1, det_size=(640, 640))
                _YAW_FACE_APP = app
            faces = app.get(bgr)
            if faces:
                f = sorted(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]), reverse=True)[0]
                pose = getattr(f, 'pose', None)
                if pose is not None and len(pose) >= 2:
                    return float(abs(pose[1]))
                kps = getattr(f, 'kps', None)
                bbox = getattr(f, 'bbox', None)
                if kps is not None and len(kps) >= 3:
                    le, re, nose = (kps[0], kps[1], kps[2])
                    mid_x = (float(le[0]) + float(re[0])) / 2.0
                    eye_w = abs(float(re[0]) - float(le[0])) + 0.001
                    off = (float(nose[0]) - mid_x) / eye_w
                    yaw = min(90.0, abs(off) * 80.0)
                    if bbox is not None:
                        face_w = max(1.0, float(bbox[2] - bbox[0]))
                        if eye_w / face_w < 0.12:
                            yaw = max(yaw, 82.0)
                        elif eye_w / face_w < 0.22:
                            yaw = max(yaw, 48.0)
                    return float(yaw)
    except Exception:
        pass
    img = Image.open(BytesIO(data)).convert('RGB')
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    left_m = right_m = mass_x = mass = 0.0
    for y in range(8, 48):
        for x in range(64):
            r, g, b = px[y * 64 + x]
            mx, mn = (max(r, g, b), min(r, g, b))
            if r > 230 and g > 230 and (b > 230):
                continue
            if mx - mn < 14 and 70 <= mx <= 200:
                continue
            if mx < 25:
                continue
            mass_x += x
            mass += 1.0
            if x < 32:
                left_m += 1.0
            else:
                right_m += 1.0
    if mass < 20:
        return None
    offset = abs(mass_x / mass - 32.0) / 32.0
    ratio = abs(left_m - right_m) / max(left_m + right_m, 1.0)
    return float(min(90.0, (0.55 * offset + 0.45 * ratio) * 120.0))

def yaw_ok_for_face_key(yaw: float | None, face_key: str, *, style: str | None=None) -> bool:
    """偏航门禁。

    二次元 insightface 对 cel 脸系统性偏低（目检约 35–45° 常被估成 ~24°），
    故 anime/二次元 的三分脸放宽为 20–60；写实仍为 30–60。正/侧不变。
    """
    if yaw is None:
        return False
    y = abs(float(yaw))
    st = (style or '').strip().lower()
    anime = st in {'anime', '二次元', 'cel', 'cartoon'}
    if face_key == 'face_front':
        return y < 15.0
    if face_key == 'face_three_quarter':
        lo = 20.0 if anime else 30.0
        return lo <= y <= 60.0
    if face_key == 'face_side':
        return 75.0 <= y <= 105.0
    return False

def _panel_is_blank_or_glitch(data: bytes) -> bool:
    """简单启发式:空白/花屏则 True。"""
    try:
        img = Image.open(BytesIO(data)).convert('RGB')
    except Exception:
        return True
    img = img.resize((64, 64), Image.Resampling.BILINEAR)
    pixels = list(img.getdata())
    if not pixels:
        return True
    n = len(pixels)
    mean = tuple((sum((c[i] for c in pixels)) / n for i in range(3)))
    var = sum((sum(((c[i] - mean[i]) ** 2 for i in range(3))) for c in pixels)) / n
    if var < 80:
        return True
    zig = 0
    for i in range(1, n):
        zig += sum((abs(pixels[i][j] - pixels[i - 1][j]) for j in range(3)))
    zig /= n
    if zig > 90 and var > 8000:
        return True
    return False

def assert_costume_cells_nonempty(costume_png: bytes, *, min_ratio: float=0.12, n: int=4) -> list[float]:
    """服饰栏每格须非空且内容像素占比 > 阈值；否则 CharacterSheetError。"""
    ratios = costume_cell_content_ratios(costume_png, n=n)
    bad = [i for i, r in enumerate(ratios) if r < min_ratio]
    if bad:
        raise CharacterSheetError(f'costume cells empty/thin: idx={bad} ratios={[round(x, 3) for x in ratios]} min={min_ratio}')
    return ratios

def assert_face_triplet_equal_width(faces_png: bytes, *, n: int=3, cell_w: int | None=None, cell_h: int | None=None, gap: int | None=None, max_content_ratio: float=1.6, max_face_width_delta_px: int | None=None, max_face_height_frac_delta: float | None=None, min_side_margin: float | None=None) -> dict:
    """断言面部三格同宽同高（18:38）。

    显式 cell_w/gap：校验画布几何；可选再验人脸框、高度占比差、水平居中边距。
    否则：等分切格后前景宽度比不得超过 max_content_ratio（挡旧 hstack）。
    """
    im = Image.open(BytesIO(faces_png)).convert('RGB')
    w, h = im.size
    if w < n * 8:
        raise CharacterSheetError(f'faces panel too narrow: {w}')
    info: dict = {'geo': None, 'content_widths': [], 'face_widths': [], 'margins': []}
    if cell_w is not None and gap is not None:
        expect = n * cell_w + (n - 1) * gap
        if w != expect:
            raise CharacterSheetError(f'faces geometry {w} != {n}*{cell_w}+{n - 1}*{gap}={expect}')
        if cell_h is not None and h != int(cell_h):
            raise CharacterSheetError(f'faces height {h} != cell_h={cell_h}')
        info['geo'] = {'cell_w': cell_w, 'cell_h': h, 'gap': gap}
        if max_face_width_delta_px is None and min_side_margin is None and (max_face_height_frac_delta is None):
            return info
        measured = measure_face_triplet_layout(faces_png, n=n, cell_w=cell_w, gap=gap)
        info['face_widths'] = measured['face_widths']
        info['face_heights'] = measured['face_heights']
        info['face_height_fracs'] = measured['face_height_fracs']
        info['margins'] = measured['margins']
        info['cell_widths'] = measured['cell_widths']
        info['cell_heights'] = measured['cell_heights']
        if max(measured['cell_heights']) - min(measured['cell_heights']) > 2:
            raise CharacterSheetError(f"face cells not equal height ±2px: {measured['cell_heights']}")
        widths = [x for x in measured['face_widths'] if x > 0]
        if len(widths) < n:
            raise CharacterSheetError(f"face bbox missing in cells: face_widths={measured['face_widths']}")
        if max_face_width_delta_px is not None:
            delta = max(widths) - min(widths)
            if delta > int(max_face_width_delta_px):
                raise CharacterSheetError(f"face widths not equal ±{max_face_width_delta_px}px: {measured['face_widths']} delta={delta}")
        if max_face_height_frac_delta is not None:
            fracs = [f for f in measured['face_height_fracs'] if f > 0]
            if len(fracs) < n:
                raise CharacterSheetError(f"face height fracs missing: {measured['face_height_fracs']}")
            fdelta = max(fracs) - min(fracs)
            if fdelta > float(max_face_height_frac_delta) + 1e-09:
                raise CharacterSheetError(f"face height frac delta>{max_face_height_frac_delta}: {measured['face_height_fracs']} delta={fdelta:.3f}")
        if min_side_margin is not None:
            for i, m in enumerate(measured['margins']):
                if i == n - 1:
                    continue
                if m['left'] + 1e-09 < float(min_side_margin) or m['right'] + 1e-09 < float(min_side_margin):
                    raise CharacterSheetError(f"face cell{i} not centered: margins L={m['left']:.3f} R={m['right']:.3f} need >={min_side_margin}")
        return info
    cell = w // n
    widths: list[int] = []
    for i in range(n):
        x0 = i * cell
        x1 = w if i == n - 1 else (i + 1) * cell
        cim = im.crop((x0, 0, x1, h))
        px = cim.load()
        minx, maxx = (cim.width, -1)
        for y in range(cim.height):
            for x in range(cim.width):
                r, gch, b = px[x, y]
                if r > 245 and gch > 245 and (b > 245):
                    continue
                if abs(r - gch) < 6 and abs(gch - b) < 6 and (r > 235):
                    continue
                minx = min(minx, x)
                maxx = max(maxx, x)
        widths.append(0 if maxx < 0 else maxx - minx + 1)
    positive = [x for x in widths if x > 0]
    if len(positive) < n:
        raise CharacterSheetError(f'face cells empty: content_widths={widths}')
    ratio = max(positive) / max(1, min(positive))
    if ratio > max_content_ratio:
        raise CharacterSheetError(f'face cells not equal width: content_widths={widths} ratio={ratio:.2f}')
    info['content_widths'] = widths
    return info

def assert_face_triplet_cell_edges_clean(faces_png: bytes, *, cell_w: int, cell_h: int, gap: int=12, band: int=4, max_delta: float=40.0, max_band_var: float=120.0) -> dict:
    """19:20：每格四边 band px 内不得有「近均匀且与邻带色差>max_delta」的竖/横杂条。"""
    im = Image.open(BytesIO(faces_png)).convert('RGB')
    expect_w = 3 * cell_w + 2 * gap
    if im.width != expect_w or im.height != cell_h:
        raise CharacterSheetError(f'faces geometry {im.size} != ({expect_w},{cell_h})')
    px = im.load()
    bad: list[str] = []

    def _stats(x0: int, y0: int, x1: int, y1: int) -> tuple[tuple[float, float, float], float]:
        rs = gs = bs = 0.0
        n = 0
        samples: list[tuple[int, int, int]] = []
        for y in range(y0, y1):
            for x in range(x0, x1):
                r, g, b = px[x, y]
                rs += r
                gs += g
                bs += b
                n += 1
                samples.append((r, g, b))
        if n <= 0:
            return ((0.0, 0.0, 0.0), 0.0)
        mean = (rs / n, gs / n, bs / n)
        var = sum(((r - mean[0]) ** 2 + (g - mean[1]) ** 2 + (b - mean[2]) ** 2 for r, g, b in samples)) / (n * 3.0)
        return (mean, var)

    def _delta(a, b) -> float:
        return (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0
    for i in range(3):
        x0 = i * (cell_w + gap)
        checks = [('L', (x0, 0, x0 + band, cell_h), (x0 + band, 0, x0 + min(cell_w, band * 3), cell_h)), ('R', (x0 + cell_w - band, 0, x0 + cell_w, cell_h), (x0 + max(0, cell_w - band * 3), 0, x0 + cell_w - band, cell_h)), ('T', (x0, 0, x0 + cell_w, band), (x0, band, x0 + cell_w, min(cell_h, band * 3))), ('B', (x0, cell_h - band, x0 + cell_w, cell_h), (x0, max(0, cell_h - band * 3), x0 + cell_w, cell_h - band))]
        if i == 2:
            checks = [c for c in checks if c[0] not in ('L', 'T')]
        for name, outer_box, inner_box in checks:
            omean, ovar = _stats(*outer_box)
            imean, _ivar = _stats(*inner_box)
            d = _delta(omean, imean)
            if ovar <= max_band_var and d > max_delta:
                bad.append(f'cell{i}-{name} var={ovar:.1f} delta={d:.1f}')
    if bad:
        raise CharacterSheetError(f'face cell edge strips: {bad}')
    return {'ok': True, 'band': band, 'max_delta': max_delta, 'max_band_var': max_band_var}

def assert_profile_cell_pad_delta_e(cell_rgb: Image.Image, src_rgb: Image.Image, *, band: int=10, max_delta_e: float=6.0) -> dict:
    """R 格鼻前（左侧）补边区与源图背景色 ΔE < max_delta_e（20:38：不再验顶边）。"""
    import math
    cell = cell_rgb.convert('RGB')
    src = src_rgb.convert('RGB')
    fill = _sample_profile_bg(src)
    cw, ch = cell.size
    b = max(2, min(int(band), cw // 4, ch // 4))

    def _to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
        r, g, b_ = [x / 255.0 for x in rgb]

        def _f(u: float) -> float:
            return ((u + 0.055) / 1.055) ** 2.4 if u > 0.04045 else u / 12.92
        r, g, b_ = (_f(r), _f(g), _f(b_))
        x = r * 0.4124 + g * 0.3576 + b_ * 0.1805
        y = r * 0.2126 + g * 0.7152 + b_ * 0.0722
        z = r * 0.0193 + g * 0.1192 + b_ * 0.9505

        def _g(t: float) -> float:
            return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
        xr, yr, zr = (_g(x / 0.95047), _g(y / 1.0), _g(z / 1.08883))
        L = 116 * yr - 16
        a = 500 * (xr - yr)
        bb = 200 * (yr - zr)
        return (L, a, bb)
    fl = _to_lab(fill)
    px = cell.load()
    samples: list[tuple[int, int, int]] = []
    for y in range(ch):
        for x in range(b):
            r, g, bb = px[x, y]
            if (r + g + bb) / 3.0 < 150:
                continue
            if max(r, g, bb) - min(r, g, bb) > 40:
                continue
            samples.append((r, g, bb))
    if not samples:
        return {'ok': True, 'max_delta_e': 0.0, 'n': 0, 'fill': fill}
    samples.sort()
    med = samples[len(samples) // 2]
    lab = _to_lab(med)
    d = math.sqrt(sum(((lab[i] - fl[i]) ** 2 for i in range(3))))
    ok = d <= float(max_delta_e) + 1e-06
    if not ok:
        raise CharacterSheetError(f'profile pad ΔE too high: median={d:.2f} sample={med} fill={fill} (limit {max_delta_e})')
    return {'ok': True, 'max_delta_e': d, 'median_rgb': med, 'n': len(samples), 'fill': fill}

def assert_face_triplet_profile_lead_margin(faces_png: bytes, *, cell_w: int, cell_h: int, gap: int=12, min_lead: float=0.12, min_top: float=0.0, max_top: float=0.08, cell_index: int=2, require_top_pad_zero: bool=True) -> dict:
    """20:38：侧脸格（默认 R）鼻尖侧留白≥min_lead；顶边 top_pad=0（发顶可贴齐/出框）。

    用上半身前景外轮廓量：左向侧脸取最左前景列作鼻侧，最上前景行作头顶。
    max_top 防止回归到 fix44 约 19% 浅底刀切；require_top_pad_zero 读取 last_pad。
    """
    im = Image.open(BytesIO(faces_png)).convert('RGB')
    expect_w = 3 * cell_w + 2 * gap
    if im.width != expect_w or im.height != cell_h:
        raise CharacterSheetError(f'faces geometry {im.size} != ({expect_w},{cell_h})')
    x0 = cell_index * (cell_w + gap)
    cell = im.crop((x0, 0, x0 + cell_w, cell_h))
    w, h = cell.size
    px = cell.load()

    def _is_bg(r: int, g: int, b: int) -> bool:
        if r > 230 and g > 230 and (b > 235):
            return True
        mx, mn = (max(r, g, b), min(r, g, b))
        if mx - mn < 14 and 65 <= mx <= 252:
            return True
        return False
    y_lim = max(8, int(h * 0.7))
    xs: list[int] = []
    ys: list[int] = []
    for yy in range(y_lim):
        for xx in range(w):
            r, g, b = px[xx, yy]
            if _is_bg(r, g, b):
                continue
            xs.append(xx)
            ys.append(yy)
    if len(xs) < 12:
        raise CharacterSheetError(f'profile cell{cell_index}: no foreground for margin')
    left_x, right_x = (min(xs), max(xs))
    top_y = min(ys)
    left_m = left_x / max(1, w)
    right_m = (w - 1 - right_x) / max(1, w)
    facing_left = left_m >= right_m
    nose_x = left_x if facing_left else right_x
    lead = nose_x / w if facing_left else (w - nose_x) / w
    top = top_y / max(1, h)
    if lead + 1e-09 < float(min_lead):
        raise CharacterSheetError(f'profile cell{cell_index} lead margin {lead:.3f} < {min_lead}')
    if top + 1e-09 < float(min_top):
        raise CharacterSheetError(f'profile cell{cell_index} top margin {top:.3f} < {min_top}')
    if top - 1e-09 > float(max_top):
        raise CharacterSheetError(f'profile cell{cell_index} top margin {top:.3f} > {max_top} (top_pad must be 0)')
    top_pad = None
    last = getattr(_fit_profile_head_cell, 'last_pad', None)
    if require_top_pad_zero:
        if not isinstance(last, dict) or int(last.get('top_pad', -1)) != 0:
            raise CharacterSheetError(f'profile cell{cell_index} top_pad!=0 (last_pad={last})')
        top_pad = 0
    elif isinstance(last, dict):
        top_pad = int(last.get('top_pad', -1))
    return {'ok': True, 'cell_index': cell_index, 'facing_left': facing_left, 'lead': lead, 'top': top, 'top_pad': top_pad, 'nose_x': nose_x, 'top_y': top_y}

def assert_sheet_faces_equal_width(sheet_png: bytes, *, max_cell_delta_px: int=2, max_face_width_delta_px: int | None=None, max_face_height_frac_delta: float | None=0.1, min_side_margin: float=0.1) -> dict:
    """最终整卡 faces 区实测（18:38）：三格可见宽高±2px、人脸高占比差≤10%、水平边距≥10%。"""
    im = Image.open(BytesIO(sheet_png)).convert('RGB')
    fx, fy, fw, fh = LAYOUT['faces']
    box = (fx + 8, fy + 32, fw - 16, fh - 40)
    x, y, w, h = box
    region = im.crop((x, y, x + w, y + h))
    n = 3
    cell = w // n
    cell_widths: list[int] = []
    cell_heights: list[int] = []
    face_widths: list[int] = []
    face_height_fracs: list[float] = []
    margins: list[dict] = []
    for i in range(n):
        x0 = i * cell
        x1 = w if i == n - 1 else (i + 1) * cell
        cim = region.crop((x0, 0, x1, h))
        cell_widths.append(cim.width)
        cell_heights.append(cim.height)
        bb = _face_bbox_for_center(cim)
        if bb is None:
            face_widths.append(0)
            face_height_fracs.append(0.0)
            margins.append({'left': 0.0, 'right': 0.0})
            continue
        a, b0, c0, d0 = bb
        face_widths.append(c0 - a)
        face_height_fracs.append((d0 - b0) / max(1, cim.height))
        margins.append({'left': a / max(1, cim.width), 'right': (cim.width - c0) / max(1, cim.width)})
    if max(cell_widths) - min(cell_widths) > int(max_cell_delta_px):
        raise CharacterSheetError(f'sheet face cells not equal width ±{max_cell_delta_px}px: {cell_widths}')
    if max(cell_heights) - min(cell_heights) > int(max_cell_delta_px):
        raise CharacterSheetError(f'sheet face cells not equal height ±{max_cell_delta_px}px: {cell_heights}')
    positive = [x for x in face_widths if x > 0]
    if len(positive) < n:
        raise CharacterSheetError(f'sheet face bbox missing: {face_widths}')
    if max_face_width_delta_px is not None and max(positive) - min(positive) > int(max_face_width_delta_px):
        raise CharacterSheetError(f'sheet face widths not equal ±{max_face_width_delta_px}px: {face_widths}')
    if max_face_height_frac_delta is not None:
        fracs = [f for f in face_height_fracs if f > 0]
        if len(fracs) < n:
            raise CharacterSheetError(f'sheet face height fracs missing: {face_height_fracs}')
        fdelta = max(fracs) - min(fracs)
        if fdelta > float(max_face_height_frac_delta) + 1e-09:
            raise CharacterSheetError(f'sheet face height frac delta>{max_face_height_frac_delta}: {face_height_fracs} delta={fdelta:.3f}')
    if min_side_margin is not None and float(min_side_margin) > 0:
        for i, m in enumerate(margins):
            if i == n - 1:
                continue
            if m['left'] + 1e-09 < float(min_side_margin) or m['right'] + 1e-09 < float(min_side_margin):
                raise CharacterSheetError(f"sheet face cell{i} not centered: L={m['left']:.3f} R={m['right']:.3f}")
    return {'cell_widths': cell_widths, 'cell_heights': cell_heights, 'face_widths': face_widths, 'face_height_fracs': face_height_fracs, 'margins': margins, 'region': [w, h]}

def _insightface_face_bbox_xyxy(data: bytes) -> tuple[float, float, float, float] | None:
    """最大人脸框 (x1,y1,x2,y2) 像素坐标; insightface 不可用则 None。"""
    try:
        import numpy as np
        import cv2
        from insightface.app import FaceAnalysis
        import os
        arr = np.frombuffer(data, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            return None
        global _YAW_FACE_APP
        app = _YAW_FACE_APP
        if app is None:
            root = os.environ.get('INSIGHTFACE_HOME') or os.path.expanduser('~/.insightface')
            app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'], root=root)
            app.prepare(ctx_id=-1, det_size=(640, 640))
            _YAW_FACE_APP = app
        faces = app.get(bgr)
        if not faces:
            return None
        f = sorted(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]), reverse=True)[0]
        bb = getattr(f, 'bbox', None)
        if bb is None:
            return None
        return (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3]))
    except Exception:
        return None

def _anime_cascade_face_bbox_xyxy(data: bytes) -> tuple[float, float, float, float] | None:
    """17:55：lbpcascade_animeface 兜底；OpenCV 5 无 CascadeClassifier 时返回 None（靠启发式）。"""
    try:
        import cv2
        import numpy as np
        from pathlib import Path as _P
        global _ANIME_CASCADE
        casc = _ANIME_CASCADE
        if casc is None:
            xml = _P(__file__).resolve().parents[2] / 'assets' / 'lbpcascade_animeface.xml'
            if not xml.is_file():
                return None
            casc = cv2.CascadeClassifier(str(xml))
            if casc.empty():
                return None
            _ANIME_CASCADE = casc
        arr = np.frombuffer(data, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            return None
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        faces = casc.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(48, 48))
        if faces is None or len(faces) == 0:
            return None
        x, y, fw, fh = max(faces, key=lambda t: int(t[2]) * int(t[3]))
        return (float(x), float(y), float(x + fw), float(y + fh))
    except Exception:
        return None

def _detect_face_bbox_xyxy(data: bytes) -> tuple[float, float, float, float] | None:
    """insightface → 动漫级联 → None。"""
    bb = _insightface_face_bbox_xyxy(data)
    if bb is not None:
        return bb
    return _anime_cascade_face_bbox_xyxy(data)

def _heuristic_skin_face_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    """肤色/五官启发式脸框,优先上半身肤色块,避免宽袖汉服全身前景拉偏中心。"""
    w, h = img.size
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    sp = small.load()
    xs, ys = ([], [])
    for y in range(64):
        if y >= 46:
            continue
        for x in range(64):
            r, g, b = sp[x, y]
            mx, mn = (max(r, g, b), min(r, g, b))
            if r > 235 and g > 235 and (b > 235):
                continue
            if mx - mn < 12 and 60 <= mx <= 210:
                continue
            if mx < 28 and mx - mn < 10:
                continue
            skin_real = r > 95 and g > 40 and (b > 20) and (r >= g) and (r >= b) and (r - g > 10) and (mx - mn > 15)
            skin_anime = r > 170 and g > 130 and (b > 120) and (r >= g - 5) and (abs(g - b) < 45) and (mx - mn > 8)
            if skin_real or skin_anime:
                xs.append(x)
                ys.append(y)
    if len(xs) < 10:
        return None
    minx, maxx = (min(xs), max(xs))
    miny, maxy = (min(ys), max(ys))
    hair_top = miny
    for y in range(miny - 1, max(0, miny - 18), -1):
        dark = 0
        for x in range(max(0, minx - 2), min(63, maxx + 2) + 1):
            r, g, b = sp[x, y]
            if max(r, g, b) < 90:
                dark += 1
        if dark >= max(2, (maxx - minx) // 3):
            hair_top = y
        else:
            break
    miny = hair_top
    pad = 1
    minx, miny = (max(0, minx - pad), max(0, miny - pad))
    maxx, maxy = (min(63, maxx + pad), min(63, maxy + pad))
    left = int(minx * w / 64)
    right = int((maxx + 1) * w / 64)
    top = int(miny * h / 64)
    bot = int((maxy + 1) * h / 64)
    if right - left < 8 or bot - top < 8:
        return None
    return (left, top, right, bot)

def _studio_pad_edge_frac(img: Image.Image | bytes, *, pad_rgb: tuple[int, int, int]=(220, 220, 224), tol: int=6, uniform_frac: float=0.9) -> float:
    """检测棚灰(220,220,224)垫边条带厚度占短边比例（四边最大）。"""
    if isinstance(img, (bytes, bytearray)):
        im = Image.open(BytesIO(img)).convert('RGB')
    else:
        im = img.convert('RGB')
    w, h = im.size
    if w < 8 or h < 8:
        return 1.0
    small = im.resize((64, 64), Image.Resampling.BOX)
    sw, sh = small.size
    px = list(small.getdata())
    pr, pg, pb = pad_rgb

    def _is_pad(r: int, g: int, b: int) -> bool:
        return abs(r - pr) <= tol and abs(g - pg) <= tol and (abs(b - pb) <= tol)

    def _pix(x: int, y: int) -> tuple[int, int, int]:
        return px[y * sw + x]

    def _row_pad(y: int) -> bool:
        return sum((1 for x in range(sw) if _is_pad(*_pix(x, y)))) / float(sw) >= uniform_frac

    def _col_pad(x: int) -> bool:
        return sum((1 for y in range(sh) if _is_pad(*_pix(x, y)))) / float(sh) >= uniform_frac
    top = 0
    while top < sh // 2 and _row_pad(top):
        top += 1
    bot = 0
    while bot < sh // 2 and _row_pad(sh - 1 - bot):
        bot += 1
    left = 0
    while left < sw // 2 and _col_pad(left):
        left += 1
    right = 0
    while right < sw // 2 and _col_pad(sw - 1 - right):
        right += 1
    return max(top, bot, left, right) / float(max(1, min(sw, sh)))
