"""角色设定卡:分格出图 + Pillow 固定版式拼版 + 真中文字体排版。

版式(用户 10/1 硬规格):
  左:大立绘 + 名字 + 基本资料表
  中:带身高刻度的三视图(正/侧/背)
  下:面部/发型多角度、表情排列、服饰饰品拆解、配色色板、设计说明

风格:ancient_realistic | anime
17:45 七条纠偏(Batch7 v2):
  1) 古风深底金字;二次元真 anime/cel
  2) 三视图以主立绘为参考新出正/侧/背(禁复用 sample)
  3) 6 格表情各自正方形头像
  4) 服饰拆该角色单品(林夏=黑雨衣),平铺纯色底
  5) 设计说明 3–5 行
  6) Ref2VA 只写立绘+三视图;整卡 sheet_url 不进视频参考链
  7) Read 缩略图逐区自检
"""
from __future__ import annotations

import math

import asyncio
import json
import colorsys
import logging
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

SHEET_STYLES = ("ancient_realistic", "anime")
SHEET_W, SHEET_H = 2400, 3200
_PANEL_KEYS = ("portrait", "front", "side", "back", "faces", "costume")
_EXPR_KEYS = tuple(f"expr_{i}" for i in range(6))
_EXPR_LABELS = ("威严", "冷酷", "沉思", "温柔", "惊恐", "果断")
_EXPR_PROMPTS = (
    "stern majestic expression, extreme face closeup head and shoulders",
    "cold aloof expression, icy gaze, extreme face closeup head and shoulders",
    "thoughtful contemplative expression, looking slightly down, extreme face closeup head and shoulders",
    "gentle soft smile, warm kind eyes, extreme face closeup head and shoulders",
    "terrified shocked expression, wide eyes open mouth, fear, extreme face closeup head and shoulders",
    "resolute determined expression, firm gaze, extreme face closeup head and shoulders",
)
_CHAR_SHEET_MARK = "char_sheet_"
_CHAR_PANEL_MARK = "char_panel_"
_POLL_INTERVAL = 2.0
_POLL_TIMEOUT = 420.0
_MAX_REFS = 8
_FORBIDDEN_WORKER_PORTS = {8195, 8196, 8197, 8205, 8261, 8263}
_SHEET_ALLOWED_PORTS = frozenset({8262, 8264})

# 固定几何(像素):拼版单测锁定这些矩形
LAYOUT = {
    "canvas": (SHEET_W, SHEET_H),
    "portrait": (48, 48, 720, 1180),
    "name": (48, 1240, 720, 72),
    "profile": (48, 1320, 720, 420),
    "turnaround": (800, 48, 1552, 1692),
    # 23:37：表情面板高度必须保持 520（锁定格）；只靠 faces valign=top 消上方空带
    "faces": (48, 1780, 760, 520),
    "expressions": (840, 1780, 980, 520),
    "costume": (48, 2340, 1180, 520),
    "palette": (1260, 2340, 520, 200),
    "notes": (1260, 2560, 1092, 300),
    "footer": (48, 3080, 2304, 80),
}

_STYLE_SUFFIX = {
    "ancient_realistic": (
        "cinematic photorealistic character design, detailed silk fabric texture, "
        "traditional Chinese hanfu, ink-wash soft lighting, "
        "solid seamless dark gray background, no scenery, "
        "no text, character sheet quality"
    ),
    "anime": (
        "anime, 2D illustration, cel shading, clean lineart, official character art, "
        "NOT photorealistic, NOT real photo, NOT 3D render, "
        "solid seamless light gray background, no scenery, no text"
    ),
}

_STYLE_NEGATIVE = {
    "ancient_realistic": (
        "blurry, low quality, text, watermark, deformed, extra limbs, "
        "raincoat, windbreaker, hoodie, modern jacket, plastic umbrella, "
        "convenience store, neon lights, rain boots, plastic shopping bag, "
        "contemporary clothing, streetwear, zippered coat, "
        "white hair, silver hair, grey hair, "
        "multiple people, collage, split screen, grid, two people in one frame, "
        "glitch, chromatic aberration"
    ),
    "anime": (
        "photorealistic, real photo, photograph, realistic skin pores, "
        "3d render, western cartoon, blurry, low quality, text, watermark, "
        "chinese text, chinese characters, letters, alphabet, caption, subtitle, title, "
        "deformed, extra limbs, hanfu, ancient chinese clothing, white robe, white dress, "
        "white hair, silver hair, grey hair, blue hair, blonde hair, "
        "multiple people, collage, split screen, grid, two people in one frame, "
        "1boy, 2boys, male, man, couple, duo, two girls, twins, "
        "glitch, chromatic aberration, scan lines, multiple faces, face sheet, "
        "sketch dump, concept art board, white jacket, white coat, "
        "beige cloak, brown cloak, red cloak, tan cape, khaki poncho, "
        "mannequin, human body in product shot, person wearing boots, "
        "white hoodie, white t-shirt, color-block hoodie, navy sleeves on white shirt, "
        "baseball cap, hat on stand, ceiling lamp, dome light, opaque black dome, hard hat, helmet, bowl, chest badge, chest emblem, chest logo, circular chest pattern, spiral emblem, round emblem on chest, brand patch, red badge, graphic print on torso, cloak, cape, poncho, wide sleeves, kimono sleeves"
    ),
}

_YAW_FACE_APP = None  # insightface FaceAnalysis cache

_FACE_ANGLE_NEGATIVE: dict[str, str] = {
    "face_front": (
        "side profile, strict profile, 90 degree profile, three-quarter turn, "
        "head turned away, only one eye, silhouette nose, hood up, hood covering hair"
    ),
    "face_three_quarter": (
        "front face looking at camera, symmetrical frontal face, both eyes equal, "
        "looking at viewer, facing camera, strict side profile, 90 degree profile, "
        "full profile silhouette, extreme dutch tilt, head flopped sideways, "
        "over-the-shoulder, looking back, hood up, hood covering hair, full body"
    ),
    "face_side": (
        "front face, looking at camera, both eyes visible, symmetrical face, "
        "frontal view, three-quarter view, face toward camera, two eyes, "
        "over-the-shoulder, looking back over shoulder, turned toward viewer, "
        "hood up, logo on hood, emblem, badge, abstract circle face, stylized mark, "
        "symbol instead of face, blank hood, full body, waist up standing"
    ),
}

_SHEET_CKPT = {
    "ancient_realistic": "DreamShaper_8_pruned.safetensors",
    "anime": "animagineXL40.safetensors",
}

_THEME = {
    "ancient_realistic": {
        "bg": (11, 14, 20, 255),
        "text": (212, 175, 55),
        "text_muted": (168, 140, 70),
        "text_dim": (120, 100, 55),
        "outline": (90, 75, 40),
        "name_bg": (20, 24, 32, 255),
        "title_bar": (8, 10, 14, 255),
        "title_text": (212, 175, 55),
        "scale": (180, 150, 70),
    },
    "anime": {
        "bg": (248, 248, 252, 255),
        "text": (30, 30, 36),
        "text_muted": (90, 90, 100),
        "text_dim": (120, 120, 130),
        "outline": (200, 200, 210),
        "name_bg": (40, 40, 48, 255),
        "title_bar": (40, 40, 48, 255),
        "title_text": (230, 230, 235),
        "scale": (80, 80, 90),
    },
}

_CJK_FONT_CANDIDATES = (
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    str(Path.home() / "Library/Fonts/SimSun-Regular.ttf"),
    str(Path.home() / "Library/Fonts/SourceHanSansSC-Regular.otf"),
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/source-han-sans/SourceHanSansSC-Regular.otf",
)

# 角色服装关键词(现代雨夜便利店设定):五件单品分生成再 collage,禁汉服/真人穿着
_COSTUME_ITEMS: tuple[tuple[str, str], ...] = (
    (
        "raincoat",
        "product still life, single object only, one complete matte slate-gray hooded raincoat "
        "garment laid flat open on table like e-commerce flat lay, attached hood at collar, "
        "two long sleeves spread left and right, full torso, front zipper, "
        "entire garment mid-tone slate gray nylon #5A6A7A, plain unbranded no logo no emblem no chest patch, "
        "no jet black, no pure black panels, no white panels, no navy panels, "
        "fills most of frame, solid seamless pure white background, studio lighting, "
        "no person, no face, no mannequin, no worn clothes, no white t-shirt, no hoodie, "
        "no cloak, no cape, no poncho, no beige, no brown, no tan, no khaki, no red, no text, no brand",
    ),
    (
        "pants",
        "product still life, single object only, ONE single pair of long black trousers, "
        "full length to ankles, one item only, exactly one waistband and two long pant legs, "
        "laid flat fully visible side by side, matte jet-black fabric, clothing flat lay catalog photo, "
        "fills most of frame, solid seamless pure white background, studio lighting, "
        "no person, no face, no body, no mannequin, no shorts, no short pants, no bermuda, "
        "no cropped pants, no knee-length, no skirt, no multiple pairs, no repeated pants, "
        "no row of pants, no four pants, no collage of pants, no grid of trousers, "
        "no navy, no blue, no grey, no beige, no brown, no cloak, no text",
    ),
    (
        "boots",
        "product still life, single object only, one pair (exactly two) glossy jet-black rubber rain boots "
        "standing side by side, footwear only, empty boots, pure black rubber, "
        "fills most of frame, solid seamless pure white background, studio lighting, "
        "no person, no face, no body, no mannequin, no legs, no feet inside, "
        "no many boots, no row of boots, no repeated boots, no multiple pairs, "
        "no five boots, no six boots, no line of boots, no collage of footwear, "
        "no sandals, no text, no debris",
    ),
    (
        "umbrella",
        "product still life, single object only, one open clear transparent rain umbrella with visible ribs and handle, "
        "with thin black ribs and black shaft handle, see-through vinyl canopy, "
        "solid seamless pure light gray background, studio lighting, "
        "no person, no face, no hat, no cap, no lamp, no opaque canopy, no solid black dome, "
        "no white canopy, no colored canopy, no cloak, no text",
    ),
    (
        "bag",
        "product still life, single object only, one plain opaque white plastic shopping bag "
        "with two handles, empty, slightly crinkled white polyethylene, "
        "solid seamless pure light gray background, studio lighting, "
        "no person, no face, no blue bag, no tote canvas, no logo, no text, no chinese, no cloak",
    ),
)

# 古风汉服单品(交领/襦裙/腰带/发簪/团扇);禁止沿用雨衣伞袋
_COSTUME_ITEMS_ANCIENT: tuple[tuple[str, str], ...] = (
    (
        "beizi",
        "e-commerce flat lay product photo, garment only, ONE traditional Chinese beizi outer robe "
        "laid flat open on table, jet black silk with gold trim and gold embroidery, "
        "black-and-gold colorway only, long wide sleeves spread left and right, "
        "no body inside, empty garment shape, fills most of frame, "
        "solid seamless medium light gray background (#C8C8CE), studio softbox, "
        "no person, no face, no hands, no mannequin, no model wearing clothes, "
        "no half body portrait, no raincoat, no modern jacket, "
        "no red, no crimson, no scarlet, no vermilion, no orange robe, no text",
    ),
    (
        "jiaoling",
        "e-commerce flat lay product photo, garment only, ONE traditional Chinese cross-collar "
        "jiaoling robe laid flat open like clothing catalog, dark silk, wide sleeves, "
        "no body inside, empty garment, fills most of frame, "
        "solid seamless medium light gray background (#C8C8CE), studio lighting, "
        "no person, no face, no mannequin, no worn clothes, no hoodie, no zipper, no text",
    ),
    (
        "sash",
        "product still life flat lay, accessory only, ONE wide silk waist sash belt for hanfu, "
        "dark embroidered ribbon coiled neatly on table, no person wearing it, "
        "solid seamless medium light gray background (#C8C8CE), studio lighting, no person, no waist, no text",
    ),
    (
        "hairpin",
        "product still life, accessory only, ONE ornate Chinese hairpin zan with jade tip, "
        "metal and jade isolated on table, catalog photo, "
        "solid seamless medium light gray background (#C8C8CE), studio lighting, "
        "no person, no hair, no head, no face, no text",
    ),
    (
        "fan",
        "product still life, accessory only, ONE round silk tuanshan hand fan, "
        "ink painting motif, wooden handle, isolated object, "
        "solid seamless medium light gray background (#C8C8CE), studio lighting, "
        "no person, no hand holding, no umbrella, no plastic, no text",
    ),
)

_COSTUME_FORCE = (
    "overhead flat lay product photography, garments and props laid flat on table, "
    "ONLY these five items: ONE slate-gray hooded raincoat, ONE pair full-length black long pants (not shorts), "
    "ONE pair black rain boots, ONE clear transparent rain umbrella with shaft and handle (not a lamp, not a hat), ONE white plastic shopping bag, "
    "slate gray raincoat plus black pants/boots, clothing pieces arranged neatly as product shots, "
    "isolated on solid seamless background, no person, no face, no mannequin, "
    "no model wearing clothes, no hanging rack display, no color variants, "
    "no hanfu, no ancient costume, no white robe, no white jacket, no white coat, "
    "no beige jacket, no blue jacket, no red cloak, no beige cloak, no brown cloak, "
    "fashion design sheet"
)

# 单品附加负向(防多件/重复/短裤);在 _build_sheet_graph 里按 prompt 关键字拼接
_COSTUME_ITEM_NEGATIVE: dict[str, str] = {
    "pants": (
        "shorts, short pants, bermuda, cropped pants, knee-length pants, skirt, "
        "multiple pairs, repeated pants, row of pants, many pants, four pants, "
        "collage of pants, grid of trousers, split screen pants, duplicate trousers, "
        "empty panel, empty slot, UI mockup, wireframe box, rectangular frame, "
        "interface layout, three empty boxes, catalog UI"
    ),
    "boots": (
        "many boots, row of boots, repeated boots, multiple pairs, five boots, six boots, "
        "four boots, three boots, line of boots, collage of footwear, duplicate rain boots, "
        "crowd of boots, shelf of boots, more than two boots"
    ),
}


def _costume_template_bytes(item_key: str, size: int = 768) -> bytes:
    """程序化单品轮廓底图,供服饰 img2img 锚定形状(防白卫衣/畸变伞)。"""
    bg = (245, 245, 248) if item_key in ("umbrella", "bag") else (255, 255, 255)
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    m = size // 10
    if item_key == "raincoat":
        # 张开的板岩灰雨衣:帽兜+双袖+躯干（#5A6A7A）
        slate = (0x5A, 0x6A, 0x7A)
        body = [m * 3, m * 3, size - m * 3, size - m * 2]
        d.rectangle(body, fill=slate)
        # hood
        d.ellipse([size // 2 - m * 2, m, size // 2 + m * 2, m * 4], fill=slate)
        # sleeves
        d.rectangle([m, m * 4, m * 3, m * 7], fill=(12, 12, 14))
        d.rectangle([size - m * 3, m * 4, size - m, m * 7], fill=(12, 12, 14))
        # zipper line
        d.line([(size // 2, m * 3), (size // 2, size - m * 2)], fill=(40, 40, 44), width=3)
    elif item_key == "pants":
        # 两条裤腿
        gap = m
        wleg = (size - 2 * m - gap) // 2
        d.rectangle([m, m * 2, m + wleg, size - m], fill=(12, 12, 14))
        d.rectangle([m + wleg + gap, m * 2, m + 2 * wleg + gap, size - m], fill=(12, 12, 14))
        d.rectangle([m, m * 2, m + 2 * wleg + gap, m * 3], fill=(12, 12, 14))  # waist
    elif item_key == "boots":
        # 仅描边双靴轮廓,避免 img2img 变成实心黑柱
        for ox in (size // 2 - m * 3, size // 2 + m):
            d.rounded_rectangle(
                [ox, m * 3, ox + m * 2, size - m],
                radius=20,
                outline=(30, 30, 34),
                width=6,
            )
            # 靴口与鞋底提示线
            d.ellipse([ox + 8, m * 3 + 4, ox + m * 2 - 8, m * 3 + m], outline=(50, 50, 55), width=3)
            d.rectangle([ox, size - m - 12, ox + m * 2, size - m], outline=(30, 30, 34), width=4)
    elif item_key == "umbrella":
        # 透明伞:浅灰穹顶描边+骨架
        cx, cy = size // 2, size // 2 - m
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
    elif item_key == "bag":
        d.rectangle([m * 2, m * 3, size - m * 2, size - m * 2], fill=(250, 250, 252), outline=(200, 200, 205), width=3)
        d.arc([m * 2 + 20, m, size // 2 - 10, m * 4], 0, 180, fill=(180, 180, 185), width=6)
        d.arc([size // 2 + 10, m, size - m * 2 - 20, m * 4], 0, 180, fill=(180, 180, 185), width=6)
    else:
        d.rectangle([m, m, size - m, size - m], outline=(0, 0, 0), width=2)
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _count_dark_blobs(px: list[tuple[int, int, int]], size: int = 64, thr: int = 80) -> int:
    """64x64 暗色连通域数量(4-邻域);用于惩罚一格多件/一排重复。"""
    dark = [False] * (size * size)
    for i, (r, g, b) in enumerate(px):
        dark[i] = r < thr and g < thr and b < thr + 10
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
            x, y = cur % size, cur // size
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or ny < 0 or nx >= size or ny >= size:
                    continue
                j = ny * size + nx
                if dark[j] and not seen[j]:
                    seen[j] = True
                    stack.append(j)
    return blobs


def _costume_item_penalty(data: bytes, item_key: str) -> float:
    """越大越差;按单品约束(雨衣必须够黑、伞不能实心黑、袋偏白;裤/靴禁多件)。"""
    img = Image.open(BytesIO(data)).convert("RGB").resize((64, 64))
    px = list(img.getdata())
    n = max(1, len(px))
    black = sum(1 for r, g, b in px if r < 70 and g < 70 and b < 80)
    white = sum(1 for r, g, b in px if r > 220 and g > 220 and b > 220)
    light = sum(1 for r, g, b in px if r > 180 and g > 180 and b > 180)
    blue = sum(1 for r, g, b in px if b > r + 25 and b > g + 15 and b > 120)
    navy = sum(1 for r, g, b in px if b > r + 10 and g < 90 and 40 < b < 140 and r < 80)
    beige = sum(1 for r, g, b in px if r > 120 and g > 90 and b < r - 15 and abs(r - g) < 45)
    pen = beige / n
    br, wr, lr = black / n, white / n, light / n
    blobs = _count_dark_blobs(px)
    if item_key in ("raincoat", "pants", "boots"):
        if br < 0.18:
            pen += (0.18 - br) * 10.0
        # 白上衣/拼色惩罚
        if wr > 0.25:
            pen += (wr - 0.25) * 8.0
        if navy / n > 0.12:
            pen += (navy / n) * 6.0
        # 假人:中心黑+边缘白
        center = px[20 * 64 + 32]
        if center[0] < 80 and wr > 0.35:
            pen += 1.5
    if item_key == "pants":
        # 一条长裤通常 1–2 个暗连通域;4 条短裤/一排重复 → 多 blob
        if blobs >= 4:
            pen += 6.0 + (blobs - 4) * 2.0
        elif blobs == 3:
            pen += 2.5
        # 短裤倾向:上下半暗区高度偏矮(暗像素集中在中带)
        rows_dark = [sum(1 for x in range(64) if px[y * 64 + x][0] < 70) for y in range(64)]
        active = [y for y, c in enumerate(rows_dark) if c > 6]
        if active:
            span = (active[-1] - active[0] + 1) / 64.0
            if span < 0.55:
                pen += (0.55 - span) * 8.0  # 竖向不够长 → 像短裤/裁切
    elif item_key == "boots":
        # 一对靴 ≈ 1–2 blob;一排五六只 → blob≥4
        if blobs >= 4:
            pen += 7.0 + (blobs - 4) * 2.5
        elif blobs == 3:
            pen += 3.0
        # 实心黑柱/剪影:暗像素占比过高且边缘过齐 → 不像可穿雨靴
        if br > 0.42:
            pen += (br - 0.42) * 12.0
        # 顶部应有靴口(近顶行不应全黑)
        top_dark = sum(1 for x in range(64) for y in range(0, 10) if px[y * 64 + x][0] < 70)
        if top_dark > 10 * 40:
            pen += 3.0
    elif item_key == "umbrella":
        # 要半透明结构,不要实心黑帽/灯
        if br > 0.45:
            pen += (br - 0.45) * 8.0
        if wr + lr < 0.25:
            pen += 2.0
    elif item_key == "bag":
        if lr < 0.35:
            pen += (0.35 - lr) * 6.0
        if blue / n > 0.12:
            pen += (blue / n) * 8.0
        if br > 0.25:
            pen += br * 4.0
    # 古风单品:检测「有人脸/肤色中带」→ 着装半身,重罚
    if item_key in ("beizi", "jiaoling", "ruqun", "sash", "hairpin", "fan"):
        skin = sum(
            1
            for r, g, b in px
            if r > 90 and g > 60 and b > 45 and r > g + 8 and r > b + 12 and abs(g - b) < 40
        )
        if skin / n > 0.06:
            pen += 8.0 + (skin / n) * 20.0
        # 中心偏上若像头部圆形暗块+下方躯干,也偏着装
        if item_key in ("beizi", "jiaoling", "ruqun") and br < 0.08 and skin / n > 0.03:
            pen += 4.0
    return pen





class CharacterSheetError(Exception):
    """设定卡业务错误;route 层映射 HTTP status。"""

    def __init__(self, message: str, *, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class SheetMeta:
    name: str
    style: str
    height_cm: int = 168
    role: str = ""
    personality: str = ""
    design_notes: str = ""
    colors: list[str] = field(default_factory=list)
    visual_prompt: str = ""
    description: str = ""


def resolve_cjk_font(size: int = 28) -> ImageFont.FreeTypeFont:
    """解析可用中文字体;全部缺失则抛 CharacterSheetError(503)。禁止默认拉丁糊字。"""
    for path in _CJK_FONT_CANDIDATES:
        p = Path(path)
        if not p.is_file():
            continue
        # TTC 可能多 face:逐 index 试到能画中文
        for face_idx in (0, 1, 2, 3, 4):
            try:
                font = ImageFont.truetype(str(p), size=size, index=face_idx)
            except OSError:
                if face_idx == 0:
                    break
                continue
            except Exception:  # noqa: BLE001
                continue
            try:
                bbox = font.getbbox("角色威严冷酷")
            except Exception:  # noqa: BLE001
                continue
            if bbox and (bbox[2] - bbox[0]) > 24:
                return font
    raise CharacterSheetError(
        "中文字体缺失(需 PingFang/思源/STHeiti/Noto Sans CJK 等)",
        status_code=503,
    )


def is_sheet_url(url: str) -> bool:
    return _CHAR_SHEET_MARK in (url or "")


def is_panel_url(url: str) -> bool:
    return _CHAR_PANEL_MARK in (url or "")


def panel_style_from_url(url: str) -> str | None:
    """从 char_panel_{cid8}_{style}_{key}_*.png 解析 style;非 panel 返回 None。"""
    if not is_panel_url(url):
        return None
    name = Path(urlsplit(url).path).name
    # char_panel_803fb69b_ancient_realistic_front_xxx.png
    # char_panel_803fb69b_anime_portrait_xxx.png
    if not name.startswith(_CHAR_PANEL_MARK):
        return None
    rest = name[len(_CHAR_PANEL_MARK) :]
    parts = rest.split("_")
    if len(parts) < 3:
        return None
    # parts[0]=cid8; style may be anime | ancient_realistic
    if len(parts) >= 3 and parts[1] == "ancient" and parts[2] == "realistic":
        return "ancient_realistic"
    if parts[1] in SHEET_STYLES:
        return parts[1]
    return None


class ReferenceImagesStyleError(CharacterSheetError):
    """reference_images 写入设定卡格图时缺显式风格匹配。"""


def assert_reference_images_panel_style(
    refs: list[str],
    *,
    allowed_styles: set[str] | frozenset[str] | None,
) -> None:
    """写入守卫:reference_images 含 char_panel_* 时必须显式风格匹配,否则拒绝。

    父代理 12:01:设定卡格图不得静默写入雨夜写实角色 reference_images。
    allowed_styles 为 None/空 → 一律拒绝任何 char_panel_*。
    """
    allowed = {s for s in (allowed_styles or set()) if s in SHEET_STYLES}
    bad: list[str] = []
    for u in refs or []:
        if not isinstance(u, str) or not is_panel_url(u):
            continue
        st = panel_style_from_url(u)
        if st is None or st not in allowed:
            bad.append(u)
    if bad:
        allow_txt = ",".join(sorted(allowed)) if allowed else "(无)"
        raise ReferenceImagesStyleError(
            f"reference_images 含设定卡格图但未显式匹配风格(allowed={allow_txt}): "
            + "; ".join(bad[:3]),
            status_code=422,
        )




def merge_video_refs(
    existing: list[str],
    *,
    panel_urls: dict[str, str],
    sheet_url: str | None = None,
) -> list[str]:
    """过检前 Ref2VA:仅主立绘+三视图置前;整卡/表情/服饰不进视频参考链。

    sheet_url 参数保留供调用方存响应字段,故意不写入返回列表。
    """
    del sheet_url  # 明确不进链
    ordered: list[str] = []
    for key in ("portrait", "front", "side", "back"):
        u = (panel_urls or {}).get(key) or ""
        if isinstance(u, str) and u.strip() and u not in ordered:
            ordered.append(u.strip())
    rest: list[str] = []
    for u in existing or []:
        if not isinstance(u, str) or not u.strip():
            continue
        if is_sheet_url(u) or is_panel_url(u):
            continue
        # 06:55:不得删除原 sample 参考;sample_* 保留在后位
        if u in ordered:
            continue
        rest.append(u.strip())
    # 立绘+三视图置前,其后保留既有非 panel/sheet 参考(含 sample)
    return (ordered + rest)[:_MAX_REFS]


def merge_sheet_into_refs(
    existing: list[str],
    sheet_url: str,
    panel_urls: dict[str, str] | None = None,
) -> list[str]:
    """兼容旧名(Batch7 v2):整卡不再置前;有 panel_urls 时写立绘+三视图。"""
    if panel_urls:
        return merge_video_refs(existing, panel_urls=panel_urls, sheet_url=sheet_url)
    # 无分格 URL 时:剥离旧整卡,保留其余(避免把整卡塞进视频链)
    rest = [
        u
        for u in existing
        if isinstance(u, str) and u.strip() and not is_sheet_url(u)
    ]
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
        st = str(k or "").strip()
        if st not in SHEET_STYLES:
            continue
        if not isinstance(v, list):
            continue
        urls = [u.strip() for u in v if isinstance(u, str) and u.strip()]
        if urls:
            out[st] = urls[:_MAX_REFS]
    return out


def merge_video_refs_by_style(
    existing_by_style: dict[str, list[str]] | None,
    *,
    style: str,
    panel_urls: dict[str, str],
    sheet_url: str | None = None,
) -> dict[str, list[str]]:
    """按风格分桶写入立绘+三视图;不覆盖其他风格分组。"""
    if style not in SHEET_STYLES:
        raise CharacterSheetError(f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422)
    by_style = {
        st: list(urls)
        for st, urls in (existing_by_style or {}).items()
        if st in SHEET_STYLES and isinstance(urls, list)
    }
    prev = [u for u in by_style.get(style, []) if isinstance(u, str)]
    by_style[style] = merge_video_refs(prev, panel_urls=panel_urls, sheet_url=sheet_url)
    # 写入守卫:该桶只允许本风格 panel
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


def flatten_refs_for_style(
    by_style: dict[str, list[str]] | None,
    *,
    style: str | None,
    samples: list[str] | None = None,
) -> list[str]:
    """供视频链选用:指定风格分桶 + sample 等非 panel 参考。"""
    ordered: list[str] = []
    if style and style in SHEET_STYLES:
        for u in (by_style or {}).get(style, []) or []:
            if isinstance(u, str) and u.strip() and u not in ordered:
                ordered.append(u.strip())
    for u in samples or []:
        if isinstance(u, str) and u.strip() and u not in ordered:
            ordered.append(u.strip())
    return ordered[:_MAX_REFS]


def count_design_note_lines(text: str) -> int:
    return len([ln.strip() for ln in (text or "").splitlines() if ln.strip()])


def assert_design_notes_ok(text: str) -> None:
    """非空设计说明必须 3–5 行（与前端 CharacterSheetEditor 一致）；空则允许后端自填。"""
    n = count_design_note_lines(text)
    if n == 0:
        return
    if n < 3 or n > 5:
        raise CharacterSheetError(
            f"设计说明须 3–5 行（当前 {n} 行）",
            status_code=422,
        )


def build_design_notes(meta: SheetMeta) -> str:
    """生成 3–5 行中文设计说明;已有足够行数则沿用。"""
    raw = (meta.design_notes or "").strip()
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if len(lines) >= 3:
        return "\n".join(lines[:5])
    name = (meta.name or "角色").strip()
    role = (meta.role or _guess_field(meta.description, "身份") or "便利店员").strip()
    personality = (
        meta.personality or _guess_field(meta.description, "性格") or "温柔果断"
    ).strip()
    desc = (meta.description or "").strip()
    style_zh = "古风写实" if meta.style == "ancient_realistic" else "二次元"
    if meta.style == "ancient_realistic":
        auto = [
            f"{name}：同一人古风写实变体，身份为{role}，性格{personality}。",
            "视觉主轴为交领汉服/齐胸襦裙或水墨写实古装，黑发，深底金字设定卡。",
            "三视图与表情均以主立绘为同一人参考，统一古装与纯色深底，保证 Ref2VA 跨镜一致。",
            f"本卡风格滤镜为{style_zh}；服饰拆解为古风单品，禁止雨衣/卫衣/便利店等现代装。",
        ]
    else:
        auto = [
            f"{name}：雨夜便利店相遇的核心角色，身份为{role}，性格{personality}。",
            "视觉主轴为板岩灰(#5A6A7A)素面无标连帽雨衣、湿发贴额与冷白灯光，辅以白色塑料袋道具。",
            "三视图与表情均以主立绘为同一人参考，主立绘/三视图/服饰统一板岩灰素面，保证 Ref2VA 跨镜一致。",
            f"本卡风格滤镜为{style_zh}；服饰拆解对齐现代雨夜设定，禁止汉服、纯黑雨衣与胸口贴标。",
        ]
    if desc and desc not in auto[0]:
        auto.insert(1, desc[:80])
    if lines:
        # 保留用户短句,补足到至少 3 行
        merged = lines + [a for a in auto if a not in lines]
        out = "\n".join(merged[:5])
    else:
        out = "\n".join(auto[:5])
    return strip_internal_design_jargon(out)


def _character_base(meta: SheetMeta) -> str:
    base = (meta.visual_prompt or meta.description or meta.name).strip()
    if not base:
        raise CharacterSheetError("角色缺少视觉描述", status_code=422)
    import re as _re
    low = base.lower()
    for bad in ("silver hair", "white hair", "grey hair", "gray hair", "blue hair", "blonde"):
        if bad in low:
            base = _re.sub(bad, "black hair", base, flags=_re.I)
            low = base.lower()
    if "black hair" not in low and "黑发" not in base:
        base = f"{base}, jet black hair, black hair"
        low = base.lower()

    if meta.style == "ancient_realistic":
        for bad in (
            "raincoat", "windbreaker", "hoodie", "convenience store",
            "plastic umbrella", "rain boots", "shopping bag", "neon",
            "zippered", "streetwear",
        ):
            if bad in low:
                base = _re.sub(_re.escape(bad), "", base, flags=_re.I)
                low = base.lower()
        base = _re.sub(r",\s*,", ", ", base).strip(" ,")
        low = base.lower()
        if "hanfu" not in low and "古装" not in base and "襦裙" not in base:
            base = (
                f"{base}, traditional Chinese hanfu, cross-collar jiaoling robe, "
                "qi-xiong ruqun or ink-wash ancient costume, silk wide sleeves, "
                "no raincoat, no modern clothing"
            )
        else:
            base = f"{base}, jet black hair, black hair, traditional Chinese clothing"
        return base

    extra = (
        "jet black hair, black hair, slate gray hooded raincoat #5A6A7A, "
        "plain unbranded no logo no chest emblem, mid-tone slate gray fabric not jet black, "
        "wet black hair on forehead, young East Asian woman, convenience store clerk vibe"
    )
    if "raincoat" not in low and "雨衣" not in base and "windbreaker" not in low:
        base = f"{base}, {extra}"
    else:
        base = f"{base}, jet black hair, black hair"
    return base


def build_panel_prompts(meta: SheetMeta) -> dict[str, str]:
    """各分区英文出图提示(风格后缀统一追加)。含 6 格独立表情键。"""
    style = meta.style if meta.style in SHEET_STYLES else "anime"
    base = _character_base(meta)
    suf = _STYLE_SUFFIX[style]
    name = meta.name
    solid = (
        "solid seamless dark gray background"
        if style == "ancient_realistic"
        else "solid seamless light gray background"
    )
    solo = "1girl, solo, single female only, alone, no other people, no male"
    if style == "ancient_realistic":
        outfit = (
            "same traditional Chinese hanfu, cross-collar robe, qi-xiong ruqun, "
            "silk wide sleeves, no raincoat, no modern jacket"
        )
        head_bit = "hair ornaments optional, face fully visible"
        back_head = "ONLY back of head and hair bun, NO face NO eyes"
    else:
        outfit = ("same character same slate-gray hooded raincoat #5A6A7A with hood, plain flat chest unbranded, no logo no emblem no badge no chest patch, no circular pattern no spiral design on chest, not jet black")
        head_bit = "hood DOWN face fully visible"
        back_head = "ONLY back of head and hood, NO face NO eyes"
    prompts: dict[str, str] = {
        "portrait": (
            f"{solo}, {base}, full body standing portrait of {name}, facing camera, "
            f"jet black hair, black hair, {outfit}, "
            f"plain chest no badge no emblem no pattern, "
            f"no silver hair, {solid}, character design, {suf}"
        ),
        "front": (
            f"{solo}, {base}, ONE figure only, front view full body turnaround of {name}, orthographic, "
            f"adult woman 165cm proportions, long legs, {head_bit}, "
            f"jet black hair, {outfit}, standing straight, "
            f"identical hooded raincoat style and color as main portrait, plain chest no badge no spiral, "
            f"feet on ground line, figure fills frame height, single person only, empty background, {solid}, {suf}"
        ),
        "side": (
            f"{solo}, {base}, ONE figure only, STRICT side profile full body turnaround of {name}, "
            f"looking left, 90 degree side view, adult woman 165cm proportions, {head_bit}, "
            f"jet black hair, orthographic, {outfit}, standing straight, "
            f"feet on ground, figure fills frame height, single person only, "
            f"NOT front view, NOT back view, empty background, {solid}, {suf}"
        ),
        "back": (
            f"{solo}, {base}, ONE figure only, STRICT rear view full body turnaround of {name}, "
            f"facing completely away from camera, back of head only, {back_head}, "
            f"hair bun / hood from behind, spine and shoulder blades visible, "
            f"NO face, NO eyes, NO nose, NO mouth, NO looking back over shoulder, "
            f"adult woman 165cm proportions, jet black hair, orthographic, single person only, "
            f"{outfit}, feet on ground, figure fills frame height, "
            f"NOT front view, NOT three-quarter, NOT face, NOT side view, empty background, {solid}, {suf}"
        ),
        "faces": (
            f"{solo}, {base}, three head closeups of {name} only, "
            f"front and three-quarter and side profile faces in a row, "
            f"EXTREME face closeups head and shoulders, NO full body, {solid}, {suf}"
        ),
        "face_front": (
            f"{solo}, {base}, FRONT facing head and shoulders closeup of {name}, "
            f"looking straight at camera, both eyes equal size, symmetrical face, "
            f"both ears faintly visible, hood DOWN completely off head, bare head, "
            f"no hood, no cloak covering hair, face fills frame, jet black hair, "
            f"eyes nose mouth clear, sharp focus, NO full body, NO waist, "
            f"NOT side profile, NOT three-quarter turn, {solid}, {suf}"
        ),
        "face_three_quarter": (
            f"{solo}, {base}, looking away, head tilt, THREE-QUARTER VIEW, "
            f"from side, head and shoulders closeup of {name}, "
            f"head yaw turned about 45 degrees to the LEFT, nose tip clearly left of face center, "
            f"viewer sees left cheek more, near eye larger than far eye, far eye partially visible, "
            f"one ear clearly visible on near side, hood DOWN bare head no hood, "
            f"face fills frame, jet black hair, sharp focus, "
            f"NOT front facing, NOT looking into camera, NOT symmetrical frontal face, "
            f"NOT 90 degree full profile, NO full body, NO waist, {solid}, {suf}"
        ),
        "face_side": (
            f"{solo}, {base}, profile, from side, side view, looking away, "
            f"STRICT SIDE PROFILE head and shoulders closeup of {name}, "
            f"exact 90 degree profile facing LEFT, ONLY one eye visible, "
            f"clear nose bridge silhouette, lips chin jawline ear outline, "
            f"other eye completely hidden behind head, face not toward camera, "
            f"hood DOWN bare head, no hood over head, jet black hair, "
            f"MUST show {outfit} collar/neckline on shoulders, clothed bust, "
            f"same art style as reference, cel-shaded consistent lineart, "
            f"NO floating disembodied head, NO white outline halo, NO photoreal skin, "
            f"sharp focus, face and shoulders fill frame, "
            f"NOT front face, NOT three-quarter, NOT both eyes, NOT logo, NOT emblem, "
            f"NOT abstract mark, NOT circle face on hood, NO full body, {solid}, {suf}"
        ),
        "costume": f"{_COSTUME_FORCE}, {suf}",
    }
    for i, expr in enumerate(_EXPR_PROMPTS):
        prompts[f"expr_{i}"] = (
            f"{solo}, {base}, {expr} of {name}, single face only, one person, "
            f"EXTREME close-up head and shoulders portrait, face fills at least 40 percent of frame, "
            f"tight headshot, hood down, face fully visible, eyes nose mouth clear, "
            f"jet black hair, same identity as main portrait, exaggerated distinct expression, "
            f"NO half body, NO full body, NO standing pose, NO waist, NO legs, NO hands props, "
            f"NO second person, no text, no letters, no chinese characters, no caption, no labels, "
            f"{solid}, {suf}"
        )
    return prompts


def _fit(
    img: Image.Image,
    box: tuple[int, int, int, int],
    *,
    cover: bool = True,
    valign: str = "center",
):
    """contain 时 valign=top|center|bottom；cover 仍居中裁。"""
    x, y, w, h = box
    src = img.convert("RGBA")
    if cover:
        scale = max(w / src.width, h / src.height)
    else:
        scale = min(w / src.width, h / src.height)
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    if cover:
        left = max(0, (nw - w) // 2)
        top = max(0, (nh - h) // 2)
        src = src.crop((left, top, left + w, top + h))
        return src, (x, y)
    ox = x + (w - src.width) // 2
    if valign == "top":
        oy = y
    elif valign == "bottom":
        oy = y + (h - src.height)
    else:
        oy = y + (h - src.height) // 2
    return src, (ox, oy)


def _paste(
    canvas: Image.Image,
    img: Image.Image,
    box: tuple[int, int, int, int],
    *,
    cover: bool = True,
    valign: str = "center",
) -> None:
    fitted, pos = _fit(img, box, cover=cover, valign=valign)
    canvas.paste(fitted, pos, fitted if fitted.mode == "RGBA" else None)


def _text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, ...] = (30, 30, 36),
    max_width: int | None = None,
) -> int:
    if not text:
        return 0
    x, y = xy
    lines: list[str] = []
    if max_width is None:
        lines = text.split("\n")
    else:
        for para in text.split("\n"):
            line = ""
            for ch in para:
                trial = line + ch
                if draw.textlength(trial, font=font) <= max_width:
                    line = trial
                else:
                    if line:
                        lines.append(line)
                    line = ch
            lines.append(line)
    line_h = int(getattr(font, "size", 24) * 1.35)
    for i, ln in enumerate(lines):
        draw.text((x, y + i * line_h), ln, font=font, fill=fill)
    return len(lines) * line_h




def extract_turnaround_view(
    sheet: Image.Image | bytes,
    key: str,
    *,
    strip_chrome: bool = True,
) -> bytes:
    """从整卡截取正/侧/背格，避开左侧身高尺(110px)，避免锁定后再画尺导致双尺。"""
    if key not in ("front", "side", "back"):
        raise CharacterSheetError(f"turnaround key 须为 front/side/back, 得到 {key}", status_code=422)
    im = sheet if isinstance(sheet, Image.Image) else Image.open(BytesIO(sheet))
    im = im.convert("RGB")
    tx, ty, tw, th = LAYOUT["turnaround"]
    view_w = (tw - 140) // 3
    idx = {"front": 0, "side": 1, "back": 2}[key]
    x0 = tx + 110 + idx * view_w
    y0 = ty + 50
    cell = im.crop((x0, y0, x0 + view_w - 12, ty + th - 40))
    if strip_chrome:
        cell = strip_baked_panel_chrome(cell)
    buf = BytesIO()
    cell.save(buf, format="PNG")
    return buf.getvalue()


def strip_baked_panel_chrome(img: Image.Image, *, top_frac: float = 0.12, max_top: int = 56) -> Image.Image:
    """去掉锁定面板自带的标题条/内框，避免服饰栏多层嵌套标题。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    if h < 80 or w < 80:
        return rgb
    top = min(max_top, max(24, int(h * top_frac)))
    top_band = rgb.crop((0, 0, w, top))
    body = rgb.crop((0, top, w, min(h, top + max(top, 24))))

    def _mean(im: Image.Image) -> float:
        px = list(im.resize((32, 8), Image.Resampling.BOX).getdata())
        return sum(sum(c) for c in px) / (len(px) * 3.0)

    try:
        mt, mb = _mean(top_band), _mean(body)
    except Exception:  # noqa: BLE001
        return rgb
    if abs(mt - mb) < 12:
        top = min(40, top)
    inset = 2 if min(w, h) > 100 else 0
    return rgb.crop((inset, top, w - inset, h - inset))


def _draw_panel_frame(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    label: str,
    font: ImageFont.ImageFont,
    *,
    outline: tuple[int, ...],
    label_fill: tuple[int, ...],
) -> None:
    x, y, w, h = box
    draw.rounded_rectangle([x, y, x + w, y + h], radius=12, outline=outline, width=2)
    if label:
        draw.text((x + 10, y + 8), label, font=font, fill=label_fill)



def _panel_garment_dominant_hex(data: bytes) -> str | None:
    """从立绘/三视图躯干 ROI 按面积取服装主色（跳过肤色/近背景）。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return None
    w, h = img.size
    # 躯干：中部偏下（避开头脸）
    crop = img.crop((int(w * 0.22), int(h * 0.28), int(w * 0.78), int(h * 0.78)))
    small = crop.resize((48, 48), Image.Resampling.BOX)
    colors = small.getcolors(48 * 48) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    best = None
    best_cnt = 0
    for cnt, (r, g, b) in colors:
        if r + g + b < 40:  # 近纯黑记但不优先
            if best is None:
                best, best_cnt = (r, g, b), cnt
            continue
        if min(r, g, b) > 235:
            continue
        # 跳过肤色
        if 90 < r < 245 and 60 < g < 210 and 45 < b < 190 and r >= g - 5 and g >= b - 15:
            continue
        if cnt > best_cnt:
            best, best_cnt = (r, g, b), cnt
    if best is None:
        return None
    r, g, b = best
    return f"#{r:02X}{g:02X}{b:02X}"


def _hex_luma(hx: str) -> float:
    return (int(hx[1:3], 16) + int(hx[3:5], 16) + int(hx[5:7], 16)) / 3.0


def _hex_dist(a: str, b: str) -> float:
    ar, ag, ab = int(a[1:3], 16), int(a[3:5], 16), int(a[5:7], 16)
    br, bg, bb = int(b[1:3], 16), int(b[3:5], 16), int(b[5:7], 16)
    return abs(ar - br) + abs(ag - bg) + abs(ab - bb)


def portrait_has_chest_emblem(data: bytes) -> bool:
    """主立绘胸口贴标/徽标启发式：中上躯干高对比小团块。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return False
    w, h = img.size
    # 胸口 ROI
    x0, x1 = int(w * 0.35), int(w * 0.65)
    y0, y1 = int(h * 0.32), int(h * 0.52)
    crop = img.crop((x0, y0, x1, y1)).resize((64, 48), Image.Resampling.BILINEAR)
    px = list(crop.getdata())
    if not px:
        return False
    # 相对邻域的亮/饱和斑
    import statistics
    lumas = [(r + g + b) / 3 for r, g, b in px]
    med = statistics.median(lumas)
    bright = sum(1 for v in lumas if v > med + 45)
    # 彩色斑（非灰）
    chroma = sum(1 for r, g, b in px if max(r, g, b) - min(r, g, b) > 40 and (r + g + b) / 3 > 40)
    # 贴标通常是局部亮/彩斑，占比小但成团；大圆螺旋图案 chroma/bright 占比更高
    n = len(px)
    if (8 <= bright <= int(n * 0.22)) or (6 <= chroma <= int(n * 0.18)):
        return True
    # 大面积非灰图案（螺旋/圆徽）
    if chroma >= int(n * 0.12) and bright >= int(n * 0.08):
        return True
    return False


def assert_sheet_garment_consistency(
    panels: dict[str, bytes],
    *,
    max_dist: int = 90,
    style: str = "anime",
) -> None:
    """13:16②：主立绘 vs 三视图服装主色差超阈或主立绘贴标 → 不得过审。"""
    portrait = panels.get("portrait")
    if not portrait:
        raise CharacterSheetError("一致性门禁失败:缺主立绘", status_code=422)
    if style in ("anime", "二次元") and portrait_has_chest_emblem(portrait):
        raise CharacterSheetError(
            "一致性门禁失败:主立绘胸口检出贴标/徽标，须重出",
            status_code=422,
        )
    if style in ("anime", "二次元"):
        for key in ("front", "side", "back"):
            data = panels.get(key)
            if data and portrait_has_chest_emblem(data):
                raise CharacterSheetError(
                    f"一致性门禁失败:三视图{key}胸口检出徽标/图案，须重出",
                    status_code=422,
                )
    p_hex = _panel_garment_dominant_hex(portrait)
    if not p_hex:
        raise CharacterSheetError("一致性门禁失败:主立绘无法取服装主色", status_code=422)
    # anime 期望板岩灰中调，禁止主色近纯黑
    if style in ("anime", "二次元") and _hex_luma(p_hex) < 35:
        raise CharacterSheetError(
            f"一致性门禁失败:主立绘服装主色过黑({p_hex})，须板岩灰素面",
            status_code=422,
        )
    for key in ("front", "side", "back"):
        data = panels.get(key)
        if not data:
            continue
        t_hex = _panel_garment_dominant_hex(data)
        if not t_hex:
            raise CharacterSheetError(
                f"一致性门禁失败:三视图 {key} 无法取服装主色",
                status_code=422,
            )
        dist = _hex_dist(p_hex, t_hex)
        if dist > max_dist:
            raise CharacterSheetError(
                f"一致性门禁失败:主立绘({p_hex})与{key}({t_hex})色差={dist}>{max_dist}",
                status_code=422,
            )


def _extract_palette(
    img: Image.Image, n: int = 6, *, style: str = "anime"
) -> list[str]:
    """从人物前景取色;剔除近背景/近黑,保证肤色(+古风金色)可用。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    corners = [
        rgb.getpixel((2, 2)),
        rgb.getpixel((w - 3, 2)),
        rgb.getpixel((2, h - 3)),
        rgb.getpixel((w - 3, h - 3)),
    ]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    # 上半身/面颊优先(避开全黑袍)
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
        mx, mn = max(r, g, b), min(r, g, b)
        if mx - mn < 12 and 70 <= mx <= 190:
            continue
        # 跳过近黑(袍底),留给 fallback 补黑
        if r + g + b < 90:
            continue
        hx = f"#{r:02X}{g:02X}{b:02X}"
        if hx not in out:
            out.append(hx)
        if 90 < r < 245 and 60 < g < 210 and 45 < b < 190 and r >= g - 5 and g >= b - 15:
            skin_cands.append((cnt, (r, g, b)))
        # 金色/琥珀
        if r > 140 and g > 100 and b < 120 and (r - b) > 40 and (g - b) > 20:
            gold_cands.append((cnt, (r, g, b)))
        if len(out) >= n:
            break
    if style == "ancient_realistic":
        fallback = ["#E8C4A8", "#D4AF37", "#1A1A1E", "#2C2C34", "#C9A227", "#8B7355"]
    else:
        # 13:16③：板岩灰主色排第一（肤色之后），纯黑只作辅色
        fallback = ["#E8C4A8", "#5A6A7A", "#D4D3D8", "#C98A7A", "#2C2C34", "#1A1A1E"]
    if skin_cands:
        sr, sg, sb = skin_cands[0][1]
        skin_hx = f"#{sr:02X}{sg:02X}{sb:02X}"
        if skin_hx in out:
            out.remove(skin_hx)
        out.insert(0, skin_hx)
    elif fallback[0] not in out:
        out.insert(0, fallback[0])
    if style == "ancient_realistic":
        if gold_cands:
            gr, gg, gb = gold_cands[0][1]
            gold_hx = f"#{gr:02X}{gg:02X}{gb:02X}"
            if gold_hx in out:
                out.remove(gold_hx)
            out.insert(min(1, len(out)), gold_hx)
        elif "#D4AF37" not in out:
            out.insert(min(1, len(out)), "#D4AF37")
    def _luma(hx: str) -> int:
        return int(hx[1:3], 16) + int(hx[3:5], 16) + int(hx[5:7], 16)
    dark_n = sum(1 for hx in out[:6] if _luma(hx) < 160)
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
    rgb = img.convert("RGBA")
    w, h = rgb.size
    if h < 200 or w < 80:
        return rgb
    # 自底向上找「宽深色横条」(名字底);出现则裁到条上方
    sample = rgb.convert("RGB").resize((64, max(32, h // 8)), Image.Resampling.BOX)
    sw, sh = sample.size
    cut_ratio = None
    for yi in range(sh - 1, int(sh * 0.55), -1):
        row = [sample.getpixel((xi, yi)) for xi in range(sw)]
        dark = sum(1 for r, g, b in row if r + g + b < 140)
        if dark >= int(sw * 0.55):
            # 横条上方再留一点边
            cut_ratio = (yi / sh) * 0.98
            break
    if cut_ratio is None or cut_ratio < 0.55:
        return rgb
    cut_y = max(int(h * 0.55), int(h * cut_ratio))
    if cut_y >= h - 8:
        return rgb
    return rgb.crop((0, 0, w, cut_y))


def _strip_expr_label_band(img: Image.Image) -> Image.Image:
    """去掉表情格底部已烘焙标签带,改由后端真字体重绘。"""
    rgba = img.convert("RGBA")
    w, h = rgba.size
    if h < 64:
        return rgba
    # 更狠:旧拼版标签可占底 25%+,留头肩
    cut = int(h * 0.70)
    out = rgba.crop((0, 0, w, max(48, cut)))
    # 底缘再抹一条浅色,防残留描边进 cover
    from PIL import ImageDraw as _ID
    d = _ID.Draw(out)
    bh = max(2, out.size[1] // 40)
    d.rectangle([0, out.size[1] - bh, out.size[0], out.size[1]], fill=(245, 245, 248, 255))
    return out


def _draw_height_scale(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    height_cm: int,
    font: ImageFont.ImageFont,
    *,
    fill: tuple[int, ...],
) -> None:
    x, y, w, h = box
    scale_x = x + 28
    top, bottom = y + 60, y + h - 40
    draw.line([(scale_x, top), (scale_x, bottom)], fill=fill, width=3)
    ticks = 8
    for i in range(ticks + 1):
        ty = top + int((bottom - top) * i / ticks)
        draw.line([(scale_x - 8, ty), (scale_x + 8, ty)], fill=fill, width=2)
        cm = int(height_cm * (1 - i / ticks))
        draw.text((scale_x + 14, ty - 8), f"{cm}", font=font, fill=fill)
    draw.text((scale_x - 10, bottom + 8), "cm", font=font, fill=fill)


def _fit_cover_keep_crown(
    img: Image.Image,
    box: tuple[int, int, int, int],
) -> tuple[Image.Image, tuple[int, int]]:
    """cover 填满,优先保留头顶:用脸框偏上裁,无脸时偏上 1/4 而非居中。"""
    x, y, w, h = box
    src = img.convert("RGBA")
    scale = max(w / src.width, h / src.height)
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - w) // 2)
    # 默认贴顶,优先保留头顶/刘海(父代理 13:00)
    top = 0
    try:
        buf = BytesIO()
        src.convert("RGB").save(buf, format="PNG")
        bb = _insightface_face_bbox_xyxy(buf.getvalue())
    except Exception:  # noqa: BLE001
        bb = None
    if bb is not None:
        _x1, y1, _x2, y2 = bb
        face_cy = (y1 + y2) / 2.0
        # 脸心落在裁窗上方约 0.45;若会裁掉头顶则退回贴顶
        desired_top = int(face_cy - 0.45 * h)
        top = 0 if desired_top < 0 else min(desired_top, nh - h)
        face_cx = (_x1 + _x2) / 2.0
        left = max(0, min(int(face_cx - w / 2.0), nw - w))
    if left + w > nw:
        left = max(0, nw - w)
    if top + h > nh:
        top = max(0, nh - h)
    src = src.crop((left, top, left + w, top + h))
    return src, (x, y)


def _compose_expression_grid(
    panels: dict[str, Image.Image],
    *,
    label_fill: tuple[int, ...] = (30, 30, 36),
    draw_labels: bool = True,
    box_w: int | None = None,
    box_h: int | None = None,
    grid_bg: tuple[int, ...] = (245, 245, 248, 255),
    label_band_bg: tuple[int, ...] | None = None,
) -> Image.Image:
    """2x3:每格=图片区+其下独立标签带;图片脸心 cover 保头顶;标签不与图重叠。

    古风可传深底 grid_bg/label_band_bg + 金字 label_fill；二次元保持浅底默认。
    单层面板：本函数不画「表情」标题（外框由 compose 画一次）。
    """
    cols, rows = 3, 2
    label_h = 44 if draw_labels else 0
    if box_w is None or box_h is None:
        _, _, ew, eh = LAYOUT["expressions"]
        box_w = box_w or (ew - 16)
        box_h = box_h or (eh - 40)
    cell_w = max(64, int(box_w) // cols)
    cell_h = max(64 + label_h, int(box_h) // rows)
    img_h = max(48, cell_h - label_h)
    # 硬隔离:图片区高度严格不含标签带
    assert label_h == 0 or img_h + label_h <= cell_h
    gbg = tuple(grid_bg) if len(grid_bg) == 4 else (*grid_bg[:3], 255)
    lbg = (
        tuple(label_band_bg)
        if label_band_bg is not None
        else gbg
    )
    if len(lbg) == 3:
        lbg = (*lbg, 255)
    grid = Image.new("RGBA", (cols * cell_w, rows * cell_h), gbg)
    draw = ImageDraw.Draw(grid)
    font = resolve_cjk_font(20) if draw_labels else None
    for i, key in enumerate(_EXPR_KEYS):
        img = panels.get(key)
        if img is None:
            raise CharacterSheetError(f"缺面板:{key}", status_code=500)
        row, col = divmod(i, cols)
        cell_x0 = col * cell_w
        cell_y0 = row * cell_h
        # 图片区:内缩 3px,严格落在 [cell_y0, cell_y0+img_h)
        ox = cell_x0 + 3
        oy = cell_y0 + 3
        iw = cell_w - 6
        ih = img_h - 6
        clean = _strip_expr_label_band(img.convert("RGBA"))
        fitted, pos = _fit_cover_keep_crown(clean, (ox, oy, iw, ih))
        # 再抹一层底,防贴图溢出标签带
        if fitted.height > ih:
            fitted = fitted.crop((0, 0, fitted.width, ih))
        grid.paste(fitted, pos, fitted)
        if draw_labels and font is not None and i < len(_EXPR_LABELS):
            # 标签带:独立矩形,与图片区零重叠（古风深底金字 / 二次元浅底深字）
            band_y0 = cell_y0 + img_h
            band_y1 = cell_y0 + cell_h
            draw.rectangle(
                [cell_x0, band_y0, cell_x0 + cell_w, band_y1],
                fill=lbg,
            )
            lab = _EXPR_LABELS[i]
            tw = draw.textlength(lab, font=font)
            lx = cell_x0 + (cell_w - tw) / 2.0
            # 垂直居中于标签带
            try:
                bbox = font.getbbox(lab)
                th = bbox[3] - bbox[1]
            except Exception:  # noqa: BLE001
                th = 20
            ly = band_y0 + max(2, (label_h - th) // 2)
            draw.text((lx, ly), lab, font=font, fill=label_fill)
    return grid


def compose_character_sheet(
    panels: dict[str, Image.Image | bytes],
    meta: SheetMeta,
    *,
    font_path_probe: bool = True,
) -> bytes:
    """程序化拼固定版式 PNG bytes。缺关键面板或字体 → CharacterSheetError。"""
    if not (meta.name or "").strip():
        raise CharacterSheetError("角色名为空", status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(
            f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422
        )
    if font_path_probe:
        font_title = resolve_cjk_font(48)
        font_body = resolve_cjk_font(26)
        font_small = resolve_cjk_font(20)
        font_label = resolve_cjk_font(18)
    else:  # pragma: no cover
        font_title = font_body = font_small = font_label = ImageFont.load_default()

    def _as_image(key: str) -> Image.Image:
        raw = panels.get(key)
        if raw is None:
            raise CharacterSheetError(f"缺面板:{key}", status_code=500)
        if isinstance(raw, Image.Image):
            return raw.convert("RGBA")
        if isinstance(raw, (bytes, bytearray)):
            try:
                return Image.open(BytesIO(raw)).convert("RGBA")
            except Exception as e:  # noqa: BLE001
                raise CharacterSheetError(f"面板损坏:{key}", status_code=500) from e
        raise CharacterSheetError(f"面板类型无效:{key}", status_code=500)

    theme = _THEME[meta.style]
    canvas = Image.new("RGBA", (SHEET_W, SHEET_H), theme["bg"])
    draw = ImageDraw.Draw(canvas)

    style_zh = "古风写实" if meta.style == "ancient_realistic" else "二次元"
    draw.rectangle([0, 0, SHEET_W, 36], fill=theme["title_bar"])
    draw.text(
        (48, 6),
        f"角色设定卡 · {style_zh}",
        font=font_label,
        fill=theme["title_text"],
    )

    portrait = sanitize_portrait_panel(_as_image("portrait"))
    _paste(canvas, portrait, LAYOUT["portrait"], cover=True)
    _draw_panel_frame(
        draw,
        LAYOUT["portrait"],
        "立绘",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )

    nx, ny, nw, nh = LAYOUT["name"]
    draw.rounded_rectangle(
        [nx, ny, nx + nw, ny + nh], radius=8, fill=theme["name_bg"]
    )
    name_fill = (
        theme["text"] if meta.style == "ancient_realistic" else (250, 250, 252)
    )
    draw.text((nx + 20, ny + 12), meta.name.strip(), font=font_title, fill=name_fill)

    px, py, pw, ph = LAYOUT["profile"]
    draw.rounded_rectangle(
        [px, py, px + pw, py + ph],
        radius=10,
        outline=theme["outline"],
        width=2,
    )
    role = meta.role or _guess_field(meta.description, "身份") or "—"
    personality = (
        meta.personality
        or _guess_field(meta.description, "性格")
        or (meta.description[:40] or "—")
    )
    rows = [
        ("身高", f"{meta.height_cm} cm"),
        ("身份", role),
        ("性格", personality),
        ("风格", style_zh),
    ]
    yy = py + 24
    for k, v in rows:
        draw.text((px + 24, yy), k, font=font_small, fill=theme["text_dim"])
        _text(
            draw,
            (px + 120, yy),
            str(v)[:48],
            font_body,
            fill=theme["text"],
            max_width=pw - 160,
        )
        yy += 56

    tx, ty, tw, th = LAYOUT["turnaround"]
    draw.rounded_rectangle(
        [tx, ty, tx + tw, ty + th],
        radius=12,
        outline=theme["outline"],
        width=2,
    )
    draw.text((tx + 16, ty + 12), "三视图", font=font_label, fill=theme["text_dim"])
    _draw_height_scale(
        draw, (tx, ty, 100, th), meta.height_cm, font_small, fill=theme["scale"]
    )
    view_w = (tw - 140) // 3
    view_box_y = ty + 50
    view_h = th - 90
    for i, key in enumerate(("front", "side", "back")):
        box = (tx + 110 + i * view_w, view_box_y, view_w - 12, view_h)
        # cover=False + 先按高度归一:脚底贴底、头顶贴齐刻度
        src = _as_image(key)
        buf = BytesIO()
        src.convert("RGB").save(buf, format="PNG")
        norm = Image.open(BytesIO(normalize_turnaround_figure(buf.getvalue(), out_w=box[2], out_h=box[3]))).convert("RGBA")
        _paste(canvas, norm, box, cover=False)
        label = {"front": "正", "side": "侧", "back": "背"}[key]
        draw.text(
            (box[0] + view_w // 2 - 20, ty + th - 36),
            label,
            font=font_body,
            fill=theme["text"],
        )

    _draw_panel_frame(
        draw,
        LAYOUT["faces"],
        "面部/发型",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )
    fx, fy, fw, fh = LAYOUT["faces"]
    # 18:10: faces 禁止 cover——cover 会按高放大后裁掉 L/R，导致中宽左右窄
    # 21:38: 内容区先铺主题底色，避免 letterbox 露出扎眼白空带（古风尤其）
    _fcx, _fcy, _fcw, _fch = fx + 8, fy + 32, fw - 16, fh - 40
    _fbg = theme["bg"][:3] if len(theme["bg"]) >= 3 else (11, 14, 20)
    draw.rectangle(
        [_fcx, _fcy, _fcx + _fcw, _fcy + _fch],
        fill=_fbg,
    )
    # 22:37：面部顶对齐，避免 240×320 三格在高面板里垂直居中留下上方空带
    _paste(
        canvas,
        _as_image("faces"),
        (_fcx, _fcy, _fcw, _fch),
        cover=False,
        valign="top",
    )

    # 表情:优先用 expr_0..5 拼 2x3;兼容旧单图 expressions
    _draw_panel_frame(
        draw,
        LAYOUT["expressions"],
        "表情",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )
    ex, ey, ew, eh = LAYOUT["expressions"]
    expr_imgs = {k: _as_image(k) for k in _EXPR_KEYS if k in panels}
    if len(expr_imgs) == 6:
        # 古风：深底金字标签带；二次元：浅底深字（默认）。单层外框标题，格内不再套「表情」。
        if meta.style == "ancient_realistic":
            expr_grid_bg = (16, 18, 24, 255)
            expr_label_bg = (16, 18, 24, 255)
        else:
            expr_grid_bg = (245, 245, 248, 255)
            expr_label_bg = (245, 245, 248, 255)
        grid = _compose_expression_grid(
            expr_imgs,
            label_fill=theme["text"],
            box_w=ew - 16,
            box_h=eh - 40,
            grid_bg=expr_grid_bg,
            label_band_bg=expr_label_bg,
        )
        # 12:34:表情格含真字体标签,禁止 cover 裁掉/撕边导致叠字残影
        _paste(canvas, grid, (ex + 8, ey + 32, ew - 16, eh - 40), cover=False)
    else:
        # 12:34: 只保留每格下方一行真字体标签;禁止栏底再叠 chip 排;禁 cover 撕标签
        legacy = strip_baked_panel_chrome(_as_image("expressions"))
        _paste(
            canvas,
            legacy,
            (ex + 8, ey + 32, ew - 16, eh - 40),
            cover=False,
        )

    _draw_panel_frame(
        draw,
        LAYOUT["costume"],
        "服饰/饰品",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )
    cx, cy, cw, ch = LAYOUT["costume"]
    # letterbox:完整物品可见,禁止竖长条中心裁切；先剥锁定区自带标题/内框防嵌套
    _costume_im = strip_baked_panel_chrome(_as_image("costume"))
    _paste(canvas, _costume_im, (cx + 8, cy + 32, cw - 16, ch - 40), cover=False)

    colors = list(meta.colors) if meta.colors else _extract_palette(
        portrait, style=meta.style
    )
    colors = [_normalize_hex(c) for c in colors if _normalize_hex(c)]
    if not colors:
        colors = _extract_palette(portrait, style=meta.style)
    # 古风强制含肤色+金色;二次元强制含肤色+浅灰(防全黑)
    if meta.style == "ancient_realistic":
        for must in ("#E8C4A8", "#D4AF37"):
            if must not in colors:
                colors = [must] + [c for c in colors if c != must]
    else:
        for must in ("#E8C4A8", "#D4D3D8"):
            if must not in colors:
                colors = [must] + [c for c in colors if c != must]
    colors = colors[:6]
    plx, ply, plw, plh = LAYOUT["palette"]
    _draw_panel_frame(
        draw,
        LAYOUT["palette"],
        "配色",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )
    n_colors = max(1, min(6, len(colors)))
    colors = colors[:n_colors]
    sw = (plw - 24) // n_colors
    # 色号互不重叠：按格宽选字号，必要时缩写
    swatch_font = font_label
    try:
        for sz in (18, 16, 14, 12, 11, 10):
            cand = resolve_cjk_font(sz)
            sample = "#E8C4A8"
            if draw.textlength(sample, font=cand) <= max(24, sw - 10):
                swatch_font = cand
                break
    except Exception:  # noqa: BLE001
        swatch_font = font_label
    label_boxes: list[tuple[int, int, int, int]] = []
    for i, hx in enumerate(colors):
        rgb = tuple(int(hx[j : j + 2], 16) for j in (1, 3, 5))
        sx = plx + 12 + i * sw
        draw.rounded_rectangle(
            [sx, ply + 40, sx + sw - 8, ply + plh - 36], radius=6, fill=rgb
        )
        label = hx
        if draw.textlength(label, font=swatch_font) > sw - 8:
            label = hx[1:]  # 去掉 # 再试
        if draw.textlength(label, font=swatch_font) > sw - 8:
            label = hx[1:4] + "…"
        tw = int(draw.textlength(label, font=swatch_font))
        tx = sx + max(2, (sw - 8 - tw) // 2)
        ty = ply + plh - 30
        # 硬推：与上一框重叠则右移到其右缘+2
        box = (tx, ty, tx + tw, ty + 18)
        if label_boxes:
            prev = label_boxes[-1]
            if box[0] < prev[2] + 2:
                tx = prev[2] + 2
                box = (tx, ty, tx + tw, ty + 18)
        # 不画出右边界
        if box[2] > plx + plw - 4:
            tx = max(sx + 2, plx + plw - 4 - tw)
            box = (tx, ty, tx + tw, ty + 18)
        draw.text((tx, ty), label, font=swatch_font, fill=theme["text_dim"])
        label_boxes.append(box)
    # 单测/运行时断言：色号文字框互不重叠
    for a, b in zip(label_boxes, label_boxes[1:]):
        if a[2] > b[0]:
            raise CharacterSheetError(
                f"配色色号文字重叠: {a} vs {b}", status_code=500
            )

    nx2, ny2, nw2, nh2 = LAYOUT["notes"]
    _draw_panel_frame(
        draw,
        LAYOUT["notes"],
        "设计说明",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )
    notes = build_design_notes(meta)
    _text(
        draw,
        (nx2 + 16, ny2 + 36),
        notes[:400],
        font_small,
        fill=theme["text"],
        max_width=nw2 - 32,
    )

    ftx, fty, ftw, _ = LAYOUT["footer"]
    draw.text(
        (ftx, fty + 20),
        f"ToIV · {meta.name} · {style_zh} · Ref2VA",
        font=font_label,
        fill=theme["text_dim"],
    )

    buf = BytesIO()
    canvas.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _normalize_hex(c: str) -> str | None:
    s = (c or "").strip()
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", s):
        return s.upper()
    if re.fullmatch(r"[0-9A-Fa-f]{6}", s):
        return f"#{s.upper()}"
    return None


def _guess_field(description: str, key: str) -> str:
    if not description:
        return ""
    m = re.search(rf"{key}\s*[:：]\s*([^\n;；|/]+)", description)
    return (m.group(1).strip() if m else "")[:40]



def extract_locked_panels_from_sheet(
    sheet_bytes: bytes,
    *,
    existing: dict[str, bytes] | None = None,
) -> dict[str, bytes]:
    """从整卡按 LAYOUT 裁出缺失分格,含 expr_0..5。

    用途:panel-replace / regenerate 锁定时,磁盘无 expr_* 也不能用空白盖掉已有表情。
    existing 中已有的键原样保留,不覆盖。
    """
    locked: dict[str, bytes] = dict(existing or {})
    sim = Image.open(BytesIO(sheet_bytes)).convert("RGB")

    def _put(key: str, crop: Image.Image) -> None:
        if key in locked and locked[key]:
            return
        buf = BytesIO()
        crop.convert("RGB").save(buf, format="PNG")
        locked[key] = buf.getvalue()

    for k, box in LAYOUT.items():
        if k in (
            "canvas",
            "name",
            "profile",
            "turnaround",
            "palette",
            "notes",
            "footer",
            "expressions",
        ):
            continue
        if k in locked and locked[k]:
            continue
        x, y, w, h = box
        if k in ("faces", "costume"):
            crop = sim.crop((x + 8, y + 32, x + w - 8, y + h - 8))
        else:
            crop = sim.crop((x, y, x + w, y + h))
        _put(k, crop)

    # 三视图从 turnaround 三等分
    if any(k not in locked or not locked.get(k) for k in ("front", "side", "back")):
        tx, ty, tw, th = LAYOUT["turnaround"]
        view_w = (tw - 140) // 3
        for i, k in enumerate(("front", "side", "back")):
            if k in locked and locked[k]:
                continue
            box = (
                tx + 110 + i * view_w,
                ty + 50,
                tx + 110 + (i + 1) * view_w - 12,
                ty + th - 40,
            )
            _put(k, sim.crop(box))

    # 表情:整区 + 拆成 expr_0..5(去掉每格标签带)
    ex, ey, ew, eh = LAYOUT["expressions"]
    content = sim.crop((ex + 8, ey + 32, ex + ew - 8, ey + eh - 8))
    if "expressions" not in locked or not locked.get("expressions"):
        _put("expressions", content)
    need_expr = sum(1 for k in _EXPR_KEYS if k in locked and locked.get(k)) < 6
    if need_expr:
        cols, rows = 3, 2
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


def style_similarity_score(
    candidate: bytes,
    reference: bytes,
    *,
    size: int = 128,
) -> dict[str, float]:
    """相对参考正视头部的画风相似度:平滑直方图 + 均色 + 像素相关。

    返回 dict: hist (0~1), pixel (0~1), mean (0~1), score (加权)。无外部 CLIP 时用此门禁。
    """
    import math

    def _prep(data: bytes) -> Image.Image:
        im = Image.open(BytesIO(data)).convert("RGB")
        return im.resize((size, size), Image.Resampling.BILINEAR)

    a = _prep(candidate)
    b = _prep(reference)

    def _smooth_hist(im: Image.Image) -> list[float]:
        # 每通道 16-bin,并做邻域平滑,避免近色落邻箱得 0
        out: list[float] = []
        full = im.histogram()
        for ch in range(3):
            hx = full[ch * 256 : (ch + 1) * 256]
            bins = [sum(hx[i * 16 : (i + 1) * 16]) for i in range(16)]
            sm = [0.0] * 16
            for i, v in enumerate(bins):
                sm[i] += v * 0.5
                if i:
                    sm[i - 1] += v * 0.25
                if i + 1 < 16:
                    sm[i + 1] += v * 0.25
            out.extend(sm)
        return out

    def _cos(u: list[float], v: list[float]) -> float:
        dot = sum(a * b for a, b in zip(u, v))
        nu = math.sqrt(sum(a * a for a in u)) or 1.0
        nv = math.sqrt(sum(b * b for b in v)) or 1.0
        return max(0.0, min(1.0, dot / (nu * nv)))

    ha, hb = _smooth_hist(a), _smooth_hist(b)
    hist = _cos(ha, hb)

    pa = list(a.getdata())
    pb = list(b.getdata())
    ma = [sum(p[i] for p in pa) / len(pa) for i in range(3)]
    mb = [sum(p[i] for p in pb) / len(pb) for i in range(3)]
    mean_dist = math.sqrt(sum((ma[i] - mb[i]) ** 2 for i in range(3))) / 441.67
    mean = max(0.0, min(1.0, 1.0 - mean_dist))

    num = dx = dy = 0.0
    for p, q in zip(pa, pb):
        for i in range(3):
            a0 = p[i] - ma[i]
            b0 = q[i] - mb[i]
            num += a0 * b0
            dx += a0 * a0
            dy += b0 * b0
    if dx < 1e-6 or dy < 1e-6:
        pixel = mean
    else:
        pixel = max(0.0, min(1.0, (num / math.sqrt(dx * dy) + 1.0) / 2.0))

    score = 0.45 * hist + 0.35 * mean + 0.20 * pixel
    return {
        "hist": float(hist),
        "pixel": float(pixel),
        "mean": float(mean),
        "score": float(score),
    }



def style_ok_for_face(
    candidate: bytes,
    reference: bytes,
    *,
    min_score: float = 0.72,
) -> tuple[bool, dict[str, float]]:
    """画风门禁:与卡内正视头部相似度低于阈值则不入卡。"""
    meta = style_similarity_score(candidate, reference)
    return bool(meta["score"] >= float(min_score)), meta


def strip_internal_design_jargon(text: str) -> str:
    """卡面设计说明去掉 fix/LoRA/az45/硬门禁等内部字样。"""
    if not text:
        return text
    bad = re.compile(
        r"(fix\d+[a-z]?|LoRA|lora|az\s*45|az45|硬门禁|yaw\s*门禁|CLIP\s*门禁|"
        r"final_review|Qwen-Edit|batch7|openpose|IPA\b)",
        re.I,
    )
    lines = []
    for ln in text.splitlines():
        s = bad.sub("", ln)
        s = re.sub(r"\s{2,}", " ", s).strip(" -|;,，、")
        s = re.sub(r"[。.]{2,}", "。", s).strip()
        if not s or s in {"。", ".", "…", "·"}:
            continue
        lines.append(s)
    return "\n".join(lines)


def save_sheet_png(data: bytes, *, character_id: str, style: str) -> str:
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{_CHAR_SHEET_MARK}{character_id[:8]}_{style}_{uuid.uuid4().hex[:12]}.png"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def save_panel_png(
    data: bytes, *, character_id: str, style: str, key: str
) -> str:
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = (
        f"{_CHAR_PANEL_MARK}{character_id[:8]}_{style}_{key}_"
        f"{uuid.uuid4().hex[:10]}.png"
    )
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def placeholder_panel(
    color: tuple[int, int, int], size: tuple[int, int] = (512, 768)
) -> Image.Image:
    img = Image.new("RGBA", size, (*color, 255))
    d = ImageDraw.Draw(img)
    d.rectangle(
        [20, 20, size[0] - 20, size[1] - 20],
        outline=(255, 255, 255, 180),
        width=4,
    )
    return img


def crop_face_ref(portrait_bytes: bytes, size: int = 768) -> bytes:
    """从立绘取头肩特写正方形参考,供表情 img2img(紧裁,避免半身站姿)。"""
    img = Image.open(BytesIO(portrait_bytes)).convert("RGB")
    w, h = img.size
    # 紧裁上部头肩:边长约宽的 72% 或高的 38%,取较小者,偏上
    side = min(int(w * 0.72), int(h * 0.38), w, h)
    side = max(64, side)
    left = max(0, (w - side) // 2)
    top = max(0, int(h * 0.01))
    if top + side > h:
        top = max(0, h - side)
    crop = img.crop((left, top, left + side, top + side))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def crop_face_head_collarbone(
    data: bytes,
    *,
    size: int = 768,
    max_zoom: float = 1.5,
) -> bytes:
    """以脸为中心裁头顶略上到锁骨;放大不超过 max_zoom(父代理 12:34)。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    bb = _insightface_face_bbox_xyxy(data)
    if bb is None:
        hbb = _heuristic_skin_face_bbox(img)
        if hbb is not None:
            bb = (float(hbb[0]), float(hbb[1]), float(hbb[2]), float(hbb[3]))
    if bb is None:
        # 回退:上半幅居中方裁
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
        # 放大上限:裁窗边长不得小于原图短边/max_zoom
        min_side = min(w, h) / max(1.01, max_zoom)
        side = max(side, min_side)
        left = cx - side / 2.0
        # clamp
        if left < 0:
            left = 0
        if left + side > w:
            left = max(0.0, w - side)
        if top < 0:
            top = 0
        if top + side > h:
            top = max(0.0, h - side)
        # 若仍超界则缩边
        side = min(side, w - left, h - top)
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()



def crop_head_from_figure(data: bytes, *, size: int = 768, top_frac: float = 0.34) -> bytes:
    """从全身/半身立绘裁头肩正方形,供面部角度锚定(尤其侧脸来自三视图侧格)。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    head = img.crop((int(w * 0.05), 0, int(w * 0.95), max(1, int(h * top_frac))))
    side = max(head.width, head.height, 8)
    canvas = Image.new("RGB", (side, side), (220, 220, 224))
    canvas.paste(head, ((side - head.width) // 2, (side - head.height) // 2))
    canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()




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
            root = os.environ.get("INSIGHTFACE_HOME") or os.path.expanduser(
                "~/.insightface"
            )
            app = FaceAnalysis(
                name="buffalo_l",
                providers=["CPUExecutionProvider"],
                root=root,
            )
            app.prepare(ctx_id=-1, det_size=(640, 640))
            _YAW_FACE_APP = app
        faces = app.get(bgr)
        if not faces:
            return None
        f = sorted(
            faces,
            key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]),
            reverse=True,
        )[0]
        bb = getattr(f, "bbox", None)
        if bb is None:
            return None
        return float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])
    except Exception:  # noqa: BLE001
        return None


def _heuristic_skin_face_bbox(
    img: Image.Image,
) -> tuple[int, int, int, int] | None:
    """肤色/五官启发式脸框,优先上半身肤色块,避免宽袖汉服全身前景拉偏中心。"""
    w, h = img.size
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    sp = small.load()
    xs, ys = [], []
    for y in range(64):
        # 忽略最底 30%(裙/袖),脸几乎都在上 70%
        if y >= 46:
            continue
        for x in range(64):
            r, g, b = sp[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            # 跳过近白/近灰底/近黑
            if r > 235 and g > 235 and b > 235:
                continue
            if mx - mn < 12 and 60 <= mx <= 210:
                continue
            if mx < 28 and mx - mn < 10:
                continue
            # 写实肤色
            skin_real = (
                r > 95
                and g > 40
                and b > 20
                and r >= g
                and r >= b
                and (r - g) > 10
                and (mx - mn) > 15
            )
            # 二次元浅肤 / 粉白脸
            skin_anime = (
                r > 170
                and g > 130
                and b > 120
                and r >= g - 5
                and abs(g - b) < 45
                and (mx - mn) > 8
            )
            if skin_real or skin_anime:
                xs.append(x)
                ys.append(y)
    if len(xs) < 10:
        return None
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    # 向上找发顶(深色块紧贴肤色上方)
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
    minx, miny = max(0, minx - pad), max(0, miny - pad)
    maxx, maxy = min(63, maxx + pad), min(63, maxy + pad)
    left = int(minx * w / 64)
    right = int((maxx + 1) * w / 64)
    top = int(miny * h / 64)
    bot = int((maxy + 1) * h / 64)
    if right - left < 8 or bot - top < 8:
        return None
    return left, top, right, bot


def _panel_content_metrics(
    img: Image.Image | bytes,
    *,
    bg_tol: int = 40,
    uniform_frac: float = 0.92,
) -> tuple[float, bool, float, float]:
    """返回 (area_ratio, is_postage_stamp, fill_h, fill_w)。"""
    if isinstance(img, (bytes, bytearray)):
        im = Image.open(BytesIO(img)).convert("RGB")
    else:
        im = img.convert("RGB")
    w, h = im.size
    if w < 8 or h < 8:
        return 0.0, True, 0.0, 0.0
    small = im.resize((64, 64), Image.Resampling.BOX)
    sw, sh = small.size
    px = list(small.getdata())

    def _pix(x: int, y: int) -> tuple[int, int, int]:
        return px[y * sw + x]

    corners = [_pix(1, 1), _pix(sw - 2, 1), _pix(1, sh - 2), _pix(sw - 2, sh - 2)]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    def _is_bg(r: int, g: int, b: int) -> bool:
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < bg_tol:
            return True
        if r > 235 and g > 235 and b > 235:
            return True
        return False

    def _row_bg_frac(y: int) -> float:
        return sum(1 for x in range(sw) if _is_bg(*_pix(x, y))) / float(sw)

    def _col_bg_frac(x: int) -> float:
        return sum(1 for y in range(sh) if _is_bg(*_pix(x, y))) / float(sh)

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
    area = float(max(0.0, min(1.0, (cw * ch) / float(sw * sh))))
    # 四边都有明显空边(~10%+) → 邮票缩水
    stamp = left >= 6 and right >= 6 and top >= 6 and bot >= 6
    fill_h = ch / float(sh)
    fill_w = cw / float(sw)
    return area, stamp, fill_h, fill_w


def panel_content_coverage(
    img: Image.Image | bytes,
    *,
    bg_tol: int = 40,
    uniform_frac: float = 0.92,
) -> float:
    """非背景内容占画面比例(0~1)。

    邮票缩水(四边垫边)→返回真实内容框面积比。
    非邮票且主轴铺满(真侧脸单侧留白)→抬到 >=0.90 以便过检。
    """
    area, stamp, fill_h, fill_w = _panel_content_metrics(
        img, bg_tol=bg_tol, uniform_frac=uniform_frac
    )
    if stamp:
        return area
    if fill_h >= 0.82 or fill_w >= 0.82:
        return float(max(area, 0.90))
    return area


def assert_panel_coverage(
    img: Image.Image | bytes,
    min_ratio: float = 0.90,
) -> float:
    """每格输出前检查。

    硬拦:邮票缩水(四边垫边)且内容框 < min_ratio。
    软过:非邮票侧脸单侧留白(主轴已铺满)视为达标。
    """
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    if stamp:
        if area + 1e-9 < float(min_ratio):
            raise CharacterSheetError(
                f"panel coverage {area:.3f} < {min_ratio:.2f} (shrunk/padded panel)",
                status_code=422,
            )
        return area
    # 非邮票:主轴铺满或面积尚可
    if fill_h >= 0.82 or fill_w >= 0.82 or area >= float(min_ratio):
        return float(max(area, 0.90 if (fill_h >= 0.82 or fill_w >= 0.82) else area))
    if area + 1e-9 < 0.50:
        raise CharacterSheetError(
            f"panel coverage {area:.3f} < 0.50 (empty/near-empty panel)",
            status_code=422,
        )
    # 面积 0.50–0.90 非邮票:仍要求达到 min_ratio(头肩应 cover 填满)
    if area + 1e-9 < float(min_ratio):
        raise CharacterSheetError(
            f"panel coverage {area:.3f} < {min_ratio:.2f} (shrunk/padded panel)",
            status_code=422,
        )
    return area


def enforce_head_shoulders_square(
    data: bytes,
    size: int = 768,
    *,
    skip_reframe: bool = False,
    max_upscale: float = 1.5,
    check_coverage: bool = True,
) -> bytes:
    """头肩正方形裁切(fix16):以**检测到的人脸框**为中心 cover 铺满。

    - 优先 insightface 人脸框;否则肤色/五官启发式(禁整前景,避免宽袖/汉服拉偏)。
    - 裁切轴=脸中心;上边含完整发顶/发髻(脸顶再留约 12–16% 格高);下边到锁骨下(≈脸高×2.0–2.2)。
    - 放大上限 max_upscale(默认 1.5):源脸过小则外扩取景;仍不足则 cover 填满(禁深色垫边缩水)。
    - skip_reframe=True:锁定格走同一 cover 填满(头顶方裁→铺满),禁止小图贴大空白。
    - check_coverage:输出前 assert_panel_coverage(>=0.90)。
    """
    import math

    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    if skip_reframe:
        # 锁定格:与生成格同一 cover 逻辑——取上部头肩方块后 LANCZOS 铺满目标格
        side = min(w, h)
        left = max(0, (w - side) // 2)
        top = max(0, (h - side) // 2)
        if h > w * 1.15:
            top = max(0, min(h - side, int(h * 0.02)))
        # 若有人脸,按脸中心/发顶~锁骨重取方裁(与生成格一致)
        face_bb = _insightface_face_bbox_xyxy(data)
        if face_bb is None:
            face_bb = _heuristic_skin_face_bbox(img)
        if face_bb is not None:
            fx1, fy1, fx2, fy2 = [float(v) for v in face_bb]
            fw = max(8.0, fx2 - fx1)
            fh = max(8.0, fy2 - fy1)
            fcx = (fx1 + fx2) / 2.0
            span_h = fh * 2.10
            span_w = max(fw * 1.55, span_h * 0.95)
            side2 = int(max(span_w, span_h, 64))
            side2 = min(side2, w, h)
            left = max(0, min(w - side2, int(round(fcx - side2 / 2.0))))
            top = max(0, min(h - side2, int(round(fy1 - 0.14 * side2))))
            if top + side2 > h:
                top = max(0, h - side2)
            side = side2
        crop = img.crop((left, top, left + side, top + side))
        # fix16:一律 cover 填满,禁止 (20,22,28) 深色垫边缩水
        crop = crop.resize((size, size), Image.Resampling.LANCZOS)
        buf = BytesIO()
        crop.save(buf, format="PNG")
        out = buf.getvalue()
        if check_coverage:
            assert_panel_coverage(out, min_ratio=0.90)
            assert_face_visible(out, min_face_area=0.04)
        return out

    face_bb = _insightface_face_bbox_xyxy(data)
    if face_bb is None:
        face_bb = _heuristic_skin_face_bbox(img)
    if face_bb is not None:
        fx1, fy1, fx2, fy2 = [float(v) for v in face_bb]
        fw = max(8.0, fx2 - fx1)
        fh = max(8.0, fy2 - fy1)
        fcx = (fx1 + fx2) / 2.0
        # 竖向:完整发顶/发髻 + 锁骨下(fix15 放宽,忌切髻)
        span_h = fh * 2.10
        span_w = max(fw * 1.55, span_h * 0.95)
        side = int(max(span_w, span_h))
        side = max(side, 64)
        # 放大上限:裁边至少 size/max_upscale,否则外扩取景而非硬放大
        min_side = int(math.ceil(float(size) / float(max_upscale)))
        if side < min_side:
            side = min(min_side, w, h)
        side = min(side, w, h)
        # 脸中心水平;竖直使脸顶约在裁切框 12% 处(发髻完整)
        left = int(round(fcx - side / 2.0))
        top = int(round(fy1 - 0.14 * side))
        left = max(0, min(w - side, left))
        top = max(0, min(h - side, top))
        if top + side > h:
            top = max(0, h - side)
        # 校验:脸中心仍在裁切框内(防侧脸只剩下巴/耳)
        if not (left + side * 0.12 <= fcx <= left + side * 0.88):
            left = max(0, min(w - side, int(round(fcx - side / 2.0))))
        if not (top + side * 0.04 <= fy1 <= top + side * 0.40):
            top = max(0, min(h - side, int(round(fy1 - 0.14 * side))))
    else:
        # 最后回退:上半身中心方裁(仍偏上,勿用全身前景)
        cx, cy = w // 2, int(h * 0.28)
        side = min(w, h, max(int(h * 0.52), int(w * 0.58)))
        min_side = int(math.ceil(float(size) / float(max_upscale)))
        if side < min_side:
            side = min(min_side, w, h)
        left = max(0, min(w - side, cx - side // 2))
        top = max(0, min(h - side, cy - side // 2))
    if top + side > h:
        top = max(0, h - side)
    crop = img.crop((left, top, left + side, top + side))
    # fix16:禁止深色/角点色垫边缩水;一律 cover 填满目标尺寸
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    out = buf.getvalue()
    if check_coverage:
        assert_panel_coverage(out, min_ratio=0.90)
        assert_face_visible(out, min_face_area=0.04)
    return out


def assert_face_visible(
    data: bytes,
    *,
    min_face_area: float = 0.04,
    face_key: str | None = None,
) -> tuple[float, float, float, float]:
    """锁定/输出前:格内必须有可检测人脸,且脸面积占比足够(拦下巴耳裁切)。

    返回人脸 bbox (x1,y1,x2,y2)。insightface 优先,启发式回退;都无则报错。
    """
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    bb = _insightface_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        raise CharacterSheetError(
            "panel face missing (no detectable face)",
            status_code=422,
        )
    x1, y1, x2, y2 = [float(v) for v in bb]
    fw = max(1.0, x2 - x1)
    fh = max(1.0, y2 - y1)
    area = (fw * fh) / float(max(1, w * h))
    if area + 1e-12 < float(min_face_area):
        raise CharacterSheetError(
            f"panel face area {area:.3f} < {min_face_area:.2f} (face cropped away)",
            status_code=422,
        )
    # 脸中心须在格内中部偏上,拦只剩耳/下巴贴边
    fcx = (x1 + x2) / 2.0
    fcy = (y1 + y2) / 2.0
    if not (0.12 * w <= fcx <= 0.88 * w) or not (0.08 * h <= fcy <= 0.72 * h):
        raise CharacterSheetError(
            "panel face off-center (chin/ear crop)",
            status_code=422,
        )
    # 侧脸允许更贴边,但仍要脸宽可见
    if face_key == "side" and fw / float(w) < 0.18:
        raise CharacterSheetError(
            "panel side face too narrow (face cropped)",
            status_code=422,
        )
    return (x1, y1, x2, y2)


def face_crop_looks_ok(data: bytes) -> bool:
    """目检启发式:禁半脸(顶缘裁掉额头或底缘贴下巴截断);允许头顶少量留白。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    small = img.resize((32, 32), Image.Resampling.BILINEAR)
    px = list(small.getdata())

    def _fg(r, g, b) -> bool:
        mx, mn = max(r, g, b), min(r, g, b)
        if r > 235 and g > 235 and b > 235:
            return False
        if mx - mn < 12 and 80 <= mx <= 210:
            return False
        return True

    # 只看中间竖带,忽略左右信箱白边
    def _band_fg(y0, y1):
        return sum(
            1
            for x in range(6, 26)
            for y in range(y0, y1)
            if _fg(*px[y * 32 + x])
        )

    top_fg = _band_fg(0, 5)
    bot_fg = _band_fg(27, 32)
    mid_fg = _band_fg(8, 24)
    # 顶缘几乎全被裁掉(头发顶贴边过猛且中带很少) → 半脸
    if top_fg >= 90 and mid_fg < 40:
        return False
    # 中带几乎无前景
    if mid_fg < 25:
        return False
    # 底缘贴满且顶缘也贴满 → 极端特写裁掉额/下可能
    if bot_fg >= 85 and top_fg >= 85 and mid_fg > 120:
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
                root = os.environ.get("INSIGHTFACE_HOME") or os.path.expanduser(
                    "~/.insightface"
                )
                app = FaceAnalysis(
                    name="buffalo_l",
                    providers=["CPUExecutionProvider"],
                    root=root,
                )
                app.prepare(ctx_id=-1, det_size=(640, 640))
                _YAW_FACE_APP = app
            faces = app.get(bgr)
            if faces:
                f = sorted(
                    faces,
                    key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]),
                    reverse=True,
                )[0]
                pose = getattr(f, "pose", None)
                if pose is not None and len(pose) >= 2:
                    return float(abs(pose[1]))
                kps = getattr(f, "kps", None)
                bbox = getattr(f, "bbox", None)
                if kps is not None and len(kps) >= 3:
                    le, re, nose = kps[0], kps[1], kps[2]
                    mid_x = (float(le[0]) + float(re[0])) / 2.0
                    eye_w = abs(float(re[0]) - float(le[0])) + 1e-3
                    off = (float(nose[0]) - mid_x) / eye_w
                    yaw = min(90.0, abs(off) * 80.0)
                    if bbox is not None:
                        face_w = max(1.0, float(bbox[2] - bbox[0]))
                        if eye_w / face_w < 0.12:
                            yaw = max(yaw, 82.0)
                        elif eye_w / face_w < 0.22:
                            yaw = max(yaw, 48.0)
                    return float(yaw)
    except Exception:  # noqa: BLE001
        pass

    img = Image.open(BytesIO(data)).convert("RGB")
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    left_m = right_m = mass_x = mass = 0.0
    for y in range(8, 48):
        for x in range(64):
            r, g, b = px[y * 64 + x]
            mx, mn = max(r, g, b), min(r, g, b)
            if r > 230 and g > 230 and b > 230:
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


def yaw_ok_for_face_key(
    yaw: float | None,
    face_key: str,
    *,
    style: str | None = None,
) -> bool:
    """偏航门禁。

    二次元 insightface 对 cel 脸系统性偏低（目检约 35–45° 常被估成 ~24°），
    故 anime/二次元 的三分脸放宽为 20–60；写实仍为 30–60。正/侧不变。
    """
    if yaw is None:
        return False
    y = abs(float(yaw))
    st = (style or "").strip().lower()
    anime = st in {"anime", "二次元", "cel", "cartoon"}
    if face_key == "face_front":
        return y < 15.0
    if face_key == "face_three_quarter":
        lo = 20.0 if anime else 30.0
        return lo <= y <= 60.0
    if face_key == "face_side":
        return 75.0 <= y <= 105.0
    return False


def _pick_best_face_with_yaw(cands: list[bytes], face_key: str) -> tuple[bytes, dict]:
    scored: list[tuple[float, float | None, float, bytes]] = []
    for b in cands:
        yaw = estimate_face_yaw_deg(b)
        ang = _score_face_angle_candidate(b, face_key)
        ok = yaw_ok_for_face_key(yaw, face_key)
        joint = ang + (40.0 if ok else -25.0)
        # 目检优先于纯 yaw:半脸/去额去下巴重罚
        if face_crop_looks_ok(b):
            joint += 35.0
        else:
            joint -= 55.0
        if yaw is not None:
            target = {
                "face_front": 0.0,
                "face_three_quarter": 42.0,  # fix15: 偏好 35–50°
                "face_side": 90.0,
            }.get(face_key, 0.0)
            joint -= abs(abs(yaw) - target) * 0.35
        scored.append((joint, yaw, ang, b))
    scored.sort(key=lambda t: t[0], reverse=True)
    passed = [t for t in scored if yaw_ok_for_face_key(t[1], face_key)]
    if passed:
        best = passed[0]
        return best[3], {
            "yaw": best[1],
            "angle_score": best[2],
            "joint": best[0],
            "yaw_ok": True,
            "n": len(cands),
            "n_pass": len(passed),
        }
    target = {
        "face_front": 0.0,
        "face_three_quarter": 42.0,  # fix15: 偏好 35–50°
        "face_side": 90.0,
    }.get(face_key, 0.0)
    scored.sort(
        key=lambda t: (
            abs((abs(t[1]) if t[1] is not None else 999.0) - target),
            -t[0],
        )
    )
    best = scored[0]
    return best[3], {
        "yaw": best[1],
        "angle_score": best[2],
        "joint": best[0],
        "yaw_ok": False,
        "n": len(cands),
        "n_pass": 0,
    }




async def _wait_images(client: Any, prompt_id: str) -> list[dict]:
    waited = 0.0
    from app.comfy.client import ComfyUIError

    while waited < _POLL_TIMEOUT:
        try:
            images = await client.get_images(prompt_id)
        except ComfyUIError:
            images = []
        if images:
            return images
        await asyncio.sleep(_POLL_INTERVAL)
        waited += _POLL_INTERVAL
    raise CharacterSheetError(f"出图超时({_POLL_TIMEOUT:.0f}s)", status_code=504)


def _panel_size(key: str, style: str) -> tuple[int, int]:
    """按风格与面板类型选分辨率(SDXL anime 用更高档)。"""
    sdxl = style == "anime"
    if key.startswith("expr_"):
        return (768, 768) if sdxl else (512, 512)
    if key == "costume":
        return (1024, 768) if sdxl else (768, 512)
    if key == "faces":
        return (1024, 640) if sdxl else (768, 512)
    # portrait / turnaround
    return (832, 1216) if sdxl else (768, 1024)


def _build_sheet_graph(
    prompt: str,
    *,
    ckpt_name: str,
    width: int,
    height: int,
    seed: int | None,
    filename_prefix: str,
    style: str,
    negative: str | None = None,
) -> tuple[dict, set[str]]:
    from app.workflows.model_profiles import is_nextgen, nextgen_recipe, profile_for
    from app.workflows.nextgen import NextgenParams, build_nextgen_graph
    from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

    neg = negative or _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
    pl = prompt.lower()
    if (
        "product still life" in pl
        or "product shot" in pl
        or "rain boots" in pl
        or "flat lay" in pl
    ):
        neg = (
            neg
            + ", person, face, body, human, model, mannequin, wearing clothes, "
            "legs, feet, silhouette, bodysuit, tight suit"
        )
    if (
        "trousers" in pl
        or "long pants" in pl
        or "pant legs" in pl
        or ("pants" in pl and "product" in pl)
    ):
        neg = neg + ", " + _COSTUME_ITEM_NEGATIVE["pants"]
    if "rain boots" in pl or ("boots" in pl and "product" in pl):
        neg = neg + ", " + _COSTUME_ITEM_NEGATIVE["boots"]
    if "head and shoulders" in pl or "extreme face closeup" in pl:
        neg = (
            neg
            + ", full body, half body, standing pose, waist, legs, "
            "chinese text, caption, subtitle, label on image"
        )
    if is_nextgen(ckpt_name):
        prof = profile_for(ckpt_name)
        recipe = nextgen_recipe(ckpt_name)
        kw: dict[str, Any] = dict(
            model_name=ckpt_name,
            positive=prompt,
            negative=neg if getattr(prof, "neg_prompt", True) else "",
            width=width,
            height=height,
            steps=getattr(prof, "steps", 20),
            cfg=getattr(prof, "cfg", 3.5),
            sampler=getattr(prof, "sampler", "euler"),
            scheduler=getattr(prof, "scheduler", "simple"),
            batch_size=1,
            filename_prefix=filename_prefix,
        )
        if seed is not None:
            kw["seed"] = seed
        graph = build_nextgen_graph(NextgenParams(**kw))
        required = {ckpt_name}
        if recipe is not None:
            for attr in ("clip_name", "vae_name", "unet_name"):
                v = getattr(recipe, attr, None)
                if v:
                    required.add(v)
        return graph, required

    params_kw: dict = dict(
        positive=prompt,
        negative=neg,
        ckpt_name=ckpt_name,
        width=width,
        height=height,
        filename_prefix=filename_prefix,
        steps=28 if style == "anime" else 22,
        cfg=6.0 if style == "anime" else 7.0,
    )
    if seed is not None:
        params_kw["seed"] = seed
    return build_txt2img_graph(Txt2ImgParams(**params_kw)), {ckpt_name}


def _build_ipa_graph(
    prompt: str,
    *,
    ref_image: str,
    ckpt_name: str,
    width: int,
    height: int,
    seed: int | None,
    filename_prefix: str,
    style: str,
) -> dict:
    from app.workflows.ipadapter import IPAdapterTxt2ImgParams, build_ipadapter_txt2img_graph

    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
    kw: dict[str, Any] = dict(
        positive=prompt,
        ref_image=ref_image,
        negative=neg,
        ckpt_name=ckpt_name,
        width=width,
        height=height,
        filename_prefix=filename_prefix,
        weight=0.85,
        steps=28 if style == "anime" else 22,
        cfg=6.0 if style == "anime" else 7.0,
        preset="PLUS FACE (portraits)",
    )
    if seed is not None:
        kw["seed"] = seed
    return build_ipadapter_txt2img_graph(IPAdapterTxt2ImgParams(**kw))


def _build_img2img_graph(
    prompt: str,
    *,
    image_name: str,
    ckpt_name: str,
    seed: int | None,
    filename_prefix: str,
    style: str,
    denoise: float = 0.62,
    negative_extra: str = "",
) -> dict:
    from app.workflows.img2img import Img2ImgParams, build_img2img_graph

    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
    if negative_extra:
        neg = f"{neg}, {negative_extra}"
    pl = prompt.lower()
    # costume / 单品额外负向:禁止真人穿着与人体靴
    if (
        "flat lay" in pl
        or "garments laid flat" in pl
        or "product still life" in pl
        or "product shot" in pl
        or "rain boots" in pl
    ):
        neg = (
            neg
            + ", person, face, body, human, wearing clothes, model, mannequin, "
            "full body portrait, legs, feet, silhouette, bodysuit, tight suit"
        )
    if "expr" in pl or "closeup" in pl or "head and shoulders" in pl:
        neg = (
            neg
            + ", full body, half body, standing pose, waist up wide, legs, "
            "hands holding props, chinese text, caption, subtitle, label"
        )
    kw: dict[str, Any] = dict(
        positive=prompt,
        image=image_name,
        negative=neg,
        ckpt_name=ckpt_name,
        denoise=denoise,
        filename_prefix=filename_prefix,
        steps=28 if style == "anime" else 22,
        cfg=6.5 if style == "anime" else 7.0,
    )
    if seed is not None:
        kw["seed"] = seed
    return build_img2img_graph(Img2ImgParams(**kw))


def _assert_sheet_worker_allowed(url: str) -> None:
    port = urlsplit(url).port
    if port in _FORBIDDEN_WORKER_PORTS or port not in _SHEET_ALLOWED_PORTS:
        raise CharacterSheetError(
            f"禁止使用端口 :{port},设定卡仅允许 :8262/:8264",
            status_code=400,
        )


async def _pick_sheet_client(worker: str | None = None) -> Any:
    """仅从 :8262/:8264 取客户端;禁止 pool/:8195/:8196/:8197/:8205/:8261/:8263。"""
    from app.comfy.client import ComfyUIClient, ComfyUIError
    from app.config import get_settings
    from app.services.video_upscale import healthy_upscale_workers, upscale_worker_urls

    settings = get_settings()
    timeout = settings.request_timeout

    if worker:
        u = worker.rstrip("/")
        _assert_sheet_worker_allowed(u)
        allowed = set(upscale_worker_urls())
        # 兼容 Tailscale / 内网同机
        if u not in allowed:
            port = urlsplit(u).port
            if port not in _SHEET_ALLOWED_PORTS:
                raise CharacterSheetError(
                    f"worker 不在设定卡允许列表(:8262/:8264):{u}",
                    status_code=400,
                )
        return ComfyUIClient(u, timeout=timeout)

    urls = await healthy_upscale_workers()
    # 过滤禁端口并优先空闲 VRAM 较多的高端口
    safe = []
    for u in urls:
        try:
            _assert_sheet_worker_allowed(u)
            safe.append(u)
        except CharacterSheetError:
            continue
    if not safe:
        # 配置可能是 192.168.71.127,再试 100.68.100.90 映射
        remapped = []
        for u in upscale_worker_urls():
            p = urlsplit(u)
            if p.port not in _SHEET_ALLOWED_PORTS:
                continue
            for host in ("100.68.100.90", "192.168.71.127"):
                cand = f"{p.scheme}://{host}:{p.port}"
                remapped.append(cand)
        # 去重保序
        seen: set[str] = set()
        uniq = []
        for c in remapped:
            if c not in seen:
                seen.add(c)
                uniq.append(c)
        safe = await healthy_upscale_workers(uniq)
    if not safe:
        raise CharacterSheetError(
            "出图 fleet :8262/:8264 不可用", status_code=503
        )
    # 优先 8262(超分/文生图),其次 8264(H3 gpu1)
    def _rank(u: str) -> int:
        port = urlsplit(u).port or 0
        return {8262: 0, 8264: 1}.get(port, 9)

    safe.sort(key=_rank)
    try:
        client = ComfyUIClient(safe[0], timeout=timeout)
        await client.get_system_stats()
        return client
    except ComfyUIError as e:
        raise CharacterSheetError(f"出图后端不可用:{e}", status_code=503) from e


async def generate_panel_bytes(
    pool: "WorkerPool",
    prompt: str,
    *,
    ckpt_name: str,
    width: int = 768,
    height: int = 1024,
    seed: int | None = None,
    worker: str | None = None,
    filename_prefix: str = "ToIV_char_sheet",
    style: str = "anime",
    client: Any | None = None,
    ref_image: str | None = None,
    ref_mode: str = "auto",
    denoise: float = 0.62,
    negative_extra: str = "",
) -> bytes:
    """单格出图 → PNG bytes。

    ref_mode: auto|ipa|img2img|none
      - anime 默认 img2img(规避 hassaku/IPA glitch)
      - ancient 默认 ipa
    注意:忽略 pool.pick,强制 :8262/:8264。
    """
    del pool  # 设定卡不走通用 WorkerPool
    from app.comfy.client import ComfyUIError

    cli = client or await _pick_sheet_client(worker)
    mode = ref_mode
    if mode == "auto":
        if not ref_image:
            mode = "none"
        elif style == "anime":
            mode = "img2img"
        else:
            mode = "ipa"
    try:
        if ref_image and mode == "img2img":
            graph = _build_img2img_graph(
                prompt,
                image_name=ref_image,
                ckpt_name=ckpt_name,
                seed=seed,
                filename_prefix=filename_prefix,
                style=style,
                denoise=denoise,
                negative_extra=negative_extra,
            )
        elif ref_image and mode == "ipa":
            graph = _build_ipa_graph(
                prompt,
                ref_image=ref_image,
                ckpt_name=ckpt_name,
                width=width,
                height=height,
                seed=seed,
                filename_prefix=filename_prefix,
                style=style,
            )
        else:
            graph, _required = _build_sheet_graph(
                prompt,
                ckpt_name=ckpt_name,
                width=width,
                height=height,
                seed=seed,
                filename_prefix=filename_prefix,
                style=style,
            )
        if negative_extra:
            # 追加角度负向到 CLIP 负向节点(常见 id 7)
            for nid, node in list(graph.items()):
                if not isinstance(node, dict):
                    continue
                if node.get("class_type") == "CLIPTextEncode":
                    inputs = node.get("inputs") or {}
                    # 负向通常 text 含 ugly/bad;保守:两端都可追加时只改已含 ugly 的
                    t = str(inputs.get("text") or "")
                    if "ugly" in t.lower() or "bad" in t.lower() or "worst" in t.lower():
                        inputs["text"] = f"{t}, {negative_extra}"
        prompt_id = await cli.queue_prompt(graph, client_id=uuid.uuid4().hex)
    except ComfyUIError as e:
        raise CharacterSheetError(f"出图后端不可用:{e}", status_code=503) from e
    except CharacterSheetError:
        raise
    except Exception as e:  # noqa: BLE001
        raise CharacterSheetError(f"出图提交失败:{e}", status_code=503) from e

    images = await _wait_images(cli, prompt_id)
    img = images[0]
    try:
        data, _ = await cli.get_image_bytes(
            img["filename"], img.get("subfolder", ""), img.get("type", "output")
        )
    except ComfyUIError as e:
        raise CharacterSheetError(f"取图失败:{e}", status_code=502) from e
    return data


async def load_image_bytes_from_url(url: str) -> bytes | None:
    from app.storage import drama_output_root

    u = (url or "").strip()
    if not u:
        return None
    marker = "/api/studio/files/"
    if marker in u:
        name = u.split(marker, 1)[-1].split("?", 1)[0]
        if "/" in name or name.startswith("."):
            return None
        path = drama_output_root() / "studio" / name
        if path.is_file():
            return path.read_bytes()
    try:
        import httpx

        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(
                u if u.startswith("http") else f"http://127.0.0.1:8090{u}"
            )
            ctype = r.headers.get("content-type", "")
            if r.status_code == 200 and (
                r.content[:4] == b"\x89PNG" or ctype.startswith("image/")
            ):
                return r.content
    except Exception:  # noqa: BLE001
        logger.warning("设定卡:拉取参考图失败 url=%s", u[:120])
    return None


async def generate_character_sheet(
    *,
    character_id: str,
    meta: SheetMeta,
    pool: "WorkerPool",
    ckpt_name: str | None = None,
    worker: str | None = None,
    seed: int | None = None,
    panels_override: dict[str, bytes] | None = None,
    reuse_ref_urls: list[str] | None = None,
    allow_reuse_refs: bool = False,
) -> tuple[str, bytes, dict[str, str]]:
    """出齐分格 → 拼版 → 落盘。返回 (sheet_url, png_bytes, panel_urls)。

    allow_reuse_refs 默认 False(17:45 纠偏#2:禁止复用旧 sample 三视图)。
    reuse_ref_urls 仅在 allow_reuse_refs=True 时生效。
    """
    if not (meta.name or "").strip():
        raise CharacterSheetError("角色名为空", status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(
            f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422
        )
    resolve_cjk_font(24)
    # 补设计说明
    meta.design_notes = build_design_notes(meta)

    prompts = build_panel_prompts(meta)
    panels: dict[str, bytes] = dict(panels_override or {})
    panel_urls: dict[str, str] = {}

    # 默认关闭复用;显式打开才吃旧三视图
    if allow_reuse_refs and reuse_ref_urls:
        views = [u for u in reuse_ref_urls if u and not is_sheet_url(u)]
        slot_map = ("front", "side", "back")
        for i, key in enumerate(slot_map):
            if key in panels or i >= len(views):
                continue
            data = await load_image_bytes_from_url(views[i])
            if data:
                panels[key] = data
        if "portrait" not in panels and views:
            data = await load_image_bytes_from_url(views[0])
            if data:
                panels["portrait"] = data

    ckpt = ckpt_name or _SHEET_CKPT.get(meta.style, _SHEET_CKPT["anime"])
    client = await _pick_sheet_client(worker)

    # 1) 主立绘(无参考)
    if "portrait" not in panels:
        w, h = _panel_size("portrait", meta.style)
        panels["portrait"] = await generate_panel_bytes(
            pool,
            prompts["portrait"],
            ckpt_name=ckpt,
            width=w,
            height=h,
            seed=seed,
            worker=worker,
            filename_prefix="ToIV_char_sheet_portrait",
            style=meta.style,
            client=client,
        )
    panel_urls["portrait"] = save_panel_png(
        panels["portrait"],
        character_id=character_id,
        style=meta.style,
        key="portrait",
    )

    # 2) 上传立绘作 IPAdapter 参考
    ref_name: str | None = None
    face_ref_name: str | None = None
    try:
        ref_name = await client.upload_image(
            panels["portrait"],
            f"sheet_ref_{character_id[:8]}_{meta.style}.png",
        )
        face_bytes = crop_face_ref(panels["portrait"])
        face_ref_name = await client.upload_image(
            face_bytes,
            f"sheet_face_{character_id[:8]}_{meta.style}.png",
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("设定卡:上传立绘/脸参考失败,后续退回 txt2img: %s", e)
        ref_name = ref_name  # may be set

    # 3) 其余面板(三视图/脸/服饰/6 表情)
    need_keys = list(_PANEL_KEYS) + list(_EXPR_KEYS)
    for key in need_keys:
        if key == "portrait" or key in panels:
            continue
        if key == "costume":
            panels["costume"] = await _generate_costume_collage(
                pool,
                meta=meta,
                ckpt=ckpt,
                worker=worker,
                client=client,
                seed=seed,
            )
            continue
        w, h = _panel_size(key, meta.style)
        use_ref = None
        ref_mode = "none"
        denoise = 0.62
        if key in ("front", "side", "back"):
            use_op, _why = await _probe_openpose_available(client)
            if use_op and ref_name:
                assets = ensure_openpose_assets(height_cm=meta.height_cm or 165)
                pose_name = await client.upload_image(
                    assets[key].read_bytes(),
                    f"sheet_pose_{character_id[:8]}_{key}.png",
                )
                panels[key] = await generate_panel_bytes_openpose(
                    pool,
                    prompts[key],
                    pose_image_name=pose_name,
                    ckpt_name=ckpt,
                    width=w,
                    height=h,
                    seed=None if seed is None else seed + (abs(hash(key)) % 10000),
                    worker=worker,
                    filename_prefix=f"ToIV_char_sheet_{key}_pose",
                    style=meta.style,
                    client=client,
                    ref_image=ref_name,
                    skip_preprocess=True,
                )
                panels[key] = normalize_turnaround_figure(panels[key], out_w=w, out_h=h)
                panel_urls[key] = save_panel_png(
                    panels[key], character_id=character_id, style=meta.style, key=key
                )
                continue
            if ref_name:
                use_ref = ref_name
                # 15:12：三视图必须以主立绘为参考锁同款同色；anime 用 img2img 强锁服装
                if meta.style in ("anime", "二次元"):
                    ref_mode = "img2img"
                    denoise = 0.52
                else:
                    ref_mode = "ipa"
                    denoise = 0.65
        elif key == "faces":
            face = face_ref_name or ref_name
            tri: dict[str, bytes] = {}
            use_op, _why = await _probe_openpose_available(client)
            face_assets = ensure_openpose_face_assets() if use_op else {}
            for fk in ("face_front", "face_three_quarter", "face_side"):
                ang_neg = _FACE_ANGLE_NEGATIVE.get(fk, "")
                if use_op and fk in face_assets and face:
                    # 角度靠头肩骨架;身份靠 IPA;禁止正脸 img2img 锁死姿态
                    pose_name = await client.upload_image(
                        face_assets[fk].read_bytes(),
                        f"sheet_face_pose_{character_id[:8]}_{fk}.png",
                    )
                    if fk == "face_front":
                        cn_s, ipa_w, ipa_st = 0.88, 0.72, 0.0
                    elif fk == "face_three_quarter":
                        cn_s, ipa_w, ipa_st = 0.96, 0.48, 0.20
                    else:
                        cn_s, ipa_w, ipa_st = 0.98, 0.38, 0.30
                    fd = await generate_panel_bytes_openpose(
                        pool,
                        prompts[fk],
                        pose_image_name=pose_name,
                        ckpt_name=ckpt,
                        width=768,
                        height=768,
                        seed=None if seed is None else seed + (abs(hash(fk)) % 10000),
                        worker=worker,
                        filename_prefix=f"ToIV_char_sheet_{fk}_pose",
                        style=meta.style,
                        client=client,
                        ref_image=face,
                        skip_preprocess=True,
                        strength=cn_s,
                        ipa_weight=ipa_w,
                        ipa_start=ipa_st,
                        ipa_end=1.0,
                        negative_extra=ang_neg,
                    )
                else:
                    # 回退:侧/3-4 用 IPA(不锁姿态);正面可 img2img
                    if fk == "face_front" and meta.style == "anime" and face:
                        mode, den = "img2img", 0.58
                    else:
                        mode, den = ("ipa" if face else "none"), 0.90
                    fd = await generate_panel_bytes(
                        pool,
                        prompts[fk],
                        ckpt_name=ckpt,
                        width=768,
                        height=768,
                        seed=None if seed is None else seed + (abs(hash(fk)) % 10000),
                        worker=worker,
                        filename_prefix=f"ToIV_char_sheet_{fk}",
                        style=meta.style,
                        client=client,
                        ref_image=face,
                        ref_mode=mode,
                        denoise=den,
                        negative_extra=ang_neg,
                    )
                tri[fk] = enforce_head_shoulders_square(fd, size=768)
            # 单候选也过 yaw 记录(多候选在 regenerate / fix11 脚本)
            for fk in list(tri.keys()):
                _y = estimate_face_yaw_deg(tri[fk])
                logger.info("faces %s yaw=%s ok=%s", fk, _y, yaw_ok_for_face_key(_y, fk))
            panels["faces"] = compose_faces_triptych(
                tri, style=meta.style, size=_panel_size("faces", meta.style)
            )
            continue
        elif key.startswith("expr_"):
            # 表情:紧裁头肩 img2img;denoise 提高以拉开表情差异(禁半身站姿)
            face = face_ref_name or ref_name
            if face:
                use_ref = face
                ref_mode = "img2img" if meta.style == "anime" else "ipa"
                denoise = 0.68
            else:
                use_ref = None
                ref_mode = "none"
        panels[key] = await generate_panel_bytes(
            pool,
            prompts[key],
            ckpt_name=ckpt,
            width=w,
            height=h,
            seed=None if seed is None else seed + (abs(hash(key)) % 10000),
            worker=worker,
            filename_prefix=f"ToIV_char_sheet_{key}",
            style=meta.style,
            client=client,
            ref_image=use_ref,
            ref_mode=ref_mode,
            denoise=denoise,
        )
        if key.startswith("expr_"):
            panels[key] = enforce_head_shoulders_square(panels[key], size=768)
        if key in ("front", "side", "back"):
            panels[key] = normalize_turnaround_figure(panels[key], out_w=w, out_h=h)
            panel_urls[key] = save_panel_png(
                panels[key],
                character_id=character_id,
                style=meta.style,
                key=key,
            )

    # 13:16②：拼版前一致性门禁（主立绘↔三视图主色 + 贴标）
    assert_sheet_garment_consistency(panels, style=meta.style)
    # anime：强制色板 garment 主色含板岩灰优先
    if meta.style in ("anime", "二次元") and not meta.colors:
        meta.colors = ["#E8C4A8", "#5A6A7A", "#D4D3D8", "#C98A7A", "#2C2C34", "#1A1A1E"]
    png = compose_character_sheet(panels, meta)
    url = save_sheet_png(png, character_id=character_id, style=meta.style)
    return url, png, panel_urls


def _panel_is_blank_or_glitch(data: bytes) -> bool:
    """简单启发式:空白/花屏则 True。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:  # noqa: BLE001
        return True
    img = img.resize((64, 64), Image.Resampling.BILINEAR)
    pixels = list(img.getdata())
    if not pixels:
        return True
    n = len(pixels)
    mean = tuple(sum(c[i] for c in pixels) / n for i in range(3))
    var = sum(sum((c[i] - mean[i]) ** 2 for i in range(3)) for c in pixels) / n
    # 近纯色 / 极低对比
    if var < 80:
        return True
    # 花屏:邻像素 RGB 通道剧烈抖动
    zig = 0
    for i in range(1, n):
        zig += sum(abs(pixels[i][j] - pixels[i - 1][j]) for j in range(3))
    zig /= n
    if zig > 90 and var > 8000:
        return True
    return False


def _score_expression_head_ratio(data: bytes) -> float:
    """表情格启发式:上半部脸/肤色占比越高越好;鼓励头肩特写(目标≥0.40)。"""
    if _panel_is_blank_or_glitch(data):
        return -1e9
    img = Image.open(BytesIO(data)).convert("RGB")
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = small.size
    face = 0
    total = 0
    # 统计偏上 70% 区域的肤色/亮部脸块
    for y in range(int(sh * 0.05), int(sh * 0.70)):
        for x in range(int(sw * 0.15), int(sw * 0.85)):
            total += 1
            r, g, b = px[y * sw + x]
            if r > 80 and g > 55 and b > 45 and r >= g - 20:
                face += 1
            elif abs(r - g) < 25 and abs(g - b) < 25 and 40 < r < 220:
                # anime 平涂脸
                face += 0.6
    ratio = face / max(1, total)
    # 惩罚下半身迹象:底部 25% 出现大量深色衣/腿结构且上部脸少
    bottom_dark = 0
    bt = 0
    for y in range(int(sh * 0.75), sh):
        for x in range(sw):
            bt += 1
            r, g, b = px[y * sw + x]
            if r < 60 and g < 60 and b < 70:
                bottom_dark += 1
    dark_ratio = bottom_dark / max(1, bt)
    score = ratio * 100.0
    if ratio < 0.40:
        score -= (0.40 - ratio) * 120.0
    if dark_ratio > 0.35 and ratio < 0.45:
        score -= 25.0  # 半身站姿常见:下半大块黑衣
    return score


def _score_turnaround_candidate(data: bytes, key: str) -> float:
    """分数越高越好;side/back 优先非正脸;back 严惩「无脸正面/空白脸椭圆」。"""
    if _panel_is_blank_or_glitch(data):
        return -1e9
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    small = img.resize((48, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = small.size
    left = [px[y * sw + x] for y in range(sh) for x in range(sw // 2)]
    right = [px[y * sw + x] for y in range(sh) for x in range(sw // 2, sw)]
    def _mean(cells):
        n = max(1, len(cells))
        return tuple(sum(c[i] for c in cells) / n for i in range(3))
    ml, mr = _mean(left), _mean(right)
    asym = sum(abs(ml[i] - mr[i]) for i in range(3))
    face_score = 0.0
    blank_face = 0.0
    hair_dark = 0.0
    head_cells = 0
    for y in range(int(sh * 0.08), int(sh * 0.42)):
        for x in range(int(sw * 0.28), int(sw * 0.72)):
            head_cells += 1
            r, g, b = px[y * sw + x]
            if r > 90 and g > 70 and b > 60 and r >= g - 10:
                face_score += 1.0
            # 空白椭圆脸(二次元常见假背影)
            if r > 210 and g > 210 and b > 210 and abs(r - g) < 18 and abs(g - b) < 18:
                blank_face += 1.0
            if r + g + b < 140 and max(r, g, b) - min(r, g, b) < 40:
                hair_dark += 1.0
    face_score /= max(1, sw * sh)
    blank_ratio = blank_face / max(1, head_cells)
    hair_ratio = hair_dark / max(1, head_cells)
    score = 100.0 - (face_score * 200.0 if key in ("side", "back") else 0.0)
    if key in ("side", "back"):
        score += asym * 0.8
    else:
        score += face_score * 50.0
    if key == "back":
        # 真背影:后脑头发应占上半中心;空白脸/正脸肤色重罚
        score -= blank_ratio * 180.0
        score += hair_ratio * 60.0
        score -= face_score * 120.0
    score += 10.0
    return score


def _score_face_angle_candidate(data: bytes, face_key: str) -> float:
    """面部三格角度启发式:front 奖励对称;3/4 奖励中等不对称;side 奖励强侧影。"""
    if _panel_is_blank_or_glitch(data):
        return -1e9
    img = Image.open(BytesIO(data)).convert("RGB")
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = 64, 64
    left = [px[y * sw + x] for y in range(int(sh * 0.15), int(sh * 0.70)) for x in range(8, 32)]
    right = [px[y * sw + x] for y in range(int(sh * 0.15), int(sh * 0.70)) for x in range(32, 56)]

    def _mean(cells: list) -> tuple[float, float, float]:
        n = max(1, len(cells))
        return tuple(sum(c[i] for c in cells) / n for i in range(3))  # type: ignore[return-value]

    ml, mr = _mean(left), _mean(right)
    asym = sum(abs(ml[i] - mr[i]) for i in range(3))
    # 中心脸块(正脸高);侧脸时中心常偏暗或偏一侧
    center_face = 0.0
    ct = 0
    for y in range(int(sh * 0.20), int(sh * 0.62)):
        for x in range(int(sw * 0.32), int(sw * 0.68)):
            ct += 1
            r, g, b = px[y * sw + x]
            if r > 85 and g > 60 and b > 50 and r >= g - 15:
                center_face += 1.0
            elif abs(r - g) < 28 and abs(g - b) < 28 and 45 < r < 220:
                center_face += 0.55
    center_ratio = center_face / max(1, ct)
    # 鼻尖/轮廓偏置:侧脸前景质量心偏一侧
    mass_x = 0.0
    mass = 0.0
    for y in range(int(sh * 0.18), int(sh * 0.68)):
        for x in range(sw):
            r, g, b = px[y * sw + x]
            if r > 230 and g > 230 and b > 230:
                continue
            if abs(r - g) < 12 and abs(g - b) < 12 and 160 <= r <= 230:
                continue
            mass_x += x
            mass += 1.0
    cx = (mass_x / mass) if mass > 10 else 32.0
    offset = abs(cx - 32.0)
    head = _score_expression_head_ratio(data)
    score = head * 0.35
    if face_key == "face_front":
        score += (1.0 - min(1.0, asym / 40.0)) * 40.0
        score += center_ratio * 50.0
        score -= offset * 1.2
    elif face_key == "face_three_quarter":
        # 要可见不对称,但别到纯侧影
        if 8.0 <= asym <= 45.0:
            score += 35.0
        else:
            score -= abs(asym - 22.0) * 0.8
        if 4.0 <= offset <= 14.0:
            score += 25.0
        else:
            score -= abs(offset - 8.0) * 1.5
        score += center_ratio * 20.0
    else:  # face_side
        score += min(55.0, asym * 1.4)
        score += min(30.0, offset * 2.2)
        score -= center_ratio * 35.0  # 正脸中心块过大则扣
        if asym < 10:
            score -= 40.0
        if offset < 3:
            score -= 25.0
        # 惩罚大块纯白圆标/抽象图案(侧脸变成罩子 logo)
        white_blob = 0
        for y in range(int(sh * 0.15), int(sh * 0.70)):
            for x in range(int(sw * 0.20), int(sw * 0.80)):
                r, g, b = px[y * sw + x]
                if r > 230 and g > 230 and b > 230:
                    white_blob += 1
        if white_blob > 180:
            score -= 50.0
        if white_blob > 280:
            score -= 40.0
    return score


def _pick_best_candidate(cands: list[bytes], key: str) -> bytes:
    if not cands:
        raise CharacterSheetError(f"无候选:{key}", status_code=500)
    if key in ("front", "side", "back"):
        ranked = sorted(
            cands, key=lambda b: _score_turnaround_candidate(b, key), reverse=True
        )
        return ranked[0]
    if key.startswith("face_"):
        ranked = sorted(
            cands, key=lambda b: _score_face_angle_candidate(b, key), reverse=True
        )
        return ranked[0]
    if key.startswith("expr_"):
        ranked = sorted(
            cands, key=lambda b: _score_expression_head_ratio(b), reverse=True
        )
        return ranked[0]
    # 其它/服饰单品:过滤花屏空白;按单品键精细惩罚
    item_key = key.split("costume_", 1)[-1] if key.startswith("costume_") else ""
    ranked = sorted(
        cands,
        key=lambda b: (
            0 if _panel_is_blank_or_glitch(b) else 1,
            -(_costume_item_penalty(b, item_key) if item_key else 0.0),
        ),
        reverse=True,
    )
    # 裤/靴:优先剔除多件(blob≥4);若全军覆没仍取惩罚最低者
    if item_key in ("pants", "boots") and ranked:
        ok = []
        for b in ranked:
            img = Image.open(BytesIO(b)).convert("RGB").resize((64, 64))
            blobs = _count_dark_blobs(list(img.getdata()))
            if blobs <= (2 if item_key == "boots" else 3):
                ok.append(b)
        if ok:
            return ok[0]
    return ranked[0]


def costume_cell_content_ratios(costume_png: bytes, n: int = 5) -> list[float]:
    """服饰栏每格前景像素占比。白底不计；细灰条不计；近黑仅当整格几乎全黑时当空底。"""
    im = Image.open(BytesIO(costume_png)).convert("RGB")
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
            if r > 230 and g > 230 and b > 230:
                continue
            if abs(r - g) < 8 and abs(g - b) < 8 and 140 < r < 210:
                continue
            if r < 28 and g < 28 and b < 32:
                near_black += 1
                continue
            fg += 1
        # 整格近黑空底 → 0；否则近黑可能是雨衣也算前景
        if near_black / max(1, len(px)) > 0.85:
            ratios.append(0.0)
        else:
            ratios.append((fg + near_black) / max(1, len(px)))
    return ratios


def assert_costume_cells_nonempty(
    costume_png: bytes, *, min_ratio: float = 0.12, n: int = 5
) -> list[float]:
    """服饰栏每格须非空且内容像素占比 > 阈值；否则 CharacterSheetError。"""
    ratios = costume_cell_content_ratios(costume_png, n=n)
    bad = [i for i, r in enumerate(ratios) if r < min_ratio]
    if bad:
        raise CharacterSheetError(
            f"costume cells empty/thin: idx={bad} ratios={[round(x, 3) for x in ratios]} min={min_ratio}"
        )
    return ratios


def _face_bbox_for_center(im: Image.Image) -> tuple[int, int, int, int] | None:
    """拼版用人脸框：优先 InsightFace，其次肤色启发式。"""
    bb = _insightface_face_bbox_xyxy(im)
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
    rs = sorted(c[0] for c in samples)
    gs = sorted(c[1] for c in samples)
    bs = sorted(c[2] for c in samples)
    mid = len(samples) // 2
    return (rs[mid], gs[mid], bs[mid])


def _trim_panel_edge_strips(im: Image.Image, *, max_frac: float = 0.22) -> Image.Image:
    """裁掉源图四周纯色/灰边/近白分隔竖条（19:20）。

    1) 四边近均匀且与内侧色差>40，或近白/近灰信箱 → 裁
    2) 靠边的近白低方差分隔带（即便最外缘是噪点）→ 整带以外裁掉
    3) 再走内容包围盒 `_trim_letterbox_rgb` 兜底
    """
    rgb = im.convert("RGB")
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
        return var / (n * 3.0), mean

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
        return var / (n * 3.0), mean

    def _delta(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
        return (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0

    def _is_letterbox(mean: tuple[float, float, float]) -> bool:
        r, g, b = mean
        mx, mn = max(r, g, b), min(r, g, b)
        if r > 230 and g > 230 and b > 230:
            return True
        if mx - mn < 16 and 60 <= mx <= 220:
            return True
        if mx < 28 and mx - mn < 12:
            return True
        return False

    def _is_white_sep(var: float, mean: tuple[float, float, float]) -> bool:
        return var < 100.0 and mean[0] > 220 and mean[1] > 220 and mean[2] > 220

    max_x = max(2, int(w * max_frac))
    max_y = max(2, int(h * max_frac))
    left = 0
    while left < max_x:
        var, mean = _col_stats(left)
        _, inner = _col_stats(min(w - 1, left + 8))
        if (var < 120.0 and _delta(mean, inner) > 40.0) or (
            var < 80.0 and _is_letterbox(mean)
        ):
            left += 1
            continue
        break
    right = w
    while w - right < max_x and right > left + 8:
        var, mean = _col_stats(right - 1)
        _, inner = _col_stats(max(0, right - 9))
        if (var < 120.0 and _delta(mean, inner) > 40.0) or (
            var < 80.0 and _is_letterbox(mean)
        ):
            right -= 1
            continue
        break
    # 近白分隔带：即便最外缘是深色噪点，也裁到分隔带内侧
    white_right = [
        x
        for x in range(max(left, w - max_x), right)
        if _is_white_sep(*_col_stats(x))
    ]
    if white_right:
        right = min(white_right)
    white_left = [
        x for x in range(left, min(right, left + max_x)) if _is_white_sep(*_col_stats(x))
    ]
    if white_left:
        left = max(white_left) + 1
    top = 0
    while top < max_y:
        var, mean = _row_stats(top)
        _, inner = _row_stats(min(h - 1, top + 8))
        if (var < 120.0 and _delta(mean, inner) > 40.0) or (
            var < 80.0 and _is_letterbox(mean)
        ):
            top += 1
            continue
        break
    bot = h
    while h - bot < max_y and bot > top + 8:
        var, mean = _row_stats(bot - 1)
        _, inner = _row_stats(max(0, bot - 9))
        if (var < 120.0 and _delta(mean, inner) > 40.0) or (
            var < 80.0 and _is_letterbox(mean)
        ):
            bot -= 1
            continue
        break
    if right - left < 16 or bot - top < 16:
        return im
    cropped = rgb.crop((left, top, right, bot))
    # 兜底内容包围盒
    trimmed = _trim_letterbox_rgb(cropped)
    return trimmed if trimmed.size[0] >= 16 and trimmed.size[1] >= 16 else cropped


def _content_head_bbox(im: Image.Image) -> tuple[int, int, int, int] | None:
    """整头外轮廓（含发丝），跳过近白/近灰底；供侧脸格定位（19:42）。"""
    rgb = im.convert("RGB")
    w, h = rgb.size
    if w < 8 or h < 8:
        return None
    # 中等分辨率采样，避免全图扫描过慢
    tw, th = (min(160, w), min(160, h))
    small = rgb.resize((tw, th), Image.Resampling.BILINEAR)
    sp = small.load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(th):
        for x in range(tw):
            r, g, b = sp[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            if r > 235 and g > 235 and b > 235:
                continue
            if mx - mn < 14 and 65 <= mx <= 210:
                continue
            if mx < 24 and mx - mn < 10:
                continue
            xs.append(x)
            ys.append(y)
    if len(xs) < 12:
        return None
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    pad = 2
    minx, miny = max(0, minx - pad), max(0, miny - pad)
    maxx, maxy = min(tw - 1, maxx + pad), min(th - 1, maxy + pad)
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
    rgb = im.convert("RGB")
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
    # 低彩度 + 中高亮度 = 背景；剔除深发/肤色
    bg: list[tuple[int, int, int]] = []
    for r, g, b in samples:
        mx, mn = max(r, g, b), min(r, g, b)
        mean = (r + g + b) / 3.0
        if mx - mn < 36 and 170 <= mean <= 245:
            bg.append((r, g, b))
    use = bg if len(bg) >= 24 else samples
    use_sorted = sorted(use)
    mid = use_sorted[len(use_sorted) // 2]
    return (int(mid[0]), int(mid[1]), int(mid[2]))


def _feather_paste_rgb(
    canvas: Image.Image,
    src: Image.Image,
    xy: tuple[int, int],
    *,
    feather: int = 12,
    sides: tuple[str, ...] | None = None,
) -> Image.Image:
    """把 src 贴到 canvas，在接缝处做 feather px 线性羽化，消除硬边（20:22/20:38）。

    sides: 限制羽化边；None=四边。fix45 侧脸只羽化鼻前侧（left/right），避免顶边羽化出浅底刀切线。
    """
    out = canvas.convert("RGB")
    s = src.convert("RGB")
    px, py = xy
    fw = max(0, int(feather))
    if fw <= 0:
        out.paste(s, (px, py))
        return out
    mask = Image.new("L", s.size, 255)
    mp = mask.load()
    sw, sh = s.size
    use = set(sides) if sides is not None else {"left", "right", "top", "bottom"}
    for y in range(sh):
        for x in range(sw):
            dists: list[int] = []
            if "left" in use:
                dists.append(x)
            if "right" in use:
                dists.append(sw - 1 - x)
            if "top" in use:
                dists.append(y)
            if "bottom" in use:
                dists.append(sh - 1 - y)
            if not dists:
                continue
            d = min(dists)
            if d < fw:
                mp[x, y] = int(round(255 * (d + 1) / (fw + 1)))
    out.paste(s, (px, py), mask)
    return out


def _fit_profile_head_cell(
    img: Image.Image,
    box: tuple[int, int, int, int],
    *,
    face_height_frac: float = 0.62,
    lead_margin: float = 0.12,
    top_margin: float = 0.0,
    min_face_height_frac: float = 0.55,
    max_face_height_frac: float = 0.75,
) -> tuple[Image.Image, tuple[int, int]]:
    """侧脸格：源图顶边对齐格顶（top_pad=0）；仅鼻前侧补背景色+12px羽化；贴底（20:38 fix45）。

    - 外框与 L/M 同为 box 尺寸
    - 禁止顶边垫色（消除发顶约 19% 浅底刀切线）
    - 鼻前留白 ≥ lead_margin；衣服贴格底（cover 无底垫 letterbox）
    - L/M 路径不走本函数
    """
    x, y, w, h = box
    src_rgb = img.convert("RGB")
    fill = _sample_profile_bg(src_rgb)
    face = _face_bbox_for_center(src_rgb)
    head = _content_head_bbox(src_rgb)
    if head is not None:
        hx0, hy0, hx1, hy1 = head
        if (hx1 - hx0) >= src_rgb.width * 0.92 or (hy1 - hy0) >= src_rgb.height * 0.92:
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
        head = (
            int(max(0, fx0 - 0.40 * fw)),
            int(max(0, fy0 - 0.65 * fh)),
            int(min(src_rgb.width, fx1 + 0.55 * fw)),
            int(min(src_rgb.height, fy1 + 0.90 * fh)),
        )
    hx0, hy0, hx1, hy1 = head
    facing_left = (fx0 - hx0) <= (hx1 - fx1)
    nose_x = float(fx0 if facing_left else fx1)
    if facing_left:
        nose_x = float(min(nose_x, hx0 + 0.02 * max(8.0, hx1 - hx0)))
    else:
        nose_x = float(max(nose_x, hx1 - 0.02 * max(8.0, hx1 - hx0)))

    # fix45: top_pad == 0 — 源图顶边直接对齐格顶；签名保留 top_margin 兼容
    pad_t = 0
    _ = (face_height_frac, top_margin, min_face_height_frac, max_face_height_frac, fh)

    # 预估 cover scale，只在鼻前侧补背景色
    scale0 = max(w / float(src_rgb.width), h / float(src_rgb.height))
    # 羽化会让前景检测把接缝灰边算进内容，内部多留 ~5% 保证实测 lead≥门禁
    place_lead = float(lead_margin) + 0.05
    lead_src = (place_lead * w) / max(1e-6, scale0)
    if facing_left:
        pad_l = max(0, int(math.ceil(lead_src - nose_x + 1e-6)))
        pad_r = 0
        feather_sides: tuple[str, ...] = ("left",)
    else:
        pad_l = 0
        pad_r = max(0, int(math.ceil(lead_src - (src_rgb.width - nose_x) + 1e-6)))
        feather_sides = ("right",)

    work_w = src_rgb.width + pad_l + pad_r
    work_h = src_rgb.height + pad_t  # pad_t 恒 0
    work = Image.new("RGB", (work_w, work_h), fill)
    work = _feather_paste_rgb(
        work, src_rgb, (pad_l, pad_t), feather=12, sides=feather_sides
    )

    # cover 铺满格；top=0（源顶→格顶）；水平保 lead；无底垫
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
        canvas = Image.new("RGB", (w, h), fill)
        px = 0 if facing_left else max(0, w - out.width)
        # 仍贴顶，禁止顶垫；高度不足时底边留 fill（极端回退）
        canvas = _feather_paste_rgb(
            canvas, out, (px, 0), feather=12, sides=feather_sides
        )
        out = canvas
    # 记录本轮 pad 供单测/门禁读取（top_pad 必须为 0）
    _fit_profile_head_cell.last_pad = {  # type: ignore[attr-defined]
        "top_pad": int(pad_t),
        "pad_l": int(pad_l),
        "pad_r": int(pad_r),
        "facing_left": bool(facing_left),
        "lead_margin": float(lead_margin),
    }
    return out.convert("RGBA"), (x, y)


def collage_face_triplet_equal_width(
    faces: list[bytes],
    *,
    cell_w: int = 256,
    cell_h: int = 384,
    gap: int = 12,
    bg: tuple[int, int, int] = (248, 248, 252),
    face_width_frac: float = 0.70,
    face_height_frac: float = 0.50,
    min_side_margin: float = 0.10,
) -> bytes:
    """面部三格同宽同高横拼（19:20 / 20:38）。

    L/M：裁边缘杂条后按人脸 cover 铺满并保头顶（像素路径不动）。
    R（侧脸）：源图顶边对齐格顶（top_pad=0），仅鼻前≥12% 补背景色+羽化，贴底铺满 240×320。
    face_* 参数保留签名兼容。
    """
    if len(faces) != 3:
        raise CharacterSheetError(f"face triplet needs 3 images, got {len(faces)}")
    _ = (face_width_frac, face_height_frac, min_side_margin)
    canvas = Image.new("RGB", (3 * cell_w + 2 * gap, cell_h), bg)
    for i, raw in enumerate(faces):
        im = _trim_panel_edge_strips(Image.open(BytesIO(raw)).convert("RGB"))
        if i == 2:
            fitted, _pos = _fit_profile_head_cell(im, (0, 0, cell_w, cell_h))
        else:
            fitted, _pos = _fit_cover_keep_crown(im, (0, 0, cell_w, cell_h))
        canvas.paste(fitted.convert("RGB"), (i * (cell_w + gap), 0))
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def measure_face_triplet_layout(
    faces_png: bytes,
    *,
    n: int = 3,
    cell_w: int | None = None,
    gap: int = 0,
) -> dict:
    """量测面部三格：几何格宽 + 人脸框宽/左右边距。"""
    im = Image.open(BytesIO(faces_png)).convert("RGB")
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
            margins.append({"left": 0.0, "right": 0.0, "bbox": None})
            continue
        x0, y0, x1, y1 = bb
        fh = y1 - y0
        face_widths.append(x1 - x0)
        face_heights.append(fh)
        face_height_fracs.append(fh / max(1, cim.height))
        margins.append(
            {
                "left": x0 / max(1, cim.width),
                "right": (cim.width - x1) / max(1, cim.width),
                "bbox": [x0, y0, x1, y1],
            }
        )
    return {
        "panel_size": [w, h],
        "cell_widths": [c.width for c in cells],
        "cell_heights": [c.height for c in cells],
        "face_widths": face_widths,
        "face_heights": face_heights,
        "face_height_fracs": face_height_fracs,
        "margins": margins,
    }


def assert_face_triplet_equal_width(
    faces_png: bytes,
    *,
    n: int = 3,
    cell_w: int | None = None,
    cell_h: int | None = None,
    gap: int | None = None,
    max_content_ratio: float = 1.6,
    max_face_width_delta_px: int | None = None,
    max_face_height_frac_delta: float | None = None,
    min_side_margin: float | None = None,
) -> dict:
    """断言面部三格同宽同高（18:38）。

    显式 cell_w/gap：校验画布几何；可选再验人脸框、高度占比差、水平居中边距。
    否则：等分切格后前景宽度比不得超过 max_content_ratio（挡旧 hstack）。
    """
    im = Image.open(BytesIO(faces_png)).convert("RGB")
    w, h = im.size
    if w < n * 8:
        raise CharacterSheetError(f"faces panel too narrow: {w}")
    info: dict = {"geo": None, "content_widths": [], "face_widths": [], "margins": []}
    if cell_w is not None and gap is not None:
        expect = n * cell_w + (n - 1) * gap
        if w != expect:
            raise CharacterSheetError(
                f"faces geometry {w} != {n}*{cell_w}+{n - 1}*{gap}={expect}"
            )
        if cell_h is not None and h != int(cell_h):
            raise CharacterSheetError(f"faces height {h} != cell_h={cell_h}")
        info["geo"] = {"cell_w": cell_w, "cell_h": h, "gap": gap}
        if (
            max_face_width_delta_px is None
            and min_side_margin is None
            and max_face_height_frac_delta is None
        ):
            return info
        measured = measure_face_triplet_layout(
            faces_png, n=n, cell_w=cell_w, gap=gap
        )
        info["face_widths"] = measured["face_widths"]
        info["face_heights"] = measured["face_heights"]
        info["face_height_fracs"] = measured["face_height_fracs"]
        info["margins"] = measured["margins"]
        info["cell_widths"] = measured["cell_widths"]
        info["cell_heights"] = measured["cell_heights"]
        if max(measured["cell_heights"]) - min(measured["cell_heights"]) > 2:
            raise CharacterSheetError(
                f"face cells not equal height ±2px: {measured['cell_heights']}"
            )
        widths = [x for x in measured["face_widths"] if x > 0]
        if len(widths) < n:
            raise CharacterSheetError(
                f"face bbox missing in cells: face_widths={measured['face_widths']}"
            )
        if max_face_width_delta_px is not None:
            delta = max(widths) - min(widths)
            if delta > int(max_face_width_delta_px):
                raise CharacterSheetError(
                    f"face widths not equal ±{max_face_width_delta_px}px: "
                    f"{measured['face_widths']} delta={delta}"
                )
        if max_face_height_frac_delta is not None:
            fracs = [f for f in measured["face_height_fracs"] if f > 0]
            if len(fracs) < n:
                raise CharacterSheetError(
                    f"face height fracs missing: {measured['face_height_fracs']}"
                )
            fdelta = max(fracs) - min(fracs)
            if fdelta > float(max_face_height_frac_delta) + 1e-9:
                raise CharacterSheetError(
                    f"face height frac delta>{max_face_height_frac_delta}: "
                    f"{measured['face_height_fracs']} delta={fdelta:.3f}"
                )
        if min_side_margin is not None:
            for i, m in enumerate(measured["margins"]):
                if i == n - 1:
                    continue
                if m["left"] + 1e-9 < float(min_side_margin) or m["right"] + 1e-9 < float(
                    min_side_margin
                ):
                    raise CharacterSheetError(
                        f"face cell{i} not centered: margins L={m['left']:.3f} "
                        f"R={m['right']:.3f} need >={min_side_margin}"
                    )
        return info
    cell = w // n
    widths: list[int] = []
    for i in range(n):
        x0 = i * cell
        x1 = w if i == n - 1 else (i + 1) * cell
        cim = im.crop((x0, 0, x1, h))
        px = cim.load()
        minx, maxx = cim.width, -1
        for y in range(cim.height):
            for x in range(cim.width):
                r, gch, b = px[x, y]
                if r > 245 and gch > 245 and b > 245:
                    continue
                if abs(r - gch) < 6 and abs(gch - b) < 6 and r > 235:
                    continue
                minx = min(minx, x)
                maxx = max(maxx, x)
        widths.append(0 if maxx < 0 else (maxx - minx + 1))
    positive = [x for x in widths if x > 0]
    if len(positive) < n:
        raise CharacterSheetError(f"face cells empty: content_widths={widths}")
    ratio = max(positive) / max(1, min(positive))
    if ratio > max_content_ratio:
        raise CharacterSheetError(
            f"face cells not equal width: content_widths={widths} ratio={ratio:.2f}"
        )
    info["content_widths"] = widths
    return info


def assert_face_triplet_cell_edges_clean(
    faces_png: bytes,
    *,
    cell_w: int,
    cell_h: int,
    gap: int = 12,
    band: int = 4,
    max_delta: float = 40.0,
    max_band_var: float = 120.0,
) -> dict:
    """19:20：每格四边 band px 内不得有「近均匀且与邻带色差>max_delta」的竖/横杂条。"""
    im = Image.open(BytesIO(faces_png)).convert("RGB")
    expect_w = 3 * cell_w + 2 * gap
    if im.width != expect_w or im.height != cell_h:
        raise CharacterSheetError(
            f"faces geometry {im.size} != ({expect_w},{cell_h})"
        )
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
            return (0.0, 0.0, 0.0), 0.0
        mean = (rs / n, gs / n, bs / n)
        var = sum(
            (r - mean[0]) ** 2 + (g - mean[1]) ** 2 + (b - mean[2]) ** 2
            for r, g, b in samples
        ) / (n * 3.0)
        return mean, var

    def _delta(a, b) -> float:
        return (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0

    for i in range(3):
        x0 = i * (cell_w + gap)
        checks = [
            ("L", (x0, 0, x0 + band, cell_h), (x0 + band, 0, x0 + min(cell_w, band * 3), cell_h)),
            (
                "R",
                (x0 + cell_w - band, 0, x0 + cell_w, cell_h),
                (x0 + max(0, cell_w - band * 3), 0, x0 + cell_w - band, cell_h),
            ),
            ("T", (x0, 0, x0 + cell_w, band), (x0, band, x0 + cell_w, min(cell_h, band * 3))),
            (
                "B",
                (x0, cell_h - band, x0 + cell_w, cell_h),
                (x0, max(0, cell_h - band * 3), x0 + cell_w, cell_h - band),
            ),
        ]
        # 侧脸格故意留鼻前/头顶浅底，跳过 L/T 杂条判定（19:42）
        if i == 2:
            checks = [c for c in checks if c[0] not in ("L", "T")]
        for name, outer_box, inner_box in checks:
            omean, ovar = _stats(*outer_box)
            imean, _ivar = _stats(*inner_box)
            d = _delta(omean, imean)
            if ovar <= max_band_var and d > max_delta:
                bad.append(f"cell{i}-{name} var={ovar:.1f} delta={d:.1f}")
    if bad:
        raise CharacterSheetError(f"face cell edge strips: {bad}")
    return {"ok": True, "band": band, "max_delta": max_delta, "max_band_var": max_band_var}



def assert_profile_cell_pad_delta_e(
    cell_rgb: Image.Image,
    src_rgb: Image.Image,
    *,
    band: int = 10,
    max_delta_e: float = 6.0,
) -> dict:
    """R 格鼻前（左侧）补边区与源图背景色 ΔE < max_delta_e（20:38：不再验顶边）。"""
    import math

    cell = cell_rgb.convert("RGB")
    src = src_rgb.convert("RGB")
    fill = _sample_profile_bg(src)
    cw, ch = cell.size
    b = max(2, min(int(band), cw // 4, ch // 4))
    # Lab-ish ΔE76 on sRGB (enough for near-neutral pads)
    def _to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
        r, g, b_ = [x / 255.0 for x in rgb]
        def _f(u: float) -> float:
            return ((u + 0.055) / 1.055) ** 2.4 if u > 0.04045 else u / 12.92
        r, g, b_ = _f(r), _f(g), _f(b_)
        x = r * 0.4124 + g * 0.3576 + b_ * 0.1805
        y = r * 0.2126 + g * 0.7152 + b_ * 0.0722
        z = r * 0.0193 + g * 0.1192 + b_ * 0.9505
        def _g(t: float) -> float:
            return t ** (1 / 3) if t > 0.008856 else (7.787 * t + 16 / 116)
        xr, yr, zr = _g(x / 0.95047), _g(y / 1.00000), _g(z / 1.08883)
        L = 116 * yr - 16
        a = 500 * (xr - yr)
        bb = 200 * (yr - zr)
        return (L, a, bb)

    fl = _to_lab(fill)
    px = cell.load()
    # 仅左侧鼻前补边取样（fix45 顶边不再垫色，验顶会误伤发丝）
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
        return {"ok": True, "max_delta_e": 0.0, "n": 0, "fill": fill}
    samples.sort()
    med = samples[len(samples) // 2]
    lab = _to_lab(med)
    d = math.sqrt(sum((lab[i] - fl[i]) ** 2 for i in range(3)))
    ok = d <= float(max_delta_e) + 1e-6
    if not ok:
        raise CharacterSheetError(
            f"profile pad ΔE too high: median={d:.2f} sample={med} fill={fill} (limit {max_delta_e})"
        )
    return {"ok": True, "max_delta_e": d, "median_rgb": med, "n": len(samples), "fill": fill}


def assert_face_triplet_profile_lead_margin(
    faces_png: bytes,
    *,
    cell_w: int,
    cell_h: int,
    gap: int = 12,
    min_lead: float = 0.12,
    min_top: float = 0.0,
    max_top: float = 0.08,
    cell_index: int = 2,
    require_top_pad_zero: bool = True,
) -> dict:
    """20:38：侧脸格（默认 R）鼻尖侧留白≥min_lead；顶边 top_pad=0（发顶可贴齐/出框）。

    用上半身前景外轮廓量：左向侧脸取最左前景列作鼻侧，最上前景行作头顶。
    max_top 防止回归到 fix44 约 19% 浅底刀切；require_top_pad_zero 读取 last_pad。
    """
    im = Image.open(BytesIO(faces_png)).convert("RGB")
    expect_w = 3 * cell_w + 2 * gap
    if im.width != expect_w or im.height != cell_h:
        raise CharacterSheetError(
            f"faces geometry {im.size} != ({expect_w},{cell_h})"
        )
    x0 = cell_index * (cell_w + gap)
    cell = im.crop((x0, 0, x0 + cell_w, cell_h))
    w, h = cell.size
    px = cell.load()

    def _is_bg(r: int, g: int, b: int) -> bool:
        if r > 230 and g > 230 and b > 235:
            return True
        mx, mn = max(r, g, b), min(r, g, b)
        if mx - mn < 14 and 65 <= mx <= 252:
            return True
        return False

    # 只看上 70%（头/肩以上），避免衣摆干扰
    y_lim = max(8, int(h * 0.70))
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
        raise CharacterSheetError(f"profile cell{cell_index}: no foreground for margin")
    left_x, right_x = min(xs), max(xs)
    top_y = min(ys)
    # 侧向：留白更多的一侧是鼻前（左向侧脸常铺满右侧）
    left_m = left_x / max(1, w)
    right_m = (w - 1 - right_x) / max(1, w)
    facing_left = left_m >= right_m
    nose_x = left_x if facing_left else right_x
    lead = (nose_x / w) if facing_left else ((w - nose_x) / w)
    top = top_y / max(1, h)
    if lead + 1e-9 < float(min_lead):
        raise CharacterSheetError(
            f"profile cell{cell_index} lead margin {lead:.3f} < {min_lead}"
        )
    if top + 1e-9 < float(min_top):
        raise CharacterSheetError(
            f"profile cell{cell_index} top margin {top:.3f} < {min_top}"
        )
    if top - 1e-9 > float(max_top):
        raise CharacterSheetError(
            f"profile cell{cell_index} top margin {top:.3f} > {max_top} (top_pad must be 0)"
        )
    top_pad = None
    last = getattr(_fit_profile_head_cell, "last_pad", None)
    if require_top_pad_zero:
        if not isinstance(last, dict) or int(last.get("top_pad", -1)) != 0:
            raise CharacterSheetError(
                f"profile cell{cell_index} top_pad!=0 (last_pad={last})"
            )
        top_pad = 0
    elif isinstance(last, dict):
        top_pad = int(last.get("top_pad", -1))
    return {
        "ok": True,
        "cell_index": cell_index,
        "facing_left": facing_left,
        "lead": lead,
        "top": top,
        "top_pad": top_pad,
        "nose_x": nose_x,
        "top_y": top_y,
    }


def assert_sheet_faces_equal_width(
    sheet_png: bytes,
    *,
    max_cell_delta_px: int = 2,
    max_face_width_delta_px: int | None = None,
    max_face_height_frac_delta: float | None = 0.10,
    min_side_margin: float = 0.10,
) -> dict:
    """最终整卡 faces 区实测（18:38）：三格可见宽高±2px、人脸高占比差≤10%、水平边距≥10%。"""
    im = Image.open(BytesIO(sheet_png)).convert("RGB")
    fx, fy, fw, fh = LAYOUT["faces"]
    # 与 compose_character_sheet 贴入盒一致
    box = (fx + 8, fy + 32, fw - 16, fh - 40)
    x, y, w, h = box
    region = im.crop((x, y, x + w, y + h))
    # 按贴入后面板：等分三格（compose 已改为 contain，禁止 cover 裁左右）
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
            margins.append({"left": 0.0, "right": 0.0})
            continue
        a, b0, c0, d0 = bb
        face_widths.append(c0 - a)
        face_height_fracs.append((d0 - b0) / max(1, cim.height))
        margins.append(
            {"left": a / max(1, cim.width), "right": (cim.width - c0) / max(1, cim.width)}
        )
    if max(cell_widths) - min(cell_widths) > int(max_cell_delta_px):
        raise CharacterSheetError(
            f"sheet face cells not equal width ±{max_cell_delta_px}px: {cell_widths}"
        )
    if max(cell_heights) - min(cell_heights) > int(max_cell_delta_px):
        raise CharacterSheetError(
            f"sheet face cells not equal height ±{max_cell_delta_px}px: {cell_heights}"
        )
    positive = [x for x in face_widths if x > 0]
    if len(positive) < n:
        raise CharacterSheetError(f"sheet face bbox missing: {face_widths}")
    if max_face_width_delta_px is not None and max(positive) - min(positive) > int(
        max_face_width_delta_px
    ):
        raise CharacterSheetError(
            f"sheet face widths not equal ±{max_face_width_delta_px}px: {face_widths}"
        )
    if max_face_height_frac_delta is not None:
        fracs = [f for f in face_height_fracs if f > 0]
        if len(fracs) < n:
            raise CharacterSheetError(f"sheet face height fracs missing: {face_height_fracs}")
        fdelta = max(fracs) - min(fracs)
        if fdelta > float(max_face_height_frac_delta) + 1e-9:
            raise CharacterSheetError(
                f"sheet face height frac delta>{max_face_height_frac_delta}: "
                f"{face_height_fracs} delta={fdelta:.3f}"
            )
    if min_side_margin is not None and float(min_side_margin) > 0:
        for i, m in enumerate(margins):
            # 20:22：侧脸末格发贴一侧、鼻前留白，跳过左右对称居中
            if i == n - 1:
                continue
            if m["left"] + 1e-9 < float(min_side_margin) or m["right"] + 1e-9 < float(
                min_side_margin
            ):
                raise CharacterSheetError(
                    f"sheet face cell{i} not centered: L={m['left']:.3f} R={m['right']:.3f}"
                )
    return {
        "cell_widths": cell_widths,
        "cell_heights": cell_heights,
        "face_widths": face_widths,
        "face_height_fracs": face_height_fracs,
        "margins": margins,
        "region": [w, h],
    }



def collage_costume_items(items: list[bytes], *, style: str) -> bytes:
    """五件单品横排拼成 costume 区图;正方形格 + 包围盒 letterbox,不裁切。"""
    # 用接近版式区的宽扁画布,每格近似正方形,避免竖长条中心裁切
    n = max(1, len(items))
    cell = 256
    pad = 8
    w = n * cell + pad * 2
    h = cell + pad * 2
    # 21:38 古风服饰：浅/中灰底（禁深黑底把物件糊成黑块）
    bg = (240, 240, 244) if style == "anime" else (200, 200, 206)
    canvas = Image.new("RGB", (w, h), bg)
    for i, raw in enumerate(items):
        try:
            im = Image.open(BytesIO(raw)).convert("RGB")
        except Exception:  # noqa: BLE001
            continue
        im = _trim_object_bbox(im, style=style)
        box = (pad + i * cell + 4, pad + 4, cell - 8, cell - 8)
        _paste(canvas, im, box, cover=False)
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def compose_boot_pair(single_boot: bytes, *, style: str, size: int = 768) -> bytes:
    """单靴 PNG → 左右一对(右靴镜像),保证服饰格正好两只。"""
    try:
        boot = Image.open(BytesIO(single_boot)).convert("RGB")
    except Exception:  # noqa: BLE001
        boot = Image.new("RGB", (size, size), (255, 255, 255))
    boot = _trim_object_bbox(boot, style=style, pad=8)
    bg = (255, 255, 255) if style == "anime" else (200, 200, 206)
    canvas = Image.new("RGB", (size, size), bg)
    # 每只靴约占半宽
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
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def _trim_object_bbox(img: Image.Image, *, style: str, pad: int = 12) -> Image.Image:
    """按物品包围盒裁切(去大片纯色底),供 letterbox 拼版。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    # anime 白底 / 古风深底
    if style == "anime":
        def _fg(r, g, b) -> bool:
            return not (r > 230 and g > 230 and b > 230)
    else:
        def _fg(r, g, b) -> bool:
            # 深黑旧底 + 浅/中灰新底都当背景
            if r < 45 and g < 45 and b < 50:
                return False
            if abs(r - g) < 18 and abs(g - b) < 18 and 150 <= ((r + g + b) // 3) <= 230:
                return False
            return True
    min_x, min_y, max_x, max_y = w, h, 0, 0
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


async def _generate_costume_collage(
    pool: "WorkerPool",
    *,
    meta: SheetMeta,
    ckpt: str,
    worker: str | None,
    client: Any,
    seed: int | None,
    n_candidates: int = 1,
) -> bytes:
    """五件单品各出图再 collage;古风用汉服单品,现代用雨衣套装。"""
    del n_candidates  # 整卡路径各 1;分区重跑路径在 regenerate 里加候选
    suf = _STYLE_SUFFIX.get(meta.style, _STYLE_SUFFIX["anime"])
    item_bytes: list[bytes] = []
    items = (
        _COSTUME_ITEMS_ANCIENT
        if meta.style == "ancient_realistic"
        else _COSTUME_ITEMS
    )
    for idx, (item_key, item_prompt) in enumerate(items):
        prompt = f"{item_prompt}, {suf}"
        if item_key == "boots":
            prompt = (
                "exactly two black rain boots only, one left boot and one right boot, "
                "a single isolated pair centered large in frame with empty white space around, "
                "NOT three, NOT four, NOT five, NOT a row, NOT a shelf, NOT repeated, "
                "product still life, no person, "
                + prompt
                + ", footwear product photography, only two boots"
            )
        elif item_key == "pants":
            prompt = (
                "single pair of long black trousers laid flat centered, full length to ankles, "
                "one item only filling the frame, plain white background only, "
                "NOT shorts, NOT multiple, NOT repeated, NOT a row of pants, "
                "NOT empty panels, NOT UI mockup, NOT wireframe boxes, NOT empty slots, "
                "product shot, no person, no mannequin, "
                + prompt
                + ", clothing flat lay only"
            )
        elif item_key == "umbrella":
            prompt = (
                "single open clear transparent plastic rain umbrella only, visible metal ribs and black handle shaft, "
                "product still life on white background, NOT a lamp, NOT a hat, NOT a dome light, NOT opaque, "
                + prompt
                + ", umbrella product photography only"
            )
        elif item_key == "raincoat":
            prompt = (
                "flat lay complete slate-gray hooded raincoat #5A6A7A only, plain unbranded no logo, "
                "hood and sleeves visible, mid-tone gray not jet black, "
                "product shot, no person, no mannequin, garment fills frame, "
                + prompt
                + ", clothing only, not empty white frame"
            )
        # 古风单品易出着装半身:多候选+anime 产品 ckpt+惩罚择优
        n_try = 4 if meta.style == "ancient_realistic" else 1
        use_ckpt, use_style = ckpt, meta.style
        w, h = (768, 768) if meta.style == "anime" else (512, 512)
        if meta.style == "ancient_realistic":
            use_ckpt = "animagineXL40.safetensors"
            use_style = "anime"
            w, h = 768, 768
            prompt = prompt + ", anime product illustration, flat lay, no person, no face"
        cands: list[bytes] = []
        for ci in range(n_try):
            cands.append(
                await generate_panel_bytes(
                    pool,
                    prompt,
                    ckpt_name=use_ckpt,
                    width=w,
                    height=h,
                    seed=None if seed is None else seed + 7000 + idx * 17 + ci * 41,
                    worker=worker,
                    filename_prefix=f"ToIV_char_sheet_costume_{item_key}",
                    style=use_style,
                    client=client,
                    ref_image=None,
                    ref_mode="none",
                    denoise=1.0,
                )
            )
        data = _pick_best_candidate(cands, f"costume_{item_key}")
        item_bytes.append(data)
    return collage_costume_items(item_bytes, style=meta.style)



# OpenPose BODY_25 近似关键点(归一化 0..1,脚底 y≈1,头顶≈0.02;按 165cm 成人比例)
_OPENPOSE_FRONT: list[tuple[float, float]] = [
    (0.50, 0.06),  # 0 nose
    (0.50, 0.12),  # 1 neck
    (0.38, 0.14),  # 2 R shoulder
    (0.30, 0.28),  # 3 R elbow
    (0.28, 0.40),  # 4 R wrist
    (0.62, 0.14),  # 5 L shoulder
    (0.70, 0.28),  # 6 L elbow
    (0.72, 0.40),  # 7 L wrist
    (0.44, 0.42),  # 8 R hip
    (0.42, 0.66),  # 9 R knee
    (0.42, 0.92),  # 10 R ankle
    (0.56, 0.42),  # 11 L hip
    (0.58, 0.66),  # 12 L knee
    (0.58, 0.92),  # 13 L ankle
    (0.46, 0.05),  # 14 R eye
    (0.54, 0.05),  # 15 L eye
    (0.44, 0.06),  # 16 R ear
    (0.56, 0.06),  # 17 L ear
]
_OPENPOSE_SIDE: list[tuple[float, float]] = [
    (0.58, 0.06),
    (0.52, 0.12),
    (0.50, 0.14),
    (0.48, 0.30),
    (0.46, 0.42),
    (0.54, 0.14),
    (0.56, 0.30),
    (0.58, 0.42),
    (0.50, 0.42),
    (0.50, 0.66),
    (0.50, 0.92),
    (0.52, 0.42),
    (0.52, 0.66),
    (0.52, 0.92),
    (0.60, 0.05),
    (0.56, 0.05),
    (0.48, 0.06),
    (0.62, 0.06),
]
_OPENPOSE_BACK: list[tuple[float, float]] = [
    (0.50, 0.07),  # occiput approx
    (0.50, 0.12),
    (0.62, 0.14),
    (0.70, 0.28),
    (0.72, 0.40),
    (0.38, 0.14),
    (0.30, 0.28),
    (0.28, 0.40),
    (0.56, 0.42),
    (0.58, 0.66),
    (0.58, 0.92),
    (0.44, 0.42),
    (0.42, 0.66),
    (0.42, 0.92),
    (0.54, 0.05),
    (0.46, 0.05),
    (0.56, 0.06),
    (0.44, 0.06),
]
_OPENPOSE_LIMBS: list[tuple[int, int, tuple[int, int, int]]] = [
    (1, 2, (255, 0, 0)),
    (1, 5, (0, 255, 0)),
    (2, 3, (255, 85, 0)),
    (3, 4, (255, 170, 0)),
    (5, 6, (0, 255, 85)),
    (6, 7, (0, 255, 170)),
    (1, 8, (170, 0, 255)),
    (1, 11, (255, 0, 170)),
    (8, 9, (85, 0, 255)),
    (9, 10, (0, 85, 255)),
    (11, 12, (0, 170, 255)),
    (12, 13, (0, 255, 255)),
    (0, 1, (255, 0, 85)),
]


def openpose_asset_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "assets" / "openpose"


def render_openpose_skeleton(
    view: str,
    *,
    width: int = 768,
    height: int = 1152,
    height_cm: int = 165,
) -> bytes:
    """程序绘制 OpenPose 风格正/侧/背关键点骨架图(黑底彩线,按成人比例占满高度)。"""
    del height_cm  # 比例已烘焙进关键点;保留参数供调用方对齐 165cm
    view = (view or "front").lower()
    if view == "side":
        kps = _OPENPOSE_SIDE
    elif view == "back":
        kps = _OPENPOSE_BACK
    else:
        kps = _OPENPOSE_FRONT
    img = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 上下留白 4%,人物占 92% 高度 → 贴合 165cm 刻度
    margin_x = int(width * 0.18)
    top = int(height * 0.04)
    usable_h = int(height * 0.92)
    usable_w = width - 2 * margin_x

    def _xy(i: int) -> tuple[int, int]:
        x, y = kps[i]
        return int(margin_x + x * usable_w), int(top + y * usable_h)

    thick = max(4, width // 96)
    for a, b, color in _OPENPOSE_LIMBS:
        draw.line([_xy(a), _xy(b)], fill=color, width=thick)
    r = max(5, width // 64)
    for i in range(len(kps)):
        x, y = _xy(i)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255))
    # 头圆
    hx, hy = _xy(0)
    hr = max(10, width // 28)
    draw.ellipse([hx - hr, hy - hr - 4, hx + hr, hy + hr + 4], outline=(255, 255, 0), width=3)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def ensure_openpose_assets(*, height_cm: int = 165) -> dict[str, Path]:
    """生成并落盘正/侧/背骨架 PNG;返回 view→路径。"""
    d = openpose_asset_dir()
    d.mkdir(parents=True, exist_ok=True)
    out: dict[str, Path] = {}
    for view in ("front", "side", "back"):
        p = d / f"openpose_{view}_165.png"
        data = render_openpose_skeleton(view, height_cm=height_cm)
        p.write_bytes(data)
        out[view] = p
    meta = d / "README.txt"
    meta.write_text(
        "Programmatic OpenPose BODY18-like skeletons for Batch7 turnaround.\n"
        "Views: front/side/back at 165cm adult proportions.\n",
        encoding="utf-8",
    )
    return out



# 面部三格专用头肩 OpenPose(正/3-4/侧);放大 yaw,供 ControlNet 锁角度
_OPENPOSE_FACE_FRONT: list[tuple[float, float]] = [
    (0.50, 0.28),  # nose
    (0.50, 0.42),  # neck
    (0.28, 0.48),  # R shoulder
    (0.18, 0.72),  # R elbow
    (0.14, 0.92),  # R wrist
    (0.72, 0.48),  # L shoulder
    (0.82, 0.72),  # L elbow
    (0.86, 0.92),  # L wrist
    (0.38, 0.95),  # R hip (cropped)
    (0.38, 0.98),
    (0.38, 0.99),
    (0.62, 0.95),  # L hip
    (0.62, 0.98),
    (0.62, 0.99),
    (0.40, 0.24),  # R eye
    (0.60, 0.24),  # L eye
    (0.30, 0.30),  # R ear
    (0.70, 0.30),  # L ear
]
_OPENPOSE_FACE_THREE_QUARTER: list[tuple[float, float]] = [
    (0.38, 0.30),  # nose pointing left of center
    (0.48, 0.42),  # neck
    (0.34, 0.50),  # R shoulder (far, foreshortened)
    (0.28, 0.74),
    (0.24, 0.92),
    (0.70, 0.48),  # L shoulder (near, larger)
    (0.82, 0.72),
    (0.86, 0.92),
    (0.42, 0.95),
    (0.42, 0.98),
    (0.42, 0.99),
    (0.62, 0.95),
    (0.62, 0.98),
    (0.62, 0.99),
    (0.30, 0.26),  # R eye (far, smaller position)
    (0.48, 0.24),  # L eye (near)
    (0.22, 0.32),  # R ear barely / back
    (0.62, 0.28),  # L ear clearly visible
]
_OPENPOSE_FACE_SIDE: list[tuple[float, float]] = [
    (0.28, 0.32),  # nose tip far left (profile)
    (0.48, 0.42),  # neck
    (0.46, 0.50),  # shoulders nearly stacked
    (0.44, 0.74),
    (0.42, 0.92),
    (0.52, 0.50),
    (0.54, 0.74),
    (0.56, 0.92),
    (0.48, 0.95),
    (0.48, 0.98),
    (0.48, 0.99),
    (0.52, 0.95),
    (0.52, 0.98),
    (0.52, 0.99),
    (0.34, 0.28),  # only near eye
    (0.34, 0.28),  # duplicate eye slot (profile)
    (0.58, 0.30),  # ear on silhouette back
    (0.58, 0.30),
]


def render_openpose_face_skeleton(
    view: str,
    *,
    width: int = 768,
    height: int = 768,
) -> bytes:
    """程序绘制头肩 OpenPose:front / three_quarter / side。"""
    view = (view or "front").lower().replace("-", "_")
    if view in ("three_quarter", "face_three_quarter", "3_4", "tq"):
        kps = _OPENPOSE_FACE_THREE_QUARTER
    elif view in ("side", "face_side", "profile"):
        kps = _OPENPOSE_FACE_SIDE
    else:
        kps = _OPENPOSE_FACE_FRONT
    img = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin_x = int(width * 0.08)
    top = int(height * 0.06)
    usable_h = int(height * 0.88)
    usable_w = width - 2 * margin_x

    def _xy(i: int) -> tuple[int, int]:
        x, y = kps[i]
        return int(margin_x + x * usable_w), int(top + y * usable_h)

    thick = max(5, width // 80)
    # 头肩相关肢干优先
    limbs = [
        (1, 2, (255, 0, 0)),
        (1, 5, (0, 255, 0)),
        (2, 3, (255, 85, 0)),
        (3, 4, (255, 170, 0)),
        (5, 6, (0, 255, 85)),
        (6, 7, (0, 255, 170)),
        (1, 8, (170, 0, 255)),
        (1, 11, (255, 0, 170)),
        (0, 1, (255, 0, 85)),
        (0, 14, (255, 255, 0)),
        (0, 15, (255, 255, 0)),
        (14, 16, (0, 255, 255)),
        (15, 17, (0, 255, 255)),
    ]
    for a, b, color in limbs:
        draw.line([_xy(a), _xy(b)], fill=color, width=thick)
    r = max(6, width // 56)
    for i in range(len(kps)):
        x, y = _xy(i)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255))
    hx, hy = _xy(0)
    # 头颅椭圆按视角拉偏,强化侧向
    if view in ("side", "face_side", "profile"):
        draw.ellipse([hx - 18, hy - 55, hx + 70, hy + 55], outline=(255, 255, 0), width=4)
    elif view in ("three_quarter", "face_three_quarter", "3_4", "tq"):
        draw.ellipse([hx - 35, hy - 58, hx + 55, hy + 52], outline=(255, 255, 0), width=4)
    else:
        draw.ellipse([hx - 48, hy - 58, hx + 48, hy + 52], outline=(255, 255, 0), width=4)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def ensure_openpose_face_assets() -> dict[str, Path]:
    """生成并落盘面部正/3-4/侧骨架;返回 face_key→路径。"""
    d = openpose_asset_dir()
    d.mkdir(parents=True, exist_ok=True)
    mapping = {
        "face_front": "front",
        "face_three_quarter": "three_quarter",
        "face_side": "side",
    }
    out: dict[str, Path] = {}
    for fk, view in mapping.items():
        p = d / f"openpose_face_{view}_768.png"
        p.write_bytes(render_openpose_face_skeleton(view))
        out[fk] = p
    return out


def _trim_letterbox_rgb(img: Image.Image) -> Image.Image:
    """去掉四周近灰/近白/近黑信箱,供面部格 cover 铺满(fix13)。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    small = rgb.resize((64, 64), Image.Resampling.BILINEAR)
    sp = small.load()
    xs, ys = [], []
    for y in range(64):
        for x in range(64):
            r, g, b = sp[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            if r > 235 and g > 235 and b > 235:
                continue
            if mx - mn < 14 and 65 <= mx <= 210:
                continue
            if mx < 24 and mx - mn < 10:
                continue
            xs.append(x)
            ys.append(y)
    if len(xs) < 12:
        return img
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    # 轻度外扩避免裁掉发丝/肩线
    pad = 2
    minx, miny = max(0, minx - pad), max(0, miny - pad)
    maxx, maxy = min(63, maxx + pad), min(63, maxy + pad)
    left = int(minx * w / 64)
    right = int((maxx + 1) * w / 64)
    top = int(miny * h / 64)
    bot = int((maxy + 1) * h / 64)
    if right - left < 8 or bot - top < 8:
        return img
    return img.crop((left, top, right, bot))


def _fit_cover_focus(
    img: Image.Image,
    box: tuple[int, int, int, int],
    focus_xy: tuple[float, float] | None = None,
) -> tuple[Image.Image, tuple[int, int]]:
    """cover 铺满格子;若给 focus_xy(源图像素)则裁切窗对准该点(防侧脸居中砍掉五官)。"""
    x, y, w, h = box
    src = img.convert("RGBA")
    sw, sh = src.size
    scale = max(w / sw, h / sh)
    nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    if focus_xy is None:
        left = max(0, (nw - w) // 2)
        top = max(0, (nh - h) // 2)
    else:
        fx = float(focus_xy[0]) * (nw / max(sw, 1))
        fy = float(focus_xy[1]) * (nh / max(sh, 1))
        left = int(round(fx - w / 2.0))
        top = int(round(fy - h / 2.0))
        left = max(0, min(nw - w, left))
        top = max(0, min(nh - h, top))
    src = src.crop((left, top, left + w, top + h))
    return src, (x, y)


def compose_faces_triptych(
    faces: dict[str, bytes],
    *,
    style: str = "anime",
    size: tuple[int, int] = (1024, 640),
    skip_enforce_keys: set[str] | frozenset[str] | None = None,
) -> bytes:
    """正/3-4/侧 三个头部特写横拼为 faces 面板。

    fix16:锁定格与生成格同一 face-center cover(禁垫边缩水);每格 assert_panel_coverage>=0.90。
    入格 cover 按人脸焦点裁(高格水平居中会砍掉侧脸五官)。
    二次元浅底:已正方形铺满源谨慎 trim,避免 cel 线/浅底被当灰边。
    """
    bg = (248, 248, 252) if style == "anime" else (20, 22, 28)
    canvas = Image.new("RGB", size, bg)
    keys = ("face_front", "face_three_quarter", "face_side")
    cell_w = size[0] // 3
    skip = set(skip_enforce_keys or ())
    for i, key in enumerate(keys):
        raw = faces.get(key)
        if not raw:
            continue
        if key in skip:
            filled = enforce_head_shoulders_square(raw, size=768, skip_reframe=True)
        else:
            filled = enforce_head_shoulders_square(raw, size=768)
        # fix16:拼版前再拦一次覆盖率(双重保险)
        assert_panel_coverage(filled, min_ratio=0.90)
        # 焦点:生成格用人脸中心;锁定格禁用 focus(防高格 cover 把头裁成半脸/空灰)
        focus = None
        if key not in skip:
            bb = _insightface_face_bbox_xyxy(filled)
            if bb is not None:
                focus = ((bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0)
            else:
                him = Image.open(BytesIO(filled)).convert("RGB")
                hbb = _heuristic_skin_face_bbox(him)
                if hbb is not None:
                    focus = ((hbb[0] + hbb[2]) / 2.0, (hbb[1] + hbb[3]) / 2.0)
        img = Image.open(BytesIO(filled)).convert("RGBA")
        iw, ih = img.size
        if iw != ih or min(iw, ih) < 200:
            img = _trim_letterbox_rgb(img).convert("RGBA")
        else:
            sample = img.convert("RGB").resize((32, 32), Image.Resampling.BILINEAR)
            spx = list(sample.getdata())

            def _edge_gray(cols, rows):
                n = 0
                g = 0
                for yy in rows:
                    for xx in cols:
                        r, gv, b = spx[yy * 32 + xx]
                        n += 1
                        mx, mn = max(r, gv, b), min(r, gv, b)
                        if (r > 230 and gv > 230 and b > 230) or (
                            mx - mn < 14 and 65 <= mx <= 210
                        ):
                            g += 1
                return g / max(n, 1)

            left_g = _edge_gray(range(0, 3), range(32))
            right_g = _edge_gray(range(29, 32), range(32))
            top_g = _edge_gray(range(32), range(0, 3))
            bot_g = _edge_gray(range(32), range(29, 32))
            if left_g > 0.85 and right_g > 0.85 and (top_g > 0.5 or bot_g > 0.5):
                img = _trim_letterbox_rgb(img).convert("RGBA")
                # trim 后焦点按比例缩放
                if focus is not None and iw > 0 and ih > 0:
                    focus = (
                        focus[0] * img.width / iw,
                        focus[1] * img.height / ih,
                    )
        box = (i * cell_w + 4, 4, cell_w - 8, size[1] - 8)
        fitted, pos = _fit_cover_focus(img, box, focus_xy=focus)
        canvas.paste(fitted.convert("RGB"), pos)
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def normalize_turnaround_figure(data: bytes, *, out_w: int = 768, out_h: int = 1152) -> bytes:
    """裁掉大块灰/白底后按高度贴满到刻度(≈165cm):脚底贴底、头顶近顶。

    fix12:宽袖/横幅人物若按宽缩放会变矮(古风汉服常见);改为始终按高度铺满,
    超出宽度则水平居中裁切,禁止回落为矮小人形。
    """
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = small.load()
    ys, xs = [], []
    for y in range(64):
        for x in range(64):
            r, g, b = px[x, y]
            if r > 235 and g > 235 and b > 235:
                continue
            if abs(r - g) < 14 and abs(g - b) < 14 and 150 <= r <= 235:
                continue  # 浅/中灰底与柔光晕
            if abs(r - g) < 12 and abs(g - b) < 12 and 35 <= r <= 110:
                continue  # 深灰影棚底
            ys.append(y)
            xs.append(x)
    if len(ys) < 30:
        fitted, _ = _fit(img.convert("RGBA"), (0, 0, out_w, out_h), cover=False)
        canvas = Image.new("RGB", (out_w, out_h), (230, 230, 234))
        canvas.paste(fitted.convert("RGB"), ((out_w - fitted.width) // 2, out_h - fitted.height))
        buf = BytesIO()
        canvas.save(buf, format="PNG")
        return buf.getvalue()
    top = max(0, int(min(ys) * h / 64) - 4)
    bottom = min(h, int(max(ys) * h / 64) + 8)
    left = max(0, int(min(xs) * w / 64) - 8)
    right = min(w, int(max(xs) * w / 64) + 8)
    crop = img.crop((left, top, right, bottom))
    # 始终按高度贴满(对齐 165cm 刻度);过宽则水平裁
    scale = out_h / max(1, crop.height)
    nw, nh = max(1, int(crop.width * scale)), out_h
    crop = crop.resize((nw, nh), Image.Resampling.LANCZOS)
    if nw > out_w:
        left_c = (nw - out_w) // 2
        crop = crop.crop((left_c, 0, left_c + out_w, out_h))
        nw = out_w
    canvas = Image.new("RGB", (out_w, out_h), (230, 230, 234))
    canvas.paste(crop, ((out_w - nw) // 2, 0))  # 头顶贴顶、脚随高度铺满
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


async def _probe_openpose_available(client: Any) -> tuple[bool, str]:
    """探测 worker 是否具备 openpose 控网+预处理器。

    须走 ComfyUIClient.get_object_info / object_info;缺方法则直接 GET /object_info。
    不可用时返回 (False, reason)——调用方对三视图必须 raise,禁止静默 IPA 假成功。
    """
    info: dict[str, Any] = {}
    try:
        if hasattr(client, "get_object_info"):
            info = await client.get_object_info()
        elif hasattr(client, "object_info"):
            # 单节点接口:拼 ControlNetLoader + 预处理器
            chunk = await client.object_info("ControlNetLoader")
            if isinstance(chunk, dict):
                info.update(chunk)
            try:
                chunk2 = await client.object_info("AIO_Preprocessor")
                if isinstance(chunk2, dict):
                    info.update(chunk2)
            except Exception:  # noqa: BLE001
                pass
        else:
            base = getattr(client, "base_url", None) or getattr(client, "_base_url", None)
            if not base:
                return False, "client 无 get_object_info/base_url,无法探测 object_info"
            import httpx

            async with httpx.AsyncClient(timeout=12.0) as hx:
                r = await hx.get(f"{str(base).rstrip('/')}/object_info")
                if r.status_code != 200:
                    return False, f"GET /object_info HTTP {r.status_code}"
                info = r.json() if isinstance(r.json(), dict) else {}
    except Exception as e:  # noqa: BLE001
        return False, f"object_info 探测失败:{e}"

    if not isinstance(info, dict) or not info:
        return False, "object_info 为空"

    node = info.get("ControlNetLoader") or {}
    inputs = (node.get("input") or {}).get("required") or {}
    cn = inputs.get("control_net_name")
    models = cn[0] if isinstance(cn, list) and cn and isinstance(cn[0], list) else (cn or [])
    model_blob = " ".join(str(m) for m in models).lower()
    if "openpose" not in model_blob and "union" not in model_blob:
        return False, "worker 未装 openpose/union controlnet 模型"

    has_prep = any(
        k in info
        for k in (
            "AIO_Preprocessor",
            "OpenposePreprocessor",
            "DWPreprocessor",
            "OpenPosePreprocessor",
        )
    )
    if not has_prep:
        return False, "缺少 Openpose/AIO/DW Preprocessor 节点"

    # 程序生成正/侧/背骨架图并入库;缺失则现场生成
    try:
        assets = ensure_openpose_assets(height_cm=165)
    except Exception as e:  # noqa: BLE001
        return False, f"openpose 骨架资产生成失败:{e}"
    missing = [k for k, p in assets.items() if not p.is_file()]
    if missing:
        return False, f"openpose 骨架资产缺失:{','.join(missing)}"
    return True, f"openpose ok assets={','.join(sorted(assets))}"


async def generate_panel_bytes_openpose(
    pool: "WorkerPool",
    prompt: str,
    *,
    pose_image_name: str,
    ckpt_name: str,
    width: int,
    height: int,
    seed: int | None,
    worker: str | None,
    filename_prefix: str,
    style: str,
    client: Any | None = None,
    ref_image: str | None = None,
    skip_preprocess: bool = True,
    strength: float = 0.88,
    ipa_weight: float = 0.72,
    ipa_start: float = 0.0,
    ipa_end: float = 1.0,
    negative_extra: str = "",
) -> bytes:
    """openpose ControlNet 出图(尺寸覆盖 EmptyLatent)。

    skip_preprocess=True:合成骨架图直喂 ControlNet(不再跑 OpenposePreprocessor)。
    ref_image:可选主立绘,注入 IPAdapter 保同一人。
    """
    del pool
    from app.comfy.client import ComfyUIError
    from app.workflows.controlnet import ControlNetParams, build_controlnet_graph

    cli = client or await _pick_sheet_client(worker)
    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
    if negative_extra:
        neg = f"{neg}, {negative_extra}"
    kw: dict[str, Any] = dict(
        positive=prompt,
        image=pose_image_name,
        control_type="openpose",
        negative=neg,
        ckpt_name=ckpt_name,
        strength=strength,
        steps=28 if style == "anime" else 22,
        cfg=6.0 if style == "anime" else 7.0,
        filename_prefix=filename_prefix,
    )
    if seed is not None:
        kw["seed"] = seed
    graph = build_controlnet_graph(ControlNetParams(**kw))
    if "5" in graph and "inputs" in graph["5"]:
        graph["5"]["inputs"]["width"] = width
        graph["5"]["inputs"]["height"] = height
    if skip_preprocess:
        # 合成 OpenPose 彩骨架直通:ControlNetApplyAdvanced.image ← LoadImage
        apply = graph.get("15") or {}
        if isinstance(apply, dict) and "inputs" in apply:
            apply["inputs"]["image"] = ["10", 0]
        # 去掉预处理器节点,避免把骨架图再跑一遍检测毁掉
        graph.pop("12", None)
    # 可选 IPA:在 KSampler.model 前插入 UnifiedLoader+Advanced(节点 200+)
    if ref_image:
        from app.workflows.ipadapter import DEFAULT_PRESET

        graph["200"] = {
            "class_type": "IPAdapterUnifiedLoader",
            "inputs": {"model": ["4", 0], "preset": DEFAULT_PRESET},
        }
        graph["202"] = {
            "class_type": "LoadImage",
            "inputs": {"image": ref_image},
        }
        graph["201"] = {
            "class_type": "IPAdapterAdvanced",
            "inputs": {
                "model": ["200", 0],
                "ipadapter": ["200", 1],
                "image": ["202", 0],
                "weight": ipa_weight,
                "weight_type": "linear",
                "combine_embeds": "concat",
                "embeds_scaling": "V only",
                "start_at": ipa_start,
                "end_at": ipa_end,
            },
        }
        if "3" in graph and "inputs" in graph["3"]:
            graph["3"]["inputs"]["model"] = ["201", 0]
    try:
        prompt_id = await cli.queue_prompt(graph, client_id=uuid.uuid4().hex)
    except ComfyUIError as e:
        raise CharacterSheetError(f"openpose 出图提交失败:{e}", status_code=503) from e
    images = await _wait_images(cli, prompt_id)
    img = images[0]
    data, _ = await cli.get_image_bytes(
        img["filename"], img.get("subfolder", ""), img.get("type", "output")
    )
    return data



async def regenerate_sheet_panels(
    *,
    character_id: str,
    meta: SheetMeta,
    pool: "WorkerPool",
    locked_panels: dict[str, bytes],
    regen_keys: list[str],
    n_candidates: int = 3,
    ckpt_name: str | None = None,
    worker: str | None = None,
    seed: int | None = None,
) -> tuple[str, bytes, dict[str, str], dict[str, Any]]:
    """分区锁定 + 单格重生成。

    locked_panels: 已合格锁定的键→PNG bytes(跳过生成)。
    regen_keys: 须重做的键(front/side/back/expr_*/costume/faces/palette 等)。
    各 regen 键出 n_candidates 后启发式挑一张。
    返回 (sheet_url, png_bytes, panel_urls, debug_info)。
    """
    if not (meta.name or "").strip():
        raise CharacterSheetError("角色名为空", status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(
            f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422
        )
    resolve_cjk_font(24)
    meta.design_notes = build_design_notes(meta)
    prompts = build_panel_prompts(meta)
    panels: dict[str, bytes] = dict(locked_panels or {})
    panel_urls: dict[str, str] = {}
    debug: dict[str, Any] = {
        "locked": sorted(panels.keys()),
        "regen_keys": list(regen_keys),
        "n_candidates": n_candidates,
        "openpose": {},
        "picks": {},
    }

    ckpt = ckpt_name or _SHEET_CKPT.get(meta.style, _SHEET_CKPT["anime"])
    client = await _pick_sheet_client(worker)

    # 锁定立绘必须有(表情/三视图参考)
    if "portrait" not in panels:
        raise CharacterSheetError("locked_panels 缺少 portrait", status_code=422)
    panel_urls["portrait"] = save_panel_png(
        panels["portrait"],
        character_id=character_id,
        style=meta.style,
        key="portrait",
    )

    ref_name: str | None = None
    face_ref_name: str | None = None
    try:
        ref_name = await client.upload_image(
            panels["portrait"],
            f"sheet_ref_{character_id[:8]}_{meta.style}.png",
        )
        face_bytes = crop_face_ref(panels["portrait"])
        face_ref_name = await client.upload_image(
            face_bytes,
            f"sheet_face_{character_id[:8]}_{meta.style}.png",
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("设定卡 regenerate:上传参考失败: %s", e)

    use_openpose, openpose_reason = await _probe_openpose_available(client)
    debug["openpose"] = {"enabled": use_openpose, "reason": openpose_reason}

    need = [k for k in regen_keys if k and k != "portrait"]
    turnaround_need = [k for k in need if k in ("front", "side", "back")]
    if turnaround_need and not use_openpose:
        raise CharacterSheetError(
            f"openpose 不可用,拒绝静默 IPA 出三视图({','.join(turnaround_need)}):"
            f"{openpose_reason}",
            status_code=503,
        )
    for key in need:
        if key == "costume":
            # 五件各出 n_candidates 再挑,再 collage;
            # 若 locked_panels 含 costume_<item>(如 costume_raincoat)则跳过该格,只重跑未锁定单品
            picked_items: list[bytes] = []
            suf = _STYLE_SUFFIX.get(meta.style, _STYLE_SUFFIX["anime"])
            locked_item_keys: list[str] = []
            regen_item_keys: list[str] = []
            costume_items = (
                _COSTUME_ITEMS_ANCIENT
                if meta.style == "ancient_realistic"
                else _COSTUME_ITEMS
            )
            for idx, (item_key, item_prompt) in enumerate(costume_items):
                lock_key = f"costume_{item_key}"
                if lock_key in panels and panels[lock_key]:
                    picked_items.append(panels[lock_key])
                    locked_item_keys.append(item_key)
                    continue
                regen_item_keys.append(item_key)
                cands: list[bytes] = []
                prompt = f"{item_prompt}, {suf}"
                if item_key == "boots":
                    prompt = (
                        "exactly two black rain boots only, one left boot and one right boot, "
                        "a single isolated pair centered large in frame with empty white space around, "
                        "NOT three, NOT four, NOT five, NOT a row, NOT a shelf, NOT repeated, "
                        "product still life, no person, "
                        + prompt
                        + ", footwear product photography, only two boots"
                    )
                elif item_key == "pants":
                    prompt = (
                        "single pair of long black trousers laid flat centered, full length to ankles, "
                        "one item only filling the frame, plain white background only, "
                        "NOT shorts, NOT multiple, NOT repeated, NOT a row of pants, "
                        "NOT empty panels, NOT UI mockup, NOT wireframe boxes, NOT empty slots, "
                        "product shot, no person, no mannequin, "
                        + prompt
                        + ", clothing flat lay only"
                    )
                elif item_key == "raincoat":
                    prompt = (
                        "flat lay complete black hooded raincoat only, hood and sleeves visible, "
                        "product shot, no person, no mannequin, garment fills frame, "
                        + prompt
                        + ", clothing only, not empty white frame"
                    )
                elif item_key == "umbrella":
                    prompt = (
                        "transparent clear umbrella only, open canopy with ribs, product shot, "
                        + prompt
                        + ", not a hat, not a lamp"
                    )
                elif item_key == "bag":
                    prompt = (
                        "white plastic shopping bag only, product shot, "
                        + prompt
                        + ", white polyethylene, not blue"
                    )
                # 服饰单品文生图。靴:先出「单只」再程序化镜像拼成一对(模型易出一排多靴)
                item_prompt_final = prompt
                if item_key == "boots":
                    item_prompt_final = (
                        "clean anime product illustration, ONE single black rubber rain boot only, "
                        "exactly one boot, solo wellington, visible shaft opening and thick sole, "
                        "glossy, large centered, empty white background, no text, "
                        "NOT a pair, NOT two boots, NOT three, NOT a row, NOT multiple, "
                        + item_prompt
                        + ", single footwear product only"
                    )
                rounds = 3 if item_key in ("boots", "pants", "beizi", "jiaoling", "sash", "hairpin", "fan") else 1
                for round_i in range(rounds):
                    for ci in range(max(1, n_candidates)):
                        # 古风单品平铺:写实 ckpt 易出着装人像,改用 anime 产品图再拼入深底卡
                        use_ckpt = ckpt
                        use_style = meta.style
                        wh = (768, 768) if meta.style == "anime" else (512, 512)
                        if meta.style == "ancient_realistic" and item_key in (
                            "beizi", "jiaoling", "sash", "hairpin", "fan", "ruqun"
                        ):
                            use_ckpt = "animagineXL40.safetensors"
                            use_style = "anime"
                            wh = (768, 768)
                            item_prompt_final = (
                                item_prompt_final
                                + ", anime product illustration, clothing flat lay catalog, "
                                "no person, no face, no hands"
                            )
                        w, h = wh
                        cands.append(
                            await generate_panel_bytes(
                                pool,
                                item_prompt_final,
                                ckpt_name=use_ckpt,
                                width=w,
                                height=h,
                                seed=None
                                if seed is None
                                else seed + 8000 + idx * 10 + ci + round_i * 170,
                                worker=worker,
                                filename_prefix=f"ToIV_char_sheet_costume_{item_key}",
                                style=use_style,
                                client=client,
                                ref_image=None,
                                ref_mode="none",
                                denoise=1.0,
                            )
                        )
                    best_try = _pick_best_candidate(cands, f"costume_{item_key}")
                    img = Image.open(BytesIO(best_try)).convert("RGB").resize((64, 64))
                    blobs = _count_dark_blobs(list(img.getdata()))
                    if item_key == "boots":
                        # 单靴目标:1 blob(或≤2);过多则再抽
                        if blobs <= 2:
                            break
                        logger.warning("单靴候选多件 blobs=%s,再抽", blobs)
                    elif item_key == "pants":
                        if blobs <= 3:
                            break
                    else:
                        break
                best = _pick_best_candidate(cands, f"costume_{item_key}")
                if item_key == "boots":
                    best = compose_boot_pair(best, style=meta.style)
                picked_items.append(best)
            panels["costume"] = collage_costume_items(picked_items, style=meta.style)
            debug["picks"]["costume"] = {
                "items": [k for k, _ in costume_items],
                "locked_items": locked_item_keys,
                "regen_items": regen_item_keys,
            }
            continue

        if key == "faces":
            # fix10c/d: 优先用已锁定三视图裁头肩锚定正/侧;3/4 与严格侧脸走 IPA(禁正脸 img2img 塌角度)
            face_keys = ("face_front", "face_three_quarter", "face_side")
            tri: dict[str, bytes] = {}
            face = face_ref_name or ref_name
            score_dbg: dict[str, Any] = {}
            head_front_name = None
            head_side_name = None
            if panels.get("front"):
                try:
                    head_front_name = await client.upload_image(
                        crop_head_from_figure(panels["front"]),
                        f"sheet_head_front_{character_id[:8]}.png",
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("faces: front headcrop upload fail: %s", e)
            if panels.get("side"):
                try:
                    side_head = crop_head_from_figure(panels["side"])
                    side_yaw = estimate_face_yaw_deg(side_head)
                    # 三视图「侧」若是回头过肩(yaw 偏低),禁止硬裁入卡;改走真侧脸 IPA
                    if side_yaw is not None and abs(float(side_yaw)) >= 55.0:
                        head_side_name = await client.upload_image(
                            side_head,
                            f"sheet_head_side_{character_id[:8]}.png",
                        )
                    else:
                        logger.warning(
                            "faces: side turnaround yaw=%s not profile, skip headcrop anchor",
                            side_yaw,
                        )
                        head_side_name = None
                except Exception as e:  # noqa: BLE001
                    logger.warning("faces: side headcrop upload fail: %s", e)
            for fk in face_keys:
                fk_cands: list[bytes] = []
                ang_neg = _FACE_ANGLE_NEGATIVE.get(fk, "")
                mode_used = "unknown"
                for fj in range(max(1, min(n_candidates, 5))):
                    fp = prompts.get(fk) or prompts["faces"]
                    if fk == "face_front" and head_front_name:
                        fd = await generate_panel_bytes(
                            pool, fp, ckpt_name=ckpt, width=768, height=768,
                            seed=None if seed is None else seed + (abs(hash(fk + str(fj))) % 10000),
                            worker=worker, filename_prefix=f"ToIV_char_sheet_{fk}",
                            style=meta.style, client=client, ref_image=head_front_name,
                            ref_mode="img2img", denoise=0.42, negative_extra=ang_neg,
                        )
                        mode_used = "ta_headcrop_img2img"
                    elif fk == "face_side" and head_side_name and fj < 2:
                        # 先用侧身头肩底保角度,再混 IPA 候选
                        fd = await generate_panel_bytes(
                            pool, fp, ckpt_name=ckpt, width=768, height=768,
                            seed=None if seed is None else seed + (abs(hash(fk + str(fj))) % 10000),
                            worker=worker, filename_prefix=f"ToIV_char_sheet_{fk}",
                            style=meta.style, client=client, ref_image=head_side_name,
                            ref_mode="img2img", denoise=0.40, negative_extra=ang_neg,
                        )
                        mode_used = "ta_headcrop_img2img+ipa_mix"
                    else:
                        # 3/4 与严格侧脸追加候选:IPA 不锁正脸姿态
                        fd = await generate_panel_bytes(
                            pool, fp, ckpt_name=ckpt, width=768, height=768,
                            seed=None if seed is None else seed + (abs(hash(fk + str(fj))) % 10000) + 91,
                            worker=worker, filename_prefix=f"ToIV_char_sheet_{fk}",
                            style=meta.style, client=client, ref_image=face,
                            ref_mode="ipa" if face else "none", denoise=1.0,
                            negative_extra=ang_neg,
                        )
                        mode_used = "ipa_angle" if face else "txt2img"
                    fd = enforce_head_shoulders_square(fd, size=768)
                    fk_cands.append(fd)
                best, meta_yaw = _pick_best_face_with_yaw(fk_cands, fk)
                tri[fk] = best
                score_dbg[fk] = {**meta_yaw, "mode": mode_used}
            panels["faces"] = compose_faces_triptych(
                tri, style=meta.style, size=_panel_size("faces", meta.style)
            )
            debug["picks"]["faces"] = {
                "mode": "triptych_headcrop_ipa_yaw",
                "keys": list(face_keys),
                "scores": score_dbg,
            }
            continue

        cands = []
        w, h = _panel_size(key, meta.style)
        for ci in range(max(1, n_candidates)):
            use_ref = None
            ref_mode = "none"
            denoise = 0.62
            prompt = prompts.get(key) or prompts.get("front", "")
            if key in ("front", "side", "back"):
                # 强化侧/背提示
                if key == "side":
                    prompt = (
                        prompts["side"]
                        + ", extreme side silhouette, ear visible, only one eye visible, "
                        "nose profile, 90 degree turn, NOT looking at camera"
                    )
                elif key == "back":
                    prompt = (
                        prompts["back"]
                        + ", completely back facing, no eyes, no nose, no mouth, "
                        "occiput and hood from behind only"
                    )
                if use_openpose:
                    # 真跑:上传程序骨架 → ControlNet(+IPA 主立绘) → 高度归一
                    assets = ensure_openpose_assets(height_cm=meta.height_cm or 165)
                    pose_path = assets[key]
                    pose_name = await client.upload_image(
                        pose_path.read_bytes(),
                        f"sheet_pose_{character_id[:8]}_{key}.png",
                    )
                    data = await generate_panel_bytes_openpose(
                        pool,
                        prompt,
                        pose_image_name=pose_name,
                        ckpt_name=ckpt,
                        width=w,
                        height=h,
                        seed=None
                        if seed is None
                        else seed + (abs(hash(key + str(ci))) % 10000),
                        worker=worker,
                        filename_prefix=f"ToIV_char_sheet_{key}_pose",
                        style=meta.style,
                        client=client,
                        ref_image=ref_name,
                        skip_preprocess=True,
                    )
                    data = normalize_turnaround_figure(data, out_w=w, out_h=h)
                    cands.append(data)
                    continue
                if ref_name:
                    use_ref = ref_name
                    ref_mode = "ipa"
                    denoise = 0.70
            elif key.startswith("expr_"):
                face = face_ref_name or ref_name
                if face:
                    use_ref = face
                    ref_mode = "img2img" if meta.style == "anime" else "ipa"
                    denoise = 0.68
            data = await generate_panel_bytes(
                pool,
                prompt,
                ckpt_name=ckpt,
                width=w,
                height=h,
                seed=None if seed is None else seed + (abs(hash(key + str(ci))) % 10000),
                worker=worker,
                filename_prefix=f"ToIV_char_sheet_{key}",
                style=meta.style,
                client=client,
                ref_image=use_ref,
                ref_mode=ref_mode,
                denoise=denoise,
            )
            cands.append(data)
        best = _pick_best_candidate(cands, key)
        if key.startswith("expr_"):
            best = enforce_head_shoulders_square(best, size=768)
        if key in ("front", "side", "back"):
            best = normalize_turnaround_figure(best, out_w=w, out_h=h)
        panels[key] = best
        debug["picks"][key] = {
            "n": len(cands),
            "blank_rejected": sum(1 for b in cands if _panel_is_blank_or_glitch(b)),
            "score": (
                _score_turnaround_candidate(best, key)
                if key in ("front", "side", "back")
                else (
                    _score_expression_head_ratio(best)
                    if key.startswith("expr_")
                    else None
                )
            ),
            "head_enforced": key.startswith("expr_"),
        }
        if key in ("front", "side", "back"):
            panel_urls[key] = save_panel_png(
                panels[key],
                character_id=character_id,
                style=meta.style,
                key=key,
            )

    # 拼版所需缺省键:用占位以免 compose 崩(faces 可用 front)
    if "faces" not in panels and "front" in panels:
        panels["faces"] = panels["front"]
    if "costume" not in panels:
        # 若未重做且未锁定,给浅色占位
        ph = placeholder_panel((220, 220, 226), _panel_size("costume", meta.style))
        buf = BytesIO()
        ph.convert("RGB").save(buf, format="PNG")
        panels["costume"] = buf.getvalue()
    for ek in _EXPR_KEYS:
        if ek not in panels and ek not in locked_panels:
            # 允许只重部分表情;缺的用立绘脸裁
            panels[ek] = crop_face_ref(panels["portrait"], size=768)

    png = compose_character_sheet(panels, meta)
    url = save_sheet_png(png, character_id=character_id, style=meta.style)
    return url, png, panel_urls, debug
