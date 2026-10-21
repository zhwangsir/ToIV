"""设定卡模板/版式常量/提示词/SheetMeta(character_sheet 拆包)."""
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

SHEET_STYLES = ('ancient_realistic', 'anime')
SHEET_W, SHEET_H = (2400, 3200)

_PANEL_KEYS = ('portrait', 'front', 'side', 'back', 'faces', 'costume')

_EXPR_KEYS = tuple((f'expr_{i}' for i in range(6)))

_EXPR_LABELS = ('威严', '冷酷', '沉思', '温柔', '惊恐', '果断')

_EXPR_PROMPTS = ('stern majestic expression, extreme face closeup head and shoulders', 'cold aloof expression, icy gaze, extreme face closeup head and shoulders', 'thoughtful contemplative expression, eyes looking down and to one side, brows slightly furrowed, lips closed, extreme face closeup head and shoulders', 'gentle smile, mouth corners up, soft relaxed brows, eyes softly curved, extreme face closeup head only no chest', 'terrified shocked expression, wide eyes open mouth, fear, extreme face closeup head and shoulders', 'determined, firm closed mouth, focused eyes, eyebrows slightly lowered, extreme face closeup head and shoulders')

LAYOUT = {'canvas': (SHEET_W, SHEET_H), 'portrait': (48, 48, 720, 1180), 'name': (48, 1240, 720, 72), 'profile': (48, 1320, 720, 420), 'turnaround': (800, 48, 1552, 1692), 'faces': (48, 1780, 760, 520), 'expressions': (840, 1780, 980, 520), 'costume': (48, 2340, 1180, 520), 'palette': (1260, 2340, 520, 200), 'notes': (1260, 2560, 1092, 300), 'footer': (48, 3080, 2304, 80)}

_STYLE_SUFFIX = {'ancient_realistic': 'cinematic photorealistic character design, detailed silk fabric texture, traditional Chinese hanfu, ink-wash soft lighting, solid seamless dark gray background, no scenery, no text, character sheet quality', 'anime': 'anime, 2D illustration, cel shading, clean lineart, official character art, NOT photorealistic, NOT real photo, NOT 3D render, solid seamless light gray background, no scenery, no text'}

_STYLE_NEGATIVE = {'ancient_realistic': 'blurry, low quality, text, watermark, deformed, extra limbs, raincoat, windbreaker, hoodie, modern jacket, plastic umbrella, convenience store, neon lights, rain boots, plastic shopping bag, contemporary clothing, streetwear, zippered coat, white hair, silver hair, grey hair, multiple people, collage, split screen, grid, two people in one frame, glitch, chromatic aberration', 'anime': 'photorealistic, real photo, photograph, realistic skin pores, 3d render, western cartoon, blurry, low quality, text, watermark, chinese text, chinese characters, letters, alphabet, caption, subtitle, title, deformed, extra limbs, hanfu, ancient chinese clothing, white robe, white dress, white hair, silver hair, grey hair, blue hair, blonde hair, multiple people, collage, split screen, grid, two people in one frame, 1boy, 2boys, male, man, couple, duo, two girls, twins, glitch, chromatic aberration, scan lines, multiple faces, face sheet, sketch dump, concept art board, white jacket, white coat, beige cloak, brown cloak, red cloak, tan cape, khaki poncho, mannequin, human body in product shot, person wearing boots, white hoodie, white t-shirt, color-block hoodie, navy sleeves on white shirt, baseball cap, hat on stand, ceiling lamp, dome light, opaque black dome, hard hat, helmet, bowl, chest badge, chest emblem, chest logo, circular chest pattern, spiral emblem, five point star, star patch, white star on chest, embroidered star, round emblem on chest, brand patch, red badge, graphic print on torso, cloak, cape, poncho, wide sleeves, kimono sleeves'}

def _costume_template_bytes(item_key: str, size: int=768) -> bytes:
    """程序化单品轮廓底图,供服饰 img2img 锚定形状(防白卫衣/畸变伞)。"""
    bg = (245, 245, 248) if item_key in ('umbrella', 'bag') else (255, 255, 255)
    im = Image.new('RGB', (size, size), bg)
    d = ImageDraw.Draw(im)
    m = size // 10
    if item_key == 'raincoat':
        slate = (90, 106, 122)
        body = [m * 3, m * 3, size - m * 3, size - m * 2]
        d.rectangle(body, fill=slate)
        d.ellipse([size // 2 - m * 2, m, size // 2 + m * 2, m * 4], fill=slate)
        d.rectangle([m, m * 4, m * 3, m * 7], fill=(12, 12, 14))
        d.rectangle([size - m * 3, m * 4, size - m, m * 7], fill=(12, 12, 14))
        d.line([(size // 2, m * 3), (size // 2, size - m * 2)], fill=(40, 40, 44), width=3)
    elif item_key == 'pants':
        gap = m
        wleg = (size - 2 * m - gap) // 2
        d.rectangle([m, m * 2, m + wleg, size - m], fill=(12, 12, 14))
        d.rectangle([m + wleg + gap, m * 2, m + 2 * wleg + gap, size - m], fill=(12, 12, 14))
        d.rectangle([m, m * 2, m + 2 * wleg + gap, m * 3], fill=(12, 12, 14))
    elif item_key == 'boots':
        for ox in (size // 2 - m * 3, size // 2 + m):
            d.rounded_rectangle([ox, m * 3, ox + m * 2, size - m], radius=20, outline=(30, 30, 34), width=6)
            d.ellipse([ox + 8, m * 3 + 4, ox + m * 2 - 8, m * 3 + m], outline=(50, 50, 55), width=3)
            d.rectangle([ox, size - m - 12, ox + m * 2, size - m], outline=(30, 30, 34), width=4)
    elif item_key == 'umbrella':
        cx, cy = (size // 2, size // 2 - m)
        bbox = [cx - m * 4, cy - m * 3, cx + m * 4, cy + m * 2]
        d.ellipse(bbox, outline=(30, 30, 34), width=4)
        for ang in range(-60, 61, 20):
            import math
            rad = math.radians(ang)
            x2 = cx + int(m * 3.6 * math.sin(rad))
            y2 = cy + int(m * 2.2 * math.cos(rad))
            d.line([(cx, cy + m), (x2, y2)], fill=(50, 50, 55), width=2)
        d.line([(cx, cy + m), (cx, size - m)], fill=(20, 20, 24), width=5)
        d.ellipse([cx - 8, size - m - 8, cx + 8, size - m + 8], fill=(20, 20, 24))
    elif item_key == 'bag':
        d.rectangle([m * 2, m * 3, size - m * 2, size - m * 2], fill=(250, 250, 252), outline=(200, 200, 205), width=3)
        d.arc([m * 2 + 20, m, size // 2 - 10, m * 4], 0, 180, fill=(180, 180, 185), width=6)
        d.arc([size // 2 + 10, m, size - m * 2 - 20, m * 4], 0, 180, fill=(180, 180, 185), width=6)
    else:
        d.rectangle([m, m, size - m, size - m], outline=(0, 0, 0), width=2)
    buf = BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()

def _count_dark_blobs(px: list[tuple[int, int, int]], size: int=64, thr: int=80) -> int:
    """64x64 暗色连通域数量(4-邻域);用于惩罚一格多件/一排重复。"""
    dark = [False] * (size * size)
    for i, (r, g, b) in enumerate(px):
        dark[i] = r < thr and g < thr and (b < thr + 10)
    seen = [False] * (size * size)
    blobs = 0
    for i in range(size * size):
        if not dark[i] or seen[i]:
            continue
        blobs += 1
        stack = [i]
        seen[i] = True
        while stack:
            cur = stack.pop()
            x, y = (cur % size, cur // size)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or ny < 0 or nx >= size or (ny >= size):
                    continue
                j = ny * size + nx
                if dark[j] and (not seen[j]):
                    seen[j] = True
                    stack.append(j)
    return blobs

def _costume_item_penalty(data: bytes, item_key: str) -> float:
    """越大越差;按单品约束(雨衣必须够黑、伞不能实心黑、袋偏白;裤/靴禁多件)。"""
    img = Image.open(BytesIO(data)).convert('RGB').resize((64, 64))
    px = list(img.getdata())
    n = max(1, len(px))
    black = sum((1 for r, g, b in px if r < 70 and g < 70 and (b < 80)))
    white = sum((1 for r, g, b in px if r > 220 and g > 220 and (b > 220)))
    light = sum((1 for r, g, b in px if r > 180 and g > 180 and (b > 180)))
    blue = sum((1 for r, g, b in px if b > r + 25 and b > g + 15 and (b > 120)))
    navy = sum((1 for r, g, b in px if b > r + 10 and g < 90 and (40 < b < 140) and (r < 80)))
    beige = sum((1 for r, g, b in px if r > 120 and g > 90 and (b < r - 15) and (abs(r - g) < 45)))
    pen = beige / n
    br, wr, lr = (black / n, white / n, light / n)
    blobs = _count_dark_blobs(px)
    if item_key in ('raincoat', 'pants', 'boots'):
        if br < 0.18:
            pen += (0.18 - br) * 10.0
        if wr > 0.25:
            pen += (wr - 0.25) * 8.0
        if navy / n > 0.12:
            pen += navy / n * 6.0
        center = px[20 * 64 + 32]
        if center[0] < 80 and wr > 0.35:
            pen += 1.5
    if item_key == 'pants':
        if blobs >= 4:
            pen += 6.0 + (blobs - 4) * 2.0
        elif blobs == 3:
            pen += 2.5
        rows_dark = [sum((1 for x in range(64) if px[y * 64 + x][0] < 70)) for y in range(64)]
        active = [y for y, c in enumerate(rows_dark) if c > 6]
        if active:
            span = (active[-1] - active[0] + 1) / 64.0
            if span < 0.55:
                pen += (0.55 - span) * 8.0
    elif item_key == 'boots':
        if blobs >= 4:
            pen += 7.0 + (blobs - 4) * 2.5
        elif blobs == 3:
            pen += 3.0
        if br > 0.42:
            pen += (br - 0.42) * 12.0
        top_dark = sum((1 for x in range(64) for y in range(0, 10) if px[y * 64 + x][0] < 70))
        if top_dark > 10 * 40:
            pen += 3.0
    elif item_key == 'umbrella':
        if br > 0.45:
            pen += (br - 0.45) * 8.0
        if wr + lr < 0.25:
            pen += 2.0
    elif item_key == 'bag':
        if lr < 0.35:
            pen += (0.35 - lr) * 6.0
        if blue / n > 0.12:
            pen += blue / n * 8.0
        if br > 0.25:
            pen += br * 4.0
    if item_key in ('beizi', 'jiaoling', 'ruqun', 'sash', 'hairpin', 'fan'):
        skin = sum((1 for r, g, b in px if r > 90 and g > 60 and (b > 45) and (r > g + 8) and (r > b + 12) and (abs(g - b) < 40)))
        if skin / n > 0.06:
            pen += 8.0 + skin / n * 20.0
        if item_key in ('beizi', 'jiaoling', 'ruqun') and br < 0.08 and (skin / n > 0.03):
            pen += 4.0
    return pen

class CharacterSheetError(Exception):
    """设定卡业务错误;route 层映射 HTTP status。

    失败时尽量挂上 rejected_bytes/rejected_panel，供 Job 结果回传拒图预览（用户感知）。
    """

    def __init__(self, message: str, *, status_code: int=500):
        super().__init__(message)
        self.status_code = status_code
        self.rejected_bytes: bytes | None = None
        self.rejected_panel: str | None = None
        ctx = _SHEET_REJECT_CTX.get()
        if ctx and isinstance(ctx, dict):
            dump_dir = ctx.get('dir')
            seed = ctx.get('seed')
            panels = ctx.get('panels') or {}
            panel = ctx.get('current_key') or 'unknown'
            data = panels.get(panel) if isinstance(panels, dict) else None
            if data is None and isinstance(panels, dict) and panels:
                panel, data = list(panels.items())[-1]
            if isinstance(data, (bytes, bytearray)) and data:
                self.rejected_bytes = bytes(data)
                self.rejected_panel = str(panel)
            try:
                dump_rejected_panel(data if isinstance(data, (bytes, bytearray)) else None, seed=seed if isinstance(seed, int) or seed is None else None, panel=str(panel), gate='CharacterSheetError', detail=str(message), dump_dir=dump_dir)
                if isinstance(panels, dict):
                    for k, v in panels.items():
                        if isinstance(v, (bytes, bytearray)) and k != panel:
                            dump_rejected_panel(v, seed=seed if isinstance(seed, int) or seed is None else None, panel=f'all_{k}', gate='snapshot', detail=str(message), dump_dir=dump_dir)
            except Exception:
                pass

@dataclass
class SheetMeta:
    name: str
    style: str
    height_cm: int = 168
    role: str = ''
    personality: str = ''
    design_notes: str = ''
    colors: list[str] = field(default_factory=list)
    visual_prompt: str = ''
    description: str = ''
    template: str = ''

def resolve_cjk_font(size: int=28) -> ImageFont.FreeTypeFont:
    """解析可用中文字体;全部缺失则抛 CharacterSheetError(503)。禁止默认拉丁糊字。"""
    import sys
    _pkg = sys.modules.get(__package__)
    _cands = getattr(_pkg, "_CJK_FONT_CANDIDATES", None) if _pkg is not None else None
    for path in (_cands if _cands is not None else _CJK_FONT_CANDIDATES):
        p = Path(path)
        if not p.is_file():
            continue
        for face_idx in (0, 1, 2, 3, 4):
            try:
                font = ImageFont.truetype(str(p), size=size, index=face_idx)
            except OSError:
                if face_idx == 0:
                    break
                continue
            except Exception:
                continue
            try:
                bbox = font.getbbox('角色威严冷酷')
            except Exception:
                continue
            if bbox and bbox[2] - bbox[0] > 24:
                return font
    raise CharacterSheetError('中文字体缺失(需 PingFang/思源/STHeiti/Noto Sans CJK 等)', status_code=503)

def is_sheet_url(url: str) -> bool:
    return _CHAR_SHEET_MARK in (url or '')

def is_panel_url(url: str) -> bool:
    return _CHAR_PANEL_MARK in (url or '')

def panel_style_from_url(url: str) -> str | None:
    """从 char_panel_{cid8}_{style}_{key}_*.png 解析 style;非 panel 返回 None。"""
    if not is_panel_url(url):
        return None
    name = Path(urlsplit(url).path).name
    if not name.startswith(_CHAR_PANEL_MARK):
        return None
    rest = name[len(_CHAR_PANEL_MARK):]
    parts = rest.split('_')
    if len(parts) < 3:
        return None
    if len(parts) >= 3 and parts[1] == 'ancient' and (parts[2] == 'realistic'):
        return 'ancient_realistic'
    if parts[1] in SHEET_STYLES:
        return parts[1]
    return None

class ReferenceImagesStyleError(CharacterSheetError):
    """reference_images 写入设定卡格图时缺显式风格匹配。"""

def assert_reference_images_panel_style(refs: list[str], *, allowed_styles: set[str] | frozenset[str] | None) -> None:
    """写入守卫:reference_images 含 char_panel_* 时必须显式风格匹配,否则拒绝。

    父代理 12:01:设定卡格图不得静默写入雨夜写实角色 reference_images。
    allowed_styles 为 None/空 → 一律拒绝任何 char_panel_*。
    """
    allowed = {s for s in allowed_styles or set() if s in SHEET_STYLES}
    bad: list[str] = []
    for u in refs or []:
        if not isinstance(u, str) or not is_panel_url(u):
            continue
        st = panel_style_from_url(u)
        if st is None or st not in allowed:
            bad.append(u)
    if bad:
        allow_txt = ','.join(sorted(allowed)) if allowed else '(无)'
        raise ReferenceImagesStyleError(f'reference_images 含设定卡格图但未显式匹配风格(allowed={allow_txt}): ' + '; '.join(bad[:3]), status_code=422)

def merge_video_refs(existing: list[str], *, panel_urls: dict[str, str], sheet_url: str | None=None) -> list[str]:
    """过检前 Ref2VA:仅主立绘+三视图置前;整卡/表情/服饰不进视频参考链。

    sheet_url 参数保留供调用方存响应字段,故意不写入返回列表。
    """
    del sheet_url
    ordered: list[str] = []
    for key in ('portrait', 'front', 'side', 'back'):
        u = (panel_urls or {}).get(key) or ''
        if isinstance(u, str) and u.strip() and (u not in ordered):
            ordered.append(u.strip())
    rest: list[str] = []
    for u in existing or []:
        if not isinstance(u, str) or not u.strip():
            continue
        if is_sheet_url(u) or is_panel_url(u):
            continue
        if u in ordered:
            continue
        rest.append(u.strip())
    return (ordered + rest)[:_MAX_REFS]

def merge_sheet_into_refs(existing: list[str], sheet_url: str, panel_urls: dict[str, str] | None=None) -> list[str]:
    """兼容旧名(Batch7 v2):整卡不再置前;有 panel_urls 时写立绘+三视图。"""
    if panel_urls:
        return merge_video_refs(existing, panel_urls=panel_urls, sheet_url=sheet_url)
    rest = [u for u in existing if isinstance(u, str) and u.strip() and (not is_sheet_url(u))]
    return rest[:_MAX_REFS]

def parse_refs_by_style(raw) -> dict[str, list[str]]:
    """解析 reference_images_by_style JSON → {style: [url,...]}。"""
    if isinstance(raw, dict):
        data = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    else:
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, list[str]] = {}
    for k, v in data.items():
        st = str(k or '').strip()
        if st not in SHEET_STYLES:
            continue
        if not isinstance(v, list):
            continue
        urls = [u.strip() for u in v if isinstance(u, str) and u.strip()]
        if urls:
            out[st] = urls[:_MAX_REFS]
    return out

def merge_video_refs_by_style(existing_by_style: dict[str, list[str]] | None, *, style: str, panel_urls: dict[str, str], sheet_url: str | None=None) -> dict[str, list[str]]:
    """按风格分桶写入立绘+三视图;不覆盖其他风格分组。"""
    if style not in SHEET_STYLES:
        raise CharacterSheetError(f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422)
    by_style = {st: list(urls) for st, urls in (existing_by_style or {}).items() if st in SHEET_STYLES and isinstance(urls, list)}
    prev = [u for u in by_style.get(style, []) if isinstance(u, str)]
    by_style[style] = merge_video_refs(prev, panel_urls=panel_urls, sheet_url=sheet_url)
    assert_reference_images_panel_style(by_style[style], allowed_styles={style})
    return by_style

def samples_from_refs(refs: list[str] | None) -> list[str]:
    """扁平 reference_images 里非设定卡 URL(含 sample_*)。"""
    out: list[str] = []
    for u in refs or []:
        if not isinstance(u, str) or not u.strip():
            continue
        if is_sheet_url(u) or is_panel_url(u):
            continue
        if u.strip() not in out:
            out.append(u.strip())
    return out

def flatten_refs_for_style(by_style: dict[str, list[str]] | None, *, style: str | None, samples: list[str] | None=None) -> list[str]:
    """供视频链选用:指定风格分桶 + sample 等非 panel 参考。"""
    ordered: list[str] = []
    if style and style in SHEET_STYLES:
        for u in (by_style or {}).get(style, []) or []:
            if isinstance(u, str) and u.strip() and (u not in ordered):
                ordered.append(u.strip())
    for u in samples or []:
        if isinstance(u, str) and u.strip() and (u not in ordered):
            ordered.append(u.strip())
    return ordered[:_MAX_REFS]

def _ancient_spec_text(meta: SheetMeta) -> str:
    """古风 spec 原文(不含自动设计说明,避免「深底金字」等卡面文案被当成服装色)。"""
    return ' '.join((s for s in (meta.visual_prompt or '', meta.description or '', meta.role or '') if s))

def extract_ancient_costume_spec(meta: SheetMeta) -> dict[str, Any]:
    """确定性抽取古风 spec:衣服颜色/服装名词/饰品/发型/身份 → 英文 tag。"""
    text = _ancient_spec_text(meta)
    garment_re = f'[{_ANCIENT_GARMENT_NOUNS}]'
    colors: list[dict[str, str]] = []
    taken: list[tuple[int, int]] = []
    for zh, en, py, alt, hx in _ANCIENT_COLOR_MAP:
        for m in re.finditer(re.escape(zh) + '色?[^\\s,，。;；、]{0,3}?' + garment_re, text):
            if any((a <= m.start() < b for a, b in taken)):
                continue
            taken.append((m.start(), m.start() + len(zh)))
            if all((c['zh'] != zh for c in colors)):
                colors.append({'zh': zh, 'en': en, 'pinyin': py, 'alt': alt, 'hex': hx})
    garment_zh, garment_en = ('', 'hanfu dress')
    for zh, en in _ANCIENT_GARMENT_EN:
        if zh in text:
            garment_zh, garment_en = (zh, en)
            break
    acc_tags: list[str] = []
    hair_acc: list[str] = []
    acc_zh: list[str] = []
    rest = text
    for zh, tag, is_hair in _ANCIENT_ACCESSORY_MAP:
        if zh in rest:
            rest = rest.replace(zh, ' ')
            acc_zh.append(zh)
            acc_tags.append(tag)
            if is_hair:
                hair_acc.append(tag)
    hair = ''
    for zh, en in _ANCIENT_HAIR_MAP:
        if zh in text:
            hair = en
            break
    if not hair and hair_acc:
        hair = 'simple low hair bun'
    roles = [en for zh, en in _ANCIENT_ROLE_MAP if zh in text]
    age = ''
    m_age = re.search('(?:约|~|～)?\\s*(\\d{2})\\s*(?:岁|years)', text) or re.search('[~～约](\\d{2})\\b', text)
    if m_age:
        age = f'{m_age.group(1)} years old young woman'
    black_gold = any((c['en'] in ('black', 'gold') for c in colors)) or any(('金' in z or '玄' in z for z in acc_zh))
    tags: list[str] = []
    if colors:
        c0 = colors[0]
        tags.append(f"({c0['en']} {c0['pinyin']} {garment_en}:1.3)")
        tags.append(f"({c0['alt']} colored hanfu:1.2)")
        for c in colors[1:3]:
            tags.append(f"({c['en']} accents:1.1)")
    tags.extend(acc_tags)
    if hair:
        tags.append(hair)
    tags.extend(roles)
    if age:
        tags.append(age)
    return {'colors': colors, 'garment_zh': garment_zh, 'garment_en': garment_en, 'accessories_zh': acc_zh, 'accessory_tags': acc_tags, 'hair_accessory_tags': hair_acc, 'hair': hair, 'tags': tags, 'has_any': bool(tags), 'black_gold': black_gold}

def ancient_spec_negative(meta: SheetMeta) -> str:
    """spec 有衣服颜色且非黑/金 → 负向压黑袍金边金发饰;否则空。"""
    if meta.style != 'ancient_realistic':
        return ''
    spec = extract_ancient_costume_spec(meta)
    acc_neg = ancient_accessory_prompt_fix(meta)['neg']
    if not spec['colors'] or spec['black_gold']:
        return acc_neg
    return f'{_ANCIENT_BLACK_GOLD_NEGATIVE}, {acc_neg}' if acc_neg else _ANCIENT_BLACK_GOLD_NEGATIVE

def ancient_spec_target_hex(meta: SheetMeta) -> str | None:
    """古风色门禁目标色;spec 无衣服颜色 → None(不门禁)。"""
    if meta.style != 'ancient_realistic':
        return None
    spec = extract_ancient_costume_spec(meta)
    return spec['colors'][0]['hex'] if spec['colors'] else None

def _with_ancient_spec_negative(neg: str, style: str) -> str:
    extra = _ANCIENT_SPEC_NEG_CTX.get() if style == 'ancient_realistic' else ''
    return f'{neg}, {extra}' if extra and extra not in neg else neg

def ancient_costume_force(meta: SheetMeta) -> str:
    """古风服饰格总述(替代现代雨夜 _COSTUME_FORCE)。"""
    spec = extract_ancient_costume_spec(meta)
    c0 = spec['colors'][0] if spec['colors'] else None
    col = f"{c0['en']} " if c0 else ''
    parts = [f"ONE {col}{spec['garment_en']}", f'ONE {col}silk waist sash']
    parts.append('ONE ' + (spec['hair_accessory_tags'][0].strip('()').split(':')[0] if spec['hair_accessory_tags'] else 'simple hairpin'))
    if any(('umbrella' in t for t in spec['accessory_tags'])):
        parts.append('ONE chinese oil-paper umbrella')
    else:
        parts.append('ONE round silk hand fan')
    neg = '' if spec['black_gold'] or not c0 else ', no black robe, no gold trim, no gold ornament'
    return 'overhead flat lay product photography, traditional Chinese costume pieces laid flat, ONLY these items: ' + ', '.join(parts) + ', no person, no face, no mannequin, no raincoat, no modern clothing' + neg

def ancient_spec_palette(meta: SheetMeta, colors: list[str]) -> list[str]:
    """古风色板:肤色 + spec 衣色在前;spec 非黑金时剔除近金色。无 spec 色原样返回。"""
    sp = extract_ancient_costume_spec(meta)
    if not sp['colors']:
        return list(colors)
    spec_hex = [c['hex'] for c in sp['colors']]
    rest = [c for c in colors if c not in spec_hex and c != '#E8C4A8' and (sp['black_gold'] or _hex_dist(c, '#D4AF37') >= 90)]
    return ['#E8C4A8'] + spec_hex + rest

ANCIENT_SKIN_HEX = '#E8C4A8'

ANCIENT_HAIR_HEX = '#3B2F2A'

def ancient_palette_from_spec(meta: SheetMeta) -> list[str]:
    """按 spec 衣色/饰品生成古风色板:肤色 + 衣色(主/浅/深) + 饰品色 + 发色;≤6。spec 无衣色 → []。"""
    sp = extract_ancient_costume_spec(meta)
    if not sp['colors']:
        return []
    out: list[str] = [ANCIENT_SKIN_HEX]
    main = sp['colors'][0]['hex']
    out.append(main)
    h, s, v = _hex_hsv(main)
    if s >= 0.15:
        out.append(_hsv_hex(h, s * 0.55, min(1.0, v + 0.25)))
    for c in sp['colors'][1:3]:
        if c['hex'] not in out:
            out.append(c['hex'])
    text = _ancient_spec_text(meta)
    rest = text
    for zh, hx in _ANCIENT_ACCESSORY_HEX:
        if zh in rest:
            rest = rest.replace(zh, ' ')
            if hx not in out and (sp['black_gold'] or not _is_near_gold_hex(hx)):
                out.append(hx)
    if ANCIENT_HAIR_HEX not in out:
        out.append(ANCIENT_HAIR_HEX)
    return out[:6]

def ancient_palette_conflict_reasons(meta: SheetMeta, colors: list[str]) -> list[str]:
    """存量色板与 spec 明确衣色冲突的原因;无冲突/无 spec 衣色/spec 本身黑金 → []。"""
    if meta.style != 'ancient_realistic':
        return []
    sp = extract_ancient_costume_spec(meta)
    if not sp['colors'] or sp['black_gold']:
        return []
    cols = [c for c in (_normalize_hex(x) for x in colors or []) if c]
    if not cols:
        return []
    target = sp['colors'][0]['hex']
    reasons: list[str] = []
    blacks = [c for c in cols if _is_near_black_hex(c)]
    golds = [c for c in cols if _is_near_gold_hex(c)]
    if blacks:
        reasons.append(f'near_black={blacks}')
    if golds:
        reasons.append(f'near_gold={golds}')
    if _hex_hsv(target)[1] >= 0.2 and (not any((_near_spec_hue(c, target) for c in cols))):
        reasons.append(f'no_color_near_spec={target}')
    return reasons

def resolve_ancient_palette(meta: SheetMeta, colors: list[str], *, source: str='sheet') -> list[str]:
    """古风色板裁决:存量色板与 spec 衣色冲突 → spec 胜出,按 spec 重生成并 WARNING;否则沿用 ancient_spec_palette。"""
    if meta.style != 'ancient_realistic':
        return list(colors)
    reasons = ancient_palette_conflict_reasons(meta, colors)
    if reasons:
        regen = ancient_palette_from_spec(meta)
        if regen:
            logger.warning('ancient palette conflict source=%s name=%s stored=%s spec=%s reasons=%s → regenerated from spec %s', source, meta.name, list(colors)[:6], [c['zh'] for c in extract_ancient_costume_spec(meta)['colors']], '; '.join(reasons), regen)
            return regen
    return ancient_spec_palette(meta, list(colors))

_ANCIENT_WOOD_HAIRPIN_POS = '(plain brown wooden hair stick, matte wood grain hairpin:1.2)'

_ANCIENT_WOOD_HAIRPIN_NEG = 'gold hairpin, golden hair ornament, metal hairpin, brass hair ring, bronze hair crown, gold headdress, jeweled hairpin'

def ancient_accessory_prompt_fix(meta: SheetMeta) -> dict[str, Any]:
    """spec 含 木簪/油纸伞 → 加正向(木质/握在手中)与负向(金属发饰/漂浮伞);仅 ancient_realistic。"""
    out: dict[str, Any] = {'pos': '', 'neg': '', 'wooden_hairpin': False, 'umbrella_in_hand': False}
    if meta.style != 'ancient_realistic':
        return out
    sp = extract_ancient_costume_spec(meta)
    pos: list[str] = []
    neg: list[str] = []
    if '(wooden hairpin:1.2)' in sp['hair_accessory_tags']:
        out['wooden_hairpin'] = True
        pos.append(_ANCIENT_WOOD_HAIRPIN_POS)
        neg.append(_ANCIENT_WOOD_HAIRPIN_NEG)
    if any(('umbrella' in t for t in sp['accessory_tags'])):
        out['umbrella_in_hand'] = True
        pos.append(_ANCIENT_UMBRELLA_HELD_POS)
        neg.append(_ANCIENT_UMBRELLA_HELD_NEG)
    out['pos'] = ', '.join(pos)
    out['neg'] = ', '.join(neg)
    return out

def build_ancient_accessory_qa_prompt(meta: SheetMeta) -> str | None:
    """按 spec 生成两问 prompt;spec 无木簪且无伞 → None。不适用的一问注明恒答 true。"""
    fix = ancient_accessory_prompt_fix(meta)
    if not (fix['wooden_hairpin'] or fix['umbrella_in_hand']):
        return None
    if fix['wooden_hairpin']:
        q1 = 'q1: Look at the hair ornament / hairpin in her hair bun. Is it a plain brown WOODEN hair stick (木簪) and NOT gold, brass, bronze, silver, metal or jeweled? true if wooden or if no metal/gold ornament is visible in the hair; false if any gold, brass, metal ring, crown or jeweled ornament is in the hair.'
    else:
        q1 = 'q1: Always answer true.'
    if fix['umbrella_in_hand']:
        q2 = 'q2: Is the umbrella either held in her hand by its handle, or not present at all? true if the umbrella is gripped in a hand or absent; false if an umbrella / parasol appears behind or above her head without being held by a hand (floating, like a halo or backdrop).'
    else:
        q2 = 'q2: Always answer true.'
    return 'You are inspecting a full-body portrait of a historical Chinese woman. Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: {"q1":true,"q2":true}. ' + q1 + ' ' + q2 + ' Judge only from what is visible.'

def ancient_accessory_qa_verdict(parsed: dict, meta: SheetMeta) -> list[str]:
    """VLM 两问结果 → 失败原因列表(空=通过)。"""
    fix = ancient_accessory_prompt_fix(meta)
    reasons: list[str] = []
    if fix['wooden_hairpin'] and parsed.get('q1') is False:
        reasons.append('hairpin_not_wooden(木簪非木质/金属金饰)')
    if fix['umbrella_in_hand'] and parsed.get('q2') is False:
        reasons.append('umbrella_not_held(伞漂浮头后/未握在手)')
    return reasons

def _strip_cjk_for_sd(text: str) -> str:
    out = _CJK_RUN_RE.sub(', ', text or '')
    frags = [f.strip() for f in out.split(',')]
    frags = [f for f in frags if f and (not re.fullmatch('[\\d\\s~～.\\-+]+', f))]
    return ', '.join(frags)

def ancient_costume_items(meta: SheetMeta) -> tuple[tuple[str, str], ...]:
    """古风服饰单品:spec 有颜色/饰品时按 spec 改写(键名不变,沿用单品惩罚/ckpt 路由)。"""
    spec = extract_ancient_costume_spec(meta)
    if not spec['colors'] and (not spec['accessory_tags']):
        return _COSTUME_ITEMS_ANCIENT
    bg = 'solid seamless medium light gray background (#C8C8CE), studio lighting'
    no_p = 'no person, no face, no hands, no mannequin, no model wearing clothes, no text'
    c0 = spec['colors'][0] if spec['colors'] else None
    col = f"{c0['en']} {c0['alt']}" if c0 else 'soft muted'
    neg_bg = '' if spec['black_gold'] or not c0 else ', no black fabric, no gold trim, no gold embroidery'
    items: dict[str, str] = dict(_COSTUME_ITEMS_ANCIENT)
    if c0:
        items['beizi'] = f"e-commerce flat lay product photo, garment only, ONE traditional Chinese {spec['garment_en']} laid flat open on table, {col} silk, entire garment {c0['en']} colorway, long wide sleeves spread left and right, no body inside, empty garment shape, fills most of frame, {bg}, {no_p}, no raincoat, no modern jacket{neg_bg}"
        items['jiaoling'] = f'e-commerce flat lay product photo, garment only, ONE traditional Chinese cross-collar jiaoling top laid flat open like clothing catalog, {col} silk, wide sleeves, no body inside, empty garment, fills most of frame, {bg}, {no_p}, no hoodie, no zipper{neg_bg}'
        items['sash'] = f'product still life flat lay, accessory only, ONE silk waist sash belt for hanfu, {col} ribbon coiled neatly on table, no person wearing it, {bg}, no person, no waist, no text{neg_bg}'
    hair_tag = next((t for t in spec['hair_accessory_tags']), '')
    if hair_tag:
        items['hairpin'] = f"product still life, accessory only, ONE {hair_tag.strip('()').split(':')[0]} isolated on table, catalog photo, {bg}, no person, no hair, no head, no face, no text" + ('' if 'gold' in hair_tag else ', no gold ornament')
    if any(('umbrella' in t for t in spec['accessory_tags'])):
        items['fan'] = f'product still life, accessory only, ONE open chinese oil-paper umbrella, bamboo ribs and wooden handle, painted paper canopy, isolated object, {bg}, no person, no hand holding, no plastic, no transparent vinyl, no text'
    return tuple(((k, items[k]) for k, _ in _COSTUME_ITEMS_ANCIENT))

def build_design_notes(meta: SheetMeta) -> str:
    """生成 3–5 行中文设计说明;已有足够行数则沿用。"""
    raw = (meta.design_notes or '').strip()
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if len(lines) >= 3:
        cleaned = strip_internal_design_jargon('\n'.join(lines[:5]))
        if count_design_note_lines(cleaned) >= 3:
            return cleaned
    name = (meta.name or '角色').strip()
    role = (meta.role or _guess_field(meta.description, '身份') or '便利店员').strip()
    personality = (meta.personality or _guess_field(meta.description, '性格') or '温柔果断').strip()
    desc = (meta.description or '').strip()
    style_zh = '古风写实' if meta.style == 'ancient_realistic' else '二次元'
    if meta.style == 'ancient_realistic':
        if not (meta.role or _guess_field(meta.description, '身份')):
            _txt = _ancient_spec_text(meta)
            role = next((z for z in ('医女', '大夫') if z in _txt), '古风角色')
        _sp = extract_ancient_costume_spec(meta)
        if _sp['colors'] or _sp['accessories_zh']:
            _col = '/'.join((c['zh'] for c in _sp['colors'])) or '主立绘同色'
            _acc = '、'.join(_sp['accessories_zh'])
            _axis = f"视觉主轴为{_col}色{_sp['garment_zh'] or '古装'}" + (f'，配{_acc}' if _acc else '') + '，黑发；服装配色以角色设定为准。'
        else:
            _axis = '视觉主轴为交领汉服/齐胸襦裙或水墨写实古装，黑发；服装配色以主立绘为准。'
        auto = [f'{name}：同一人古风写实变体，身份为{role}，性格{personality}。', _axis, '三视图与表情均以主立绘为同一人参考，统一古装与纯色深底，保证跨镜一致。', f'本卡风格滤镜为{style_zh}；服饰拆解为古风单品，禁止雨衣/卫衣/便利店等现代装。']
    else:
        auto = [f'{name}：雨夜便利店相遇的核心角色，身份为{role}，性格{personality}。', '视觉主轴为板岩灰(#5A6A7A)长款过膝连帽雨衣（长袖）、黑色裤袜与黑色短靴、胸前素面无标，湿发贴额与冷白灯光，辅以白色塑料袋道具。', '三视图与表情均以主立绘为同一人参考，主立绘/三视图/服饰统一板岩灰素面，保证跨镜一致。', f'本卡风格滤镜为{style_zh}；服饰拆解对齐现代雨夜设定，禁止汉服、纯黑雨衣与胸口贴标。']
    if desc and desc not in auto[0]:
        auto.insert(1, desc[:80])
    if lines:
        merged = lines + [a for a in auto if a not in lines]
        out = '\n'.join(merged[:5])
    else:
        out = '\n'.join(auto[:5])
    return strip_internal_design_jargon(out)

def _character_base(meta: SheetMeta) -> str:
    base = (meta.visual_prompt or meta.description or meta.name).strip()
    if not base:
        raise CharacterSheetError('角色缺少视觉描述', status_code=422)
    import re as _re
    low = base.lower()
    for bad in ('silver hair', 'white hair', 'grey hair', 'gray hair', 'blue hair', 'blonde'):
        if bad in low:
            base = _re.sub(bad, 'black hair', base, flags=_re.I)
            low = base.lower()
    if 'black hair' not in low and '黑发' not in base:
        base = f'{base}, jet black hair, black hair'
        low = base.lower()
    if meta.style == 'ancient_realistic':
        for bad in ('raincoat', 'windbreaker', 'hoodie', 'convenience store', 'plastic umbrella', 'rain boots', 'shopping bag', 'neon', 'zippered', 'streetwear'):
            if bad in low:
                base = _re.sub(_re.escape(bad), '', base, flags=_re.I)
                low = base.lower()
        base = _re.sub(',\\s*,', ', ', base).strip(' ,')
        low = base.lower()
        _spec = extract_ancient_costume_spec(meta)
        if _spec['has_any']:
            _en = _strip_cjk_for_sd(base) or 'young East Asian woman'
            return f"{', '.join(_spec['tags'])}, {_en}, traditional Chinese hanfu, silk wide sleeves, no raincoat, no modern clothing"
        if 'hanfu' not in low and '古装' not in base and ('襦裙' not in base):
            base = f'{base}, traditional Chinese hanfu, cross-collar jiaoling robe, qi-xiong ruqun or ink-wash ancient costume, silk wide sleeves, no raincoat, no modern clothing'
        else:
            base = f'{base}, jet black hair, black hair, traditional Chinese clothing'
        return base
    extra = 'jet black hair, black hair, slate gray #5A6A7A long knee-length hooded raincoat with long sleeves, black pantyhose, black ankle boots, plain unbranded no logo no chest emblem, mid-tone slate gray fabric not jet black not near-white, wet black hair on forehead, young East Asian woman, convenience store clerk vibe'
    if 'raincoat' not in low and '雨衣' not in base and ('windbreaker' not in low):
        base = f'{base}, {extra}'
    else:
        base = f'{base}, jet black hair, black hair'
    return base

def _side_view_prompt(meta: SheetMeta, *, solo: str, base: str, name: str, outfit: str, head_bit: str, solid: str, suf: str) -> str:
    """侧视图提示:经典=左侧;toonflow_board=严格右侧90°(四视图参考板规范)。"""
    if meta.template == 'toonflow_board':
        return f"{solo}, {base}, ONE figure only, STRICT right-side profile full body turnaround of {name}, body and face turned exactly 90 degrees to the viewer's RIGHT, facing viewer's right, right 90 degree side view, only one eye visible, nose bridge silhouette pointing right, adult woman 165cm proportions, {head_bit}, jet black hair, orthographic, {outfit}, standing straight, feet on ground, figure fills frame height, single person only, NOT front view, NOT back view, NOT left side view, empty background, {solid}, {suf}"
    return f'{solo}, {base}, ONE figure only, STRICT side profile full body turnaround of {name}, looking left, 90 degree side view, adult woman 165cm proportions, {head_bit}, jet black hair, orthographic, {outfit}, standing straight, feet on ground, figure fills frame height, single person only, NOT front view, NOT back view, empty background, {solid}, {suf}'

def build_panel_prompts(meta: SheetMeta) -> dict[str, str]:
    """各分区英文出图提示(风格后缀统一追加)。含 6 格独立表情键。"""
    style = meta.style if meta.style in SHEET_STYLES else 'anime'
    base = _character_base(meta)
    suf = _STYLE_SUFFIX[style]
    name = meta.name
    solid = 'solid seamless dark gray background' if style == 'ancient_realistic' else 'solid seamless light gray background'
    solo = '1girl, solo, single female only, alone, no other people, no male'
    if style == 'ancient_realistic':
        _spec = extract_ancient_costume_spec(meta)
        if _spec['colors']:
            _c0 = _spec['colors'][0]
            outfit = f"same ({_c0['en']} {_c0['pinyin']} {_spec['garment_en']}:1.3), {_c0['alt']} traditional Chinese hanfu, silk wide sleeves, no raincoat, no modern jacket"
            same_outfit = f"identical {_c0['en']} {_spec['garment_en']} style and color as main portrait"
        else:
            outfit = 'same traditional Chinese hanfu, cross-collar robe, qi-xiong ruqun, silk wide sleeves, no raincoat, no modern jacket'
            same_outfit = 'identical hanfu outfit style and color as main portrait'
        if _spec['hair'] or _spec['hair_accessory_tags']:
            head_bit = ', '.join([t for t in [_spec['hair'], *_spec['hair_accessory_tags']] if t] + ['no other hair ornaments', 'face fully visible'])
        else:
            head_bit = 'simple black hair bun, minimal plain hair accessories, face fully visible'
        back_head = 'ONLY back of head and hair bun, NO face NO eyes'
        _acc = ancient_accessory_prompt_fix(meta)
        if _acc['pos']:
            head_bit = f"{head_bit}, {_acc['pos']}"
            outfit = f"{outfit}, {_acc['pos']}"
    else:
        outfit = 'same character same slate-gray #5A6A7A long knee-length hooded raincoat with long sleeves and hood, black pantyhose, black ankle boots, fully clothed legs and feet, plain flat chest unbranded, no logo no emblem no badge no chest patch, no circular pattern no spiral design on chest, not jet black, not near-white light gray, NOT short skirt, NOT bare legs, NOT short sleeves, NOT barefoot'
        head_bit = 'hood DOWN face fully visible'
        back_head = 'ONLY back of head and hood, NO face NO eyes'
        same_outfit = 'identical hooded raincoat style and color as main portrait'
    prompts: dict[str, str] = {'portrait': f'{solo}, {base}, full body standing portrait of {name}, facing camera, jet black hair, black hair, {outfit}, plain chest no badge no emblem no pattern, no silver hair, {solid}, character design, {suf}', 'front': f'{solo}, {base}, ONE figure only, front view full body turnaround of {name}, orthographic, adult woman 165cm proportions, long legs, {head_bit}, jet black hair, {outfit}, standing straight, {same_outfit}, plain chest no badge no spiral, feet on ground line, figure fills frame height, single person only, empty background, {solid}, {suf}', 'side': _side_view_prompt(meta, solo=solo, base=base, name=name, outfit=outfit, head_bit=head_bit, solid=solid, suf=suf), 'back': f'{solo}, {base}, ONE figure only, STRICT rear view full body turnaround of {name}, facing completely away from camera, back of head only, {back_head}, hair bun / hood from behind, spine and shoulder blades visible, NO face, NO eyes, NO nose, NO mouth, NO looking back over shoulder, adult woman 165cm proportions, jet black hair, orthographic, single person only, {outfit}, feet on ground, figure fills frame height, NOT front view, NOT three-quarter, NOT face, NOT side view, empty background, {solid}, {suf}', 'faces': f'{solo}, {base}, three head closeups of {name} only, front and three-quarter and side profile faces in a row, EXTREME face closeups head and shoulders, NO full body, {solid}, {suf}', 'face_front': f'{solo}, {base}, FRONT facing head and shoulders closeup of {name}, looking straight at camera, both eyes equal size, symmetrical face, both ears faintly visible, hood DOWN completely off head, bare head, no hood, no cloak covering hair, face fills frame, jet black hair, eyes nose mouth clear, sharp focus, NO full body, NO waist, NOT side profile, NOT three-quarter turn, {solid}, {suf}', 'face_three_quarter': f'{solo}, {base}, looking away, head tilt, THREE-QUARTER VIEW, from side, head and shoulders closeup of {name}, head yaw turned about 45 degrees to the LEFT, nose tip clearly left of face center, viewer sees left cheek more, near eye larger than far eye, far eye partially visible, one ear clearly visible on near side, hood DOWN bare head no hood, face fills frame, jet black hair, sharp focus, NOT front facing, NOT looking into camera, NOT symmetrical frontal face, NOT 90 degree full profile, NO full body, NO waist, {solid}, {suf}', 'face_side': f'{solo}, {base}, profile, from side, side view, looking away, STRICT SIDE PROFILE head and shoulders closeup of {name}, exact 90 degree profile facing LEFT, ONLY one eye visible, clear nose bridge silhouette, lips chin jawline ear outline, other eye completely hidden behind head, face not toward camera, hood DOWN bare head, no hood over head, jet black hair, MUST show {outfit} collar/neckline on shoulders, clothed bust, same art style as reference, cel-shaded consistent lineart, NO floating disembodied head, NO white outline halo, NO photoreal skin, sharp focus, face and shoulders fill frame, NOT front face, NOT three-quarter, NOT both eyes, NOT logo, NOT emblem, NOT abstract mark, NOT circle face on hood, NO full body, {solid}, {suf}', 'costume': f'{_COSTUME_FORCE}, {suf}'}
    if style == 'ancient_realistic':
        prompts['costume'] = f'{ancient_costume_force(meta)}, {suf}'
    for i, expr in enumerate(_EXPR_PROMPTS):
        hair_bit = 'chin-length short jet black hair, hair tips end at chin line, NOT past chin, NOT past shoulders, no long hair, no shoulder-length hair, no hair lengthening' if i == 3 else 'short jet black hair chin-length or above, hair tips NOT past shoulders, no long hair, no hair lengthening beyond main portrait'
        prompts[f'expr_{i}'] = f'{solo}, {base}, {expr} of {name}, single face only, one person, EXTREME close-up head and shoulders portrait, face fills at least 40 percent of frame, tight headshot, hood down, face fully visible, eyes nose mouth clear, {hair_bit}, same identity as main portrait, exaggerated distinct expression, plain flat chest unbranded, NO text NO letters NO chinese NO logo NO emblem NO badge NO chest patch NO circular mark NO star on chest, bare raincoat fabric only, NO half body, NO full body, NO standing pose, NO waist, NO legs, NO hands props, NO second person, no caption, no labels, {solid}, {suf}'
    if style == 'ancient_realistic':
        for _k in [k for k in prompts if k.startswith('expr_')]:
            prompts[_k] = prompts[_k].replace('bare raincoat fabric only', 'bare garment fabric only')
    if meta.template == 'toonflow_board':
        keep = {'portrait', 'face_front', 'front', 'side', 'back'}
        for _k in [k for k in prompts if k not in keep]:
            prompts.pop(_k)
    return prompts

def _guess_field(description: str, key: str) -> str:
    if not description:
        return ''
    m = re.search(f'{key}\\s*[:：]\\s*([^\\n;；|/]+)', description)
    return (m.group(1).strip() if m else '')[:40]

def strip_internal_design_jargon(text: str) -> str:
    """卡面设计说明去掉 fix/LoRA/调试路由/版本备注等内部字样；成品卡只留角色设定。"""
    if not text:
        return text
    bad = re.compile('(fix\\d+[a-z]?|LoRA|lora|az\\s*45|az45|硬门禁|yaw\\s*门禁|CLIP\\s*门禁|final_review|deliver\\b|Qwen-Edit|batch7|openpose|IPA\\b|SetLatentNoiseMask|VAEEncode(?:ForInpaint)?|letterbox|inpaint|Ref2VA|md5|seed\\s*=?\\s*\\d+|commit\\s*[:=]?\\s*[0-9a-f]{7,}|route\\s*[:=]|\\b826[0-9]\\b|\\b819[0-9]\\b|\\d{1,2}:\\d{2}[a-z]?\\b|侧头锁定(?:不改)?|锁定不改|领口下巴到锁骨|门禁|调试|版本说明|开发备注|fallback|hist[_ ]?match|果断抿嘴\\s*/\\s*温柔微笑|温柔微笑\\s*/\\s*果断抿嘴)', re.I)
    lines = []
    for ln in text.splitlines():
        s = bad.sub('', ln)
        s = re.sub('[；;]{2,}', '；', s)
        s = re.sub('\\s{2,}', ' ', s).strip(' -|;,，、；')
        s = re.sub('[。.]{2,}', '。', s).strip()
        if not s or s in {'。', '.', '…', '·', '；', ';', '不改'}:
            continue
        if not re.search('[\\u4e00-\\u9fffA-Za-z]', s):
            continue
        if len(re.sub('\\W+', '', s)) < 4:
            continue
        lines.append(s)
    return '\n'.join(lines)

def placeholder_panel(color: tuple[int, int, int], size: tuple[int, int]=(512, 768)) -> Image.Image:
    img = Image.new('RGBA', size, (*color, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, size[0] - 20, size[1] - 20], outline=(255, 255, 255, 180), width=4)
    return img

class HeadcropSourceShort(CharacterSheetError):
    """04:30：头特写源图不够（下方/侧边），禁止灰垫；调用方换更宽源或 outpaint。"""

    def __init__(self, message: str):
        super().__init__(message, status_code=422)

def _panel_size(key: str, style: str) -> tuple[int, int]:
    """按风格与面板类型选分辨率(SDXL anime 用更高档)。"""
    sdxl = style == 'anime'
    if key.startswith('expr_'):
        return (768, 768) if sdxl else (512, 512)
    if key == 'costume':
        return (1024, 768) if sdxl else (768, 512)
    if key == 'faces':
        return (1024, 640) if sdxl else (768, 512)
    return (832, 1216) if sdxl else (768, 1024)

def count_design_note_lines(text: str) -> int:
    return len([ln.strip() for ln in (text or '').splitlines() if ln.strip()])

def assert_design_notes_ok(text: str) -> None:
    """非空设计说明必须 3–5 行（与前端 CharacterSheetEditor 一致）；空则允许后端自填。"""
    n = count_design_note_lines(text)
    if n == 0:
        return
    if n < 3 or n > 5:
        raise CharacterSheetError(f'设计说明须 3–5 行（当前 {n} 行）', status_code=422)
