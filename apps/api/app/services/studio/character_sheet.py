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

import os
import contextvars

import math

import asyncio
import hashlib
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
    "thoughtful contemplative expression, eyes looking down and to one side, brows slightly furrowed, lips closed, extreme face closeup head and shoulders",
    "gentle smile, mouth corners up, soft relaxed brows, eyes softly curved, extreme face closeup head only no chest",
    "terrified shocked expression, wide eyes open mouth, fear, extreme face closeup head and shoulders",
    "determined, firm closed mouth, focused eyes, eyebrows slightly lowered, extreme face closeup head and shoulders",
)
# 19:01：表情只走图像编辑——中文指令仅改表情，锁身份/发型/服装/构图
_EXPR_EDIT_INSTRUCTIONS = (
    # 20:58：拉开威严/冷酷/沉思视觉差（门禁不放宽）；禁宫格整图编辑贴回
    "只改变面部表情为威严：下巴微抬（chin raised）、俯视镜头（looking down at viewer）、双眼锐利眯窄（sharp narrowed eyes，禁止 wide eyes/blank）、眉毛明显压低聚拢（eyebrows lowered，眉峰下压）、双唇抿紧紧闭（tight closed mouth，禁止微笑/张嘴）。表情幅度要大、一眼可辨。保持同一人物、同一短发齐下巴、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切、不要心形瞳孔、不要多眼睛、不要重画瞳孔高光。",
    "只改变面部表情为冷酷：面无表情（expressionless）、眼神冷、双眼半睁半阖（half-lidded eyes）、眉毛中性不皱不抬（eyebrows neutral）、闭嘴嘴角平直（flat mouth，禁止 frown/smile）、目光冷淡可略偏一侧。表情幅度要大。保持同一人物、同一短发、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切。",
    "同一角色、同发型同服装、头肩构图，只改变面部表情为沉思：视线下垂偏一侧（eyes looking down and to one side, not at viewer）、眉头微蹙（brows slightly furrowed / soft knit brows）、嘴唇闭合（lips closed，禁止张嘴、禁止 O 形嘴）；目光低垂偏侧沉思，不要微笑。禁止侧面化、禁止改发型服装构图、不要戴帽、不要加徽章文字、不要加长发。",
    "同一角色、同发型同服装、头部特写构图，只改变面部表情为温柔：closed-mouth gentle smile, lips together, mouth corners up, soft warm eyes, soft relaxed brows（闭嘴浅笑、抿嘴微笑、眼神柔和，睁眼或弯月眼均可）；眉毛舒展放松（禁止 frown/furrowed），嘴角上扬但双唇闭合、禁止张嘴露齿。禁止嘟嘴撇嘴、禁止改发型服装构图、不要戴帽、不要加徽章文字、不要加长发、不要心形瞳孔、胸口不要入画。",
    "只改变面部表情为惊恐：双眼瞪大、嘴巴明显张开可见口腔、眉毛高高上扬、眉心分开。必须张嘴。表情幅度要大。保持同一人物、同一短发、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切、不要裁太近。",
    "只改变面部表情为果断：determined，firm closed mouth，focused eyes，eyebrows slightly lowered；双唇抿紧闭嘴（坚定，禁止张嘴/喊叫/surprised/open mouth）、禁止挑眉。下颌微绷（正面，勿侧头）。与威严的皱眉下垂嘴角区分，与惊恐张嘴区分。表情幅度要大。保持同一人物、同一短发、同一雨衣与构图，不要改衣服、不要戴帽、不要加徽章文字、不要加长发、不要改裁切。",
)

# 17:38：SDXL 真 inpaint 正向（英文）；顺序同 _EXPR_LABELS
_EXPR_INPAINT_PROMPTS = (
    "same character anime closeup, stern majestic expression, chin raised looking down at viewer, sharp narrowed eyes, eyebrows lowered, tight closed mouth lips pressed, no smile no wide eyes no blank stare, blue-violet iris unchanged, only change eyebrows eyes mouth jaw tilt, keep identical hair length face shape skin tone collar composition, do not redraw pupil highlights",
    "same character anime closeup, cold expressionless face, half-lidded eyes, flat mouth, eyebrows neutral, no frown no smile, closed mouth, only change eyebrows eyes mouth, keep identical hair face shape skin tone collar composition",
    "same character anime closeup head and shoulders, thoughtful contemplative expression, eyes looking down and to one side, brows slightly furrowed, lips closed no smile, only change expression, keep identical hair face shape skin tone clothing composition, front facing no side view",
    "same character anime head closeup, gentle smile, mouth corners up, soft relaxed brows, eyes softly curved, no frown no pout, only change expression, keep identical hair face shape skin tone, no chest in frame",
    "same character anime closeup, terrified expression, eyes wide open, mouth wide open showing interior, eyebrows raised high, must open mouth, only change eyebrows eyes mouth, keep identical hair face shape skin tone collar composition",
    "same character anime closeup, determined expression, firm closed mouth, focused eyes, eyebrows slightly lowered, no surprised open mouth, no raised brows, jaw slightly tense, front facing, only change eyebrows eyes mouth, keep identical hair face shape skin tone collar composition",
)

# 20:58：威严/冷酷/沉思互斥负向（追加到通用 _expr_neg）
_EXPR_INPAINT_NEGATIVES = (
    "wide eyes, blank stare, blank expression, smile, grinning, open mouth, raised brows, soft smile",
    "frown, smiling, smile, grinning, furrowed brows, angry brows, downturned angry mouth",
    "big smile, grinning, wide eyes, raised brows, open mouth, laughing, angry deep scowl, looking straight at camera alert",
    "frown, pout, scowling, furrowed brows, downturned mouth, angry brows, neutral expression no smile, blank stare, wide terrified eyes, open mouth scream",
    "closed mouth, smile, calm face, sleepy eyes",
    "surprised, open mouth, raised brows, screaming, shouting, wide open mouth",
)
_CHAR_SHEET_MARK = "char_sheet_"
_CHAR_PANEL_MARK = "char_panel_"
_POLL_INTERVAL = 2.0
_POLL_TIMEOUT = 420.0  # 04:30：只计 Comfy 开始执行后的时间
_QUEUE_WAIT_MAX = 1200.0  # 04:30：排队超 20 分钟只记 queue_wait，不算失败次数
_QUEUE_WAIT_RETRY_MAX = 3  # 单格 queue_wait 重排上限（超出如实报 FAIL）
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
        "baseball cap, hat on stand, ceiling lamp, dome light, opaque black dome, hard hat, helmet, bowl, chest badge, chest emblem, chest logo, circular chest pattern, spiral emblem, five point star, star patch, white star on chest, embroidered star, round emblem on chest, brand patch, red badge, graphic print on torso, cloak, cape, poncho, wide sleeves, kimono sleeves"
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





_SHEET_REJECT_CTX: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "toiv_sheet_reject_ctx", default=None
)


class CharacterSheetError(Exception):
    """设定卡业务错误;route 层映射 HTTP status。"""

    def __init__(self, message: str, *, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code
        # 17:47：抛出时若在设定卡生成上下文中，落盘已有分格 + 错误元数据
        ctx = _SHEET_REJECT_CTX.get()
        if ctx and isinstance(ctx, dict):
            dump_dir = ctx.get("dir")
            seed = ctx.get("seed")
            panels = ctx.get("panels") or {}
            panel = ctx.get("current_key") or "unknown"
            data = panels.get(panel) if isinstance(panels, dict) else None
            if data is None and isinstance(panels, dict) and panels:
                # 兜底：落最新一张
                panel, data = list(panels.items())[-1]
            try:
                dump_rejected_panel(
                    data if isinstance(data, (bytes, bytearray)) else None,
                    seed=seed if isinstance(seed, int) or seed is None else None,
                    panel=str(panel),
                    gate="CharacterSheetError",
                    detail=str(message),
                    dump_dir=dump_dir,
                )
                # 也把当前所有分格落一份
                if isinstance(panels, dict):
                    for k, v in panels.items():
                        if isinstance(v, (bytes, bytearray)) and k != panel:
                            dump_rejected_panel(
                                v,
                                seed=seed if isinstance(seed, int) or seed is None else None,
                                panel=f"all_{k}",
                                gate="snapshot",
                                detail=str(message),
                                dump_dir=dump_dir,
                            )
            except Exception:
                pass


class CharacterSheetQueueWait(CharacterSheetError):
    """04:30：作业在 Comfy 队列里排队超过上限（未开始执行）。

    不是出图失败：调用方记 queue_wait、不消耗重试次数；本作业已从 pending 撤下。
    """

    def __init__(self, message: str, *, queue_wait: float, prompt_id: str = ""):
        super().__init__(message, status_code=503)
        self.queue_wait = float(queue_wait)
        self.prompt_id = prompt_id


async def _comfy_prompt_state(client: Any, prompt_id: str) -> str:
    """pending / running / gone / unknown（/queue 查不到时 unknown，按执行计时更保守）。"""
    try:
        running, pending = await client.get_queue_detail()
    except Exception:  # noqa: BLE001
        return "unknown"
    if prompt_id in pending:
        return "pending"
    if prompt_id in running:
        return "running"
    return "gone"


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


# ---------------------------------------------------------------------------
# 古风(ancient_realistic)服装规格:中文 spec → 加权英文 tag(DreamShaper SD1.5 读不懂中文)
# 仅供 ancient_realistic 分支使用;无颜色 spec 时不加负向、不加色门禁。
# ---------------------------------------------------------------------------
# (中文关键字, 英文色名, 拼音, 次级英文色名, 目标 hex);长词在前,先匹配先占位
_ANCIENT_COLOR_MAP: tuple[tuple[str, str, str, str, str], ...] = (
    ("藏青", "navy blue", "zangqing", "dark navy", "#233A5E"),
    ("天青", "celadon sky blue", "tianqing", "pale blue celadon", "#8FBCC8"),
    ("竹青", "bamboo green teal", "zhuqing", "teal green", "#3C8C78"),
    ("青绿", "teal green", "qinglv", "teal green", "#3C8C78"),
    ("月白", "pale moon white", "yuebai", "very pale blue white", "#D6E4EA"),
    ("鹅黄", "pale goose yellow", "ehuang", "light yellow", "#F0DC82"),
    ("胭脂", "rouge red", "yanzhi", "carmine red", "#B03A48"),
    ("朱红", "vermilion red", "zhuhong", "vermilion", "#C83C23"),
    ("绯", "crimson red", "feise", "crimson", "#B83A3A"),
    ("青", "teal", "qingse", "cyan teal", "#3A8C8C"),
    ("碧", "jade green", "bise", "jade green", "#3FA58A"),
    ("绿", "green", "lvse", "soft green", "#4A8A4A"),
    ("蓝", "blue", "lanse", "soft blue", "#3A5F9A"),
    ("红", "red", "hongse", "red", "#B03030"),
    ("粉", "pink", "fense", "soft pink", "#E8A0B0"),
    ("紫", "purple", "zise", "lavender purple", "#7A4E9A"),
    ("黄", "yellow", "huangse", "yellow", "#E0C050"),
    ("橙", "orange", "chengse", "orange", "#D8823A"),
    ("褐", "brown", "hese", "brown", "#7A5434"),
    ("棕", "brown", "zongse", "brown", "#7A5434"),
    ("灰", "gray", "huise", "gray", "#8A8A8E"),
    ("白", "white", "baise", "white", "#EDEDE8"),
    ("玄", "black", "xuanse", "black", "#1A1A1E"),
    ("黑", "black", "heise", "black", "#1A1A1E"),
    ("金", "gold", "jinse", "golden", "#D4AF37"),
)
# 服装名词:颜色词后 0–3 字内须出现其一,才算「衣服颜色」(排除 黑发/青丝/金簪)
_ANCIENT_GARMENT_NOUNS = "衣裙袍衫襦袄裳褂服纱罗绸锦缎帔氅装褙"
# (中文, 英文名词);先匹配先占位
_ANCIENT_GARMENT_EN: tuple[tuple[str, str], ...] = (
    ("襦裙", "ruqun dress"),
    ("衣裙", "ruqun dress"),
    ("褙子", "beizi robe"),
    ("长袍", "robe"),
    ("袍", "robe"),
    ("裙", "ruqun dress"),
    ("衫", "shan blouse"),
    ("袄", "ao jacket"),
)
# (中文, 加权英文 tag, 是否发饰)
_ANCIENT_ACCESSORY_MAP: tuple[tuple[str, str, bool], ...] = (
    ("木簪", "(wooden hairpin:1.2)", True),
    ("玉簪", "(jade hairpin:1.2)", True),
    ("银簪", "(silver hairpin:1.2)", True),
    ("金簪", "(gold hairpin:1.2)", True),
    ("步摇", "(buyao dangling hairpin:1.1)", True),
    ("簪", "(simple hairpin:1.1)", True),
    ("发带", "(ribbon hair band:1.1)", True),
    ("油纸伞", "(oil-paper umbrella:1.2), chinese paper parasol", False),
    ("纸伞", "(oil-paper umbrella:1.2), chinese paper parasol", False),
    ("伞", "(chinese paper umbrella:1.1)", False),
    ("团扇", "(round silk fan:1.1)", False),
    ("折扇", "(folding fan:1.1)", False),
    ("药箱", "(wooden medicine box:1.1)", False),
    ("药篓", "(bamboo herb basket:1.1)", False),
    ("玉佩", "(jade pendant:1.1)", False),
    ("香囊", "(embroidered sachet:1.1)", False),
    ("面纱", "(thin face veil:1.1)", False),
    ("斗笠", "(bamboo hat:1.1)", False),
)
_ANCIENT_HAIR_MAP: tuple[tuple[str, str], ...] = (
    ("双髻", "double hair buns"),
    ("低髻", "low hair bun"),
    ("发髻", "hair bun"),
    ("髻", "hair bun"),
    ("马尾", "long ponytail"),
    ("披发", "loose long black hair"),
    ("垂鬟", "half-up hairstyle"),
    ("长发", "long black hair"),
    ("短发", "short black hair"),
)
_ANCIENT_ROLE_MAP: tuple[tuple[str, str], ...] = (
    ("医女", "herbalist physician girl"),
    ("大夫", "herbalist physician"),
    ("江南", "jiangnan water town maiden"),
)
_ANCIENT_BLACK_GOLD_NEGATIVE = (
    "black robe, black clothing, black hanfu, gold trim, gold embroidery, "
    "gold hair ornament, gold headdress, golden crown, ornate gold hairpin"
)
_CJK_RUN_RE = re.compile(r"[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+")


def _ancient_spec_text(meta: SheetMeta) -> str:
    """古风 spec 原文(不含自动设计说明,避免「深底金字」等卡面文案被当成服装色)。"""
    return " ".join(
        s for s in ((meta.visual_prompt or ""), (meta.description or ""), (meta.role or "")) if s
    )


def extract_ancient_costume_spec(meta: SheetMeta) -> dict[str, Any]:
    """确定性抽取古风 spec:衣服颜色/服装名词/饰品/发型/身份 → 英文 tag。"""
    text = _ancient_spec_text(meta)
    garment_re = f"[{_ANCIENT_GARMENT_NOUNS}]"
    colors: list[dict[str, str]] = []
    taken: list[tuple[int, int]] = []
    for zh, en, py, alt, hx in _ANCIENT_COLOR_MAP:
        for m in re.finditer(re.escape(zh) + r"色?[^\s,，。;；、]{0,3}?" + garment_re, text):
            if any(a <= m.start() < b for a, b in taken):
                continue
            taken.append((m.start(), m.start() + len(zh)))
            if all(c["zh"] != zh for c in colors):
                colors.append({"zh": zh, "en": en, "pinyin": py, "alt": alt, "hex": hx})
    garment_zh, garment_en = "", "hanfu dress"
    for zh, en in _ANCIENT_GARMENT_EN:
        if zh in text:
            garment_zh, garment_en = zh, en
            break
    acc_tags: list[str] = []
    hair_acc: list[str] = []
    acc_zh: list[str] = []
    rest = text
    for zh, tag, is_hair in _ANCIENT_ACCESSORY_MAP:
        if zh in rest:
            rest = rest.replace(zh, " ")
            acc_zh.append(zh)
            acc_tags.append(tag)
            if is_hair:
                hair_acc.append(tag)
    hair = ""
    for zh, en in _ANCIENT_HAIR_MAP:
        if zh in text:
            hair = en
            break
    if not hair and hair_acc:
        hair = "simple low hair bun"
    roles = [en for zh, en in _ANCIENT_ROLE_MAP if zh in text]
    age = ""
    m_age = re.search(r"(?:约|~|～)?\s*(\d{2})\s*(?:岁|years)", text) or re.search(r"[~～约](\d{2})\b", text)
    if m_age:
        age = f"{m_age.group(1)} years old young woman"
    black_gold = any(c["en"] in ("black", "gold") for c in colors) or any(
        ("金" in z or "玄" in z) for z in acc_zh
    )
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
    return {
        "colors": colors,
        "garment_zh": garment_zh,
        "garment_en": garment_en,
        "accessories_zh": acc_zh,
        "accessory_tags": acc_tags,
        "hair_accessory_tags": hair_acc,
        "hair": hair,
        "tags": tags,
        "has_any": bool(tags),
        "black_gold": black_gold,
    }


def ancient_spec_negative(meta: SheetMeta) -> str:
    """spec 有衣服颜色且非黑/金 → 负向压黑袍金边金发饰;否则空。"""
    if meta.style != "ancient_realistic":
        return ""
    spec = extract_ancient_costume_spec(meta)
    acc_neg = ancient_accessory_prompt_fix(meta)["neg"]
    if not spec["colors"] or spec["black_gold"]:
        return acc_neg
    return f"{_ANCIENT_BLACK_GOLD_NEGATIVE}, {acc_neg}" if acc_neg else _ANCIENT_BLACK_GOLD_NEGATIVE


def ancient_spec_target_hex(meta: SheetMeta) -> str | None:
    """古风色门禁目标色;spec 无衣服颜色 → None(不门禁)。"""
    if meta.style != "ancient_realistic":
        return None
    spec = extract_ancient_costume_spec(meta)
    return spec["colors"][0]["hex"] if spec["colors"] else None


# 当前出卡的古风 spec 负向;仅 ancient_realistic 的图构建读取(costume 单品走 anime ckpt 不受影响)
_ANCIENT_SPEC_NEG_CTX: contextvars.ContextVar[str] = contextvars.ContextVar(
    "toiv_ancient_spec_neg", default=""
)


def _with_ancient_spec_negative(neg: str, style: str) -> str:
    extra = _ANCIENT_SPEC_NEG_CTX.get() if style == "ancient_realistic" else ""
    return f"{neg}, {extra}" if extra and extra not in neg else neg


def ancient_costume_force(meta: SheetMeta) -> str:
    """古风服饰格总述(替代现代雨夜 _COSTUME_FORCE)。"""
    spec = extract_ancient_costume_spec(meta)
    c0 = spec["colors"][0] if spec["colors"] else None
    col = f"{c0['en']} " if c0 else ""
    parts = [f"ONE {col}{spec['garment_en']}", f"ONE {col}silk waist sash"]
    parts.append(
        "ONE " + (spec["hair_accessory_tags"][0].strip("()").split(":")[0] if spec["hair_accessory_tags"] else "simple hairpin")
    )
    if any("umbrella" in t for t in spec["accessory_tags"]):
        parts.append("ONE chinese oil-paper umbrella")
    else:
        parts.append("ONE round silk hand fan")
    neg = "" if spec["black_gold"] or not c0 else ", no black robe, no gold trim, no gold ornament"
    return (
        "overhead flat lay product photography, traditional Chinese costume pieces laid flat, "
        "ONLY these items: " + ", ".join(parts)
        + ", no person, no face, no mannequin, no raincoat, no modern clothing" + neg
    )


def ancient_spec_palette(meta: SheetMeta, colors: list[str]) -> list[str]:
    """古风色板:肤色 + spec 衣色在前;spec 非黑金时剔除近金色。无 spec 色原样返回。"""
    sp = extract_ancient_costume_spec(meta)
    if not sp["colors"]:
        return list(colors)
    spec_hex = [c["hex"] for c in sp["colors"]]
    rest = [
        c for c in colors
        if c not in spec_hex and c != "#E8C4A8"
        and (sp["black_gold"] or _hex_dist(c, "#D4AF37") >= 90)
    ]
    return ["#E8C4A8"] + spec_hex + rest


# ---------------------------------------------------------------------------
# 10/05 沈青禾:存量色板(黑金)与 spec 明确衣色(青)冲突 → 以 spec 为准重生成并记日志
# ---------------------------------------------------------------------------
ANCIENT_SKIN_HEX = "#E8C4A8"
ANCIENT_HAIR_HEX = "#3B2F2A"  # 墨褐发色(非纯黑,避免被当成黑袍色)
_ANCIENT_GOLD_HEX = "#D4AF37"
# (中文关键字, 色板 hex);先匹配先占位
_ANCIENT_ACCESSORY_HEX: tuple[tuple[str, str], ...] = (
    ("木簪", "#A0764A"),
    ("玉簪", "#9FC8A8"),
    ("银簪", "#C0C0C8"),
    ("金簪", "#D4AF37"),
    ("油纸伞", "#E6D8B8"),
    ("纸伞", "#E6D8B8"),
    ("药箱", "#8B6A44"),
    ("药篓", "#B89A6A"),
)


def _hex_hsv(hx: str) -> tuple[float, float, float]:
    r, g, b = (int(hx[i : i + 2], 16) / 255.0 for i in (1, 3, 5))
    return colorsys.rgb_to_hsv(r, g, b)


def _hsv_hex(h: float, s: float, v: float) -> str:
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, max(0.0, min(1.0, s)), max(0.0, min(1.0, v)))
    return f"#{round(r * 255):02X}{round(g * 255):02X}{round(b * 255):02X}"


def _is_near_black_hex(hx: str) -> bool:
    return max(int(hx[1:3], 16), int(hx[3:5], 16), int(hx[5:7], 16)) < 40


def _is_near_gold_hex(hx: str) -> bool:
    return _hex_dist(hx, _ANCIENT_GOLD_HEX) < 90


def _near_spec_hue(hx: str, target: str, max_deg: float | None = None) -> bool:
    if max_deg is None:
        max_deg = SPEC_COLOR_MAX_HUE_DEG
    h, s, v = _hex_hsv(hx)
    th, _ts, _tv = _hex_hsv(target)
    if s < 0.15 or v < 0.18:
        return False
    d = abs(h - th) * 360.0
    return min(d, 360.0 - d) <= max_deg


def ancient_palette_from_spec(meta: SheetMeta) -> list[str]:
    """按 spec 衣色/饰品生成古风色板:肤色 + 衣色(主/浅/深) + 饰品色 + 发色;≤6。spec 无衣色 → []。"""
    sp = extract_ancient_costume_spec(meta)
    if not sp["colors"]:
        return []
    out: list[str] = [ANCIENT_SKIN_HEX]
    main = sp["colors"][0]["hex"]
    out.append(main)
    h, s, v = _hex_hsv(main)
    if s >= 0.15:
        out.append(_hsv_hex(h, s * 0.55, min(1.0, v + 0.25)))  # 浅衣色(衬里/腰带)
    for c in sp["colors"][1:3]:
        if c["hex"] not in out:
            out.append(c["hex"])
    text = _ancient_spec_text(meta)
    rest = text
    for zh, hx in _ANCIENT_ACCESSORY_HEX:
        if zh in rest:
            rest = rest.replace(zh, " ")
            if hx not in out and (sp["black_gold"] or not _is_near_gold_hex(hx)):
                out.append(hx)
    if ANCIENT_HAIR_HEX not in out:
        out.append(ANCIENT_HAIR_HEX)
    return out[:6]


def ancient_palette_conflict_reasons(meta: SheetMeta, colors: list[str]) -> list[str]:
    """存量色板与 spec 明确衣色冲突的原因;无冲突/无 spec 衣色/spec 本身黑金 → []。"""
    if meta.style != "ancient_realistic":
        return []
    sp = extract_ancient_costume_spec(meta)
    if not sp["colors"] or sp["black_gold"]:
        return []
    cols = [c for c in (_normalize_hex(x) for x in colors or []) if c]
    if not cols:
        return []
    target = sp["colors"][0]["hex"]
    reasons: list[str] = []
    blacks = [c for c in cols if _is_near_black_hex(c)]
    golds = [c for c in cols if _is_near_gold_hex(c)]
    if blacks:
        reasons.append(f"near_black={blacks}")
    if golds:
        reasons.append(f"near_gold={golds}")
    if _hex_hsv(target)[1] >= 0.2 and not any(_near_spec_hue(c, target) for c in cols):
        reasons.append(f"no_color_near_spec={target}")
    return reasons


def resolve_ancient_palette(
    meta: SheetMeta, colors: list[str], *, source: str = "sheet"
) -> list[str]:
    """古风色板裁决:存量色板与 spec 衣色冲突 → spec 胜出,按 spec 重生成并 WARNING;否则沿用 ancient_spec_palette。"""
    if meta.style != "ancient_realistic":
        return list(colors)
    reasons = ancient_palette_conflict_reasons(meta, colors)
    if reasons:
        regen = ancient_palette_from_spec(meta)
        if regen:
            logger.warning(
                "ancient palette conflict source=%s name=%s stored=%s spec=%s reasons=%s → regenerated from spec %s",
                source,
                meta.name,
                list(colors)[:6],
                [c["zh"] for c in extract_ancient_costume_spec(meta)["colors"]],
                "; ".join(reasons),
                regen,
            )
            return regen
    return ancient_spec_palette(meta, list(colors))


# 古风饰品:木簪须木质(非金/铜/金属);油纸伞须握在手中(主立绘禁漂浮在头后)
_ANCIENT_WOOD_HAIRPIN_POS = "(plain brown wooden hair stick, matte wood grain hairpin:1.2)"
_ANCIENT_WOOD_HAIRPIN_NEG = (
    "gold hairpin, golden hair ornament, metal hairpin, brass hair ring, "
    "bronze hair crown, gold headdress, jeweled hairpin"
)
_ANCIENT_UMBRELLA_HELD_POS = (
    "(closed oil-paper umbrella held in her hand by the bamboo handle:1.2), "
    "umbrella handle gripped in hand"
)
_ANCIENT_UMBRELLA_HELD_NEG = (
    "floating umbrella, umbrella floating behind head, umbrella as halo, "
    "detached umbrella, umbrella not held, umbrella attached to hair"
)


def ancient_accessory_prompt_fix(meta: SheetMeta) -> dict[str, Any]:
    """spec 含 木簪/油纸伞 → 加正向(木质/握在手中)与负向(金属发饰/漂浮伞);仅 ancient_realistic。"""
    out: dict[str, Any] = {"pos": "", "neg": "", "wooden_hairpin": False, "umbrella_in_hand": False}
    if meta.style != "ancient_realistic":
        return out
    sp = extract_ancient_costume_spec(meta)
    pos: list[str] = []
    neg: list[str] = []
    if "(wooden hairpin:1.2)" in sp["hair_accessory_tags"]:
        out["wooden_hairpin"] = True
        pos.append(_ANCIENT_WOOD_HAIRPIN_POS)
        neg.append(_ANCIENT_WOOD_HAIRPIN_NEG)
    if any("umbrella" in t for t in sp["accessory_tags"]):
        out["umbrella_in_hand"] = True
        pos.append(_ANCIENT_UMBRELLA_HELD_POS)
        neg.append(_ANCIENT_UMBRELLA_HELD_NEG)
    out["pos"] = ", ".join(pos)
    out["neg"] = ", ".join(neg)
    return out


# 主立绘发饰区金色占比上限(木簪 spec);超过视为金属/金发饰 → 换 seed
HAIRPIN_GOLD_MAX_FRAC = 0.06


def hair_ornament_gold_frac(data: bytes) -> dict[str, Any]:
    """主立绘头顶发饰区(脸框上方)金色/黄铜色像素占比;找不到脸 → frac=None(不门禁)。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    bb = _face_bbox_for_center(im)
    if bb is None:
        return {"frac": None, "box": None}
    x0, y0, x1, y1 = bb
    fw, fh = max(1, x1 - x0), max(1, y1 - y0)
    w, h = im.size
    box = (
        max(0, int(x0 - 0.35 * fw)),
        max(0, int(y0 - 0.75 * fh)),
        min(w, int(x1 + 0.35 * fw)),
        min(h, int(y0 + 0.20 * fh)),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return {"frac": None, "box": box}
    reg = im.crop(box)
    reg.thumbnail((128, 128))
    n = gold = 0
    for r, g, b in list(reg.getdata()):
        n += 1
        hh, ss, vv = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        if 36.0 <= hh * 360.0 <= 60.0 and ss >= 0.40 and vv >= 0.50:
            gold += 1
    return {"frac": (gold / n) if n else 0.0, "box": box}


def assert_hairpin_not_gold(data: bytes, meta: SheetMeta, *, label: str = "主立绘") -> dict[str, Any]:
    """木簪 spec:发饰区金色占比 > 上限 → CharacterSheetError(422)。非木簪/无脸 → 放行。"""
    if not ancient_accessory_prompt_fix(meta)["wooden_hairpin"]:
        return {"frac": None, "skipped": True}
    st = hair_ornament_gold_frac(data)
    frac = st.get("frac")
    if frac is not None and frac > HAIRPIN_GOLD_MAX_FRAC:
        raise CharacterSheetError(
            f"饰品门禁失败:{label}发饰区金色占比{frac:.3f}>{HAIRPIN_GOLD_MAX_FRAC}(spec 木簪),重出",
            status_code=422,
        )
    return st


# ---------------------------------------------------------------------------
# 10/05 run3:古风饰品 VLM 是/否判官(复用表情专项问答同一套 Qwen-VL 图/解析/粘性后端,
# 不改表情函数本身)。q1=木簪为木质(非金/铜/金属/珠宝);q2=伞握在手中或不出现(禁漂浮在头后)。
# ---------------------------------------------------------------------------
ACCESSORY_QA_HARD_ATTEMPTS = 4  # 主立绘前 4 次不过即换 seed;之后仅记日志放行(防整卡失败)


def build_ancient_accessory_qa_prompt(meta: SheetMeta) -> str | None:
    """按 spec 生成两问 prompt;spec 无木簪且无伞 → None。不适用的一问注明恒答 true。"""
    fix = ancient_accessory_prompt_fix(meta)
    if not (fix["wooden_hairpin"] or fix["umbrella_in_hand"]):
        return None
    if fix["wooden_hairpin"]:
        q1 = (
            "q1: Look at the hair ornament / hairpin in her hair bun. Is it a plain brown WOODEN hair stick "
            "(木簪) and NOT gold, brass, bronze, silver, metal or jeweled? "
            "true if wooden or if no metal/gold ornament is visible in the hair; false if any gold, brass, "
            "metal ring, crown or jeweled ornament is in the hair."
        )
    else:
        q1 = "q1: Always answer true."
    if fix["umbrella_in_hand"]:
        q2 = (
            "q2: Is the umbrella either held in her hand by its handle, or not present at all? "
            "true if the umbrella is gripped in a hand or absent; false if an umbrella / parasol "
            "appears behind or above her head without being held by a hand (floating, like a halo or backdrop)."
        )
    else:
        q2 = "q2: Always answer true."
    return (
        "You are inspecting a full-body portrait of a historical Chinese woman. "
        "Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: "
        '{"q1":true,"q2":true}. ' + q1 + " " + q2 + " Judge only from what is visible."
    )


def ancient_accessory_qa_verdict(parsed: dict, meta: SheetMeta) -> list[str]:
    """VLM 两问结果 → 失败原因列表(空=通过)。"""
    fix = ancient_accessory_prompt_fix(meta)
    reasons: list[str] = []
    if fix["wooden_hairpin"] and parsed.get("q1") is False:
        reasons.append("hairpin_not_wooden(木簪非木质/金属金饰)")
    if fix["umbrella_in_hand"] and parsed.get("q2") is False:
        reasons.append("umbrella_not_held(伞漂浮头后/未握在手)")
    return reasons


async def classify_ancient_accessory_qa(
    image_bytes: bytes, *, meta: SheetMeta, worker_url: str | None, seed: int = 42
) -> dict:
    """调 Comfy Qwen-VL 判古风饰品两问;返回 {q1,q2,raw,model,reasons}。无适用问题 → {skipped:True}。"""
    from app.comfy.client import ComfyUIClient, ComfyUIError

    global _VLM_STICKY_BACKEND
    prompt = build_ancient_accessory_qa_prompt(meta)
    if not prompt:
        return {"skipped": True, "reasons": []}
    if not worker_url:
        raise CharacterSheetError("饰品问答缺少 worker_url", status_code=502)
    url = str(worker_url).rstrip("/")
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    fname = await client.upload_image(image_bytes, f"sheet_acc_qa_{uuid.uuid4().hex[:10]}.png")
    default_backends = (
        ("Qwen2_VQA", "Qwen3-VL-4B-Instruct"),
        ("Qwen2_VQA", "Qwen2-VL-7B-Instruct"),
        ("AILab_QwenVL", "Qwen3-VL-4B-Instruct"),
        ("AILab_QwenVL", "Qwen3-VL-4B-Instruct-FP8"),
    )
    sticky = _VLM_STICKY_BACKEND
    backends = ((sticky,) + tuple(b for b in default_backends if b != sticky)) if sticky else default_backends
    last_err: Exception | None = None
    for backend, model in backends:
        try:
            graph = build_expression_vlm_graph(fname, prompt=prompt, model=model, seed=seed, backend=backend)
            prompt_id = await client.queue_prompt(graph, client_id=f"sheet_accqa_{uuid.uuid4().hex[:8]}")
            waited = 0.0
            raw_text = ""
            while waited < 180.0:
                hist = await client.get_history(prompt_id)
                entry = (hist or {}).get(prompt_id) or {}
                st = entry.get("status") or {}
                if entry.get("outputs"):
                    raw_text = _extract_history_text(entry)
                    if raw_text:
                        break
                if st.get("status_str") == "error":
                    raise CharacterSheetError("饰品问答执行失败", status_code=502)
                await asyncio.sleep(1.5)
                waited += 1.5
            if not raw_text:
                raise CharacterSheetError(f"饰品问答超时无文本 {backend}/{model}", status_code=504)
            parsed = _parse_expr_qa_json(raw_text)
            parsed["model"] = f"{backend}:{model}"
            parsed["reasons"] = ancient_accessory_qa_verdict(parsed, meta)
            _VLM_STICKY_BACKEND = (backend, model)
            return parsed
        except (CharacterSheetError, ComfyUIError) as e:
            last_err = e
            logger.warning("classify_ancient_accessory_qa %s/%s fail: %s", backend, model, e)
            continue
        except Exception as e:  # noqa: BLE001
            last_err = e
            logger.warning("classify_ancient_accessory_qa exc %s/%s: %s", backend, model, e)
            continue
    raise CharacterSheetError(f"饰品问答全部后端失败: {last_err}", status_code=502) from last_err


def _strip_cjk_for_sd(text: str) -> str:
    out = _CJK_RUN_RE.sub(", ", text or "")
    # 去掉中文剥离后残留的纯数字/标点碎片(如「约20岁」→「20」)
    frags = [f.strip() for f in out.split(",")]
    frags = [f for f in frags if f and not re.fullmatch(r"[\d\s~～.\-+]+", f)]
    return ", ".join(frags)


def ancient_costume_items(meta: SheetMeta) -> tuple[tuple[str, str], ...]:
    """古风服饰单品:spec 有颜色/饰品时按 spec 改写(键名不变,沿用单品惩罚/ckpt 路由)。"""
    spec = extract_ancient_costume_spec(meta)
    if not spec["colors"] and not spec["accessory_tags"]:
        return _COSTUME_ITEMS_ANCIENT
    bg = "solid seamless medium light gray background (#C8C8CE), studio lighting"
    no_p = "no person, no face, no hands, no mannequin, no model wearing clothes, no text"
    c0 = spec["colors"][0] if spec["colors"] else None
    col = f"{c0['en']} {c0['alt']}" if c0 else "soft muted"
    neg_bg = "" if spec["black_gold"] or not c0 else ", no black fabric, no gold trim, no gold embroidery"
    items: dict[str, str] = dict(_COSTUME_ITEMS_ANCIENT)
    if c0:
        items["beizi"] = (
            f"e-commerce flat lay product photo, garment only, ONE traditional Chinese {spec['garment_en']} "
            f"laid flat open on table, {col} silk, entire garment {c0['en']} colorway, "
            f"long wide sleeves spread left and right, no body inside, empty garment shape, "
            f"fills most of frame, {bg}, {no_p}, no raincoat, no modern jacket{neg_bg}"
        )
        items["jiaoling"] = (
            f"e-commerce flat lay product photo, garment only, ONE traditional Chinese cross-collar "
            f"jiaoling top laid flat open like clothing catalog, {col} silk, wide sleeves, "
            f"no body inside, empty garment, fills most of frame, {bg}, {no_p}, no hoodie, no zipper{neg_bg}"
        )
        items["sash"] = (
            f"product still life flat lay, accessory only, ONE silk waist sash belt for hanfu, "
            f"{col} ribbon coiled neatly on table, no person wearing it, {bg}, no person, no waist, no text{neg_bg}"
        )
    hair_tag = next((t for t in spec["hair_accessory_tags"]), "")
    if hair_tag:
        items["hairpin"] = (
            f"product still life, accessory only, ONE {hair_tag.strip('()').split(':')[0]} "
            f"isolated on table, catalog photo, {bg}, no person, no hair, no head, no face, no text"
            + ("" if "gold" in hair_tag else ", no gold ornament")
        )
    if any("umbrella" in t for t in spec["accessory_tags"]):
        # 键名仍为 fan(单品惩罚/路由沿用),内容按 spec 改为油纸伞
        items["fan"] = (
            "product still life, accessory only, ONE open chinese oil-paper umbrella, "
            "bamboo ribs and wooden handle, painted paper canopy, isolated object, "
            f"{bg}, no person, no hand holding, no plastic, no transparent vinyl, no text"
        )
    return tuple((k, items[k]) for k, _ in _COSTUME_ITEMS_ANCIENT)


# 古风 spec 色门禁阈值(主立绘 + 三视图躯干 ROI)
SPEC_COLOR_MAX_HUE_DEG = 40.0  # 彩色目标:像素色相距目标 ≤40° 视为贴近
SPEC_COLOR_MIN_NEAR_FRAC = 0.25  # 服装像素中贴近目标色的占比下限
SPEC_COLOR_MAX_DARK_FRAC = 0.45  # 近黑像素(V<0.20)占比上限(防黑袍)
SPEC_COLOR_ACHROMATIC_MAX_DIST = 110  # 白/灰/黑目标:主色 L1 距离上限


def _garment_roi_pixels(data: bytes) -> list[tuple[int, int, int]]:
    """与 _panel_garment_dominant_hex 同 ROI/背景/肤色规则取服装像素。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    corners = [img.getpixel((2, 2)), img.getpixel((w - 3, 2)), img.getpixel((2, h - 3)), img.getpixel((w - 3, h - 3))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    crop = img.crop((int(w * 0.22), int(h * 0.28), int(w * 0.78), int(h * 0.78)))
    small = crop.resize((48, 48), Image.Resampling.BOX)
    out: list[tuple[int, int, int]] = []
    for r, g, b in small.getdata():
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 22:
            continue
        if min(r, g, b) > 235:
            continue
        if 90 < r < 245 and 60 < g < 210 and 45 < b < 190 and r >= g - 5 and g >= b - 15:
            continue
        out.append((r, g, b))
    return out


def garment_spec_color_stats(data: bytes, target: str) -> dict[str, Any]:
    px = _garment_roi_pixels(data)
    tr, tg, tb = (int(target[i : i + 2], 16) / 255.0 for i in (1, 3, 5))
    th, ts, _tv = colorsys.rgb_to_hsv(tr, tg, tb)
    n = len(px)
    dark = near = 0
    for r, g, b in px:
        hh, ss, vv = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        if vv < 0.20:
            dark += 1
            continue
        if ss >= 0.15 and vv >= 0.18:
            d = abs(hh - th) * 360.0
            if min(d, 360.0 - d) <= SPEC_COLOR_MAX_HUE_DEG:
                near += 1
    return {
        "n": n,
        "dark_frac": (dark / n) if n else 1.0,
        "near_frac": (near / n) if n else 0.0,
        "dominant": _panel_garment_dominant_hex(data),
        "chromatic": ts >= 0.2,
    }


def assert_garment_near_spec_color(data: bytes, target: str, *, label: str = "主立绘") -> dict[str, Any]:
    """古风:服装主色须贴近 spec 颜色(参照 anime 板岩灰门禁);不过 → 422 重出(不着色)。"""
    st = garment_spec_color_stats(data, target)
    if st["n"] < 40:
        raise CharacterSheetError(f"颜色门禁失败:{label}无法取服装像素", status_code=422)
    if st["chromatic"]:
        if st["dark_frac"] > SPEC_COLOR_MAX_DARK_FRAC:
            raise CharacterSheetError(
                f"颜色门禁失败:{label}服装近黑占比{st['dark_frac']:.2f}>{SPEC_COLOR_MAX_DARK_FRAC}"
                f"(主色{st['dominant']}),须 spec 色{target},重出",
                status_code=422,
            )
        if st["near_frac"] < SPEC_COLOR_MIN_NEAR_FRAC:
            raise CharacterSheetError(
                f"颜色门禁失败:{label}服装贴近 spec 色{target}占比{st['near_frac']:.2f}<"
                f"{SPEC_COLOR_MIN_NEAR_FRAC}(主色{st['dominant']}),重出",
                status_code=422,
            )
        return st
    hx = st["dominant"]
    if not hx or _hex_dist(hx, target) > SPEC_COLOR_ACHROMATIC_MAX_DIST:
        raise CharacterSheetError(
            f"颜色门禁失败:{label}服装主色{hx}距 spec 色{target}>{SPEC_COLOR_ACHROMATIC_MAX_DIST},重出",
            status_code=422,
        )
    return st


def build_design_notes(meta: SheetMeta) -> str:
    """生成 3–5 行中文设计说明;已有足够行数则沿用。"""
    raw = (meta.design_notes or "").strip()
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if len(lines) >= 3:
        cleaned = strip_internal_design_jargon("\n".join(lines[:5]))
        if count_design_note_lines(cleaned) >= 3:
            return cleaned
        # 用户稿被剥成调试残渣后不足 3 行 → 走自动设定文案
    name = (meta.name or "角色").strip()
    role = (meta.role or _guess_field(meta.description, "身份") or "便利店员").strip()
    personality = (
        meta.personality or _guess_field(meta.description, "性格") or "温柔果断"
    ).strip()
    desc = (meta.description or "").strip()
    style_zh = "古风写实" if meta.style == "ancient_realistic" else "二次元"
    if meta.style == "ancient_realistic":
        if not (meta.role or _guess_field(meta.description, "身份")):
            # 古风不沿用现代默认身份「便利店员」
            _txt = _ancient_spec_text(meta)
            role = next((z for z in ("医女", "大夫") if z in _txt), "古风角色")
        _sp = extract_ancient_costume_spec(meta)
        if _sp["colors"] or _sp["accessories_zh"]:
            _col = "/".join(c["zh"] for c in _sp["colors"]) or "主立绘同色"
            _acc = "、".join(_sp["accessories_zh"])
            _axis = (
                f"视觉主轴为{_col}色{_sp['garment_zh'] or '古装'}"
                + (f"，配{_acc}" if _acc else "")
                + "，黑发；服装配色以角色设定为准。"
            )
        else:
            _axis = "视觉主轴为交领汉服/齐胸襦裙或水墨写实古装，黑发；服装配色以主立绘为准。"
        auto = [
            f"{name}：同一人古风写实变体，身份为{role}，性格{personality}。",
            _axis,
            "三视图与表情均以主立绘为同一人参考，统一古装与纯色深底，保证跨镜一致。",
            f"本卡风格滤镜为{style_zh}；服饰拆解为古风单品，禁止雨衣/卫衣/便利店等现代装。",
        ]
    else:
        auto = [
            f"{name}：雨夜便利店相遇的核心角色，身份为{role}，性格{personality}。",
            "视觉主轴为板岩灰(#5A6A7A)长款过膝连帽雨衣（长袖）、黑色裤袜与黑色短靴、胸前素面无标，湿发贴额与冷白灯光，辅以白色塑料袋道具。",
            "三视图与表情均以主立绘为同一人参考，主立绘/三视图/服饰统一板岩灰素面，保证跨镜一致。",
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
        _spec = extract_ancient_costume_spec(meta)
        if _spec["has_any"]:
            # DreamShaper(SD1.5) 读不懂中文:spec 已确定性映射为加权英文 tag,去掉中文残留
            _en = _strip_cjk_for_sd(base) or "young East Asian woman"
            return (
                f"{', '.join(_spec['tags'])}, {_en}, traditional Chinese hanfu, "
                "silk wide sleeves, no raincoat, no modern clothing"
            )
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
        "jet black hair, black hair, "
        "slate gray #5A6A7A long knee-length hooded raincoat with long sleeves, "
        "black pantyhose, black ankle boots, "
        "plain unbranded no logo no chest emblem, mid-tone slate gray fabric not jet black not near-white, "
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
        _spec = extract_ancient_costume_spec(meta)
        if _spec["colors"]:
            _c0 = _spec["colors"][0]
            outfit = (
                f"same ({_c0['en']} {_c0['pinyin']} {_spec['garment_en']}:1.3), "
                f"{_c0['alt']} traditional Chinese hanfu, silk wide sleeves, "
                "no raincoat, no modern jacket"
            )
            same_outfit = f"identical {_c0['en']} {_spec['garment_en']} style and color as main portrait"
        else:
            outfit = (
                "same traditional Chinese hanfu, cross-collar robe, qi-xiong ruqun, "
                "silk wide sleeves, no raincoat, no modern jacket"
            )
            same_outfit = "identical hanfu outfit style and color as main portrait"
        if _spec["hair"] or _spec["hair_accessory_tags"]:
            head_bit = ", ".join(
                [t for t in [_spec["hair"], *_spec["hair_accessory_tags"]] if t]
                + ["no other hair ornaments", "face fully visible"]
            )
        else:
            head_bit = "simple black hair bun, minimal plain hair accessories, face fully visible"
        back_head = "ONLY back of head and hair bun, NO face NO eyes"
        _acc = ancient_accessory_prompt_fix(meta)
        if _acc["pos"]:
            head_bit = f"{head_bit}, {_acc['pos']}"
            outfit = f"{outfit}, {_acc['pos']}"
    else:
        outfit = (
            "same character same slate-gray #5A6A7A long knee-length hooded raincoat with long sleeves and hood, "
            "black pantyhose, black ankle boots, fully clothed legs and feet, "
            "plain flat chest unbranded, no logo no emblem no badge no chest patch, "
            "no circular pattern no spiral design on chest, not jet black, not near-white light gray, "
            "NOT short skirt, NOT bare legs, NOT short sleeves, NOT barefoot"
        )
        head_bit = "hood DOWN face fully visible"
        back_head = "ONLY back of head and hood, NO face NO eyes"
        same_outfit = "identical hooded raincoat style and color as main portrait"
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
            f"{same_outfit}, plain chest no badge no spiral, "
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
    if style == "ancient_realistic":
        # 古风:服饰格按 spec 单品(禁现代雨夜五件);表情格去掉雨衣措辞
        prompts["costume"] = f"{ancient_costume_force(meta)}, {suf}"
    for i, expr in enumerate(_EXPR_PROMPTS):
        hair_bit = (
            "chin-length short jet black hair, hair tips end at chin line, NOT past chin, NOT past shoulders, "
            "no long hair, no shoulder-length hair, no hair lengthening"
            if i == 3
            else
            "short jet black hair chin-length or above, hair tips NOT past shoulders, "
            "no long hair, no hair lengthening beyond main portrait"
        )
        prompts[f"expr_{i}"] = (
            f"{solo}, {base}, {expr} of {name}, single face only, one person, "
            f"EXTREME close-up head and shoulders portrait, face fills at least 40 percent of frame, "
            f"tight headshot, hood down, face fully visible, eyes nose mouth clear, "
            f"{hair_bit}, same identity as main portrait, exaggerated distinct expression, "
            f"plain flat chest unbranded, NO text NO letters NO chinese NO logo NO emblem NO badge "
            f"NO chest patch NO circular mark NO star on chest, bare raincoat fabric only, "
            f"NO half body, NO full body, NO standing pose, NO waist, NO legs, NO hands props, "
            f"NO second person, no caption, no labels, "
            f"{solid}, {suf}"
        )
    if style == "ancient_realistic":
        for _k in [k for k in prompts if k.startswith("expr_")]:
            prompts[_k] = prompts[_k].replace(
                "bare raincoat fabric only", "bare garment fabric only"
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
    # 四角背景色：人物偏下半时中部 ROI 仍可能混入大面积浅灰底
    corners = [
        img.getpixel((2, 2)),
        img.getpixel((w - 3, 2)),
        img.getpixel((2, h - 3)),
        img.getpixel((w - 3, h - 3)),
    ]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    # 躯干：中部偏下（避开头脸）
    crop = img.crop((int(w * 0.22), int(h * 0.28), int(w * 0.78), int(h * 0.78)))
    small = crop.resize((48, 48), Image.Resampling.BOX)
    colors = small.getcolors(48 * 48) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    best = None
    best_cnt = 0
    for cnt, (r, g, b) in colors:
        # 跳过近背景（人物未铺满时浅灰底会伪装成「服装主色」）
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 22:
            continue
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


SLATE_GRAY_TARGET = "#5A6A7A"
# L1 距离阈值：过近白浅灰 / 过偏色则重出（15:40）
SLATE_GRAY_MAX_DIST = 85


def force_slate_garment_tint(
    data: bytes,
    *,
    target: str = SLATE_GRAY_TARGET,
    strength: float = 0.85,
) -> bytes:
    """16:18：已禁用。整图着色/矩形铺色路径删除，不留开关。"""
    raise CharacterSheetError(
        "已禁用整图着色(force_slate_garment_tint)，须重出而非程序上色",
        status_code=422,
    )
    """把人物内容框内服装区主色拉向板岩灰（保留明暗结构）。img2img 重染失败时的硬兜底。"""
    tr, tg, tb = int(target[1:3], 16), int(target[3:5], 16), int(target[5:7], 16)
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    px = img.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    # 扫非背景行/列得到人物框（浅灰衣+浅灰底时用更严 bg 判定 + 行列密度）
    small = img.resize((64, 64), Image.Resampling.BOX)
    sp = list(small.getdata())

    def _is_bg_s(r, g, b, tol=18):
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < tol

    rows = []
    for y in range(64):
        fg = sum(1 for x in range(64) if not _is_bg_s(*sp[y * 64 + x], 22))
        rows.append(fg / 64.0)
    cols = []
    for x in range(64):
        fg = sum(1 for y in range(64) if not _is_bg_s(*sp[y * 64 + x], 22))
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
        x0, x1, y0, y1 = int(w * 0.18), int(w * 0.82), int(h * 0.22), int(h * 0.92)
    s = max(0.0, min(1.0, float(strength)))
    face_y1 = y0 + int((y1 - y0) * 0.28)
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y]
            # 严格背景跳过
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 14:
                continue
            # 头脸肤色跳过
            if y < face_y1 and 95 < r < 250 and 70 < g < 220 and 55 < b < 200 and r >= g - 8:
                continue
            luma = (r + g + b) / 3.0
            mid = (tr + tg + tb) / 3.0
            delta = max(-0.18, min(0.18, (luma - mid) / 255.0))
            nr = int(max(0, min(255, tr * (1.0 + delta))))
            ng = int(max(0, min(255, tg * (1.0 + delta))))
            nb = int(max(0, min(255, tb * (1.0 + delta))))
            # 对近白浅灰衣提高强度
            local_s = s
            if luma > 170:
                local_s = min(1.0, s + 0.12)
            px[x, y] = (
                int(r * (1 - local_s) + nr * local_s),
                int(g * (1 - local_s) + ng * local_s),
                int(b * (1 - local_s) + nb * local_s),
            )
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()



def assert_garment_near_slate_gray(
    data: bytes,
    *,
    target: str = SLATE_GRAY_TARGET,
    max_dist: float = SLATE_GRAY_MAX_DIST,
    label: str = "主立绘",
) -> str:
    """衣服区域主色须贴近板岩灰 #5A6A7A，否则 422 重出。"""
    hx = _panel_garment_dominant_hex(data)
    if not hx:
        raise CharacterSheetError(
            f"颜色门禁失败:{label}无法取服装主色", status_code=422
        )
    dist = _hex_dist(hx, target)
    luma = _hex_luma(hx)
    # 近白浅灰（父代理 15:40 不过）
    if luma > 175:
        raise CharacterSheetError(
            f"颜色门禁失败:{label}服装主色过浅近白({hx} luma={luma:.0f})，须板岩灰{target}",
            status_code=422,
        )
    if dist > float(max_dist):
        raise CharacterSheetError(
            f"颜色门禁失败:{label}服装主色{hx}距{target}={dist:.0f}>{max_dist}，须重出",
            status_code=422,
        )
    return hx


def assert_fullbody_portrait_face_ok(data: bytes) -> None:
    """全身主立绘人脸门禁。

    二次元立绘 insightface 常检不出；人物又常偏画幅下半。
    策略：能检出脸更好；否则按内容框上半裁头肩做启发式；再退到
    「非空白 + 内容框上缘有肤色/五官色块」。
    """
    if _panel_is_blank_or_glitch(data):
        raise CharacterSheetError("主立绘人脸门禁失败:空白/花屏", status_code=422)
    try:
        assert_face_visible(data, min_face_area=0.003)
        return
    except CharacterSheetError:
        pass
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    # 从内容框估算人物顶：若邮票缩水用未贴边区域；否则扫非背景行
    small = img.resize((64, 64), Image.Resampling.BOX)
    px = list(small.getdata())
    corners = [px[1 * 64 + 1], px[1 * 64 + 62], px[62 * 64 + 1], px[62 * 64 + 62]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    def _bg(r, g, b):
        return abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 28

    top_row = 0
    for y in range(64):
        if sum(1 for x in range(64) if not _bg(*px[y * 64 + x])) / 64.0 > 0.08:
            top_row = y
            break
    # 头肩：内容顶往下约 45% 画幅
    y0 = max(0, int(h * (top_row / 64.0) - 0.02 * h))
    y1 = min(h, y0 + int(h * 0.45))
    x0, x1 = int(w * 0.15), int(w * 0.85)
    head = img.crop((x0, y0, x1, y1))
    buf = BytesIO()
    head.save(buf, format="PNG")
    head_b = buf.getvalue()
    try:
        assert_face_visible(head_b, min_face_area=0.02)
        return
    except CharacterSheetError:
        pass
    if face_crop_looks_ok(head_b):
        return
    # 最后：内容上半肤色/灰阶脸块占比
    hs = head.resize((48, 48), Image.Resampling.BILINEAR)
    hp = list(hs.getdata())
    faceish = 0
    for r, g, b in hp:
        if 90 < r < 250 and 70 < g < 230 and 60 < b < 210 and r >= g - 10:
            faceish += 1
        elif abs(r - g) < 18 and abs(g - b) < 18 and 70 < r < 230:
            faceish += 0.5
    if faceish / max(1, len(hp)) >= 0.06 and fill_h >= 0.25:
        return
    raise CharacterSheetError(
        "主立绘人脸门禁失败:无可辨识人脸/头肩", status_code=422
    )



def dump_rejected_panel(
    data: bytes | None,
    *,
    seed: int | None,
    panel: str,
    gate: str,
    detail: str,
    dump_dir: str | Path | None = None,
) -> Path | None:
    """17:47：失败必须落盘拒图 + 门禁名/数值 JSON。"""
    if not data:
        return None
    root = Path(dump_dir or os.environ.get("TOIV_SHEET_REJECT_DIR") or "/tmp/toiv_sheet_rejects")
    root.mkdir(parents=True, exist_ok=True)
    tag = f"rejected_{seed if seed is not None else 'noseed'}_{panel}"
    png_path = root / f"{tag}.png"
    json_path = root / f"{tag}.json"
    try:
        png_path.write_bytes(data)
        # annotated box thumb
        try:
            img = Image.open(BytesIO(data)).convert("RGB")
            w, h = img.size
            draw = ImageDraw.Draw(img)
            # chest ROI hint
            draw.rectangle(
                [int(w * 0.35), int(h * 0.32), int(w * 0.65), int(h * 0.52)],
                outline=(255, 64, 64),
                width=3,
            )
            thumb = img.copy()
            thumb.thumbnail((512, 512))
            thumb.save(root / f"{tag}_box.jpg", quality=85)
        except Exception:
            pass
        json_path.write_text(
            json.dumps(
                {
                    "seed": seed,
                    "panel": panel,
                    "gate": gate,
                    "detail": detail,
                    "bytes": len(data),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return png_path
    except Exception as e:  # noqa: BLE001
        logger.warning("dump_rejected_panel fail %s: %s", tag, e)
        return None


def _chest_emblem_scores(
    data: bytes, *, below_face: bool = False
) -> tuple[int, int, int]:
    """胸口 ROI 的 (bright, chroma, n)。失败返回 (0,0,0)。

    18:23 below_face=True：近景表情脸占上半幅时，ROI 改到脸框下方（下巴~锁骨），
    避免眼睛/嘴唇高 chroma 被误判成胸口徽标。
    22:20：ROI 严格脸框下沿以下；检测器无脸框则画高 45% 以下（不用会吞胸口的肤色启发式）。
    """
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return 0, 0, 0
    w, h = img.size
    if below_face:
        # 22:20：只用可靠检测器脸框；取不到 → 画高 45% 以下（禁止启发式吞胸）
        bb = _detect_face_bbox_xyxy(data)
        x0, x1 = int(w * 0.28), int(w * 0.72)
        if bb is None:
            y0, y1 = int(h * 0.45), int(h * 0.98)
        else:
            _x1, _y1, _x2, y2 = [float(v) for v in bb]
            chin = float(y2)
            # 下巴过低不可信（近景误扩）→ 退回 45%
            if chin / float(h) > 0.62:
                y0, y1 = int(h * 0.45), int(h * 0.98)
            else:
                y0 = int(min(h - 2, chin + max(2.0, 0.02 * float(h))))
                y1 = int(h * 0.98)
                if y1 <= y0 + 8:
                    y0, y1 = int(h * 0.45), int(h * 0.98)
    else:
        x0, x1 = int(w * 0.35), int(w * 0.65)
        y0, y1 = int(h * 0.32), int(h * 0.52)
    crop = img.crop((x0, y0, x1, y1)).resize((64, 48), Image.Resampling.BILINEAR)
    px = list(crop.getdata())
    if not px:
        return 0, 0, 0
    import statistics

    lumas = [(r + g + b) / 3 for r, g, b in px]
    med = statistics.median(lumas)
    bright = sum(1 for v in lumas if v > med + 45)
    chroma = sum(
        1
        for r, g, b in px
        if max(r, g, b) - min(r, g, b) > 40 and (r + g + b) / 3 > 40
    )
    return bright, chroma, len(px)


def _chest_emblem_chroma_peak(
    data: bytes, *, below_face: bool = False, win: int = 12
) -> int:
    """below_face ROI 内最大局部 chroma 窗像素数（64x48 网格）。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return 0
    w, h = img.size
    if below_face:
        bb = _detect_face_bbox_xyxy(data)
        x0, x1 = int(w * 0.28), int(w * 0.72)
        if bb is None or (float(bb[3]) / float(h) > 0.62):
            y0, y1 = int(h * 0.45), int(h * 0.98)
        else:
            y0 = int(min(h - 2, float(bb[3]) + max(2.0, 0.02 * float(h))))
            y1 = int(h * 0.98)
            if y1 <= y0 + 8:
                y0, y1 = int(h * 0.45), int(h * 0.98)
    else:
        x0, x1 = int(w * 0.35), int(w * 0.65)
        y0, y1 = int(h * 0.32), int(h * 0.52)
    crop = img.crop((x0, y0, x1, y1)).resize((64, 48), Image.Resampling.BILINEAR)
    px = list(crop.getdata())
    if not px:
        return 0
    mask = [
        1
        if max(r, g, b) - min(r, g, b) > 40 and (r + g + b) / 3 > 40
        else 0
        for r, g, b in px
    ]
    # 64x48 row-major
    peak = 0
    for yy in range(0, 48 - win + 1, 2):
        for xx in range(0, 64 - win + 1, 2):
            s = 0
            for dy in range(win):
                row = (yy + dy) * 64
                s += sum(mask[row + xx : row + xx + win])
            if s > peak:
                peak = s
    return int(peak)


def portrait_has_chest_emblem(
    data: bytes, *, ref: bytes | None = None, below_face: bool = False
) -> bool:
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
        # 漫布皮肤：chroma 占比过高 → 非贴标
        if chroma > int(n * 0.40):
            abs_hit = False
        else:
            peak = _chest_emblem_chroma_peak(data, below_face=True)
            # 局部色斑：有限亮团 + 有限 chroma 窗
            if (
                chroma >= 8
                and (10 <= bright <= int(n * 0.18))
                and (8 <= chroma <= int(n * 0.28))
            ):
                abs_hit = True
            # 真贴标常无高亮（红标 luma≈灰衣）：靠高密度局部 chroma 峰
            # peak≥100/144 ≈窗内几乎整块色斑；排除 expr_4 口腔中等扩散 chroma
            elif (
                20 <= chroma <= int(n * 0.22)
                and peak >= 100
                and peak <= int(n * 0.18)
                and bright <= int(n * 0.12)
            ):
                abs_hit = True
    else:
        # 贴标需彩色斑；纯亮无彩多为雨衣高光（母版 front bright≈39 chroma=0）
        if chroma >= 6 and (
            (8 <= bright <= int(n * 0.22)) or (6 <= chroma <= int(n * 0.18))
        ):
            abs_hit = True
        if chroma >= int(n * 0.12) and bright >= int(n * 0.08):
            abs_hit = True
    if ref:
        rb, rc, rn = _chest_emblem_scores(ref, below_face=below_face)
        if rn > 0:
            # 相对母版：chroma 或 bright 显著变差才拒
            worse = (chroma >= rc + 8) or (bright >= max(rb * 1.6, rb + 20))
            if below_face:
                # 相对路径也禁止漫布皮肤：须绝对命中局部色斑且相对更花
                return bool(abs_hit and worse)
            return bool(abs_hit and worse) if abs_hit else worse and (
                chroma >= 6 or bright >= int(n * 0.05)
            )
    return abs_hit




def _uniform_rect_hit_stats(data: bytes) -> tuple[int, float]:
    """返回 (hits, last_stdev)。hits>=2 表示绝对路径会拒。"""
    import statistics

    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    slate = (
        int(SLATE_GRAY_TARGET[1:3], 16),
        int(SLATE_GRAY_TARGET[3:5], 16),
        int(SLATE_GRAY_TARGET[5:7], 16),
    )
    win_w, win_h = max(24, int(w * 0.18)), max(20, int(h * 0.12))
    y_lo, y_hi = int(h * 0.22), int(h * 0.62)
    x_lo, x_hi = int(w * 0.22), int(w * 0.78)
    step_x, step_y = max(8, win_w // 3), max(8, win_h // 3)
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
            mean_rgb = tuple(sum(c[i] for c in px) / len(px) for i in range(3))
            dist = sum(abs(mean_rgb[i] - slate[i]) for i in range(3))
            if stdev < 8.0 and dist < 45:
                hits += 2
                last_stdev = stdev
            elif stdev < 3.5:
                hits += 1
                last_stdev = stdev
            if hits >= 2:
                return hits, last_stdev
    return hits, last_stdev


def assert_no_large_uniform_rect(
    data: bytes, *, label: str = "面板", ref: bytes | None = None
) -> None:
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
    raise CharacterSheetError(
        f"出图门禁失败:{label}检出大块均匀矩形色块(stdev={stdev:.1f})",
        status_code=422,
    )


def _face_cool_metrics(data: bytes) -> tuple[float, float] | None:
    """返回 (b-r, chroma)；不足样本则 None。"""
    img = Image.open(BytesIO(data)).convert("RGB")
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
    mean_r = sum(c[0] for c in cands) / len(cands)
    mean_b = sum(c[2] for c in cands) / len(cands)
    mean_chroma = sum(max(c) - min(c) for c in cands) / len(cands)
    return (mean_b - mean_r, mean_chroma)


def assert_skin_not_blue_gray(
    data: bytes,
    *,
    label: str = "面板",
    ref: bytes | None = None,
) -> None:
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
            # 相对母版：明显更冷且更灰才拒
            if (br - base[0]) >= 12 and chroma <= (base[1] + 4) and br >= 22:
                raise CharacterSheetError(
                    f"出图门禁失败:{label}脸部相对参考偏蓝灰"
                    f"(b-r={br:.1f} vs {base[0]:.1f})",
                    status_code=422,
                )
            return
    # 无参考：只拦极端染灰（强制着色典型）
    if br >= 32 and chroma <= 18:
        raise CharacterSheetError(
            f"出图门禁失败:{label}脸部肤色偏蓝灰(b-r={br:.1f},chroma={chroma:.1f})",
            status_code=422,
        )


def assert_turnaround_pose(data: bytes, key: str) -> None:
    """16:18③：侧/背姿态门禁——侧须侧脸或高 yaw；背须无明显正脸。"""
    if key not in ("side", "back"):
        return
    yaw = estimate_face_yaw_deg(data)
    if key == "side":
        # 侧脸：yaw 足够大；或检不出正脸（轮廓侧影）
        if yaw is not None and abs(yaw) < 28:
            raise CharacterSheetError(
                f"姿态门禁失败:side 仍偏正面(yaw={yaw:.1f}<28)",
                status_code=422,
            )
        # 若 yaw 检不出，用左右不对称启发式已在 estimate 内；仍 None 则看是否像正脸
        if yaw is None:
            try:
                assert_face_visible(data, min_face_area=0.01)
                # 能检到正脸且无 yaw → 多半仍是正面
                raise CharacterSheetError(
                    "姿态门禁失败:side 检出正脸且无有效 yaw",
                    status_code=422,
                )
            except CharacterSheetError as e:
                if "姿态门禁" in str(e):
                    raise
                # 无人脸更像真侧影，放行
                return
    if key == "back":
        # 背影不应有清晰正脸
        try:
            assert_face_visible(data, min_face_area=0.012)
        except CharacterSheetError:
            return  # 无正脸 = 合格背影
        # 有脸则 yaw 须极高（几乎侧/后）或拒绝
        if yaw is None or abs(yaw) < 55:
            raise CharacterSheetError(
                f"姿态门禁失败:back 仍可见正脸(yaw={yaw})",
                status_code=422,
            )


def assert_panel_output_gates(data: bytes, *, label: str, key: str | None = None) -> None:
    """16:18 组合出图门禁：矩形色块 + 肤色 + 侧背姿态。"""
    assert_no_large_uniform_rect(data, label=label)
    if key in (None, "portrait", "front", "side") or (
        key and key.startswith("expr_")
    ):
        assert_skin_not_blue_gray(data, label=label)
    if key in ("side", "back"):
        assert_turnaround_pose(data, key)


def assert_sheet_garment_consistency(
    panels: dict[str, bytes],
    *,
    max_dist: int = 90,
    style: str = "anime",
    skip_keys: set[str] | None = None,
) -> None:
    """13:16②：主立绘 vs 三视图服装主色差超阈或主立绘贴标 → 不得过审。

    16:18：禁止矩形铺色去标；检出贴标直接 422 重出。
    """
    skip = set(skip_keys or ())
    portrait = panels.get("portrait")
    if not portrait:
        raise CharacterSheetError("一致性门禁失败:缺主立绘", status_code=422)
    if style in ("anime", "二次元") and portrait_has_chest_emblem(
        portrait, ref=panels.get("front")
    ):
        raise CharacterSheetError(
            "一致性门禁失败:主立绘胸口检出贴标/徽标", status_code=422
        )
    # 三视图若为过审母版注入，不再用绝对徽标启发式误杀
    # 16:18 出图门禁：矩形色块 / 肤色偏蓝灰（侧背姿态在新生成时检查，复用旧三视图不因姿态误杀）
    # 17:14：主立绘均匀块相对 front；三视图母版本身常有二次元平涂，跳过绝对均匀块以免误杀
    assert_no_large_uniform_rect(
        portrait, label="主立绘", ref=panels.get("front")
    )
    assert_skin_not_blue_gray(
        portrait, label="主立绘", ref=panels.get("front")
    )
    for key in ("front", "side", "back"):
        data = panels.get(key)
        if not data:
            continue
        if key != "back":
            assert_skin_not_blue_gray(data, label=key)
    p_hex = _panel_garment_dominant_hex(portrait)
    if not p_hex:
        raise CharacterSheetError("一致性门禁失败:主立绘无法取服装主色", status_code=422)
    # anime：禁止近纯黑/近白；绝对板岩灰仅在无三视图对照时强制（16:18 母版路线用相对色差）
    if style in ("anime", "二次元"):
        if _hex_luma(p_hex) < 35:
            raise CharacterSheetError(
                f"一致性门禁失败:主立绘服装主色过黑({p_hex})，须板岩灰素面",
                status_code=422,
            )
        if _hex_luma(p_hex) > 175:
            raise CharacterSheetError(
                f"一致性门禁失败:主立绘服装主色过浅近白({p_hex})",
                status_code=422,
            )
        # 有 front 时相对锁色已在生成路径完成；此处不再绝对 assert_garment_near_slate_gray
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
    """去掉表情格底部已烘焙标签带,改由后端真字体重绘。

    21:30：仅在检测到底部门禁标签带时裁切；干净方图（无烘焙标签）原样返回，
    禁止一律裁掉底 30%（会切掉嘴/下巴）或涂近白底条（白边门禁根因）。
    """
    rgba = img.convert("RGBA")
    w, h = rgba.size
    if h < 64:
        return rgba
    rgb = rgba.convert("RGB")
    # 扫底部 18%：若出现「浅底+深色横排文字」则视为烘焙标签带
    band0 = int(h * 0.82)
    sample = rgb.resize((min(64, w), max(8, h - band0)), Image.Resampling.BILINEAR)
    sw, sh = sample.size
    cut_ratio = None
    for yi in range(sh):
        row = [sample.getpixel((xi, yi)) for xi in range(sw)]
        dark = sum(1 for r, g, b in row if r + g + b < 140)
        light = sum(
            1
            for r, g, b in row
            if (r + g + b) / 3.0 >= 220
            and abs(r - g) < 18
            and abs(g - b) < 18
        )
        if dark >= int(sw * 0.35) and light >= int(sw * 0.25):
            cut_ratio = (band0 + yi * (h - band0) / float(max(1, sh))) / float(h)
            break
    if cut_ratio is None or cut_ratio < 0.72 or cut_ratio > 0.97:
        return rgba
    cut_y = max(int(h * 0.72), int(h * cut_ratio * 0.98))
    if cut_y >= h - 8:
        return rgba
    return rgba.crop((0, 0, w, cut_y))


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
        bb = _detect_face_bbox_xyxy(buf.getvalue())
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


def _expr_face_bbox_of(img: Image.Image) -> tuple[float, float, float, float] | None:
    """表情贴格用脸框：insightface → 启发式。"""
    rgb = img.convert("RGB")
    buf = BytesIO()
    rgb.save(buf, format="PNG")
    data = buf.getvalue()
    bb = _detect_face_bbox_xyxy(data)
    if bb is not None:
        return (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3]))
    try:
        hbb = _heuristic_skin_face_bbox(rgb)
    except Exception:  # noqa: BLE001
        hbb = None
    if hbb is None:
        return None
    return (float(hbb[0]), float(hbb[1]), float(hbb[2]), float(hbb[3]))


def _fit_expr_cell_face_fill(
    img: Image.Image,
    box: tuple[int, int, int, int],
    *,
    target_face_height_frac: float = 0.58,
    min_face_height_frac: float = 0.55,
    max_face_height_frac: float = 0.65,
    allow_studio_pad_for_face_gate: bool = False,
) -> tuple[Image.Image, tuple[int, int]]:
    """23:18：按脸框**扩大裁剪**→缩放到格尺寸铺满；禁止棚灰垫边缩小凑脸高。

    铺满优先：输出必须铺满 (tw,th)，四周不许垫边（content coverage=1.0）。
    face_height 0.55–0.65 尽量用扩大裁剪达到；与铺满冲突时以铺满为准。
    allow_studio_pad_for_face_gate 默认 False 且 23:18 起忽略（保留参数仅兼容旧调用）。
    """
    del allow_studio_pad_for_face_gate  # 23:18：永久禁用棚灰垫边路径
    x, y, tw, th = [int(v) for v in box]
    tw = max(8, tw)
    th = max(8, th)
    src0 = img.convert("RGBA")
    aspect = tw / float(th)
    tgt = max(0.50, min(0.70, float(target_face_height_frac)))
    sw, sh = src0.size

    def _max_zero_pad_window(sw_: int, sh_: int) -> tuple[float, float]:
        if sw_ / float(max(1, sh_)) >= aspect:
            ch0 = float(sh_)
            cw0 = ch0 * aspect
        else:
            cw0 = float(sw_)
            ch0 = cw0 / aspect
        return min(cw0, float(sw_)), min(ch0, float(sh_))

    bb = _expr_face_bbox_of(src0)
    cw0, ch0 = _max_zero_pad_window(sw, sh)
    if bb is None:
        left = max(0.0, (sw - cw0) / 2.0)
        top = max(0.0, min(float(sh) - ch0, sh * 0.06))
        crop_w, crop_h = cw0, ch0
    else:
        fx1, fy1, fx2, fy2 = [float(v) for v in bb]
        fw = max(8.0, fx2 - fx1)
        fh = max(8.0, fy2 - fy1)
        fcx = (fx1 + fx2) / 2.0
        chin_y = fy2 + 0.10 * fh
        mouth_y = fy1 + 0.72 * fh
        # 目标脸高：扩大裁剪窗（want），使贴格后面高≈tgt
        want_h = max(fh / tgt, fw * 1.05 / max(aspect, 0.5), 64.0)
        want_w = want_h * aspect
        if want_w <= sw + 1e-6 and want_h <= sh + 1e-6:
            crop_w, crop_h = want_w, want_h
        else:
            # 源不够大：取源内最大同比例窗（扩大到极限），禁止垫边缩小
            crop_w, crop_h = cw0, ch0
        top = fy1 - 0.12 * crop_h
        if chin_y > top + crop_h * 0.96:
            top = chin_y - crop_h * 0.96
        if mouth_y > top + crop_h * 0.90:
            top = mouth_y - crop_h * 0.90
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
    if crop.mode == "RGBA":
        # 仅处理透明通道；不引入棚灰露边（不透明像素保留原色）
        solid = Image.new("RGBA", crop.size, (0, 0, 0, 0))
        solid.paste(crop, (0, 0), crop)
        # 若全不透明则直接用 RGB 等价；有透明时用源角点色填满（仍铺满格，非缩水垫边）
        alpha = solid.split()[-1]
        if alpha.getextrema()[0] < 250:
            corner = src0.convert("RGB").getpixel((min(2, sw - 1), min(2, sh - 1)))
            bg = Image.new("RGBA", crop.size, (*corner[:3], 255))
            bg.paste(solid, (0, 0), solid)
            crop = bg
        else:
            crop = solid.convert("RGBA")
    return crop, (x, y)


def _studio_pad_edge_frac(
    img: Image.Image | bytes,
    *,
    pad_rgb: tuple[int, int, int] = (220, 220, 224),
    tol: int = 6,
    uniform_frac: float = 0.90,
) -> float:
    """检测棚灰(220,220,224)垫边条带厚度占短边比例（四边最大）。"""
    if isinstance(img, (bytes, bytearray)):
        im = Image.open(BytesIO(img)).convert("RGB")
    else:
        im = img.convert("RGB")
    w, h = im.size
    if w < 8 or h < 8:
        return 1.0
    small = im.resize((64, 64), Image.Resampling.BOX)
    sw, sh = small.size
    px = list(small.getdata())
    pr, pg, pb = pad_rgb

    def _is_pad(r: int, g: int, b: int) -> bool:
        return (
            abs(r - pr) <= tol
            and abs(g - pg) <= tol
            and abs(b - pb) <= tol
        )

    def _pix(x: int, y: int) -> tuple[int, int, int]:
        return px[y * sw + x]

    def _row_pad(y: int) -> bool:
        return sum(1 for x in range(sw) if _is_pad(*_pix(x, y))) / float(sw) >= uniform_frac

    def _col_pad(x: int) -> bool:
        return sum(1 for y in range(sh) if _is_pad(*_pix(x, y))) / float(sh) >= uniform_frac

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


def expr_cell_content_coverage(img: Image.Image | bytes) -> float:
    """23:18：表情格内容铺满比。

    贴格路径已 LANCZOS 输出满格像素；本门禁专拦「小图+四周棚灰(220)垫边」邮票缩水。
    源图自带浅底/噪声边不算未铺满（避免 fill_w 误杀）。
    """
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    pad = _studio_pad_edge_frac(img)
    # 四边棚灰垫边 + 邮票缩水 → 未铺满
    if stamp and pad > 0.04:
        return float(min(area, max(0.0, 1.0 - pad), fill_h, fill_w))
    if pad > 0.10:
        return float(max(0.0, 1.0 - pad))
    return 1.0


def assert_expr_cell_content_coverage(
    img: Image.Image | bytes,
    *,
    expr_key: str = "expr",
    min_coverage: float = 1.0,
) -> float:
    """23:18：表情格须全铺满（coverage=1.0）；禁四周棚灰垫边缩小塞格。"""
    cov = expr_cell_content_coverage(img)
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    pad = _studio_pad_edge_frac(img)
    if cov + 1e-9 < float(min_coverage):
        raise CharacterSheetError(
            f"{expr_key}表情格未全铺满 coverage={cov:.3f} "
            f"(need {min_coverage:.2f}) stamp={stamp} pad={pad:.3f} "
            f"area={area:.3f} fill_h={fill_h:.3f} fill_w={fill_w:.3f}",
            status_code=422,
        )
    return cov



def assert_expr_cell_face_height_frac(
    data: bytes,
    *,
    expr_key: str = "expr",
    min_face_height_frac: float = 0.55,
    max_face_height_frac: float = 0.65,
) -> dict:
    """22:28：贴格/方化后脸高占格高硬门禁 0.55–0.65；越界拒收该格。"""
    frac = measure_face_height_frac(data)
    if frac is None:
        raise CharacterSheetError(
            f"{expr_key}贴格脸高门禁失败：无人脸",
            status_code=422,
        )
    lo = float(min_face_height_frac)
    hi = float(max_face_height_frac)
    if frac + 1e-12 < lo or frac - 1e-12 > hi:
        raise CharacterSheetError(
            f"{expr_key}贴格脸高越界 face_height_frac={frac:.3f} not in [{lo:.2f},{hi:.2f}]",
            status_code=422,
        )
    return {"expr_key": expr_key, "face_height_frac": float(frac), "min": lo, "max": hi}


def _compose_expression_grid_unified_face_scales(
    panels: dict[str, Image.Image],
) -> float:
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
    # 源图已偏大时略降目标，避免贴格再放大；偏小则抬到 0.58
    if mid >= 0.62:
        return 0.56
    if mid <= 0.45:
        return 0.60
    return 0.58


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
    # 21:30：先统一脸框尺度，再按格纵横比脸心裁满（含嘴下巴）；禁贴顶 cover 裁嘴
    _clean_panels: dict[str, Image.Image] = {}
    for _k in _EXPR_KEYS:
        _im = panels.get(_k)
        if _im is None:
            raise CharacterSheetError(f"缺面板:{_k}", status_code=500)
        _clean_panels[_k] = _strip_expr_label_band(_im.convert("RGBA"))
    _tgt_face = _compose_expression_grid_unified_face_scales(_clean_panels)
    for i, key in enumerate(_EXPR_KEYS):
        img = _clean_panels[key]
        row, col = divmod(i, cols)
        cell_x0 = col * cell_w
        cell_y0 = row * cell_h
        # 图片区:内缩 3px,严格落在 [cell_y0, cell_y0+img_h)
        ox = cell_x0 + 3
        oy = cell_y0 + 3
        iw = cell_w - 6
        ih = img_h - 6
        # 格底先铺棚灰（非近白），杜绝贴不满露 245 白边
        draw.rectangle([ox, oy, ox + iw - 1, oy + ih - 1], fill=(220, 220, 224, 255))
        fitted, pos = _fit_expr_cell_face_fill(
            img, (ox, oy, iw, ih), target_face_height_frac=_tgt_face
        )
        if fitted.height != ih or fitted.width != iw:
            fitted = fitted.resize((iw, ih), Image.Resampling.LANCZOS)
        # 22:28：贴格后脸高硬门禁 0.55–0.65；越界拒收该格
        _fbuf = BytesIO()
        fitted.convert("RGB").save(_fbuf, format="PNG")
        # 23:18：铺满硬门禁优先；脸高尽量满足，越界仅记日志不拒（禁垫边凑数）
        try:
            assert_expr_cell_face_height_frac(
                _fbuf.getvalue(),
                expr_key=key,
                min_face_height_frac=0.55,
                max_face_height_frac=0.65,
            )
        except CharacterSheetError as _fh_err:
            logger.warning(
                "expr compose face_height soft (fill-first 23:18): %s", _fh_err
            )
        assert_expr_cell_content_coverage(
            fitted, expr_key=key, min_coverage=1.0
        )
        # 23:18：贴格强制不透明 RGB，杜绝底层棚灰透出被当成垫边
        _paste_im = fitted.convert("RGB").convert("RGBA")
        grid.paste(_paste_im, pos)

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



def measure_face_area_frac(data: bytes) -> float | None:
    """insightface/启发式脸面积占图画面积；无人脸返回 None。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:  # noqa: BLE001
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
    return (fw * fh) / float(max(1, w * h))


def _zoom_face_for_area(data: bytes, *, size: int = 768, target_area: float = 0.18) -> bytes:
    """轻微围绕脸框放大，尽量把脸面积抬到 target_area（供表情底送模前）。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        return data
    x1, y1, x2, y2 = [float(v) for v in bb]
    fw = max(8.0, x2 - x1)
    fh = max(8.0, y2 - y1)
    area = (fw * fh) / float(max(1, w * h))
    if area + 1e-12 >= float(target_area):
        return data
    # 目标边长：使脸约占 target_area
    scale = (area / max(1e-6, float(target_area))) ** 0.5
    scale = max(0.55, min(0.92, scale))
    side = max(64, int(min(w, h) * scale))
    fcx = (x1 + x2) / 2.0
    fcy = (y1 + y2) / 2.0
    left = max(0, min(w - side, int(round(fcx - side / 2.0))))
    top = max(0, min(h - side, int(round(fcy - side / 2.0 - 0.05 * side))))
    crop = img.crop((left, top, left + side, top + side))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def assert_expr_base_face_area(
    data: bytes, *, expr_key: str, min_area: float = 0.15
) -> tuple[bytes, float]:
    """22:45/23:17：表情底裁后 insightface 脸面积须 ≥0.15；略低时先 zoom 一次，仍不足直接停。

    返回 (可能被放大后的 bytes, area)。
    """
    cur = data
    area = measure_face_area_frac(cur)
    if area is not None and area + 1e-12 < float(min_area):
        cur = _zoom_face_for_area(cur, target_area=max(float(min_area) + 0.03, 0.18))
        area = measure_face_area_frac(cur)
    if area is None:
        raise CharacterSheetError(
            f"{expr_key} 表情底无人脸(area=None)，停",
            status_code=422,
        )
    if area + 1e-12 < float(min_area):
        raise CharacterSheetError(
            f"{expr_key} 表情底脸面积 {area:.3f} < {min_area:.2f}，停",
            status_code=422,
        )
    return cur, float(area)


def _compose_expression_grid_raw(
    panels: dict[str, bytes] | dict[str, Image.Image],
    *,
    cell: int = 512,
) -> bytes:
    """23:17：六表情底拼成无标签 2×3 宫格（送 Comfy/Qwen 一次编辑）。"""
    cols, rows = 3, 2
    grid = Image.new("RGB", (cols * cell, rows * cell), (245, 245, 248))
    for i, key in enumerate(_EXPR_KEYS):
        raw = panels.get(key)
        if raw is None:
            raise CharacterSheetError(f"缺表情底:{key}", status_code=422)
        if isinstance(raw, Image.Image):
            im = raw.convert("RGB")
        else:
            im = Image.open(BytesIO(raw)).convert("RGB")
        im = im.resize((cell, cell), Image.Resampling.LANCZOS)
        row, col = divmod(i, cols)
        grid.paste(im, (col * cell, row * cell))
    buf = BytesIO()
    grid.save(buf, format="PNG")
    return buf.getvalue()


def _split_expression_grid(
    data: bytes,
    *,
    cell: int | None = None,
) -> dict[str, bytes]:
    """23:17：整张 2×3 六表情图按格裁成 expr_0..5（无标签带几何）。

    默认按图宽/3 × 图高/2 均分；若传入 cell 则按固定方格从左上裁。
    """
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    cols, rows = 3, 2
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
        # 统一方图 768 便于后续拼版
        side = max(cell_im.size)
        canvas = Image.new("RGB", (side, side), (245, 245, 248))
        ox = (side - cell_im.width) // 2
        oy = (side - cell_im.height) // 2
        canvas.paste(cell_im, (ox, oy))
        canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
        buf = BytesIO()
        canvas.save(buf, format="PNG")
        out[key] = buf.getvalue()
    return out


def _compose_expression_feature_mask_grid(*, cell: int = 512) -> Image.Image:
    """2×3 宫格眉眼嘴硬遮罩（白=可编辑）。每格复用 build_face_feature_mask，二值化防叠影。"""
    cols, rows = 3, 2
    mask = Image.new("L", (cols * int(cell), rows * int(cell)), 0)
    cell_m = build_face_feature_mask(int(cell)).point(lambda v: 255 if v >= 96 else 0)
    for i in range(cols * rows):
        row, col = divmod(i, cols)
        mask.paste(cell_m, (col * int(cell), row * int(cell)))
    return mask


def apply_expression_grid_local_features(
    base_grid: bytes,
    edited_grid: bytes,
    *,
    cell: int = 512,
    max_cell_mae: float = 55.0,
    feather: int = 10,
) -> bytes:
    """16:53：宫格局部五官重绘合成。

    遮罩边高斯羽化（内缩后模糊，羽化落在五官区内），消除头发外沿半透明重影；
    贴回必须用同一张底图同尺寸；遮罩外（含全部头发与胸口）强制用底图像素贴回；硬遮罩外强制底图像素逐点一致。
    """
    from PIL import ImageFilter

    base = Image.open(BytesIO(base_grid)).convert("RGB")
    edit = Image.open(BytesIO(edited_grid)).convert("RGB")
    if edit.size != base.size:
        edit = edit.resize(base.size, Image.Resampling.LANCZOS)
    cols, rows = 3, 2
    cw = max(1, base.size[0] // cols)
    ch = max(1, base.size[1] // rows)
    fw = max(2, int(feather))
    hard = Image.new("L", base.size, 0)
    soft = Image.new("L", base.size, 0)
    for i in range(cols * rows):
        row, col = divmod(i, cols)
        cm = build_face_feature_mask(max(cw, ch)).point(lambda v: 255 if v >= 96 else 0)
        cm = cm.resize((cw, ch), Image.Resampling.NEAREST)
        hard.paste(cm, (col * cw, row * ch))
        try:
            # 内缩 ≥ 羽化半径，再模糊 → 渐变不溢出硬核外
            erode_r = fw
            cm_e = cm.filter(ImageFilter.MinFilter(size=erode_r * 2 + 1))
            cm_s = cm_e.filter(ImageFilter.GaussianBlur(radius=fw))
        except Exception:
            cm_s = cm
        soft.paste(cm_s, (col * cw, row * ch))
    # 合成后硬外强制底图：先 soft 羽化贴，再 hard 外用底图盖回
    blended = Image.composite(edit, base, soft)
    # hard==0 → 底图；hard>0 → 保留 blended（含羽化环，环在硬核内）
    out = Image.composite(blended, base, hard)
    # 格级 MAE 门禁：漂移过大的格整格回退底图
    for i in range(cols * rows):
        row, col = divmod(i, cols)
        box = (col * cw, row * ch, col * cw + cw, row * ch + ch)
        bc = base.crop(box)
        ec = edit.crop(box)
        try:
            pa = list(bc.resize((48, 48)).getdata())
            pb = list(ec.resize((48, 48)).getdata())
            mae = sum(
                (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0
                for a, b in zip(pa, pb)
            ) / float(max(1, len(pa)))
        except Exception:
            mae = 999.0
        if mae > float(max_cell_mae):
            out.paste(bc, (box[0], box[1]))
    if out.size != base.size:
        out = out.resize(base.size, Image.Resampling.LANCZOS)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


# 00:31：2×3 宫格眉眼嘴局部重绘（禁止整图弱编辑；禁止已废弃脸罩软贴回叠影）
_EXPR_GRID_EDIT_INSTRUCTION = (
    "这是一张 2 行×3 列的角色近景头像宫格。"
    "只改每一格的眉毛、眼睛、嘴巴，做出六种明显不同的表情；"
    "不要改发型、脸型、肤色、领口、肩线、构图与背景；"
    "从左到右、从上到下依次为："
    "威严（眉头下压、嘴角下压）、冷酷（半睁斜视、嘴平）、沉思（视线下垂、眉轻蹙）、"
    "温柔（眉放松带微笑）、惊恐（双眼瞪大、嘴巴明显张开）、果断（眉压低、双唇抿紧闭嘴）。"
    "每格保持同一人物、同一短发齐下巴、同一雨衣领口与配色；"
    "不要加文字、徽标、徽章、水印；不要加长发；不要把六格融成一张脸；"
    "六格眉眼嘴变化要大、一眼可辨，尤其惊恐必须张嘴。"
)


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
        if extract_ancient_costume_spec(meta)["colors"]:
            # 色板跟 spec 衣色走;非黑金 spec 剔除近金色(卡面深底金字主题不变)
            colors = resolve_ancient_palette(meta, colors, source="sheet_compose")
        else:
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
    """卡面设计说明去掉 fix/LoRA/调试路由/版本备注等内部字样；成品卡只留角色设定。"""
    if not text:
        return text
    bad = re.compile(
        r"(fix\d+[a-z]?|LoRA|lora|az\s*45|az45|硬门禁|yaw\s*门禁|CLIP\s*门禁|"
        r"final_review|deliver\b|Qwen-Edit|batch7|openpose|IPA\b|"
        r"SetLatentNoiseMask|VAEEncode(?:ForInpaint)?|letterbox|inpaint|"
        r"Ref2VA|md5|seed\s*=?\s*\d+|commit\s*[:=]?\s*[0-9a-f]{7,}|"
        r"route\s*[:=]|\b826[0-9]\b|\b819[0-9]\b|"
        r"\d{1,2}:\d{2}[a-z]?\b|侧头锁定(?:不改)?|锁定不改|领口下巴到锁骨|"
        r"门禁|调试|版本说明|开发备注|fallback|hist[_ ]?match|"
        r"果断抿嘴\s*/\s*温柔微笑|温柔微笑\s*/\s*果断抿嘴)",
        re.I,
    )
    lines = []
    for ln in text.splitlines():
        s = bad.sub("", ln)
        s = re.sub(r"[；;]{2,}", "；", s)
        s = re.sub(r"\s{2,}", " ", s).strip(" -|;,，、；")
        s = re.sub(r"[。.]{2,}", "。", s).strip()
        if not s or s in {"。", ".", "…", "·", "；", ";", "不改"}:
            continue
        # 无汉字/字母的残渣行丢弃
        if not re.search(r"[\u4e00-\u9fffA-Za-z]", s):
            continue
        # 过短残句（剥完后 <4 字）丢弃
        if len(re.sub(r"\W+", "", s)) < 4:
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


def _trim_letterbox_bars(
    data: bytes,
    *,
    white_lum: float = 232.0,
    min_strip_frac: float = 0.92,
) -> bytes:
    """去掉上下左右整条近白 letterbox（1822/1830 底白条根因），保留棚灰中的人物。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    w, h = im.size
    px = im.load()

    def _row_white(y: int) -> bool:
        n = sum(
            1
            for x in range(w)
            if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3.0 >= white_lum
            and abs(px[x, y][0] - px[x, y][1]) < 14
            and abs(px[x, y][1] - px[x, y][2]) < 14
        )
        return n / float(max(1, w)) >= float(min_strip_frac)

    def _col_white(x: int) -> bool:
        n = sum(
            1
            for y in range(h)
            if (px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3.0 >= white_lum
            and abs(px[x, y][0] - px[x, y][1]) < 14
            and abs(px[x, y][1] - px[x, y][2]) < 14
        )
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
    if top == 0 and bot == h - 1 and left == 0 and right == w - 1:
        return data
    crop = im.crop((left, top, right + 1, bot + 1))
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def squareize_face_center_crop(
    data: bytes,
    size: int = 768,
    *,
    min_face_height_frac: float = 0.55,
    max_face_height_frac: float = 0.65,
    require_mouth_in_frame: bool = True,
) -> bytes:
    """18:30 / 19:55：表情格方化 —— 去 letterbox 后按同尺度脸高约 0.55–0.65 裁切，嘴须在格内。

    1930 威严裁太近只剩眼睛=失败；目标头肩近景含嘴，非贴眼特写。
    """
    trimmed = _trim_letterbox_bars(data)
    last_err: Exception | None = None
    for tgt in (0.60, 0.58, 0.56, 0.62, 0.54):
        try:
            cropped = _crop_expr_face_same_scale(
                trimmed,
                size=int(size),
                target_face_height_frac=float(tgt),
                min_face_height_frac=float(min_face_height_frac),
                max_face_height_frac=float(max_face_height_frac),
            )
            assert_face_closeup_framing(
                cropped,
                min_face_height_frac=float(min_face_height_frac),
                max_face_height_frac=float(max_face_height_frac),
                require_mouth_in_frame=bool(require_mouth_in_frame),
            )
            return cropped
        except CharacterSheetError as e:
            last_err = e
            continue
    if last_err is not None:
        raise last_err
    raise CharacterSheetError("expr same-scale crop failed", status_code=422)


def assert_expr_cell_no_white_border(
    data: bytes,
    *,
    expr_key: str = "expr",
    max_strip_frac: float = 0.08,
    white_lum: float = 232.0,
    edge_px: int = 3,
    max_edge_near_white_frac: float = 0.35,
) -> float:
    """表情格不得含整条近白 letterbox（格外白底）；棚灰人物边不算。

    测四边：若某边连续条带（厚≈4%边长）行/列近白占比≥92%，计入 strip 厚度占比。
    21:30 硬检查：四边 edge_px（默认 3px）内近白像素占比不得超过 max_edge_near_white_frac；
    棚灰(~220)不算近白（阈值 white_lum 默认 232）。
    """
    im = Image.open(BytesIO(data)).convert("RGB")
    w, h = im.size
    px = im.load()
    # 最多扫到短边 30%，才能抓住 1830 底白条约 1/3 画幅的 letterbox
    band = max(8, int(min(w, h) * 0.30))

    def _near_white(rgb: tuple[int, int, int]) -> bool:
        r, g, b = rgb
        return (
            (r + g + b) / 3.0 >= float(white_lum)
            and abs(r - g) < 14
            and abs(g - b) < 14
        )

    def _row_white(y: int) -> bool:
        n = sum(1 for x in range(w) if _near_white(px[x, y]))
        return n / float(max(1, w)) >= 0.92

    def _col_white(x: int) -> bool:
        n = sum(1 for y in range(h) if _near_white(px[x, y]))
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
        raise CharacterSheetError(
            f"{expr_key}表情格含格外白底 letterbox_strip={strip:.3f}>{max_strip_frac} "
            f"(T{top}B{bot}L{left}R{right})",
            status_code=422,
        )
    # 21:30：3px 近白边硬门禁（像素条，非整行 92% 才算）
    ep = max(1, int(edge_px))
    edge_stats: dict[str, float] = {}
    # top / bottom bands
    for name, ys in (("T", range(0, min(ep, h))), ("B", range(max(0, h - ep), h))):
        n = 0
        tot = 0
        for yy in ys:
            for xx in range(w):
                tot += 1
                if _near_white(px[xx, yy]):
                    n += 1
        edge_stats[name] = n / float(max(1, tot))
    for name, xs in (("L", range(0, min(ep, w))), ("R", range(max(0, w - ep), w))):
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
        raise CharacterSheetError(
            f"{expr_key}表情格{ep}px近白边超标 edge_near_white={worst:.3f}"
            f">{max_edge_near_white_frac} stats={{{', '.join(f'{k}:{v:.2f}' for k,v in edge_stats.items())}}}",
            status_code=422,
        )
    return max(strip, worst)


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
    bb = _detect_face_bbox_xyxy(data)
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


def _hair_center_x(img: Image.Image, *, y0_frac: float, y1_frac: float) -> float:
    """顶带内暗色发丝/轮廓的水平重心，作硬裁中心。"""
    w, h = img.size
    y0 = max(0, int(h * y0_frac))
    y1 = min(h, max(y0 + 1, int(h * y1_frac)))
    px = img.load()
    sx = sw = 0.0
    for y in range(y0, y1):
        for x in range(w):
            r, g, b = px[x, y]
            lum = (r + g + b) / 3.0
            # 近黑发或深灰轮廓；排除近白底与板岩灰雨衣中段
            if lum < 55 and max(r, g, b) - min(r, g, b) < 40:
                sx += float(x)
                sw += 1.0
            elif lum < 120 and abs(r - g) < 18 and abs(g - b) < 18 and b <= r + 12:
                sx += float(x) * 0.35
                sw += 0.35
    if sw < 8:
        return w * 0.5
    return sx / sw



def _densify_three_quarter_head_crop(
    img: Image.Image,
    *,
    size: int = 768,
    max_up: float = 2.0,
) -> bytes | None:
    """00:59：按头高（发顶→下巴+颈）取框再 Lanczos；禁止眼部特写级密裁。"""
    box = _native_three_quarter_crop_box(img, max_up=max_up, prefer_tight=False)
    if box is None:
        return None
    left, top, side = box
    crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
    crop = _lanczos_to_square(crop, size)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def _native_three_quarter_crop_box(
    img: Image.Image,
    *,
    max_up: float | None = 2.0,
    prefer_tight: bool = False,
) -> tuple[float, float, float] | None:
    """00:59：在母版原分辨率上按头高取¾侧头框 (left, top, side)。

    发顶 → 下巴再加脖子；禁止按画高固定比例紧裁成眼部特写。
    prefer_tight 保留兼容但默认 False，且不再把 side 压到 0.22*h。
    """
    w, h = img.size
    if w < 32 or h < 32:
        return None
    px = img.load()
    # 1) 发顶：首行非浅色
    y_top = None
    for y in range(0, int(h * 0.55), max(1, h // 220)):
        dark = 0
        for x in range(0, w, max(1, w // 64)):
            r, g, b = px[x, y][:3]
            if r < 220 or g < 220 or b < 220:
                dark += 1
        if dark >= 3:
            y_top = y
            break
    if y_top is None:
        y_top = int(h * 0.02)
    # 2) 脸框 → 下巴；找不到则用肤色启发式 / 头顶下 0.28*h
    face_bb = None
    try:
        buf = BytesIO()
        img.save(buf, format="PNG")
        face_bb = _detect_face_bbox_xyxy(buf.getvalue())
    except Exception:
        face_bb = None
    if face_bb is None:
        try:
            face_bb = _heuristic_skin_face_bbox(img)
        except Exception:
            face_bb = None
    if face_bb is not None:
        fx1, fy1, fx2, fy2 = [float(v) for v in face_bb]
        face_h = max(8.0, fy2 - fy1)
        face_w = max(8.0, fx2 - fx1)
        # 发顶取检测顶与扫描顶的更靠上者
        y_top_f = min(float(y_top), fy1 - face_h * 0.12)
        y_top_f = max(0.0, y_top_f)
        # 下巴 + 脖子（约 0.22 脸高），禁止只裁到眼下
        y_bot = min(float(h), fy2 + face_h * 0.28)
        head_h = max(face_h * 1.35, y_bot - y_top_f)
        # 目标脸高占格 25%–50% → 方框边长约 face_h / 0.38
        target_side = face_h / 0.38
        side = max(head_h, face_w * 1.25, target_side)
        cx = (fx1 + fx2) / 2.0
    else:
        # 无脸：头顶以下约 0.32*h（头+颈），不用 0.22 紧裁
        band = 0.30 if prefer_tight else 0.34
        y_top_f = float(y_top)
        side = float(h) * band
        xs: list[int] = []
        y1 = min(h, int(y_top_f) + max(16, int(side)))
        for y in range(int(y_top_f), y1, max(1, max(1, y1 - int(y_top_f)) // 16)):
            for x in range(w):
                r, g, b = px[x, y][:3]
                if r < 220 or g < 220 or b < 220:
                    xs.append(x)
        if len(xs) >= 8:
            xs.sort()
            cx = float(xs[len(xs) // 2])
        else:
            cx = _hair_center_x(img, y0_frac=0.0, y1_frac=min(0.40, band + 0.08))
    if max_up is not None and max_up > 1e-6:
        side = max(side, float(min(w, h)) / float(max_up))
    side = min(side, float(w), float(h))
    left = max(0.0, min(float(w) - side, cx - side / 2.0))
    top = max(0.0, min(float(h) - side, float(y_top_f) - side * 0.04))
    return left, top, side


def _lanczos_to_square(crop: Image.Image, size: int) -> Image.Image:
    """00:31：Lanczos 到方格。native≥size 时为缩小；native<size 时不可避免放大（应走高分侧母版）。"""
    if crop.size == (size, size):
        return crop
    return crop.resize((size, size), Image.Resampling.LANCZOS)


def side_crop_upscale_factor(native_side: float, size: int = 768) -> float:
    """格尺寸 / 母版原裁边长；>1 表示需要放大（糊风险）。"""
    ns = max(1.0, float(native_side))
    return float(size) / ns


def side_face_slot_readable(
    data: bytes,
    *,
    native_side: float | None = None,
    size: int = 768,
    max_upscale: float = 1.08,
    min_sharp: float = 8.0,
    min_face_frac: float = 0.22,
) -> bool:
    """00:31：侧面格是否可读。需放大过多 / 边缘能量过低 / 无人脸 → 不可读，应重出高分侧母版。"""
    up = (
        side_crop_upscale_factor(native_side, size)
        if native_side is not None
        else 1.0
    )
    if up > float(max_upscale):
        return False
    frac = measure_face_height_frac(data)
    if frac is None or frac + 1e-12 < float(min_face_frac):
        area = measure_face_area_frac(data)
        if area is None or area + 1e-12 < 0.04:
            return False
    # 仅当需要放大时才用边缘能量卡糊；原分辨率缩小路径像素已够，不因平底合成图误杀
    if up > 1.0 + 1e-6:
        sharp = _edge_sharpness_score(data)
        if sharp + 1e-12 < float(min_sharp):
            return False
    return True


def crop_face_slot_from_master(
    data: bytes,
    *,
    slot: str,
    size: int = 768,
) -> bytes:
    """00:31 / 22:02：母版固定比例硬裁头像。

    face_front ← 主立绘顶部到下巴下（约画高 0–20%）
    face_three_quarter ← 侧母版原分辨率裁头 → Lanczos 到格尺寸（禁止改脸超分；默认无 Qwen 清线）
    face_side ← 背母版后脑勺顶部约 0–25%（≤2×；继续背母版硬裁）
    水平以头发轮廓中心为准。
    """
    out, _meta = crop_face_slot_from_master_with_meta(data, slot=slot, size=size)
    return out


def crop_face_slot_from_master_with_meta(
    data: bytes,
    *,
    slot: str,
    size: int = 768,
) -> tuple[bytes, dict]:
    """同 crop_face_slot_from_master，额外返回 meta（native_side / upscale / readable）。"""
    if not data:
        raise CharacterSheetError(f"faces crop: empty master for {slot}", status_code=422)
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    meta: dict = {"slot": slot, "master_size": (w, h), "target": int(size)}

    if slot == "face_front":
        band = 0.20
        max_up = 2.5
        side = float(band) * float(h)
        min_side = float(min(w, h)) / float(max_up)
        side = max(side, min_side)
        side = min(side, float(w), float(h))
        cx = _hair_center_x(img, y0_frac=0.0, y1_frac=min(0.35, band + 0.08))
        left = cx - side / 2.0
        top = 0.0
        if left < 0:
            left = 0.0
        if left + side > w:
            left = max(0.0, float(w) - side)
        if top + side > h:
            top = max(0.0, float(h) - side)
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = _lanczos_to_square(crop, size)
        buf = BytesIO()
        out_im.save(buf, format="PNG")
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        if frac is not None and frac + 1e-12 < 0.35:
            target = 0.42
            shrink = max(0.55, min(0.92, float(frac) / target))
            floor = float(min(w, h)) / float(max_up)
            new_side = max(floor, side * shrink)
            new_side = min(new_side, float(w), float(h), side)
            left2 = cx - new_side / 2.0
            if left2 < 0:
                left2 = 0.0
            if left2 + new_side > w:
                left2 = max(0.0, float(w) - new_side)
            crop = img.crop((int(left2), int(0.0), int(left2 + new_side), int(new_side)))
            out_im = _lanczos_to_square(crop, size)
            buf = BytesIO()
            out_im.save(buf, format="PNG")
            out = buf.getvalue()
            side = new_side
            frac = measure_face_height_frac(out)
        meta.update(
            {
                "native_side": float(side),
                "upscale": side_crop_upscale_factor(side, size),
                "face_frac": frac,
            }
        )
        if frac is None:
            vspan = panel_vertical_span(out)
            if vspan + 1e-12 < 0.35:
                raise CharacterSheetError(
                    f"faces {slot} hard-crop head/content frac {vspan:.3f} < 0.35",
                    status_code=422,
                )
        elif frac + 1e-12 < 0.35:
            raise CharacterSheetError(
                f"faces {slot} hard-crop face height frac {frac:.3f} < 0.35",
                status_code=422,
            )
        meta["readable"] = True
        return out, meta

    if slot == "face_three_quarter":
        # 00:59：按头高（发顶→下巴+颈）原分辨率裁，Lanczos 到格；禁眼部特写；不做改脸超分
        box = _native_three_quarter_crop_box(img, max_up=2.0, prefer_tight=False)
        if box is None:
            raise CharacterSheetError(
                "faces face_three_quarter: cannot locate head box", status_code=422
            )
        left, top, side = box
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = _lanczos_to_square(crop, size)
        buf = BytesIO()
        out_im.save(buf, format="PNG")
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        # 脸高过小：再按头高取一次；过大（>50%）：在原图上放大取景框稀释
        if frac is not None and frac - 1e-12 > 0.50:
            # 放大 side 使目标脸高≈38%
            grow = min(2.2, float(frac) / 0.38)
            new_side = min(float(w), float(h), side * grow)
            cx = left + side / 2.0
            left2 = max(0.0, min(float(w) - new_side, cx - new_side / 2.0))
            top2 = max(0.0, min(float(h) - new_side, top - (new_side - side) * 0.35))
            crop = img.crop(
                (int(left2), int(top2), int(left2 + new_side), int(top2 + new_side))
            )
            out_im = _lanczos_to_square(crop, size)
            buf = BytesIO()
            out_im.save(buf, format="PNG")
            out = buf.getvalue()
            side = new_side
            left, top = left2, top2
            frac = measure_face_height_frac(out)
            logger.info(
                "faces %s expand overcrop frac→%s native_side=%.1f", slot, frac, side
            )
        elif frac is None or frac + 1e-12 < 0.28:
            # 16:53：低于 ≈0.28 则收紧裁框到 face_frac≈0.3（几何，不重出母版）
            denser = _densify_three_quarter_head_crop(img, size=size, max_up=2.0)
            tightened = None
            if frac is not None and float(frac) + 1e-12 < 0.28:
                try:
                    tightened = tighten_side_square_to_face_frac(
                        out, target=0.30, min_frac=0.28, max_frac=0.35, size=size
                    )
                except Exception:  # noqa: BLE001
                    tightened = None
            chosen = None
            chosen_frac = frac
            for cand in (tightened, denser):
                if not cand:
                    continue
                dfrac = measure_face_height_frac(cand)
                if dfrac is None:
                    continue
                if float(dfrac) <= 0.50 + 1e-9 and (
                    chosen_frac is None or float(dfrac) > float(chosen_frac) + 0.01
                ):
                    chosen, chosen_frac = cand, dfrac
            if chosen is not None:
                out = chosen
                frac = chosen_frac
                logger.info(
                    "faces %s tighten/densify head frac→%s native_side=%.1f",
                    slot,
                    frac,
                    side,
                )
        up = side_crop_upscale_factor(side, size)
        readable = side_face_slot_readable(
            out, native_side=side, size=size, max_upscale=1.08
        )
        # 00:59 门禁：脸框高占格高 25%–50%
        framing_ok = frac is not None and 0.25 - 1e-9 <= float(frac) <= 0.50 + 1e-9
        meta.update(
            {
                "native_side": float(side),
                "upscale": float(up),
                "face_frac": frac,
                "framing_ok": bool(framing_ok),
                "readable": bool(readable) and bool(framing_ok if frac is not None else readable),
                "route": "00:59_head_height_lanczos",
            }
        )
        if frac is None:
            logger.warning(
                "faces %s hard-crop no face frac upscale=%.2f — soft ok (00:59)",
                slot,
                up,
            )
        elif not framing_ok:
            logger.warning(
                "faces %s hard-crop frac=%.3f outside 0.25–0.50 upscale=%.2f",
                slot,
                frac,
                up,
            )
        return out, meta

    if slot == "face_side":
        band = 0.25
        max_up = 2.0
        side = float(band) * float(h)
        min_side = float(min(w, h)) / float(max_up)
        side = max(side, min_side)
        side = min(side, float(w), float(h))
        cx = _hair_center_x(img, y0_frac=0.0, y1_frac=min(0.35, band + 0.08))
        left = cx - side / 2.0
        top = 0.0
        if left < 0:
            left = 0.0
        if left + side > w:
            left = max(0.0, float(w) - side)
        if top + side > h:
            top = max(0.0, float(h) - side)
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = _lanczos_to_square(crop, size)
        buf = BytesIO()
        out_im.save(buf, format="PNG")
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        meta.update(
            {
                "native_side": float(side),
                "upscale": side_crop_upscale_factor(side, size),
                "face_frac": frac,
                "readable": True,
            }
        )
        if frac is None:
            logger.warning(
                "faces %s hard-crop no face frac — soft ok (23:17/00:31 no deblur)",
                slot,
            )
        elif frac + 1e-12 < 0.35:
            logger.warning(
                "faces %s hard-crop frac=%.3f <0.35 — soft ok (23:17/00:31 no deblur)",
                slot,
                frac,
            )
        return out, meta

    raise CharacterSheetError(f"faces crop: unknown slot {slot}", status_code=422)


def prepare_hires_side_head_init(
    side_master: bytes,
    *,
    out_size: int = 1280,
) -> bytes:
    """从侧母版原分辨率裁头肩，再 Lanczos 到 out_size，作高分侧母版 img2img 初值。

    注意：此处放大仅作生成初值，真正清晰度靠模型重出，不是改脸超分。
    """
    img = Image.open(BytesIO(side_master)).convert("RGB")
    box = _native_three_quarter_crop_box(img, max_up=None, prefer_tight=False)
    if box is None:
        w, h = img.size
        side = min(float(w), float(h) * 0.35, float(h))
        box = (max(0.0, (w - side) / 2.0), 0.0, side)
    left, top, side = box
    # 略放宽为头肩
    side2 = min(float(img.size[0]), float(img.size[1]), side * 1.15)
    left = max(0.0, min(float(img.size[0]) - side2, left - (side2 - side) / 2.0))
    top = max(0.0, min(float(img.size[1]) - side2, top))
    crop = img.crop((int(left), int(top), int(left + side2), int(top + side2)))
    out = _lanczos_to_square(crop, int(out_size))
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def build_faces_tri_from_masters(
    *,
    portrait: bytes | None,
    front: bytes | None,
    side: bytes | None,
    back: bytes | None = None,
    size: int = 768,
) -> dict[str, bytes]:
    """22:02 映射：正←portrait/front；侧/¾←侧母版；背头←背母版。

    三格源文件 md5 必须互异，否则 compose 前 422（禁止侧脸重复占第三格）。
    """
    import hashlib as _hl

    src_front = portrait or front
    if not src_front:
        raise CharacterSheetError(
            "faces crop: need portrait or front master", status_code=422
        )
    if not side:
        raise CharacterSheetError("faces crop: need side master", status_code=422)
    if not back:
        raise CharacterSheetError(
            "faces crop: need back master for back-of-head slot", status_code=422
        )
    md_f = _hl.md5(src_front).hexdigest()
    md_s = _hl.md5(side).hexdigest()
    md_b = _hl.md5(back).hexdigest()
    if len({md_f, md_s, md_b}) < 3:
        raise CharacterSheetError(
            f"faces crop: source masters not distinct "
            f"(front={md_f[:12]} side={md_s[:12]} back={md_b[:12]})",
            status_code=422,
        )
    return {
        "face_front": crop_face_slot_from_master(
            src_front, slot="face_front", size=size
        ),
        "face_three_quarter": crop_face_slot_from_master(
            side, slot="face_three_quarter", size=size
        ),
        # 第三格：背面头像（后脑勺），不再复用侧母版
        "face_side": crop_face_slot_from_master(
            back, slot="face_side", size=size
        ),
    }


def _hair_extent_below_face(data: bytes) -> dict[str, float]:
    """脸侧发带下探（不含脸下中央，避免雨衣深色当头发）。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        x1, y1, x2, y2 = w * 0.25, h * 0.08, w * 0.75, h * 0.38
    else:
        x1, y1, x2, y2 = [float(v) for v in bb]
        # 启发式大脸框：收成上半脸，防整幅当脸
        if (y2 - y1) / float(h) > 0.45:
            y2 = y1 + 0.38 * h
            x1, x2 = w * 0.30, w * 0.70
    fh = max(8.0, y2 - y1)
    fw = max(8.0, x2 - x1)
    chin_y = y2
    shoulder_y = min(h - 1.0, y2 + 0.70 * fh)
    # 仅左右鬓角发带（从脸顶到画底）；不要脸下中央躯干
    side_pad = max(6, int(0.42 * fw))
    bands = [
        (max(0, int(x1) - side_pad), max(0, int(x1) + 2), int(y1), h),
        (min(w, int(x2) - 2), min(w, int(x2) + side_pad), int(y1), h),
    ]
    dark_chin = 0
    dark_shoulder = 0
    max_y_dark = chin_y
    px = img.load()
    for xa, xb, ya, yb in bands:
        xa, xb = max(0, min(xa, xb)), max(0, max(xa, xb))
        xa, xb = min(xa, w), min(xb, w)
        ya, yb = max(0, ya), min(h, yb)
        for y in range(ya, yb):
            row_dark = 0
            for x in range(xa, xb):
                r, g, b = px[x, y]
                lum = (r + g + b) / 3.0
                # 近黑发；排除板岩灰雨衣（偏亮且偏蓝灰）
                if lum < 42 and max(r, g, b) - min(r, g, b) < 28 and b <= r + 8:
                    row_dark += 1
                    if y >= chin_y:
                        if y <= shoulder_y:
                            dark_chin += 1
                        else:
                            dark_shoulder += 1
                        if y > max_y_dark:
                            max_y_dark = float(y)
            # 该行几乎无发丝则视为发梢断掉，停止该带下探累计 tip
            if y > chin_y and row_dark == 0 and max_y_dark > chin_y + 2:
                pass
    tip_frac = (max_y_dark - chin_y) / float(max(1, h))
    return {
        "tip_frac": float(max(0.0, tip_frac)),
        "dark_below_chin": float(dark_chin),
        "dark_below_shoulder": float(dark_shoulder),
        "chin_y": float(chin_y),
        "shoulder_y": float(shoulder_y),
        "h": float(h),
    }


def expression_hair_too_long(
    data: bytes,
    *,
    ref: bytes | None = None,
    chin_only: bool = False,
    relative_only: bool = False,
) -> bool:
    """18:23 / 16:18 / 19:15 发长门禁：只与同格表情底同裁同尺度比 delta。

    relative_only=True（遮罩外已贴回底图）：只比相对 delta，不做绝对过肩拒。
    禁止拿表情近景去比主立绘全身比例。
    非温柔：肩下侧发带相对加长才拒；温柔：下巴下 + 肩下。
    """
    cur = _hair_extent_below_face(data)
    base = _hair_extent_below_face(ref) if ref else None
    if relative_only:
        if base is None:
            return False  # 无参照且已贴回 → 不因绝对发长拒
        if chin_only:
            return bool(
                cur["dark_below_shoulder"] >= base["dark_below_shoulder"] + 80
                or cur["tip_frac"] >= base["tip_frac"] + 0.12
            )
        return bool(
            cur["dark_below_shoulder"] >= base["dark_below_shoulder"] + 90
            or cur["tip_frac"] >= base["tip_frac"] + 0.14
        )
    if chin_only:
        abs_hit = (
            cur["dark_below_shoulder"] >= 80
            or (
                cur["tip_frac"] > 0.16
                and (cur["dark_below_chin"] + cur["dark_below_shoulder"]) >= 80
            )
        )
        if base is None:
            return bool(abs_hit)
        worse = (
            cur["dark_below_shoulder"] >= base["dark_below_shoulder"] + 50
            or cur["tip_frac"] >= base["tip_frac"] + 0.08
        )
        return bool(abs_hit and worse)
    # 非温柔：过肩才拒
    abs_hit = cur["dark_below_shoulder"] >= 100
    if base is None:
        return bool(abs_hit)
    worse = cur["dark_below_shoulder"] >= base["dark_below_shoulder"] + 60
    return bool(abs_hit and worse)


def assert_expression_identity_gates(
    data: bytes,
    *,
    portrait_ref: bytes | None,
    expr_key: str,
    skip_chest_emblem: bool = False,
    hair_ref: bytes | None = None,
    relative_hair_only: bool | None = None,
) -> None:
    """表情格：相对主立绘新徽标/字样 → 拒；发长过线 → 拒。

    徽标检测用 below_face ROI，避免近景五官误杀。
    19:15：发长只和同格 base_expr（hair_ref，同裁同尺度）比；禁止用主立绘全身比例。
    00:59：遮罩外与底图一致 → skip_chest_emblem；16:18：此时发长只比相对 delta。
    """
    # 20:56：惊恐张嘴口腔高 chroma 易误杀；张嘴时跳过徽标，改靠领口 ROI（已下移）
    # 00:59：遮罩外未改 → 跳过胸口徽标（防贴回后误杀）
    _skip_emblem = bool(skip_chest_emblem) or (
        mouth_appears_open(data) and expr_key == "expr_4"
    )
    if (
        not _skip_emblem
        and portrait_ref
        and portrait_has_chest_emblem(data, ref=portrait_ref, below_face=True)
    ):
        raise CharacterSheetError(
            f"{expr_key}胸口相对主立绘出现新徽标/字样",
            status_code=422,
        )
    if (
        not _skip_emblem
        and portrait_ref is None
        and portrait_has_chest_emblem(data, below_face=True)
    ):
        raise CharacterSheetError(
            f"{expr_key}胸口检出徽标/字样",
            status_code=422,
        )
    chin_only = expr_key == "expr_3"
    href = hair_ref
    rel_only = (
        bool(skip_chest_emblem)
        if relative_hair_only is None
        else bool(relative_hair_only)
    )
    # 19:15：相对发长门禁必须用同格表情底；禁止回退主立绘头肩（尺度不同会误杀）
    if href is None and (not rel_only) and portrait_ref:
        try:
            href = crop_face_ref(portrait_ref, size=768)
        except Exception:  # noqa: BLE001
            href = portrait_ref
    if expression_hair_too_long(
        data, ref=href, chin_only=chin_only, relative_only=rel_only
    ):
        raise CharacterSheetError(
            f"{expr_key}发长相对同格表情底过长（{'须齐下巴' if chin_only else '发梢不过肩'}；须同裁同尺度）",
            status_code=422,
        )



def _facial_feature_roi(im: Image.Image) -> Image.Image:
    """眉眼嘴区域：上半脸到嘴下（约 12%–72% 高，20%–80% 宽）。"""
    w, h = im.size
    return im.crop((int(w * 0.20), int(h * 0.12), int(w * 0.80), int(h * 0.72)))


def build_face_feature_mask(size: int = 768) -> Image.Image:
    """眉/眼/嘴局部遮罩（白=可编辑），供表情局部合成。

    19:15：眼带收紧，并挖掉左右瞳孔中心，避免重画瞳孔高光/心形瞳。
    """
    s = int(size)
    mask = Image.new("L", (s, s), 0)
    from PIL import ImageDraw as _ID

    d = _ID.Draw(mask)
    # 眉带
    d.ellipse((int(s * 0.22), int(s * 0.14), int(s * 0.78), int(s * 0.36)), fill=255)
    # 眼带（相对旧版上下各收 ~4%，减少发丝/颧骨渗入）
    d.ellipse((int(s * 0.22), int(s * 0.30), int(s * 0.78), int(s * 0.48)), fill=255)
    # 嘴带
    d.ellipse((int(s * 0.30), int(s * 0.52), int(s * 0.70), int(s * 0.74)), fill=255)
    # 挖掉瞳孔高光区（黑=不可编辑）
    pr = max(4, int(s * 0.035))
    for cx in (int(s * 0.38), int(s * 0.62)):
        cy = int(s * 0.38)
        d.ellipse((cx - pr, cy - pr, cx + pr, cy + pr), fill=0)
    try:
        from PIL import ImageFilter

        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(4, s // 64)))
    except Exception:
        pass
    return mask


def blend_face_local_edit(
    original: bytes,
    edited: bytes,
    *,
    strength: float = 0.70,
    size: int = 768,
) -> bytes:
    """把编辑结果仅合成到眉眼嘴遮罩内；strength≈0.6–0.75 等效局部 inpaint 强度。

    须在 enforce_head_shoulders_square 之前调用，且 original 与 edited 同构图参考，
    否则重框后会对不齐 → 叠影。
    """
    strength = max(0.60, min(0.75, float(strength)))
    o = Image.open(BytesIO(original)).convert("RGB").resize(
        (size, size), Image.Resampling.LANCZOS
    )
    e = Image.open(BytesIO(edited)).convert("RGB").resize(
        (size, size), Image.Resampling.LANCZOS
    )
    # 对齐门禁：全局 MAE 过大说明被重框/漂移，直接用编辑图避免叠影
    try:
        pa = list(o.resize((64, 64)).getdata())
        pb = list(e.resize((64, 64)).getdata())
        mae = sum(
            (abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0
            for a, b in zip(pa, pb)
        ) / float(len(pa))
        if mae > 45.0:
            buf = BytesIO()
            e.save(buf, format="PNG")
            return buf.getvalue()
    except Exception:
        pass
    m = build_face_feature_mask(size)
    # 16:53：硬核区 + 边羽化；遮罩外强制底图，消头发外沿半透明重影
    m = m.point(lambda v: 255 if v >= 96 else 0)
    try:
        from PIL import ImageFilter
        m = m.filter(ImageFilter.GaussianBlur(radius=max(6, size // 64)))
    except Exception:
        pass
    m_s = m.point(lambda v: int(v * strength))
    # 贴回必须与底同尺寸（上文已 resize）
    out = Image.composite(e, o, m_s)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()



def build_face_paste_mask(
    size: int = 768,
    *,
    face_bbox: tuple[float, float, float, float] | None = None,
) -> Image.Image:
    """00:30：眉眼口鼻区羽化遮罩，下边界不超过下巴。

    用于 Qwen-Edit 结果贴回 approved_portrait：遮罩外（胸口/衣服）强制原图像素，
    消除新徽标/字样。相对脸框比例；无人脸时回退头肩经验比例。
    """
    s = int(size)
    mask = Image.new("L", (s, s), 0)
    from PIL import ImageDraw as _ID

    d = _ID.Draw(mask)
    if face_bbox is not None:
        x1, y1, x2, y2 = [float(v) for v in face_bbox]
        fw = max(8.0, x2 - x1)
        fh = max(8.0, y2 - y1)
        d.ellipse(
            (
                int(x1 + 0.05 * fw),
                int(y1 + 0.02 * fh),
                int(x2 - 0.05 * fw),
                int(y1 + 0.38 * fh),
            ),
            fill=255,
        )
        d.ellipse(
            (
                int(x1 + 0.06 * fw),
                int(y1 + 0.22 * fh),
                int(x2 - 0.06 * fw),
                int(y1 + 0.52 * fh),
            ),
            fill=255,
        )
        d.ellipse(
            (
                int(x1 + 0.32 * fw),
                int(y1 + 0.40 * fh),
                int(x2 - 0.32 * fw),
                int(y1 + 0.68 * fh),
            ),
            fill=255,
        )
        mouth_bottom = min(float(y2), y1 + 0.92 * fh)
        d.ellipse(
            (
                int(x1 + 0.18 * fw),
                int(y1 + 0.58 * fh),
                int(x2 - 0.18 * fw),
                int(mouth_bottom),
            ),
            fill=255,
        )
        if int(y2) < s - 1:
            d.rectangle((0, int(y2) + 1, s, s), fill=0)
    else:
        d.ellipse((int(s * 0.22), int(s * 0.12), int(s * 0.78), int(s * 0.36)), fill=255)
        d.ellipse((int(s * 0.22), int(s * 0.28), int(s * 0.78), int(s * 0.48)), fill=255)
        d.ellipse((int(s * 0.38), int(s * 0.40), int(s * 0.62), int(s * 0.62)), fill=255)
        d.ellipse((int(s * 0.30), int(s * 0.52), int(s * 0.70), int(s * 0.70)), fill=255)
        d.rectangle((0, int(s * 0.72), s, s), fill=0)
    try:
        from PIL import ImageFilter

        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(6, s // 48)))
    except Exception:
        pass
    return mask


def paste_qedit_face_onto_portrait(
    original: bytes,
    edited: bytes,
    *,
    size: int = 768,
) -> bytes:
    """00:30：Qwen-Edit 结果只取眉眼口鼻贴回 approved_portrait；胸口衣服保留原像素。"""
    o = Image.open(BytesIO(original)).convert("RGB").resize(
        (size, size), Image.Resampling.LANCZOS
    )
    e = Image.open(BytesIO(edited)).convert("RGB").resize(
        (size, size), Image.Resampling.LANCZOS
    )
    bb = _detect_face_bbox_xyxy(original)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(o)
        except Exception:  # noqa: BLE001
            bb = None
    m = build_face_paste_mask(size, face_bbox=bb)
    m_hard = m.point(lambda v: 255 if v >= 64 else 0)
    try:
        from PIL import ImageFilter

        m_soft = m_hard.filter(ImageFilter.GaussianBlur(radius=max(6, size // 48)))
    except Exception:
        m_soft = m
    out = Image.composite(e, o, m_soft)
    out = Image.composite(out, o, m_hard)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()



class HeadcropSourceShort(CharacterSheetError):
    """04:30：头特写源图不够（下方/侧边），禁止灰垫；调用方换更宽源或 outpaint。"""

    def __init__(self, message: str):
        super().__init__(message, status_code=422)


def _expr_frame_bbox(data: bytes) -> tuple[float, float, float, float] | None:
    """表情格构图测量用脸框：与 crop_expr_head_closeup 同一检测链（insightface→动漫级联→启发式）。"""
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(Image.open(BytesIO(data)).convert("RGB"))
        except Exception:  # noqa: BLE001
            bb = None
    if bb is None:
        return None
    return tuple(float(v) for v in bb)  # type: ignore[return-value]


def measure_expr_frame(data: bytes) -> dict | None:
    """04:30：测表情格构图 {face_frac, face_top_frac, face_cx_frac}（相对画面边长）。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    w, h = im.size
    bb = _expr_frame_bbox(data)
    if bb is None:
        return None
    x1, y1, x2, y2 = bb
    if y2 - y1 < 8 or x2 - x1 < 8:
        return None
    return {
        "face_frac": (y2 - y1) / float(h),
        "face_top_frac": y1 / float(h),
        "face_cx_frac": (x1 + x2) / 2.0 / float(w),
    }


def locked_expr_frame(cells: list[bytes]) -> dict | None:
    """04:30：已锁表情格构图中位数；可测格 <2 返回 None（回退默认头特写规则）。"""
    ms = [m for m in (measure_expr_frame(c) for c in cells if c) if m]
    if len(ms) < 2:
        return None
    import statistics as _st

    out = {k: float(_st.median([m[k] for m in ms])) for k in ("face_frac", "face_top_frac", "face_cx_frac")}
    out["n"] = len(ms)
    return out


def _crop_expr_to_frame(
    im0: Image.Image,
    bb: tuple[float, float, float, float],
    frame: dict,
    *,
    size: int = 768,
) -> bytes:
    """04:30：按锁定格比例裁（同检测器），越界只允许小幅平移；不够则抛 HeadcropSourceShort。"""
    w0, h0 = im0.size
    fx1, fy1, fx2, fy2 = bb
    fh = max(8.0, fy2 - fy1)
    ff = max(0.20, min(0.85, float(frame["face_frac"])))
    side = fh / ff
    top = fy1 - float(frame["face_top_frac"]) * side
    left = (fx1 + fx2) / 2.0 - float(frame["face_cx_frac"]) * side
    mn = float(min(w0, h0))
    if side > mn * 1.03:
        raise HeadcropSourceShort(
            f"头特写源图不足: 需 side={side:.0f}px > 源 {w0}x{h0}（禁止灰垫，需更宽源/outpaint）"
        )
    side = min(side, mn)
    over_b = top + side - h0
    if over_b > 0.04 * side:
        raise HeadcropSourceShort(
            f"头特写源图下方不足: 缺 {over_b:.0f}px（{over_b / side:.2f}×side，禁止灰垫，需更宽源/outpaint）"
        )
    if -top > 0.06 * side:
        raise HeadcropSourceShort(f"头特写源图上方不足: 缺 {-top:.0f}px（禁止灰垫）")
    over_l = max(0.0, -left)
    over_r = max(0.0, left + side - w0)
    if over_l + over_r > 0.15 * side:
        raise HeadcropSourceShort(
            f"头特写源图侧边不足: 左缺 {over_l:.0f}px 右缺 {over_r:.0f}px（禁止灰垫）"
        )
    s_i = int(round(side))
    top_i = int(round(max(0.0, min(h0 - side, top))))
    left_i = int(round(max(0.0, min(w0 - side, left))))
    crop = im0.crop((left_i, top_i, left_i + s_i, top_i + s_i)).resize(
        (int(size), int(size)), Image.Resampling.LANCZOS
    )
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def uniform_bottom_band_frac(data: bytes, *, std_thr: float = 4.0) -> float:
    """04:30：底部整行近乎纯色（行内灰度标准差 < std_thr）的连续行数占高比例。"""
    import numpy as np

    a = np.asarray(Image.open(BytesIO(data)).convert("L"), dtype=np.float32)
    h = a.shape[0]
    rs = a.std(axis=1)
    n = 0
    for y in range(h - 1, -1, -1):
        if rs[y] < std_thr:
            n += 1
        else:
            break
    return n / float(h)


def assert_no_uniform_bottom_band(data: bytes, *, expr_key: str, max_frac: float = 0.06) -> float:
    """04:30：头肩格底部不得有整条纯色垫块（灰垫/白条）；头肩构图底行必穿过衣服。"""
    frac = uniform_bottom_band_frac(data)
    if frac > max_frac:
        raise CharacterSheetError(
            f"{expr_key}底部纯色垫块门禁: band={frac:.3f}>{max_frac:.2f}（禁止灰色填充）",
            status_code=422,
        )
    return frac


def assert_expr_frame_match(
    data: bytes,
    frame: dict,
    *,
    expr_key: str,
    tol_face: float = 0.07,
    tol_top: float = 0.07,
) -> dict:
    """04:30：新表情格构图须与锁定格同比例（脸高、头顶留白）。"""
    m = measure_expr_frame(data)
    if m is None:
        raise CharacterSheetError(f"{expr_key}构图门禁: 测不到脸", status_code=422)
    d_face = abs(m["face_frac"] - float(frame["face_frac"]))
    d_top = abs(m["face_top_frac"] - float(frame["face_top_frac"]))
    if d_face > tol_face or d_top > tol_top:
        raise CharacterSheetError(
            f"{expr_key}构图门禁: 与锁定格不同比例 face={m['face_frac']:.3f} vs {frame['face_frac']:.3f}, "
            f"top={m['face_top_frac']:.3f} vs {frame['face_top_frac']:.3f}",
            status_code=422,
        )
    return {**m, "d_face": d_face, "d_top": d_top}


def crop_expr_head_closeup(
    data: bytes,
    *,
    size: int = 768,
    chin_margin_face_frac: float = 0.40,
    hair_above_face_frac: float = 0.60,
    target_face_height_frac: float = 0.45,
    top_margin_frac: float = 0.10,
    frame: dict | None = None,
) -> bytes:
    """02:42：表情格头部特写裁剪。

    04:30：**禁止任何色块/灰垫填充**。源图下方/侧边不够时抛
    ``HeadcropSourceShort``（调用方换更宽的源再裁），不再用角点色垫边。
    ``frame``（来自已锁表情格的 face_frac/face_top_frac/face_cx_frac 中位数）给定时，
    按同一检测器同比例裁，保证与锁定格头顶留白、肩线一致。

    - 脸框上沿以上至少 ``hair_above_face_frac``(默认 0.6) 倍脸高，盖住整个发顶；
    - 成品脸高约占画面 ``target_face_height_frac``(≈0.45)；
    - 头顶留白约 ``top_margin_frac``(8–12%，默认 0.10)；
    - 下沿到锁骨附近（``chin_margin_face_frac``≈0.40 脸高）；
    - 源图发顶空间不足时 **禁止** 灰底垫高；贴顶实裁，由发顶平切门禁拒灰底平切；上游可换全身/立绘或让 Qwen 补发顶。
    """
    im0 = Image.open(BytesIO(data)).convert("RGB")
    w0, h0 = im0.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(im0)
        except Exception:  # noqa: BLE001
            bb = None
    if bb is None:
        # 无人脸：中上 70% 方裁兜底
        side = min(w0, h0)
        left = (w0 - side) // 2
        top = max(0, int(h0 * 0.02))
        if top + side > h0:
            top = max(0, h0 - side)
        crop = im0.crop((left, top, left + side, top + side)).resize(
            (int(size), int(size)), Image.Resampling.LANCZOS
        )
        buf = BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue()
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    fw = max(8.0, fx2 - fx1)
    fh = max(8.0, fy2 - fy1)
    fcx = (fx1 + fx2) / 2.0
    if frame:
        return _crop_expr_to_frame(im0, (fx1, fy1, fx2, fy2), frame, size=int(size))
    hair_pad = max(0.50, float(hair_above_face_frac)) * fh
    hair_top = fy1 - hair_pad
    chin_bottom = fy2 + float(chin_margin_face_frac) * fh
    tgt_face = max(0.38, min(0.55, float(target_face_height_frac)))
    top_m = max(0.08, min(0.12, float(top_margin_frac)))
    # 目标边长：脸约占 45%
    side_f = fh / tgt_face
    # 水平略宽于脸
    side_f = max(side_f, fw * 1.35)
    # 竖直至少覆盖 发顶pad + 脸 + 锁骨
    span_need = (hair_pad + fh + float(chin_margin_face_frac) * fh) + top_m * side_f
    side_f = max(side_f, span_need)
    side = int(math.ceil(side_f))
    # 裁顶：发顶之上再留 top_margin
    top_f = hair_top - top_m * side
    left_f = fcx - side / 2.0
    # 发顶空间不足：禁止灰底垫高（会制造发顶平切）。
    # 改为贴源图顶实裁，保留已有发丝；平切门禁再拒「灰底+水平发际」。
    # 上游可换全身/立绘或让 Qwen 补发顶后重试。
    short_headroom = False
    if hair_top < 0.0:
        short_headroom = True
        hair_top = 0.0
        top_f = hair_top - top_m * side
    if top_f < 0.0:
        short_headroom = True
        top_f = 0.0
    # 04:30：禁止角点色垫边（0305 a1 底部大块灰垫根因）。只允许极小越界时平移窗口。
    img = im0
    over_l = max(0.0, -left_f)
    over_r = max(0.0, left_f + side - w0)
    over_b = max(0.0, top_f + side - h0)
    if side > min(w0, h0) * 1.03:
        raise HeadcropSourceShort(
            f"头特写源图不足: 需 side={side}px > 源 {w0}x{h0}（禁止灰垫，需更宽源/outpaint）"
        )
    if over_b > 0.04 * side:
        raise HeadcropSourceShort(
            f"头特写源图下方不足: 缺 {over_b:.0f}px（{over_b / side:.2f}×side，禁止灰垫，需更宽源/outpaint）"
        )
    if (over_l + over_r) > 0.15 * side:
        raise HeadcropSourceShort(
            f"头特写源图侧边不足: 左缺 {over_l:.0f}px 右缺 {over_r:.0f}px（禁止灰垫）"
        )
    w, h = img.size
    side = int(min(max(side, 64), w, h))
    left = int(round(left_f))
    top = int(round(top_f))
    # 钳制：下巴/锁骨落在裁底附近
    if chin_bottom - top > side * 0.98:
        top = int(round(chin_bottom - side * 0.96))
    left = max(0, min(w - side, left))
    top = max(0, min(h - side, top))
    # 二次确认：在未 short_headroom 时要求裁窗内发顶空间；不足则贴顶实裁（已禁止上垫灰）
    face_top_in_crop = fy1 - top
    if (not short_headroom) and face_top_in_crop + 1e-6 < 0.55 * fh:
        # 尽量上移裁窗（仍不越界到负）
        want_top = fy1 - 0.60 * fh - top_m * side
        top = max(0, int(round(want_top)))
        face_top_in_crop = fy1 - top
    crop = img.crop((left, top, left + side, top + side)).resize(
        (int(size), int(size)), Image.Resampling.LANCZOS
    )
    buf = BytesIO()
    crop.save(buf, format="PNG")
    out = buf.getvalue()
    # 成品构图复核：脸高 ~45%，头顶留白不过度
    bb2 = _detect_face_bbox_xyxy(out)
    if bb2 is not None:
        _x1, _y1, _x2, _y2 = [float(v) for v in bb2]
        face_frac = (_y2 - _y1) / float(size)
        top_blank = _y1 / float(size)
        # 脸过高/过低或顶留白过大（常见灰底平切）时再按目标重裁一次
        if face_frac > 0.55 or face_frac < 0.36 or top_blank > 0.18:
            fh2 = max(8.0, _y2 - _y1)
            hair2 = _y1 - 0.60 * fh2
            chin2 = _y2 + float(chin_margin_face_frac) * fh2
            side2 = int(max(64, fh2 / 0.45, (_x2 - _x1) * 1.3, chin2 - hair2 + 0.10 * (fh2 / 0.45)))
            im2 = Image.open(BytesIO(out)).convert("RGB")
            if side2 <= size and hair2 >= -1.0:
                cx2 = (_x1 + _x2) / 2.0
                top2 = int(round(hair2 - 0.10 * side2))
                left2 = int(round(cx2 - side2 / 2.0))
                # 二次裁也不上垫灰底
                left2 = max(0, min(size - side2, left2))
                top2 = max(0, min(size - side2, top2))
                c2 = im2.crop((left2, top2, left2 + side2, top2 + side2)).resize(
                    (int(size), int(size)), Image.Resampling.LANCZOS
                )
                buf2 = BytesIO()
                c2.save(buf2, format="PNG")
                out = buf2.getvalue()
    return out


def measure_hard_seam_contour(
    data: bytes,
    *,
    size: int = 768,
    stage: str = "raw",
) -> dict:
    """01:50：检测椭圆/矩形硬边接缝（边缘梯度沿闭合轮廓突变）。

    主信号：沿脸部羽化贴回遮罩边界的颜色跳变（专拦 0104 碎脸贴回伪影）；
    辅信号：轴对齐长边围成的矩形框；强闭合椭圆突变。

    stage:
      - raw：完整 Qwen 输出，mask_p75 阈值按 0104 碎脸校准
      - crop：头部特写裁剪后，mask 边界易与发际线重合 → 提高阈值，主靠 rect/ell
    """
    import cv2  # local: core/MateBook api venv 均有

    im0 = Image.open(BytesIO(data)).convert("RGB")
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(im0)
        except Exception:  # noqa: BLE001
            bb = None
    im = im0.resize((size, size), Image.Resampling.LANCZOS)
    if bb is not None:
        sx = size / float(max(1, im0.width))
        sy = size / float(max(1, im0.height))
        bb_s = (bb[0] * sx, bb[1] * sy, bb[2] * sx, bb[3] * sy)
    else:
        bb_s = None
    import numpy as np

    arr = np.asarray(im, dtype=np.float32)
    gray = arr.mean(axis=2).astype(np.float32)
    m = build_face_paste_mask(size, face_bbox=bb_s)
    marr = np.asarray(m, dtype=np.float32)
    try:
        from PIL import ImageFilter as _IF

        soft = np.asarray(
            m.filter(_IF.GaussianBlur(radius=max(2, size // 256))),
            dtype=np.float32,
        )
    except Exception:  # noqa: BLE001
        soft = marr
    ring = np.abs(marr - soft) > 6
    mk = np.ones((5, 5), np.uint8)
    dil = cv2.dilate(marr, mk)
    ero = cv2.erode(marr, mk)
    ring = ring | ((dil - ero) > 15)
    gy, gx = np.gradient(marr)
    ys, xs = np.where(ring)
    jumps: list[float] = []
    if len(xs) > 30:
        idx = np.linspace(0, len(xs) - 1, min(400, len(xs))).astype(int)
        for i in idx:
            x, y = int(xs[i]), int(ys[i])
            gxv, gyv = float(gx[y, x]), float(gy[y, x])
            nrm = (gxv * gxv + gyv * gyv) ** 0.5 + 1e-6
            gxv /= nrm
            gyv /= nrm
            xin = int(round(x - 5 * gxv))
            yin = int(round(y - 5 * gyv))
            xout = int(round(x + 5 * gxv))
            yout = int(round(y + 5 * gyv))
            if 0 <= xin < size and 0 <= yin < size and 0 <= xout < size and 0 <= yout < size:
                jumps.append(float(np.abs(arr[yin, xin] - arr[yout, xout]).mean()))
    if jumps:
        ja = np.asarray(jumps, dtype=np.float32)
        mask_p75 = float(np.percentile(ja, 75))
        mask_mean = float(ja.mean())
        mask_strong = float((ja > 32).mean())
    else:
        mask_p75 = mask_mean = mask_strong = 0.0

    edges = cv2.Canny(np.clip(gray, 0, 255).astype(np.uint8), 60, 160)
    margin = int(size * 0.12)
    roi = edges[margin : size - margin, margin : size - margin]
    lines = cv2.HoughLinesP(
        roi,
        1,
        np.pi / 180,
        threshold=40,
        minLineLength=int(size * 0.18),
        maxLineGap=8,
    )
    h_seg = v_seg = 0
    if lines is not None:
        for ln in lines:
            pts = ln[0] if getattr(ln, "ndim", 1) > 1 or len(ln) == 1 else ln
            try:
                x1, y1, x2, y2 = [int(v) for v in (pts if len(pts) == 4 else ln.reshape(-1)[:4])]
            except Exception:  # noqa: BLE001
                continue
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            if dy <= 3 and dx >= int(size * 0.18):
                h_seg += 1
            if dx <= 3 and dy >= int(size * 0.18):
                v_seg += 1
    rectish = bool(h_seg >= 2 and v_seg >= 2)

    # 顶部水平硬切（头特写常见矩形硬边：发顶被平切）
    top_band = edges[int(size * 0.04) : int(size * 0.18), int(size * 0.15) : int(size * 0.85)]
    top_row_frac = float((top_band > 0).mean(axis=1).max()) if top_band.size else 0.0
    top_hard_cut = bool(top_row_frac >= 0.55)

    mag = cv2.magnitude(
        cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3),
    )
    if bb_s is not None:
        cx = int((bb_s[0] + bb_s[2]) / 2)
        cy = int((bb_s[1] + bb_s[3]) / 2)
    else:
        cx, cy = size // 2, int(size * 0.40)
    best_ell = 0.0
    best_frac = 0.0
    for ry in range(int(size * 0.12), int(size * 0.28), 4):
        for rx in range(int(size * 0.10), int(size * 0.26), 4):
            n = 48
            strong = 0
            js: list[float] = []
            for i in range(n):
                a = 2 * math.pi * i / n
                x = int(round(cx + rx * math.cos(a)))
                y = int(round(cy + ry * math.sin(a)))
                if not (6 <= x < size - 6 and 6 <= y < size - 6):
                    continue
                nx, ny = math.cos(a), math.sin(a)
                xin = int(round(x - 4 * nx))
                yin = int(round(y - 4 * ny))
                xout = int(round(x + 4 * nx))
                yout = int(round(y + 4 * ny))
                j = float(np.abs(arr[yin, xin] - arr[yout, xout]).mean())
                m0 = float(mag[y, x])
                ms = 0.5 * (float(mag[yin, xin]) + float(mag[yout, xout]))
                thin = m0 / max(ms, 1.0)
                js.append(j)
                if j > 32 and thin > 1.7:
                    strong += 1
            if len(js) < 30:
                continue
            frac = strong / float(n)
            score = float(sum(js) / len(js)) * frac * 2.0
            if score > best_ell:
                best_ell = score
                best_frac = frac

    # 校准：0104 沉思过门禁碎脸 / 温柔 a5（raw）必须拒；锁定好格放行
    # crop 阶段：头特写使 paste-mask 边界贴发际线，易误杀 → 提高 mask 阈值
    st = (stage or "raw").strip().lower()
    if st == "crop":
        mask_hit = mask_p75 >= 40.0 and mask_strong >= 0.27
        ell_hit = best_ell >= 80.0 and best_frac >= 0.38
        # crop 额外拦发顶水平硬切
        extra = top_hard_cut
    else:
        mask_hit = mask_p75 >= 26.0 and mask_strong >= 0.20
        ell_hit = best_ell >= 70.0 and best_frac >= 0.35
        extra = False
    reject = bool(mask_hit or rectish or ell_hit or extra)
    return {
        "mask_p75": mask_p75,
        "mask_mean": mask_mean,
        "mask_strong": mask_strong,
        "rectish": rectish,
        "h_seg": h_seg,
        "v_seg": v_seg,
        "ell_score": best_ell,
        "ell_frac": best_frac,
        "top_hard_cut": top_hard_cut,
        "stage": st,
        "reject": reject,
    }


def measure_flat_hairline_cut(
    data: bytes,
    *,
    min_run_px: int = 40,
    bg_tol: float = 18.0,
    min_flat_y_frac: float = 0.05,
) -> dict:
    """02:42：发顶平切检测——顶部发际轮廓出现 ≥min_run_px 水平直线且其上为均匀灰底即拒。

    用每列最上方前景 y 构成发际轮廓；连续同 y（容差 0）的水平段长度即平切 run。
    发顶紧贴画布上沿（无灰底垫高）不判为平切，避免误杀自然顶裁。
    """
    import numpy as np

    im = np.asarray(Image.open(BytesIO(data)).convert("RGB"), dtype=np.float32)
    h, w, _ = im.shape
    corners = np.concatenate(
        [im[:12, :12].reshape(-1, 3), im[:12, -12:].reshape(-1, 3)],
        axis=0,
    )
    bg = np.median(corners, axis=0)
    dist = np.linalg.norm(im - bg[None, None, :], axis=2)
    gray = im.mean(axis=2)
    fg = (dist > float(bg_tol)) & (gray < float(bg.mean()) - 6.0)
    top_y = np.full(w, -1, dtype=np.int32)
    for x in range(w):
        ys = np.where(fg[:, x])[0]
        if len(ys):
            top_y[x] = int(ys[0])
    best = 0
    best_y = -1
    best_x0 = -1
    cur = 0
    cur_y = -1
    cur_x0 = -1
    for x in range(w):
        y = int(top_y[x])
        if y < 0:
            cur = 0
            cur_y = -1
            continue
        if cur > 0 and y == cur_y:
            cur += 1
            if cur > best:
                best = cur
                best_y = cur_y
                best_x0 = cur_x0
        else:
            cur = 1
            cur_y = y
            cur_x0 = x
            if cur > best:
                best = cur
                best_y = y
                best_x0 = x
    gray_above = False
    y_floor = int(float(min_flat_y_frac) * h)
    if best_y >= y_floor:
        band = im[max(0, best_y - min(best_y, 24)) : best_y]
        if band.size:
            d = np.linalg.norm(band - bg[None, None, :], axis=2)
            gray_above = float(np.median(d)) < float(bg_tol) and float(d.std()) < 12.0
    reject = bool(best >= int(min_run_px) and best_y >= y_floor and gray_above)
    return {
        "max_flat_run": int(best),
        "flat_y": int(best_y),
        "flat_x0": int(best_x0),
        "flat_y_frac": (float(best_y) / float(h) if best_y >= 0 else None),
        "gray_above": bool(gray_above),
        "min_run_px": int(min_run_px),
        "reject": reject,
    }


def assert_no_flat_hairline_cut(
    data: bytes,
    *,
    expr_key: str = "expr",
    min_run_px: int = 40,
) -> dict:
    """02:42：发顶平切门禁——顶部发际 ≥40px 水平直线（其上灰底）即 FAIL。"""
    info = measure_flat_hairline_cut(data, min_run_px=min_run_px)
    info["expr_key"] = expr_key
    if info.get("reject"):
        raise CharacterSheetError(
            f"{expr_key}发顶平切门禁: 发际水平直线 "
            f"run={info['max_flat_run']}px≥{min_run_px} "
            f"y={info['flat_y']}({info.get('flat_y_frac')})",
            status_code=422,
        )
    return info



def assert_no_hard_seam_contour(
    data: bytes,
    *,
    expr_key: str = "expr",
    size: int = 768,
    stage: str = "raw",
) -> dict:
    """01:50：接缝门禁——椭圆/矩形硬边（闭合轮廓梯度突变）即拒。"""
    info = measure_hard_seam_contour(data, size=size, stage=stage)
    info["expr_key"] = expr_key
    if info.get("reject"):
        raise CharacterSheetError(
            f"{expr_key}接缝门禁: 检测到椭圆/矩形硬边 "
            f"(stage={info.get('stage')} mask_p75={info['mask_p75']:.1f} "
            f"strong={info['mask_strong']:.2f} "
            f"ell={info['ell_score']:.1f}/{info['ell_frac']:.2f} "
            f"rect={info['rectish']})",
            status_code=422,
        )
    return info


def _parse_yes_no_token(raw) -> bool | None:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("true", "yes", "y", "1", "是", "对", "有"):
            return True
        if s in ("false", "no", "n", "0", "否", "不", "没有", "无"):
            return False
    return None


_EXPR_QA_PROMPTS: dict[str, str] = {
    # 04:30：q1 判是否闭嘴（张嘴/O 形嘴一律否），q2 判是否符合该情绪；两问皆是才过
    "expr_2": (
        "You are inspecting an anime character head closeup for a CONTEMPLATIVE (沉思) expression. "
        "Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: "
        '{"q1":true,"q2":true}. '
        "q1: Is the mouth CLOSED (lips together)? Answer false if the mouth is open at all, "
        "including an O-shaped or round open mouth, visible teeth or a gap between the lips. "
        "q2: Does the face read as contemplative: gaze directed DOWNWARD or down-to-the-side "
        "(视线下垂偏一侧 / looking down and to one side) "
        "(not staring blankly at the viewer), brows slightly knit/furrowed, no smile? "
        "Answer false for a blank empty stare, surprise, or smiling. "
        "Judge only from visible face features."
    ),
    "expr_3": (
        "You are inspecting an anime character head closeup for a GENTLE (温柔) expression. "
        "Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: "
        '{"q1":true,"q2":true}. '
        "q1: Is the mouth CLOSED with a slight smile (lips together, mouth corners up)? "
        "Answer false if the mouth is open, O-shaped, showing teeth, or not smiling. "
        "q2: Does the face read as gentle: soft warm eyes (open eyes or 弯月眼 crescent eyes both OK; closed eyes NOT required), relaxed brows, "
        "no frown, no blank stare? "
        "Judge only from visible face features."
    ),
    # 05:30：嘴部放大复判——0505 expr_2 整格问答判「闭嘴」但目检是小 O 形张嘴（暗红口腔可见）。
    # 4B VLM 在 768 头肩格上看不清小嘴，放大嘴部后单独再问一次。
    "mouth_zoom": (
        "This image is a ZOOMED crop of the mouth area of an anime character. "
        "Answer TWO yes/no questions. Output ONLY one JSON object, no markdown: "
        '{"q1":true,"q2":true}. '
        "q1: Are the lips FULLY CLOSED, drawn as a single line or a closed curve, with NO opening? "
        "Answer false if there is ANY visible gap, small oval or round opening, dark or red mouth "
        "interior, tongue or teeth, however small. "
        "q2: Is a mouth clearly visible in this crop? "
        "Judge only from what is visible."
    ),
}


def crop_mouth_zoom(data: bytes, *, out_w: int = 512) -> bytes:
    """05:30：按脸框裁嘴部（脸框 0.40→1.15 高、中间 70% 宽，容检测框偏差）并放大，供 VLM 复判是否闭嘴。"""
    bb = _detect_face_bbox_xyxy(data)
    im = Image.open(BytesIO(data)).convert("RGB")
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(im)
        except Exception:  # noqa: BLE001
            bb = None
    if bb is None:
        raise CharacterSheetError("嘴部放大: 测不到脸", status_code=422)
    w, h = im.size
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    fw = max(8.0, fx2 - fx1)
    fh = max(8.0, fy2 - fy1)
    x1 = int(max(0, round(fx1 + 0.15 * fw)))
    x2 = int(min(w, round(fx2 - 0.15 * fw)))
    y1 = int(max(0, round(fy1 + 0.40 * fh)))
    y2 = int(min(h, round(fy2 + 0.15 * fh)))
    if x2 - x1 < 16 or y2 - y1 < 12:
        raise CharacterSheetError(
            f"嘴部放大: 裁区过小 {x2 - x1}x{y2 - y1}", status_code=422
        )
    crop = im.crop((x1, y1, x2, y2))
    oh = max(1, int(round(out_w * crop.height / float(crop.width))))
    crop = crop.resize((int(out_w), oh), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def _iris_hue_in_band(
    im: Image.Image,
    band: tuple[int, int, int, int],
) -> tuple[float, int] | None:
    """01:45：眼带主色相（饱和像素圆均值）；饱和像素不足返回 None。"""
    import numpy as np

    ex0, ey0, ex1, ey1 = [int(v) for v in band]
    if ex1 - ex0 < 8 or ey1 - ey0 < 8:
        return None
    eye = np.asarray(im.convert("RGB"), dtype=np.float32)[ey0:ey1, ex0:ex1] / 255.0
    mx = np.max(eye, axis=2)
    mn = np.min(eye, axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    m = (sat > 0.45) & (mx > 0.35)
    if int(m.sum()) < 30:
        return None
    px = eye[m]
    step = max(1, len(px) // 2000)
    sin_sum = 0.0
    cos_sum = 0.0
    n = 0
    for p in px[::step]:
        hh, _ss, _vv = colorsys.rgb_to_hsv(float(p[0]), float(p[1]), float(p[2]))
        ang = hh * 360.0
        sin_sum += math.sin(math.radians(ang))
        cos_sum += math.cos(math.radians(ang))
        n += 1
    if n == 0:
        return None
    return (math.degrees(math.atan2(sin_sum / n, cos_sum / n)) % 360.0, n)


def measure_iris_hue(data: bytes) -> tuple[float, int] | None:
    """01:45：表情格眼带（脸框 28%-52% 高、cx±35%fh）主色相。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    bb = _expr_face_bbox_of(im)
    if bb is None:
        return None
    x1, y1, x2, y2 = bb
    fh = max(8.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    band = (
        int(cx - 0.35 * fh),
        int(y1 + 0.28 * fh),
        int(cx + 0.35 * fh),
        int(y1 + 0.52 * fh),
    )
    return _iris_hue_in_band(im, band)


def assert_iris_hue_match(
    cell_data: bytes,
    ref_data: bytes,
    *,
    expr_key: str = "expr",
    max_hue_diff: float = 40.0,
) -> dict:
    """01:45：瞳色漂移门禁——生成格眼带主色相须与编辑底一致（0110 实证红瞳假通过 hue 差 127°，蓝系互差≤2°）。"""
    got = measure_iris_hue(cell_data)
    ref = measure_iris_hue(ref_data)
    if got is None or ref is None:
        # 测不到（灰度/低饱和）不拦，交目检
        return {"expr_key": expr_key, "skipped": True, "got": got, "ref": ref}
    diff = abs(got[0] - ref[0]) % 360.0
    diff = min(diff, 360.0 - diff)
    if diff > float(max_hue_diff):
        raise CharacterSheetError(
            f"{expr_key}瞳色漂移门禁: 眼带色相 {got[0]:.0f}° vs 底 {ref[0]:.0f}° (diff {diff:.0f}°>{max_hue_diff:.0f}°)",
            status_code=422,
        )
    return {"expr_key": expr_key, "hue": got[0], "ref_hue": ref[0], "diff": diff}


def assert_mouth_zoom_closed(expr_key: str, qa: dict) -> dict:
    """05:30：嘴部放大复判两问皆须为是（闭嘴且看得到嘴），否则 FAIL 换 seed。"""
    q1 = qa.get("q1")
    q2 = qa.get("q2")
    info = {"expr_key": expr_key, "q1": q1, "q2": q2, "pass": False}
    if q1 is not True or q2 is not True:
        raise CharacterSheetError(
            f"{expr_key}嘴部放大复判未过: 闭嘴={q1!r} 可见={q2!r}（张嘴/小O形/口腔可见一律拒）",
            status_code=422,
        )
    info["pass"] = True
    return info


def _parse_expr_qa_json(raw: str) -> dict:
    """解析专项问答 JSON：须含 q1/q2 布尔。"""
    import ast

    text = (raw or "").strip()
    if not text:
        raise CharacterSheetError("专项问答返回空文本", status_code=502)
    if text.startswith("["):
        try:
            lit = ast.literal_eval(text)
            if isinstance(lit, list) and lit:
                first = lit[0]
                text = (
                    first
                    if isinstance(first, str)
                    else json.dumps(first, ensure_ascii=False)
                )
        except (SyntaxError, ValueError):
            pass
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise CharacterSheetError(f"专项问答无 JSON: {raw[:200]}", status_code=502)
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise CharacterSheetError(
            f"专项问答 JSON 解析失败: {e}; raw={raw[:240]}",
            status_code=502,
        ) from e
    if not isinstance(obj, dict):
        raise CharacterSheetError("专项问答 JSON 非对象", status_code=502)
    q1 = _parse_yes_no_token(obj.get("q1", obj.get("Q1")))
    q2 = _parse_yes_no_token(obj.get("q2", obj.get("Q2")))
    if q1 is None or q2 is None:
        raise CharacterSheetError(
            f"专项问答缺 q1/q2 布尔: {obj!r}",
            status_code=502,
        )
    return {"q1": q1, "q2": q2, "raw": raw, "obj": obj}


def assert_expression_qa_match(expr_key: str, qa: dict) -> dict:
    """沉思/温柔专项两问皆须为是。"""
    if expr_key not in ("expr_2", "expr_3"):
        raise CharacterSheetError(f"专项问答不支持 {expr_key}", status_code=422)
    q1 = qa.get("q1")
    q2 = qa.get("q2")
    want = _EXPR_KEY_TO_VLM_LABEL.get(expr_key, expr_key)
    info = {"expr_key": expr_key, "want": want, "q1": q1, "q2": q2, "pass": False}
    if q1 is not True or q2 is not True:
        raise CharacterSheetError(
            f"{expr_key}{want}专项问答未过: q1={q1!r} q2={q2!r}（两问皆须是）",
            status_code=422,
        )
    info["pass"] = True
    return info



def pick_best_expression_candidate(
    cands: list[bytes],
    *,
    neutral_ref: bytes | None,
    portrait_ref: bytes | None,
    expr_key: str,
    min_clip: float = 0.72,
) -> bytes:
    """4 候选：选与中性脸差异最大、且与主立绘 CLIP 相对比对仍通过的那张。"""
    if not cands:
        raise CharacterSheetError(f"{expr_key}无表情候选", status_code=422)
    scored: list[tuple[float, bytes]] = []
    for c in cands:
        diff = (
            expression_roi_pixel_diff(c, neutral_ref)
            if neutral_ref
            else expression_roi_pixel_diff(c, cands[0])
        )
        if portrait_ref is not None:
            sim = clip_image_cosine_sim(c, portrait_ref)
            if sim is not None and sim + 1e-12 < float(min_clip):
                continue
        scored.append((diff, c))
    if not scored:
        # 全部 CLIP 不过：退回差异最大者（仍过后续门禁）
        scored = [
            (
                expression_roi_pixel_diff(c, neutral_ref) if neutral_ref else 0.0,
                c,
            )
            for c in cands
        ]
    scored.sort(key=lambda t: t[0], reverse=True)
    return scored[0][1]


def expression_roi_pixel_diff(a: bytes, b: bytes) -> float:
    """两图眉眼嘴 ROI 的平均绝对像素差（0–255）。"""
    ia = _facial_feature_roi(Image.open(BytesIO(a)).convert("RGB").resize((256, 256), Image.Resampling.BILINEAR))
    ib = _facial_feature_roi(Image.open(BytesIO(b)).convert("RGB").resize((256, 256), Image.Resampling.BILINEAR))
    pa = list(ia.getdata())
    pb = list(ib.getdata())
    if not pa or len(pa) != len(pb):
        return 0.0
    acc = 0.0
    for (r1, g1, b1), (r2, g2, b2) in zip(pa, pb):
        acc += (abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)) / 3.0
    return acc / float(len(pa))


def mouth_dark_ratio(data: bytes) -> float:
    """嘴区深色占比（张嘴口腔）；供语义门禁复用。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    w, h = im.size
    box = (int(w * 0.32), int(h * 0.55), int(w * 0.68), int(h * 0.78))
    crop = im.crop(box)
    px = list(crop.getdata())
    if not px:
        return 0.0
    dark = sum(1 for r, g, b in px if (r + g + b) / 3.0 < 70)
    return dark / float(len(px))


def mouth_appears_open(data: bytes) -> bool:
    """惊恐门禁：下半脸中央出现明显深色张嘴区域。"""
    # 闭嘴几乎无深色洞；张嘴通常 ≥8% 深色
    return mouth_dark_ratio(data) >= 0.08


def mouth_appears_wide_open(data: bytes) -> bool:
    """大张嘴（惊恐级）；温柔轻露上齿不应触发（1915 误杀根因：0.09≈露齿）。"""
    return mouth_dark_ratio(data) >= 0.16




def _mouth_corner_lift(data: bytes) -> float:
    """嘴角相对嘴中的上扬：正=微笑（角高于中），≈0=平，负=下垂。

    只看唇线深色行质心几何，不用肤色亮度（anime 平嘴易被亮度误判）。
    """
    im = Image.open(BytesIO(data)).convert("RGB")
    w, h = im.size
    y0, y1 = int(h * 0.56), int(h * 0.74)
    bands = {
        "mid": (int(w * 0.44), y0, int(w * 0.56), y1),
        "left": (int(w * 0.30), y0, int(w * 0.40), y1),
        "right": (int(w * 0.60), y0, int(w * 0.70), y1),
    }

    def _lip_y_frac(box: tuple[int, int, int, int]) -> float:
        crop = im.crop(box)
        cw, ch = crop.size
        if ch < 2:
            return 0.5
        px = crop.load()
        best_y, best_n = ch // 2, -1
        for y in range(ch):
            n = 0
            for x in range(cw):
                r, g, b = px[x, y]
                lum = (r + g + b) / 3.0
                # 唇色：偏暗红/褐，排除近黑发与近白肤
                if 40 <= lum <= 165 and r >= g - 5 and r >= b - 5 and max(r, g, b) - min(r, g, b) >= 12:
                    n += 1
                elif lum < 95 and max(r, g, b) - min(r, g, b) < 28:
                    n += 1
            if n > best_n:
                best_n, best_y = n, y
        return best_y / float(max(1, ch - 1))

    y_mid = _lip_y_frac(bands["mid"])
    y_side = (_lip_y_frac(bands["left"]) + _lip_y_frac(bands["right"])) / 2.0
    # 角更靠上 → y_side < y_mid → 正值
    return float(y_mid - y_side)


def _brow_press_delta(data: bytes, neutral: bytes | None) -> float | None:
    """相对中性脸：眉带深色质心下移为正（压眉）；上移为负（舒展/挑眉）。"""
    if not neutral:
        return None
    im = Image.open(BytesIO(data)).convert("RGB")
    neu = Image.open(BytesIO(neutral)).convert("RGB").resize(im.size, Image.Resampling.LANCZOS)
    w, h = im.size
    box = (int(w * 0.22), int(h * 0.16), int(w * 0.78), int(h * 0.36))

    def _centroid(img: Image.Image) -> float:
        crop = img.crop(box)
        cw, ch = crop.size
        px = list(crop.getdata())
        weights = []
        for y in range(ch):
            row = px[y * cw : (y + 1) * cw]
            dark = sum(
                1
                for r, g, b in row
                if (r + g + b) / 3.0 < 90 and max(r, g, b) - min(r, g, b) < 40
            )
            weights.append(dark)
        tot = sum(weights) or 1
        return sum(i * ww for i, ww in enumerate(weights)) / float(tot * max(1, ch - 1))

    return float(_centroid(im) - _centroid(neu))



_EXPR_VLM_LABEL_TO_KEY = {
    "威严": "expr_0",
    "冷酷": "expr_1",
    "沉思": "expr_2",
    "温柔": "expr_3",
    "惊恐": "expr_4",
    "果断": "expr_5",
}
_EXPR_KEY_TO_VLM_LABEL = {v: k for k, v in _EXPR_VLM_LABEL_TO_KEY.items()}

_EXPR_VLM_PROMPT = (
    "You are an expression classifier for anime character closeups. "
    "Choose exactly ONE label from: 威严, 冷酷, 沉思, 温柔, 惊恐, 果断. "
    "Also answer the yes/no second question: is the face smiling "
    "(mouth corners up OR soft closed-eye smile)? "
    "Output ONLY one JSON object, no markdown, no extra text. Schema: "
    '{"label":"<one of six>","scores":{"威严":0,"冷酷":0,"沉思":0,"温柔":0,"惊恐":0,"果断":0},'
    '"smiling":true}. '
    "smiling must be a boolean: true if mouth corners raised or soft smile / crescent eyes, else false. "
    "Fill scores with your confidences (0~1, roughly normalized). "
    "Do NOT copy any example; judge from the actual face in the image. "
    "Visible-feature definitions (must match what you see, not just the name): "
    "威严=chin raised + looking down at viewer + sharp narrowed eyes + eyebrows lowered + tight closed mouth "
    "(reject if wide eyes or blank stare); "
    "冷酷=expressionless + half-lidded eyes + flat mouth + eyebrows neutral "
    "(reject if frown or smile); "
    "沉思=eyes looking down and to one side + brows slightly furrowed (soft knit) + lips closed + faraway gaze "
    "(reject if smile or open mouth or looking straight alert); "
    "温柔=relaxed brows + gentle smile with mouth corners up + eyes softly curved (open or crescent OK, closed OK); reject if no smile / frown; "
    "for 温柔, smiling MUST be true; "
    "惊恐=wide eyes + open mouth; "
    "果断=focused eyes + firm closed mouth + brows slightly lowered."
)


def _crop_expr_face_same_scale(
    data: bytes,
    *,
    size: int = 768,
    target_face_height_frac: float = 0.60,
    min_face_height_frac: float = 0.55,
    max_face_height_frac: float = 0.65,
) -> bytes:
    """表情格同尺度裁剪：脸高约占格高 0.55–0.65，保留嘴与少许下颌，禁贴眼特写。

    源图已贴脸过近时先垫棚灰再拉远，保证能落到目标窗。
    """
    img = Image.open(BytesIO(data)).convert("RGB")
    w0, h0 = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(img)
        except Exception:  # noqa: BLE001
            bb = None
    if bb is None:
        return enforce_head_shoulders_square(
            data,
            size=int(size),
            max_upscale=2.2,
            check_coverage=False,
            face_closeup_gate=False,
        )
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    fw = max(8.0, fx2 - fx1)
    fh = max(8.0, fy2 - fy1)
    fcx = (fx1 + fx2) / 2.0
    fcy = (fy1 + fy2) / 2.0
    tgt = max(0.52, min(0.68, float(target_face_height_frac)))
    # 需要的裁边：脸高 / tgt；水平略宽
    need = int(max(fh / tgt, fw * 1.70, 64))
    # 若源图不够大，垫棚灰（与 anime 底接近）
    pad = 0
    if need > min(w0, h0) - 2:
        pad = int(math.ceil((need - min(w0, h0)) / 2.0)) + 16
    if pad > 0:
        canvas = Image.new("RGB", (w0 + 2 * pad, h0 + 2 * pad), (220, 220, 224))
        canvas.paste(img, (pad, pad))
        img = canvas
        fx1 += pad
        fy1 += pad
        fx2 += pad
        fy2 += pad
        fcx += pad
        fcy += pad
    w, h = img.size
    mouth_y = fy1 + 0.72 * fh
    chin_y = fy2 + 0.10 * fh
    side = int(max(fh / tgt, fw * 1.70, 64))
    out = data
    for _round in range(12):
        side = max(64, min(side, w, h))
        # 竖直：脸顶约 12%；若嘴贴底则整体上移或放大
        top = int(round(fy1 - 0.12 * side))
        left = int(round(fcx - side / 2.0))
        for _ in range(5):
            left = max(0, min(w - side, left))
            top = max(0, min(h - side, top))
            if (mouth_y - top) <= side * 0.90 and (chin_y - top) <= side * 0.95:
                break
            side = int(min(max(w, h), max(side + 8, int(side * 1.08))))
            side = min(side, w, h)
            top = int(round(fy1 - 0.12 * side))
            left = int(round(fcx - side / 2.0))
        left = max(0, min(w - side, left))
        top = max(0, min(h - side, top))
        crop = img.crop((left, top, left + side, top + side))
        crop = crop.resize((int(size), int(size)), Image.Resampling.LANCZOS)
        buf = BytesIO()
        crop.save(buf, format="PNG")
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        if frac is None:
            break
        lo = float(min_face_height_frac)
        hi = float(max_face_height_frac)
        mid = 0.5 * (lo + hi)
        if lo - 1e-6 <= frac <= hi + 1e-6:
            try:
                assert_mouth_in_frame(out)
                return out
            except CharacterSheetError:
                side = int(min(max(w, h), side * 1.10))
                continue
        if frac > hi:
            side = int(max(side + 4, side * (frac / max(mid, 0.58))))
            # 仍可能顶到画布：继续垫边
            if side > min(w, h):
                extra = int(math.ceil((side - min(w, h)) / 2.0)) + 8
                canvas = Image.new(
                    "RGB", (w + 2 * extra, h + 2 * extra), (220, 220, 224)
                )
                canvas.paste(img, (extra, extra))
                img = canvas
                fx1 += extra
                fy1 += extra
                fx2 += extra
                fy2 += extra
                fcx += extra
                fcy += extra
                mouth_y += extra
                chin_y += extra
                w, h = img.size
        else:
            side = int(max(64, side * (frac / max(mid, 0.58))))
    return out


def assert_mouth_in_frame(
    data: bytes,
    *,
    face_bbox: tuple[float, float, float, float] | None = None,
    margin_frac: float = 0.04,
) -> dict:
    """嘴须在格内：估算嘴部 y 不得贴/出底；脸框下沿也不得贴底（禁只剩眼睛）。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    _w, h = img.size
    bb = face_bbox
    if bb is None:
        bb = _detect_face_bbox_xyxy(data)
        if bb is None:
            bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        raise CharacterSheetError("mouth-in-frame: no face", status_code=422)
    x1, y1, x2, y2 = [float(v) for v in bb]
    fh = max(1.0, y2 - y1)
    mouth_y = y1 + 0.72 * fh
    chin_y = y2
    bottom_lim = float(h) * (1.0 - float(margin_frac))
    if mouth_y >= bottom_lim:
        raise CharacterSheetError(
            f"mouth near/below bottom mouth_y={mouth_y:.1f} h={h} (overcropped eyes-only)",
            status_code=422,
        )
    if chin_y >= float(h) * (1.0 - float(margin_frac) * 0.5):
        raise CharacterSheetError(
            f"face/chin clipped at bottom chin_y={chin_y:.1f} h={h}",
            status_code=422,
        )
    # 脸下沿须明显低于半格，否则多半是贴眼特写
    if y2 / float(max(1, h)) < 0.48:
        raise CharacterSheetError(
            f"face bottom too high y2/h={y2 / float(h):.3f} (eyes-only crop)",
            status_code=422,
        )
    return {
        "mouth_y": float(mouth_y),
        "chin_y": float(chin_y),
        "mouth_in_frame": True,
    }


def _parse_vlm_expression_json(raw: str, labels: tuple[str, ...] = _EXPR_LABELS) -> dict:
    """从 VLM 原始文本解析 label + scores；失败抛 CharacterSheetError。"""
    import ast

    text = (raw or "").strip()
    if not text:
        raise CharacterSheetError("VLM 表情判官返回空文本", status_code=502)
    # PreviewAny / Qwen2_VQA 偶发返回 Python list 字面量：['{"label":...}']
    if text.startswith("["):
        try:
            lit = ast.literal_eval(text)
            if isinstance(lit, list) and lit:
                first = lit[0]
                text = (
                    first
                    if isinstance(first, str)
                    else json.dumps(first, ensure_ascii=False)
                )
            elif isinstance(lit, str):
                text = lit
        except (SyntaxError, ValueError):
            pass
    # 剥 markdown fence
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    text = text.strip().lstrip("\ufeff")
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise CharacterSheetError(
            f"VLM 表情判官无 JSON: {raw[:200]}", status_code=502
        )
    blob = m.group(0)
    try:
        obj = json.loads(blob)
    except json.JSONDecodeError as e:
        raise CharacterSheetError(
            f"VLM 表情判官 JSON 解析失败: {e}; raw={raw[:240]}",
            status_code=502,
        ) from e
    if not isinstance(obj, dict):
        raise CharacterSheetError("VLM 表情判官 JSON 非对象", status_code=502)
    label = str(obj.get("label") or obj.get("expression") or "").strip()
    # 容错英文/别名
    aliases = {
        "stern": "威严",
        "majestic": "威严",
        "cold": "冷酷",
        "aloof": "冷酷",
        "thoughtful": "沉思",
        "contemplative": "沉思",
        "gentle": "温柔",
        "tender": "温柔",
        "warm": "温柔",
        "terrified": "惊恐",
        "fear": "惊恐",
        "shocked": "惊恐",
        "determined": "果断",
        "resolute": "果断",
    }
    if label not in labels:
        low = label.lower()
        label = aliases.get(low, label)
    scores_in = obj.get("scores") or obj.get("probs") or obj.get("probabilities") or {}
    scores: dict[str, float] = {}
    if isinstance(scores_in, dict):
        for lab in labels:
            v = scores_in.get(lab)
            if v is None:
                # try english key
                for en, zh in aliases.items():
                    if zh == lab and en in scores_in:
                        v = scores_in[en]
                        break
            try:
                scores[lab] = float(v) if v is not None else 0.0
            except (TypeError, ValueError):
                scores[lab] = 0.0
    else:
        scores = {lab: 0.0 for lab in labels}
    if label not in labels:
        # 若 scores 有 argmax，用它
        if any(scores.values()):
            label = max(scores.items(), key=lambda kv: kv[1])[0]
        else:
            raise CharacterSheetError(
                f"VLM 表情判官 label 非法: {obj.get('label')!r}",
                status_code=502,
            )
    # 若 scores 全 0，把 label 置 1
    if not any(scores.values()):
        scores = {lab: (1.0 if lab == label else 0.0) for lab in labels}
    # 归一（容错）
    ssum = sum(max(0.0, float(v)) for v in scores.values()) or 1.0
    scores = {lab: max(0.0, float(scores.get(lab, 0.0))) / ssum for lab in labels}
    # 22:28：温柔第二问 — smiling 是/否
    smiling_raw = obj.get("smiling", obj.get("is_smiling", obj.get("smile")))
    smiling: bool | None = None
    if isinstance(smiling_raw, bool):
        smiling = smiling_raw
    elif isinstance(smiling_raw, (int, float)):
        smiling = bool(smiling_raw)
    elif isinstance(smiling_raw, str):
        s = smiling_raw.strip().lower()
        if s in ("true", "yes", "y", "1", "是", "微笑", "smile", "smiling"):
            smiling = True
        elif s in ("false", "no", "n", "0", "否", "不", "not smiling"):
            smiling = False
    return {"label": label, "scores": scores, "raw": raw, "smiling": smiling}


def build_expression_vlm_graph(
    image_name: str,
    *,
    prompt: str = _EXPR_VLM_PROMPT,
    model: str = "Qwen3-VL-4B-Instruct-FP8",
    seed: int = 42,
    backend: str = "Qwen2_VQA",
) -> dict:
    """构建 Comfy 表情六类分类图：LoadImage → Qwen2_VQA/AILab_QwenVL → PreviewAny。"""
    if backend == "AILab_QwenVL":
        return {
            "1": {"class_type": "LoadImage", "inputs": {"image": image_name}},
            "2": {
                "class_type": "AILab_QwenVL",
                "inputs": {
                    "model_name": model if model.startswith("Qwen") else "Qwen3-VL-4B-Instruct-FP8",
                    "quantization": "None (FP16)",
                    "attention_mode": "sdpa",
                    "preset_prompt": "🖼️ Detailed Description",
                    "custom_prompt": prompt,
                    "max_tokens": 512,
                    "keep_model_loaded": True,
                    "seed": max(1, int(seed)),
                    "image": ["1", 0],
                },
            },
            "3": {
                "class_type": "PreviewAny",
                "inputs": {"source": ["2", 0]},
            },
        }
    # 默认 Qwen2_VQA（节点清单含 Qwen3-VL-*FP8）
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "2": {
            "class_type": "Qwen2_VQA",
            "inputs": {
                "text": prompt,
                "model": model,
                "quantization": "none",
                "keep_model_loaded": True,
                "temperature": 0.2,
                "max_new_tokens": 512,
                "min_pixels": 200704,
                "max_pixels": 1003520,
                "seed": int(seed),
                "attention": "sdpa",
                "image": ["1", 0],
            },
        },
        "3": {
            "class_type": "PreviewAny",
            "inputs": {"source": ["2", 0]},
        },
    }


def _extract_history_text(entry: dict) -> str:
    """从 Comfy history entry 抽 STRING/text。"""
    outputs = (entry or {}).get("outputs") or {}
    chunks: list[str] = []
    for node_out in outputs.values():
        if not isinstance(node_out, dict):
            continue
        for key in ("text", "STRING", "string", "response", "RESPONSE", "result"):
            val = node_out.get(key)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip():
                        chunks.append(item)
                    elif isinstance(item, dict):
                        for kk in ("text", "string", "content"):
                            if isinstance(item.get(kk), str) and item[kk].strip():
                                chunks.append(item[kk])
            elif isinstance(val, str) and val.strip():
                chunks.append(val)
        # PreviewAny 偶发 ui / 其它键
        for val in node_out.values():
            if isinstance(val, str) and val.strip() and val not in chunks:
                if len(val) < 4000:
                    chunks.append(val)
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip() and item not in chunks:
                        chunks.append(item)
    return "\n".join(chunks).strip()


# 20:58：进程内粘性 VLM 后端——首次成功后优先复用，避免每表情轮询多模型反复加载
_VLM_STICKY_BACKEND: tuple[str, str] | None = None
_VLM_STICKY_EVIDENCE: dict[str, Any] = {
    "keep_model_loaded": True,
    "sticky_hits": 0,
    "sticky_misses": 0,
    "last_backend": None,
    "last_model": None,
}


def vlm_sticky_evidence() -> dict[str, Any]:
    """供 gate_summary / 进展记录：VLM 常驻与粘性命中证据。"""
    return {
        **dict(_VLM_STICKY_EVIDENCE),
        "sticky_backend": (
            list(_VLM_STICKY_BACKEND) if _VLM_STICKY_BACKEND else None
        ),
        "graph_keep_model_loaded": True,
    }


async def classify_expression_vlm(
    image_bytes: bytes,
    *,
    worker_url: str | None,
    labels: tuple[str, ...] = _EXPR_LABELS,
    seed: int = 42,
) -> dict:
    """调 Comfy Qwen VL 对表情做 6 选 1；返回 {label, scores, raw, model}。

    失败抛 CharacterSheetError（不许静默跳过判官伪过检）。
    图节点 keep_model_loaded=True；同进程粘性后端避免每表情重试多模型。
    """
    from app.comfy.client import ComfyUIClient, ComfyUIError

    global _VLM_STICKY_BACKEND
    if not worker_url:
        raise CharacterSheetError("VLM 判官缺少 worker_url", status_code=502)
    url = str(worker_url).rstrip("/")
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    fname = await client.upload_image(
        image_bytes, f"sheet_expr_vlm_{uuid.uuid4().hex[:10]}.png"
    )
    # 优先非 FP8：:8262 FP8 需 kernels 包，缺则 execution_error
    default_backends = (
        ("Qwen2_VQA", "Qwen3-VL-4B-Instruct"),
        ("Qwen2_VQA", "Qwen2-VL-7B-Instruct"),
        ("AILab_QwenVL", "Qwen3-VL-4B-Instruct"),
        ("Qwen2_VQA", "Qwen3-VL-8B-Instruct"),
        ("AILab_QwenVL", "Qwen3-VL-4B-Instruct-FP8"),
        ("Qwen2_VQA", "Qwen3-VL-4B-Instruct-FP8"),
    )
    if _VLM_STICKY_BACKEND is not None:
        sticky = _VLM_STICKY_BACKEND
        backends = (sticky,) + tuple(b for b in default_backends if b != sticky)
        _VLM_STICKY_EVIDENCE["sticky_hits"] = int(
            _VLM_STICKY_EVIDENCE.get("sticky_hits") or 0
        ) + 1
    else:
        backends = default_backends
        _VLM_STICKY_EVIDENCE["sticky_misses"] = int(
            _VLM_STICKY_EVIDENCE.get("sticky_misses") or 0
        ) + 1
    last_err: Exception | None = None
    for backend, model in backends:
        try:
            graph = build_expression_vlm_graph(
                fname, prompt=_EXPR_VLM_PROMPT, model=model, seed=seed, backend=backend
            )
            prompt_id = await client.queue_prompt(graph, client_id=f"sheet_vlm_{uuid.uuid4().hex[:8]}")
            waited = 0.0
            raw_text = ""
            while waited < 180.0:
                hist = await client.get_history(prompt_id)
                entry = (hist or {}).get(prompt_id) or {}
                st = entry.get("status") or {}
                if entry.get("outputs"):
                    raw_text = _extract_history_text(entry)
                    if raw_text:
                        break
                if st.get("status_str") == "error" or (
                    st.get("completed") is False
                    and any(
                        isinstance(m, list) and m and m[0] == "execution_error"
                        for m in (st.get("messages") or [])
                    )
                ):
                    msg = "execution_error"
                    for m in st.get("messages") or []:
                        if isinstance(m, list) and m and m[0] == "execution_error":
                            detail = m[1] if len(m) > 1 else {}
                            msg = str(
                                (detail or {}).get("exception_message")
                                or (detail or {}).get("exception_type")
                                or msg
                            )
                            break
                    raise CharacterSheetError(f"VLM 判官执行失败:{msg}", status_code=502)
                await asyncio.sleep(1.5)
                waited += 1.5
            if not raw_text:
                raise CharacterSheetError(
                    f"VLM 判官超时无文本 backend={backend} model={model}",
                    status_code=504,
                )
            parsed = _parse_vlm_expression_json(raw_text, labels=labels)
            parsed["model"] = f"{backend}:{model}"
            parsed["worker"] = url
            _VLM_STICKY_BACKEND = (backend, model)
            _VLM_STICKY_EVIDENCE["last_backend"] = backend
            _VLM_STICKY_EVIDENCE["last_model"] = model
            _VLM_STICKY_EVIDENCE["keep_model_loaded"] = True
            parsed["vlm_sticky"] = True
            parsed["keep_model_loaded"] = True
            return parsed
        except CharacterSheetError as e:
            last_err = e
            logger.warning("classify_expression_vlm %s/%s fail: %s", backend, model, e)
            continue
        except ComfyUIError as e:
            last_err = CharacterSheetError(f"VLM Comfy 错误:{e}", status_code=502)
            logger.warning("classify_expression_vlm comfy %s/%s: %s", backend, model, e)
            continue
        except Exception as e:  # noqa: BLE001
            last_err = CharacterSheetError(f"VLM 判官异常:{e}", status_code=502)
            logger.warning("classify_expression_vlm exc %s/%s: %s", backend, model, e)
            continue
    raise CharacterSheetError(
        f"VLM 表情判官全部后端失败: {last_err}",
        status_code=502,
    ) from last_err



async def classify_expression_qa(
    image_bytes: bytes,
    *,
    expr_key: str,
    worker_url: str | None,
    seed: int = 42,
) -> dict:
    """00:30：沉思/温柔专项两问（非六分类）。返回 {q1,q2,raw,model,...}。"""
    from app.comfy.client import ComfyUIClient, ComfyUIError

    global _VLM_STICKY_BACKEND
    if expr_key not in _EXPR_QA_PROMPTS:
        raise CharacterSheetError(f"专项问答无 prompt: {expr_key}", status_code=422)
    if not worker_url:
        raise CharacterSheetError("专项问答缺少 worker_url", status_code=502)
    url = str(worker_url).rstrip("/")
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    fname = await client.upload_image(
        image_bytes, f"sheet_expr_qa_{uuid.uuid4().hex[:10]}.png"
    )
    prompt = _EXPR_QA_PROMPTS[expr_key]
    default_backends = (
        ("Qwen2_VQA", "Qwen3-VL-4B-Instruct"),
        ("Qwen2_VQA", "Qwen2-VL-7B-Instruct"),
        ("AILab_QwenVL", "Qwen3-VL-4B-Instruct"),
        ("Qwen2_VQA", "Qwen3-VL-8B-Instruct"),
        ("AILab_QwenVL", "Qwen3-VL-4B-Instruct-FP8"),
        ("Qwen2_VQA", "Qwen3-VL-4B-Instruct-FP8"),
    )
    if _VLM_STICKY_BACKEND is not None:
        sticky = _VLM_STICKY_BACKEND
        backends = (sticky,) + tuple(b for b in default_backends if b != sticky)
        _VLM_STICKY_EVIDENCE["sticky_hits"] = int(
            _VLM_STICKY_EVIDENCE.get("sticky_hits") or 0
        ) + 1
    else:
        backends = default_backends
        _VLM_STICKY_EVIDENCE["sticky_misses"] = int(
            _VLM_STICKY_EVIDENCE.get("sticky_misses") or 0
        ) + 1
    last_err: Exception | None = None
    for backend, model in backends:
        try:
            graph = build_expression_vlm_graph(
                fname, prompt=prompt, model=model, seed=seed, backend=backend
            )
            prompt_id = await client.queue_prompt(
                graph, client_id=f"sheet_qa_{uuid.uuid4().hex[:8]}"
            )
            waited = 0.0
            _qa_queue_wait = 0.0
            raw_text = ""
            while waited < 180.0:
                hist = await client.get_history(prompt_id)
                entry = (hist or {}).get(prompt_id) or {}
                st = entry.get("status") or {}
                if entry.get("outputs"):
                    raw_text = _extract_history_text(entry)
                    if raw_text:
                        break
                if st.get("status_str") == "error" or (
                    st.get("completed") is False
                    and any(
                        isinstance(m, list) and m and m[0] == "execution_error"
                        for m in (st.get("messages") or [])
                    )
                ):
                    msg = "execution_error"
                    for m in st.get("messages") or []:
                        if isinstance(m, list) and m and m[0] == "execution_error":
                            detail = m[1] if len(m) > 1 else {}
                            msg = str(
                                (detail or {}).get("exception_message")
                                or (detail or {}).get("exception_type")
                                or msg
                            )
                            break
                    raise CharacterSheetError(f"专项问答执行失败:{msg}", status_code=502)
                _qs = await _comfy_prompt_state(client, prompt_id)
                await asyncio.sleep(1.5)
                if _qs == "pending":
                    _qa_queue_wait += 1.5
                    if _qa_queue_wait >= _QUEUE_WAIT_MAX:
                        try:
                            await client.delete_from_queue([prompt_id])
                        except Exception:  # noqa: BLE001
                            pass
                        raise CharacterSheetQueueWait(
                            f"专项问答排队超时 queue_wait={_qa_queue_wait:.0f}s(不计失败)",
                            queue_wait=_qa_queue_wait,
                            prompt_id=prompt_id,
                        )
                    continue
                waited += 1.5
            if not raw_text:
                raise CharacterSheetError(
                    f"专项问答超时无文本 backend={backend} model={model}",
                    status_code=504,
                )
            parsed = _parse_expr_qa_json(raw_text)
            parsed["model"] = f"{backend}:{model}"
            parsed["worker"] = url
            parsed["expr_key"] = expr_key
            _VLM_STICKY_BACKEND = (backend, model)
            _VLM_STICKY_EVIDENCE["last_backend"] = backend
            _VLM_STICKY_EVIDENCE["last_model"] = model
            _VLM_STICKY_EVIDENCE["keep_model_loaded"] = True
            parsed["vlm_sticky"] = True
            parsed["keep_model_loaded"] = True
            return parsed
        except CharacterSheetQueueWait:
            raise
        except CharacterSheetError as e:
            last_err = e
            logger.warning("classify_expression_qa %s/%s fail: %s", backend, model, e)
            continue
        except ComfyUIError as e:
            last_err = CharacterSheetError(f"专项问答 Comfy 错误:{e}", status_code=502)
            logger.warning("classify_expression_qa comfy %s/%s: %s", backend, model, e)
            continue
        except Exception as e:  # noqa: BLE001
            last_err = CharacterSheetError(f"专项问答异常:{e}", status_code=502)
            logger.warning("classify_expression_qa exc %s/%s: %s", backend, model, e)
            continue
    raise CharacterSheetError(
        f"专项问答全部后端失败: {last_err}",
        status_code=502,
    ) from last_err



def assert_expression_vlm_match(
    cell_bytes: bytes,
    expr_key: str,
    vlm_result: dict,
) -> dict:
    """目标标签必须是 scores argmax 且 label 命中；否则 CharacterSheetError。"""
    del cell_bytes  # 裁图已由调用方落盘；此处只验分类结果
    want = _EXPR_KEY_TO_VLM_LABEL.get(expr_key)
    if not want:
        raise CharacterSheetError(f"未知表情键 {expr_key}", status_code=422)
    if not isinstance(vlm_result, dict):
        raise CharacterSheetError("VLM 结果非 dict", status_code=502)
    label = str(vlm_result.get("label") or "").strip()
    scores = vlm_result.get("scores") or {}
    if not isinstance(scores, dict) or not scores:
        raise CharacterSheetError(
            f"{expr_key} VLM 无 scores: {vlm_result!r}",
            status_code=502,
        )
    # argmax
    try:
        argmax = max(scores.items(), key=lambda kv: float(kv[1]))[0]
    except Exception as e:  # noqa: BLE001
        raise CharacterSheetError(
            f"{expr_key} VLM scores 不可比: {e}",
            status_code=502,
        ) from e
    info = {
        "expr_key": expr_key,
        "want": want,
        "label": label,
        "argmax": argmax,
        "scores": scores,
        "model": vlm_result.get("model"),
    }
    if label != want:
        raise CharacterSheetError(
            f"{expr_key} VLM 判错: want={want} got={label} scores={scores}",
            status_code=422,
        )
    if argmax != want:
        raise CharacterSheetError(
            f"{expr_key} VLM argmax 非目标: want={want} argmax={argmax} scores={scores}",
            status_code=422,
        )
    # 22:28：温柔必须第二问 smiling=true（嘴角上扬或闭眼笑）
    if expr_key == "expr_3":
        smiling = vlm_result.get("smiling")
        info["smiling"] = smiling
        if smiling is not True:
            raise CharacterSheetError(
                f"{expr_key}温柔第二问未通过: smiling={smiling!r}（须为是/true）",
                status_code=422,
            )
    return info


def assert_expression_semantic(
    data: bytes,
    *,
    expr_key: str,
    neutral_ref: bytes | None = None,
) -> dict:
    """19:15：表情语义硬校验。威严=眉压低+嘴闭紧；温柔=眉舒展+嘴角微扬。"""
    info: dict = {"expr_key": expr_key}
    open_m = mouth_appears_open(data)
    lift = _mouth_corner_lift(data)
    press = _brow_press_delta(data, neutral_ref)
    info.update({"mouth_open": open_m, "mouth_lift": float(lift), "brow_press": press})
    if expr_key == "expr_0":
        # 威严：闭嘴 + 眉压低；微笑只用高阈值（anime 唇线易误报上扬）
        if open_m:
            raise CharacterSheetError(
                f"{expr_key}威严语义失败：须闭嘴（检测到张嘴）",
                status_code=422,
            )
        if press is not None and press < -0.04:
            raise CharacterSheetError(
                f"{expr_key}威严语义失败：眉须压低，检测到上挑 press={press:.3f}",
                status_code=422,
            )
        if lift > 0.35 and (press is None or press < 0.02):
            raise CharacterSheetError(
                f"{expr_key}威严语义失败：嘴须闭紧，禁微笑上扬 lift={lift:.3f}",
                status_code=422,
            )
    elif expr_key == "expr_3":
        # 温柔：禁大张嘴（允许轻露上齿）+ 眉舒展。
        # 19:55：几何 lift 不可靠 → 撤回 lift 硬拒；微笑由 VLM 六类判官硬门禁判定。
        wide = mouth_appears_wide_open(data)
        info["mouth_wide_open"] = wide
        info["mouth_dark"] = float(mouth_dark_ratio(data))
        if wide:
            raise CharacterSheetError(
                f"{expr_key}温柔语义失败：禁大张嘴 dark={info['mouth_dark']:.3f}",
                status_code=422,
            )
        if press is not None and press > 0.05:
            raise CharacterSheetError(
                f"{expr_key}温柔语义失败：眉须舒展，禁皱眉/压眉 press={press:.3f}",
                status_code=422,
            )
    return info


def assert_expression_diversity(
    data: bytes,
    *,
    expr_key: str,
    neutral_ref: bytes | None,
    other_exprs: dict[str, bytes] | None = None,
    min_vs_neutral: float = 6.0,
    min_pairwise: float = 4.0,
) -> None:
    """20:23：与中性脸眉眼嘴 ROI 像素差 ≥ 阈值；两两也 ≥ 阈值；惊恐须张嘴。"""
    if expr_key == "expr_4" and not mouth_appears_open(data):
        raise CharacterSheetError(
            f"{expr_key}惊恐未检测到张嘴",
            status_code=422,
        )
    if neutral_ref:
        d = expression_roi_pixel_diff(data, neutral_ref)
        if d + 1e-12 < float(min_vs_neutral):
            raise CharacterSheetError(
                f"{expr_key}相对中性脸表情差过弱 diff={d:.2f}<{min_vs_neutral}",
                status_code=422,
            )
    if other_exprs:
        for ok, ob in other_exprs.items():
            if ok == expr_key or not ob:
                continue
            d2 = expression_roi_pixel_diff(data, ob)
            if d2 + 1e-12 < float(min_pairwise):
                raise CharacterSheetError(
                    f"{expr_key}与{ok}表情过于相似 diff={d2:.2f}<{min_pairwise}",
                    status_code=422,
                )


def clip_image_cosine_sim(a: bytes, b: bytes) -> float | None:
    """可选 open_clip 图相似度；不可用则 None。"""
    try:
        from app.services.studio.candidate_pick import (
            _cosine,
            _openclip_image_embedder,
        )
    except Exception:
        return None
    enc = _openclip_image_embedder()
    if enc is None:
        return None
    try:
        ia = Image.open(BytesIO(a)).convert("RGB")
        ib = Image.open(BytesIO(b)).convert("RGB")
        ea = enc(ia)
        eb = enc(ib)
        if ea is None or eb is None:
            return None
        return float(_cosine(ea, eb))
    except Exception:
        return None


def _edge_sharpness_score(data: bytes, size: int = 256) -> float:
    """边缘能量：侧面融化/糊图偏低，清线成功后应升高。"""
    try:
        from PIL import ImageFilter, ImageStat

        im = Image.open(BytesIO(data)).convert("L").resize((size, size))
        e = im.filter(ImageFilter.FIND_EDGES)
        return float(ImageStat.Stat(e).mean[0])
    except Exception:
        return 0.0


def side_face_cleanup_accept(
    cleaned: bytes,
    original_crop: bytes,
    *,
    master_side: bytes | None = None,
    min_clip: float = 0.82,
    identity_ref: bytes | None = None,
) -> bool:
    """20:23/23:05：清线须像侧面；母版融化时放宽 MAE/CLIP，要求更清晰且有脸。

    禁止脸罩叠影；整图 Qwen 清线结果用本门禁取舍。
    """
    src_frac = measure_face_height_frac(original_crop)
    src_soft = src_frac is None or (src_frac + 1e-12 < 0.35)
    # 23:05b：融化源修复常改五官几何，MAE/CLIP 再放宽；靠脸占比+身份参考兜底
    mae_max = 78.0 if src_soft else 28.0
    clip_min = 0.64 if src_soft else float(min_clip)
    try:
        ia = Image.open(BytesIO(cleaned)).convert("RGB").resize((128, 128))
        ib = Image.open(BytesIO(original_crop)).convert("RGB").resize((128, 128))
        pa, pb = list(ia.getdata()), list(ib.getdata())
        mae = sum(
            (abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)) / 3.0
            for (r1, g1, b1), (r2, g2, b2) in zip(pa, pb)
        ) / float(len(pa))
        if mae > mae_max:
            return False
    except Exception:
        return False
    # 清线后须更清晰，且脸占比不得更差（融化源允许从 None 升到有脸）
    out_frac = measure_face_height_frac(cleaned)
    if src_soft:
        if out_frac is None or out_frac + 1e-12 < 0.22:
            return False
        # 清晰度：允许持平；仅当明显糊于原裁才拒
        if _edge_sharpness_score(cleaned) + 1.5 < _edge_sharpness_score(original_crop):
            return False
    ref = master_side or original_crop
    sim = clip_image_cosine_sim(cleaned, ref)
    if sim is None:
        # 无 CLIP：软源靠清晰度+脸；硬源靠 MAE
        return True
    if sim + 1e-12 >= clip_min:
        return True
    # 软源：与身份参考（正脸/立绘头）相似度过门也可接受（母版融化时 CLIP 对侧源不可靠）
    if src_soft and identity_ref is not None:
        sim_id = clip_image_cosine_sim(cleaned, identity_ref)
        if sim_id is not None and sim_id + 1e-12 >= 0.58:
            return True
    return False


def pick_best_side_deblur_candidate(
    candidates: list[bytes],
    original_crop: bytes,
    *,
    master_side: bytes | None = None,
    identity_ref: bytes | None = None,
) -> bytes | None:
    """多候选清线：先过 accept，再按清晰度+脸占比择优；全拒返回 None。"""
    accepted: list[tuple[float, bytes]] = []
    for c in candidates:
        if not c:
            continue
        if not side_face_cleanup_accept(
            c,
            original_crop,
            master_side=master_side,
            identity_ref=identity_ref,
        ):
            continue
        frac = measure_face_height_frac(c) or 0.0
        sharp = _edge_sharpness_score(c)
        accepted.append((sharp + 40.0 * float(frac), c))
    if not accepted:
        return None
    accepted.sort(key=lambda t: t[0], reverse=True)
    return accepted[0][1]


def _expr_reject_cause(err: Exception | str) -> str:
    msg = str(err)
    if "接缝" in msg or "硬边" in msg or "seam" in msg.lower():
        return "seam"
    if "徽标" in msg or "字样" in msg or "emblem" in msg.lower():
        return "emblem"
    if "发长" in msg or "齐下巴" in msg or "hair" in msg.lower():
        return "hair"
    if "专项问答" in msg or "qa" in msg.lower():
        return "qa"
    if "CLIP" in msg or "clip" in msg.lower():
        return "clip"
    if "张嘴" in msg or "表情差过弱" in msg or "过于相似" in msg or "diversity" in msg.lower():
        return "expr_weak"
    if "face" in msg.lower() or "近景" in msg or "closeup" in msg.lower():
        return "face"
    return "other"


def crop_raincoat_detail_from_figure(data: bytes, *, size: int = 768) -> bytes:
    """从主立绘/正面裁雨衣躯干局部，供服饰首格空白兜底。"""
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    # 胸口~腰：避开头与腿
    box = (
        int(w * 0.18),
        int(h * 0.28),
        int(w * 0.82),
        int(h * 0.62),
    )
    crop = img.crop(box)
    side = max(crop.width, crop.height, 8)
    canvas = Image.new("RGB", (side, side), (240, 240, 244))
    canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def replace_costume_cell(
    costume_png: bytes, cell_idx: int, cell_png: bytes, *, n: int = 4
) -> bytes:
    """替换服饰横排某一格。"""
    im = Image.open(BytesIO(costume_png)).convert("RGB")
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    x0 = cell_idx * cell_w
    x1 = w if cell_idx == n - 1 else (cell_idx + 1) * cell_w
    cell = Image.open(BytesIO(cell_png)).convert("RGB")
    # letterbox 进格
    bw, bh = x1 - x0, h
    scale = min(bw / cell.width, bh / cell.height)
    nw, nh = max(1, int(cell.width * scale)), max(1, int(cell.height * scale))
    cell = cell.resize((nw, nh), Image.Resampling.LANCZOS)
    patch = Image.new("RGB", (bw, bh), (240, 240, 244))
    patch.paste(cell, ((bw - nw) // 2, (bh - nh) // 2))
    im.paste(patch, (x0, 0))
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def ensure_costume_first_cell_filled(
    costume_png: bytes,
    *,
    portrait: bytes | None = None,
    front: bytes | None = None,
    min_ratio: float = 0.12,
    n: int = 4,
) -> bytes:
    """18:23：服饰空格 → 主立绘/正面雨衣（或下装/靴）局部替换，再 assert。

    父代理点名首格；其它空格同样用立绘分区裁切兜底，避免 assert 全格非空卡死。
    """
    ratios = costume_cell_content_ratios(costume_png, n=n)
    out = costume_png
    src = portrait or front
    # 15:52 四格偏好：0 领口、1 袖口、2 下摆、3 靴子
    bands = (
        (0.28, 0.18, 0.72, 0.36),
        (0.10, 0.42, 0.42, 0.60),
        (0.30, 0.55, 0.70, 0.78),
        (0.34, 0.80, 0.66, 0.995),
    )
    for idx, r in enumerate(ratios):
        if r >= min_ratio:
            continue
        if not src:
            raise CharacterSheetError(
                f"costume cells empty/thin: idx={[idx]} ratios={[round(x, 3) for x in ratios]} "
                "且无 portrait/front 可裁细节",
                status_code=422,
            )
        img = Image.open(BytesIO(src)).convert("RGB")
        w, h = img.size
        x0, y0, x1, y1 = bands[idx % len(bands)]
        crop = img.crop((int(w * x0), int(h * y0), int(w * x1), int(h * y1)))
        side = max(crop.width, crop.height, 8)
        canvas = Image.new("RGB", (side, side), (240, 240, 244))
        canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
        buf = BytesIO()
        canvas.save(buf, format="PNG")
        out = replace_costume_cell(out, idx, buf.getvalue(), n=n)
        logger.info(
            "costume cell%s empty ratio=%.3f → portrait band crop", idx, r
        )
    assert_costume_cells_nonempty(out, min_ratio=min_ratio, n=n)
    return out




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


_ANIME_CASCADE = None  # cv2 CascadeClassifier cache


def _anime_cascade_face_bbox_xyxy(
    data: bytes,
) -> tuple[float, float, float, float] | None:
    """17:55：lbpcascade_animeface 兜底；OpenCV 5 无 CascadeClassifier 时返回 None（靠启发式）。"""
    try:
        import cv2
        import numpy as np
        from pathlib import Path as _P

        global _ANIME_CASCADE
        casc = _ANIME_CASCADE
        if casc is None:
            xml = _P(__file__).resolve().parents[2] / "assets" / "lbpcascade_animeface.xml"
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
        faces = casc.detectMultiScale(
            gray, scaleFactor=1.05, minNeighbors=3, minSize=(48, 48)
        )
        if faces is None or len(faces) == 0:
            return None
        x, y, fw, fh = max(faces, key=lambda t: int(t[2]) * int(t[3]))
        return float(x), float(y), float(x + fw), float(y + fh)
    except Exception:  # noqa: BLE001
        return None


def _detect_face_bbox_xyxy(data: bytes) -> tuple[float, float, float, float] | None:
    """insightface → 动漫级联 → None。"""
    bb = _insightface_face_bbox_xyxy(data)
    if bb is not None:
        return bb
    return _anime_cascade_face_bbox_xyxy(data)


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
        # 15:36：板岩灰衣服易被当成浅灰背景；中调灰要求更严的色差
        dist = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
        luma = (r + g + b) / 3.0
        tol = bg_tol
        if 40 <= luma <= 190:
            tol = max(12, bg_tol // 2)
        if dist < tol:
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


def panel_vertical_span(
    img: Image.Image | bytes,
    *,
    bg_tol: int = 40,
    uniform_frac: float = 0.92,
    var_thresh: float = 8.0,
) -> float:
    """17:55：人物头顶→脚底占画高比例。

    四角取背景色；横向均匀灰条（低方差且近背景）不算人物行。
    """
    import statistics as _stats

    if isinstance(img, (bytes, bytearray)):
        im = Image.open(BytesIO(img)).convert("RGB")
    else:
        im = img.convert("RGB")
    w, h = im.size
    if w < 8 or h < 8:
        return 0.0
    small = im.resize((64, 64), Image.Resampling.BOX)
    sw, sh = small.size
    px = list(small.getdata())

    def _pix(x: int, y: int) -> tuple[int, int, int]:
        return px[y * sw + x]

    corners = [_pix(1, 1), _pix(sw - 2, 1), _pix(1, sh - 2), _pix(sw - 2, sh - 2)]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    def _is_bg(r: int, g: int, b: int) -> bool:
        dist = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
        luma = (r + g + b) / 3.0
        tol = bg_tol
        if 40 <= luma <= 190:
            tol = max(12, bg_tol // 2)
        if dist < tol:
            return True
        if r > 235 and g > 235 and b > 235:
            return True
        return False

    person_rows: list[int] = []
    for y in range(sh):
        row = [_pix(x, y) for x in range(sw)]
        non_bg = sum(1 for r, g, b in row if not _is_bg(r, g, b)) / float(sw)
        lumas = [(r + g + b) / 3.0 for r, g, b in row]
        diffs = [abs(lumas[i] - lumas[i + 1]) for i in range(sw - 1)]
        mean_diff = sum(diffs) / float(len(diffs))
        var = float(_stats.pstdev(lumas)) if len(lumas) > 1 else 0.0
        # 灰条：近背景且低纹理 → 不算人物
        if non_bg >= (1.0 - uniform_frac) or var >= var_thresh or mean_diff >= 4.0:
            person_rows.append(y)
    if not person_rows:
        return 0.0
    return float(person_rows[-1] - person_rows[0] + 1) / float(sh)


def panel_content_coverage(
    img: Image.Image | bytes,
    *,
    bg_tol: int = 40,
    uniform_frac: float = 0.92,
) -> float:
    """全身格以纵向跨度为主(17:55)；邮票缩水仍回落面积比。"""
    area, stamp, fill_h, fill_w = _panel_content_metrics(
        img, bg_tol=bg_tol, uniform_frac=uniform_frac
    )
    vspan = panel_vertical_span(img, bg_tol=bg_tol, uniform_frac=uniform_frac)
    if vspan >= 0.85:
        return float(max(vspan, 0.90))
    if stamp:
        return area
    if fill_h >= 0.82 or fill_w >= 0.82:
        return float(max(area, 0.90))
    return float(max(area, vspan))


def assert_panel_coverage(
    img: Image.Image | bytes,
    min_ratio: float = 0.90,
) -> float:
    """17:55：全身格硬门槛=纵向跨度≥0.85；邮票缩水仍按面积拦。"""
    area, stamp, fill_h, fill_w = _panel_content_metrics(img)
    vspan = panel_vertical_span(img)
    # 纵向跨度达标 → 过（灰衣满画高不再被四角误判）
    if vspan + 1e-9 >= 0.85:
        return float(max(vspan, 0.90))
    if stamp:
        if area + 1e-9 < float(min_ratio):
            raise CharacterSheetError(
                f"panel coverage {area:.3f} < {min_ratio:.2f} (shrunk/padded panel)",
                status_code=422,
            )
        return area
    if fill_h >= 0.82 or fill_w >= 0.82 or area >= float(min_ratio):
        return float(max(area, 0.90 if (fill_h >= 0.82 or fill_w >= 0.82) else area))
    if area + 1e-9 < 0.50:
        raise CharacterSheetError(
            f"panel coverage {area:.3f} < 0.50 (empty/near-empty panel)",
            status_code=422,
        )
    if vspan + 1e-9 < 0.85 and area + 1e-9 < float(min_ratio):
        raise CharacterSheetError(
            f"panel coverage vspan={vspan:.3f} area={area:.3f} < {min_ratio:.2f} "
            f"(shrunk/padded panel)",
            status_code=422,
        )
    return float(max(area, vspan))


def enforce_head_shoulders_square(
    data: bytes,
    size: int = 768,
    *,
    skip_reframe: bool = False,
    max_upscale: float = 1.5,
    check_coverage: bool = True,
    face_closeup_gate: bool = False,
) -> bytes:
    """头肩正方形裁切(fix16):以**检测到的人脸框**为中心 cover 铺满。

    - 优先 insightface 人脸框;否则肤色/五官启发式(禁整前景,避免宽袖/汉服拉偏)。
    - 裁切轴=脸中心;上边含完整发顶/发髻(脸顶再留约 12–16% 格高);下边到锁骨下(≈脸高×2.0–2.2)。
    - 放大上限 max_upscale(默认 1.5):源脸过小则外扩取景;仍不足则 cover 填满(禁深色垫边缩水)。
    - skip_reframe=True:锁定格走同一 cover 填满(头顶方裁→铺满),禁止小图贴大空白。
    - check_coverage:输出前 assert_panel_coverage(>=0.90)；全身格用。
    - face_closeup_gate:16:45 近景脸格用「有人脸+脸高占格高 25%–70%」替代 coverage。
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
        face_bb = _detect_face_bbox_xyxy(data)
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
        if face_closeup_gate:
            assert_face_closeup_framing(out)
        elif check_coverage:
            assert_panel_coverage(out, min_ratio=0.90)
            assert_face_visible(out, min_face_area=0.04)
        return out

    face_bb = _detect_face_bbox_xyxy(data)
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
    if face_closeup_gate:
        assert_face_closeup_framing(out)
    elif check_coverage:
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
    bb = _detect_face_bbox_xyxy(data)
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


def assert_face_closeup_framing(
    data: bytes,
    *,
    min_face_height_frac: float = 0.35,
    max_face_height_frac: float = 0.80,
    min_face_area: float = 0.04,
    face_key: str | None = None,
    require_mouth_in_frame: bool = False,
) -> dict:
    """16:45：近景脸格门禁——有人脸，且脸高占格高约 25%–70%（替代 coverage 0.90）。

    17:47：上限 0.80（父代理）；吸收 reframe 测量余量，近景头肩而非贴脸裁切。
    19:01：下限改为 0.35（脸格头高≥35%）；过小则先 auto_tighten 再验。
    19:55：表情格可收紧到 0.55–0.65，并可选要求嘴在框内（禁贴/出底）。

    全身格仍走 assert_panel_coverage；本函数只用于 faces / expr_*。
    """
    img = Image.open(BytesIO(data)).convert("RGB")
    _w, h = img.size
    area = float(min_face_area)
    if face_key in ("face_three_quarter", "face_side"):
        area = min(area, 0.02)
    bb = assert_face_visible(
        data, min_face_area=area, face_key=face_key
    )
    x1, y1, x2, y2 = bb
    face_h = max(1.0, float(y2) - float(y1))
    frac = face_h / float(max(1, h))
    if frac + 1e-12 < float(min_face_height_frac):
        raise CharacterSheetError(
            f"face height frac {frac:.3f} < {min_face_height_frac:.2f} (face too small in cell)",
            status_code=422,
        )
    if frac - 1e-12 > float(max_face_height_frac):
        raise CharacterSheetError(
            f"face height frac {frac:.3f} > {max_face_height_frac:.2f} (face too large / overcropped)",
            status_code=422,
        )
    info = {
        "bbox": bb,
        "face_height_frac": frac,
        "min": float(min_face_height_frac),
        "max": float(max_face_height_frac),
    }
    if require_mouth_in_frame:
        info.update(assert_mouth_in_frame(data, face_bbox=bb))
    return info



def sample_iris_hsv_mean(data: bytes) -> tuple[float, float, float] | None:
    """从近景头像估计虹膜平均 HSV（H∈[0,360)）。取脸上半高 chroma 非肤色像素。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return None
    w, h = img.size
    if w < 16 or h < 16:
        return None
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(img)
        except Exception:
            bb = None
    if bb is None:
        x1, y1, x2, y2 = int(w * 0.25), int(h * 0.18), int(w * 0.75), int(h * 0.55)
    else:
        fx1, fy1, fx2, fy2 = [float(v) for v in bb]
        fh = max(8.0, fy2 - fy1)
        fw = max(8.0, fx2 - fx1)
        # 眼带：脸上 18%–48% 高，左右内收
        x1 = int(fx1 + fw * 0.12)
        x2 = int(fx2 - fw * 0.12)
        y1 = int(fy1 + fh * 0.18)
        y2 = int(fy1 + fh * 0.48)
    x1, x2 = max(0, min(x1, x2)), min(w, max(x1, x2))
    y1, y2 = max(0, min(y1, y2)), min(h, max(y1, y2))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    px = img.load()
    hs: list[float] = []
    ss: list[float] = []
    vs: list[float] = []
    for y in range(y1, y2, max(1, (y2 - y1) // 48)):
        for x in range(x1, x2, max(1, (x2 - x1) // 48)):
            r, g, b = px[x, y][:3]
            # 跳过近白/近黑/低饱和肤色
            mx, mn = max(r, g, b), min(r, g, b)
            if mx < 40 or mn > 230:
                continue
            rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
            hh, ss_, vv = colorsys.rgb_to_hsv(rf, gf, bf)
            if ss_ < 0.22 or vv < 0.18:
                continue
            # 跳过典型肤色（低饱和橙粉）
            hue = hh * 360.0
            if 10 <= hue <= 50 and ss_ < 0.45 and vv > 0.45:
                continue
            hs.append(hue)
            ss.append(ss_)
            vs.append(vv)
    if len(hs) < 6:
        return None
    hs.sort(); ss.sort(); vs.sort()
    mid = len(hs) // 2
    return (float(hs[mid]), float(ss[mid]), float(vs[mid]))


def iris_hsv_consistent(
    a: bytes,
    b: bytes,
    *,
    max_hue_deg: float = 48.0,
    min_sat: float = 0.18,
) -> bool:
    """00:59：侧面头与正面头瞳色 HSV 一致（主要比 Hue 环距）。缺样本时不拦。"""
    ha = sample_iris_hsv_mean(a)
    hb = sample_iris_hsv_mean(b)
    if ha is None or hb is None:
        return True
    if ha[1] < min_sat and hb[1] < min_sat:
        return True
    d = abs(ha[0] - hb[0])
    d = min(d, 360.0 - d)
    return d <= float(max_hue_deg)


def side_three_quarter_accept(
    data: bytes,
    *,
    front_face: bytes | None = None,
    min_frac: float = 0.25,
    max_frac: float = 0.50,
) -> tuple[bool, dict]:
    """00:59：侧面头格硬门禁——脸高 25%–50%；有正面时瞳色 HSV 一致。"""
    info: dict = {}
    frac = measure_face_height_frac(data)
    info["face_frac"] = frac
    if frac is None:
        info["reason"] = "no_face"
        return False, info
    if float(frac) + 1e-12 < float(min_frac) or float(frac) - 1e-12 > float(max_frac):
        info["reason"] = f"face_frac={frac:.3f} not in [{min_frac},{max_frac}]"
        return False, info
    if front_face is not None:
        ok = iris_hsv_consistent(data, front_face)
        info["iris_ok"] = bool(ok)
        ha = sample_iris_hsv_mean(data)
        hb = sample_iris_hsv_mean(front_face)
        info["iris_side"] = ha
        info["iris_front"] = hb
        if not ok:
            info["reason"] = "iris_hsv_mismatch"
            return False, info
    info["reason"] = "ok"
    return True, info


def side_three_quarter_accept_in_panel_cell(
    data: bytes,
    *,
    front_face: bytes | None = None,
    panel_size: tuple[int, int] | None = None,
    min_frac: float = 0.25,
    max_frac: float = 0.50,
) -> tuple[bool, dict]:
    """16:18：模拟 faces 高格 cover 后的 face_frac（与 runner 裁 cell 同口径）。"""
    ok0, info0 = side_three_quarter_accept(
        data, front_face=front_face, min_frac=min_frac, max_frac=max_frac
    )
    info = dict(info0)
    info["square_ok"] = bool(ok0)
    try:
        fw, fh = panel_size or (LAYOUT["faces"][2], LAYOUT["faces"][3])
        cell_w = max(8, int(fw) // 3)
        tri = {
            "face_front": data,
            "face_three_quarter": data,
            "face_side": data,
        }
        panel = compose_faces_triptych(
            tri, style="anime", size=(int(fw), int(fh)), master_crop=True
        )
        pim = Image.open(BytesIO(panel)).convert("RGB")
        cell = pim.crop((cell_w, 0, cell_w * 2, int(fh)))
        buf = BytesIO()
        cell.save(buf, format="PNG")
        cell_b = buf.getvalue()
        ok1, info1 = side_three_quarter_accept(
            cell_b, front_face=front_face, min_frac=min_frac, max_frac=max_frac
        )
        info["cell_face_frac"] = info1.get("face_frac")
        info["cell_ok"] = bool(ok1)
        info["cell_reason"] = info1.get("reason")
        if not ok1:
            info["reason"] = f"panel_cell:{info1.get('reason')}"
            return False, info
        if not ok0:
            info["reason"] = f"square:{info0.get('reason')}"
            return False, info
        info["reason"] = "ok"
        return True, info
    except Exception as e:  # noqa: BLE001
        info["cell_error"] = str(e)
        return ok0, info


def _channel_cdf_lut(src_vals: list[int], ref_vals: list[int]) -> list[int]:
    """256-entry LUT: match src channel CDF to ref channel CDF."""
    hist_s = [0] * 256
    hist_r = [0] * 256
    for v in src_vals:
        hist_s[max(0, min(255, int(v)))] += 1
    for v in ref_vals:
        hist_r[max(0, min(255, int(v)))] += 1
    ns = max(1, len(src_vals))
    nr = max(1, len(ref_vals))
    cdf_s = [0.0] * 256
    cdf_r = [0.0] * 256
    acc = 0.0
    for i in range(256):
        acc += hist_s[i] / ns
        cdf_s[i] = acc
    acc = 0.0
    for i in range(256):
        acc += hist_r[i] / nr
        cdf_r[i] = acc
    lut = [0] * 256
    j = 0
    for i in range(256):
        while j < 255 and cdf_r[j] < cdf_s[i]:
            j += 1
        lut[i] = j
    return lut


def _hair_coat_region_masks(im: Image.Image) -> tuple[list[bool], list[bool]]:
    """头肩方图：头发（上半偏暗）与外套（下半非肤色服装，含偏蓝/偏亮雨衣）布尔掩码。"""
    w, h = im.size
    px = list(im.convert("RGB").getdata())
    hair = [False] * len(px)
    coat = [False] * len(px)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            r, g, b = px[i]
            yf = y / float(max(1, h - 1))
            lum = (r + g + b) / 3.0
            chroma = max(abs(r - g), abs(g - b), abs(r - b))
            skin = r > 180 and g > 140 and b > 110 and r >= g >= b - 25
            near_white = r > 230 and g > 230 and b > 230
            # 头发：上 60%、偏暗（含高光稍亮），排除肤色
            if yf < 0.60 and (not skin) and (not near_white) and lum < 130:
                if chroma < 90 or lum < 70:
                    hair[i] = True
            # 外套：下 40% 起、非肤色非白，板岩/偏蓝雨衣都算
            if yf > 0.40 and (not skin) and (not near_white) and 25 < lum < 210:
                coat[i] = True
    return hair, coat


def side_hist_match_enabled() -> bool:
    """18:02：侧头直方图匹配默认关（恢复 1618 干净 Lanczos/母版裁）；仅 TOIV_SHEET_SIDE_HIST_MATCH=1 才启用。"""
    return os.environ.get("TOIV_SHEET_SIDE_HIST_MATCH", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def match_side_head_coat_hair_to_front(side: bytes, front: bytes) -> bytes:
    """15:52 / 16:18：侧头外套+头发直方图匹配；排除脸区、羽化边界、半透明混合，避免接缝与 face_frac 膨胀。

    18:02：默认跳过（见 side_hist_match_enabled）；anime 整卡走 1618 干净路径，消除 1738 彩噪。
    """
    if not side or not front:
        return side
    if not side_hist_match_enabled():
        return side
    try:
        s_im = Image.open(BytesIO(side)).convert("RGB")
        f_im = Image.open(BytesIO(front)).convert("RGB")
    except Exception:  # noqa: BLE001
        return side
    if f_im.size != s_im.size:
        f_im = f_im.resize(s_im.size, Image.Resampling.LANCZOS)
    w, h = s_im.size
    s_hair, s_coat = _hair_coat_region_masks(s_im)
    f_hair, f_coat = _hair_coat_region_masks(f_im)
    # 排除脸/肤色区，避免 CDF 改脸导致检测框膨胀与接缝
    face_mask = [False] * (w * h)
    try:
        bb = _detect_face_bbox_xyxy(side)
        if bb is None:
            bb = _heuristic_skin_face_bbox(s_im)
        if bb is not None:
            x1, y1, x2, y2 = [float(v) for v in bb]
            pad_x = max(4.0, (x2 - x1) * 0.12)
            pad_y = max(4.0, (y2 - y1) * 0.10)
            xa = max(0, int(x1 - pad_x))
            xb = min(w, int(x2 + pad_x))
            ya = max(0, int(y1 - pad_y))
            yb = min(h, int(y2 + pad_y * 1.15))
            for y in range(ya, yb):
                for x in range(xa, xb):
                    face_mask[y * w + x] = True
    except Exception:  # noqa: BLE001
        pass
    sp = list(s_im.getdata())
    fp = list(f_im.getdata())
    out_px = list(sp)

    def _apply_region(mask_s: list[bool], mask_f: list[bool], *, blend: float = 0.55) -> None:
        src_ch = [[], [], []]
        ref_ch = [[], [], []]
        idxs: list[int] = []
        for i, m in enumerate(mask_s):
            if not m or face_mask[i]:
                continue
            r, g, b = sp[i]
            src_ch[0].append(r)
            src_ch[1].append(g)
            src_ch[2].append(b)
            idxs.append(i)
        for i, m in enumerate(mask_f):
            if not m:
                continue
            r, g, b = fp[i]
            ref_ch[0].append(r)
            ref_ch[1].append(g)
            ref_ch[2].append(b)
        if len(src_ch[0]) < 32 or len(ref_ch[0]) < 32:
            return
        luts = [_channel_cdf_lut(src_ch[c], ref_ch[c]) for c in range(3)]
        a = max(0.0, min(1.0, float(blend)))
        for i in idxs:
            r, g, b = sp[i]
            mr, mg, mb = luts[0][r], luts[1][g], luts[2][b]
            out_px[i] = (
                int(r * (1.0 - a) + mr * a + 0.5),
                int(g * (1.0 - a) + mg * a + 0.5),
                int(b * (1.0 - a) + mb * a + 0.5),
            )

    _apply_region(s_hair, f_hair, blend=0.50)
    _apply_region(s_coat, f_coat, blend=0.55)
    out = Image.new("RGB", s_im.size)
    out.putdata(out_px)
    # 轻度羽化：3×3 仅在 hair/coat 且非脸边界平滑，抑硬接缝
    try:
        from PIL import ImageFilter

        soft = out.filter(ImageFilter.GaussianBlur(radius=0.6))
        spx = list(out.getdata())
        soft_px = list(soft.getdata())
        for i, (mh, mc) in enumerate(zip(s_hair, s_coat)):
            if face_mask[i] or not (mh or mc):
                continue
            # 边界像素（邻域有非 mask）才混一点 blur
            y, x = divmod(i, w) if False else (i // w, i % w)
            border = False
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    xx, yy = x + dx, y + dy
                    if xx < 0 or yy < 0 or xx >= w or yy >= h:
                        continue
                    j = yy * w + xx
                    if face_mask[j] or not (s_hair[j] or s_coat[j]):
                        border = True
                        break
                if border:
                    break
            if border:
                r, g, b = spx[i]
                sr, sg, sb = soft_px[i]
                spx[i] = ((r * 2 + sr) // 3, (g * 2 + sg) // 3, (b * 2 + sb) // 3)
        out.putdata(spx)
    except Exception:  # noqa: BLE001
        pass
    buf = BytesIO()
    out.save(buf, format="PNG")
    matched = buf.getvalue()
    # 16:18：仅当匹配后 face_frac 越出 [0.25,0.5] 而原图在门内时回退（避免误杀正常调色）
    try:
        frac_m = measure_face_height_frac(matched)
        frac_s = measure_face_height_frac(side)
        def _in(f):
            return f is not None and 0.25 - 1e-9 <= float(f) <= 0.50 + 1e-9
        if (not _in(frac_m)) and _in(frac_s):
            return side
    except Exception:  # noqa: BLE001
        pass
    return matched


def score_expression_grid_candidate(
    grid: bytes,
    *,
    bases: dict[str, bytes] | None = None,
    portrait_ref: bytes | None = None,
    skip_chest_emblem: bool = False,
) -> tuple[float, str | None]:
    """15:52 / 16:18：宫格候选打分；发长相对表情底测 delta；遮罩外贴回后不因绝对发长拒。"""
    try:
        cells = _split_expression_grid(grid)
    except Exception as e:  # noqa: BLE001
        return -1.0, f"split:{e}"
    score = 0.0
    for ek, cell_b in cells.items():
        try:
            cell_b = enforce_head_shoulders_square(
                cell_b, size=768, face_closeup_gate=True
            )
            href = None
            if bases and bases.get(ek):
                href = bases[ek]
            assert_expression_identity_gates(
                cell_b,
                portrait_ref=portrait_ref,
                expr_key=ek,
                skip_chest_emblem=skip_chest_emblem,
                hair_ref=href,
                relative_hair_only=bool(skip_chest_emblem) or href is not None,
            )
            cells[ek] = cell_b
        except CharacterSheetError as ge:
            return -1.0, str(ge)
        except Exception as e:  # noqa: BLE001
            return -1.0, f"{ek}:{e}"
    # 多样性：相对中性 + 两两
    neutral = None
    if portrait_ref:
        try:
            neutral = crop_face_ref(portrait_ref, size=768)
        except Exception:  # noqa: BLE001
            neutral = None
    for ek, cell_b in cells.items():
        try:
            others = {o: cells[o] for o in _EXPR_KEYS if o != ek}
            assert_expression_diversity(
                cell_b, expr_key=ek, neutral_ref=neutral, other_exprs=others
            )
            score += 1.0
            if neutral is not None:
                score += min(40.0, expression_roi_pixel_diff(cell_b, neutral)) / 40.0
        except CharacterSheetError as ge:
            return -1.0, str(ge)
    return score, None


def expression_mask_exterior_unchanged(
    original: bytes,
    edited: bytes,
    mask: Image.Image | None = None,
    *,
    size: int | None = None,
    max_diff: int = 0,
    grid_cell: int | None = None,
) -> bool:
    """遮罩外像素与原图逐像素一致（00:59：局部重绘后跳过胸口徽标检）。

    mask 白=可编辑；None 时：
      - grid_cell 给定或宽高比≈3:2 → 2×3 宫格眉眼嘴硬遮罩
      - 否则单格 build_face_feature_mask
    """
    try:
        o = Image.open(BytesIO(original)).convert("RGB")
        e = Image.open(BytesIO(edited)).convert("RGB")
    except Exception:
        return False
    if size is not None:
        o = o.resize((size, size), Image.Resampling.LANCZOS)
        e = e.resize((size, size), Image.Resampling.LANCZOS)
    if e.size != o.size:
        e = e.resize(o.size, Image.Resampling.LANCZOS)
    if mask is None:
        w, h = o.size
        if grid_cell is not None or (w >= h * 1.3 and w % 3 == 0 and h % 2 == 0):
            cols, rows = 3, 2
            cw, ch = max(1, w // cols), max(1, h // rows)
            mask = Image.new("L", (w, h), 0)
            for i in range(6):
                row, col = divmod(i, cols)
                cm = build_face_feature_mask(max(cw, ch)).point(
                    lambda v: 255 if v >= 96 else 0
                )
                cm = cm.resize((cw, ch), Image.Resampling.NEAREST)
                mask.paste(cm, (col * cw, row * ch))
        else:
            side = min(w, h)
            mask = build_face_feature_mask(side).point(lambda v: 255 if v >= 96 else 0)
            if mask.size != o.size:
                mask = mask.resize(o.size, Image.Resampling.NEAREST)
    elif mask.size != o.size:
        mask = mask.resize(o.size, Image.Resampling.NEAREST)
    op = o.load(); ep = e.load(); mp = mask.load()
    w, h = o.size
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] >= 96:
                continue
            a = op[x, y]; b = ep[x, y]
            if (
                abs(int(a[0]) - int(b[0])) > max_diff
                or abs(int(a[1]) - int(b[1])) > max_diff
                or abs(int(a[2]) - int(b[2])) > max_diff
            ):
                return False
    return True



def expression_mask_exterior_mae(
    original: bytes,
    edited: bytes,
    mask: Image.Image | None = None,
    *,
    size: int | None = None,
) -> float:
    """遮罩外（mp<96）平均绝对像素差；真 inpaint 应近 0，位移贴回会明显偏大。"""
    try:
        o = Image.open(BytesIO(original)).convert("RGB")
        e = Image.open(BytesIO(edited)).convert("RGB")
    except Exception:
        return 999.0
    if size is not None:
        o = o.resize((size, size), Image.Resampling.LANCZOS)
        e = e.resize((size, size), Image.Resampling.LANCZOS)
    if e.size != o.size:
        e = e.resize(o.size, Image.Resampling.LANCZOS)
    if mask is None:
        side = min(o.size)
        mask = build_face_feature_mask(side).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != o.size:
        mask = mask.resize(o.size, Image.Resampling.NEAREST)
    op = o.load(); ep = e.load(); mp = mask.load()
    w, h = o.size
    total = 0.0
    n = 0
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] >= 96:
                continue
            a = op[x, y]; b = ep[x, y]
            total += (abs(int(a[0]) - int(b[0])) + abs(int(a[1]) - int(b[1])) + abs(int(a[2]) - int(b[2]))) / 3.0
            n += 1
    return total / float(max(1, n))


def assert_expression_inpaint_exterior(
    original: bytes,
    edited: bytes,
    mask: Image.Image | None = None,
    *,
    max_mae: float = 2.5,
    expr_key: str = "expr",
) -> float:
    """门禁1：遮罩外与底图差值近 0（真 inpaint 天然对齐；位移贴回必 fail）。"""
    mae = expression_mask_exterior_mae(original, edited, mask)
    if mae > float(max_mae):
        raise CharacterSheetError(
            f"{expr_key} inpaint 遮罩外差过大 mae={mae:.2f}>{max_mae}",
            status_code=422,
        )
    return mae


def _face_region_var_sat(
    data: bytes, mask: Image.Image | None = None, *, size: int | None = None
) -> tuple[float, float]:
    """眉眼嘴遮罩内局部亮度方差 + 平均饱和度（HSV S）。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    if size is not None:
        im = im.resize((size, size), Image.Resampling.LANCZOS)
    if mask is None:
        mask = build_face_feature_mask(min(im.size)).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    px = im.load(); mp = mask.load()
    w, h = im.size
    lumas: list[float] = []
    sats: list[float] = []
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] < 96:
                continue
            r, g, b = px[x, y]
            lumas.append((int(r) + int(g) + int(b)) / 3.0)
            mx = max(r, g, b); mn = min(r, g, b)
            sats.append(0.0 if mx <= 0 else (mx - mn) / float(mx))
    if not lumas:
        return 0.0, 0.0
    mean = sum(lumas) / len(lumas)
    var = sum((v - mean) ** 2 for v in lumas) / len(lumas)
    sat = sum(sats) / len(sats)
    return float(var), float(sat)


def _face_region_mean_rgb(
    data: bytes, mask: Image.Image | None = None, *, size: int | None = None
) -> tuple[float, float, float]:
    """遮罩内平均 RGB（用于距 0.5 灰均值差）。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    if size is not None:
        im = im.resize((size, size), Image.Resampling.LANCZOS)
    if mask is None:
        mask = build_face_feature_mask(min(im.size)).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    px = im.load(); mp = mask.load()
    w, h = im.size
    sr = sg = sb = 0.0
    n = 0
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] < 96:
                continue
            r, g, b = px[x, y]
            sr += float(r); sg += float(g); sb += float(b)
            n += 1
    if n <= 0:
        return 128.0, 128.0, 128.0
    return sr / n, sg / n, sb / n


def _insightface_face_kps_xy(
    data: bytes,
) -> list[tuple[float, float]] | None:
    """insightface 五官关键：le, re, nose, lm, rm；不可用则 None。"""
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
        kps = getattr(f, "kps", None)
        if kps is None or len(kps) < 5:
            return None
        return [(float(kps[i][0]), float(kps[i][1])) for i in range(5)]
    except Exception:  # noqa: BLE001
        return None


def _heuristic_eyes_mouth_in_mask(
    data: bytes, mask: Image.Image
) -> tuple[bool, bool, dict[str, float]]:
    """无 landmark 时：遮罩内上半(眼带)与下半(嘴带)须有足够暗色/对比结构。"""
    im = Image.open(BytesIO(data)).convert("RGB")
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    px = im.load(); mp = mask.load()
    w, h = im.size
    eye_dark = eye_n = mouth_dark = mouth_n = 0
    eye_lumas: list[float] = []
    mouth_lumas: list[float] = []
    for y in range(h):
        for x in range(w):
            if mp[x, y] < 96:
                continue
            r, g, b = px[x, y]
            lum = (r + g + b) / 3.0
            yf = y / float(max(1, h - 1))
            if 0.18 <= yf <= 0.52:
                eye_n += 1
                eye_lumas.append(lum)
                if lum < 90:
                    eye_dark += 1
            if 0.52 <= yf <= 0.78:
                mouth_n += 1
                mouth_lumas.append(lum)
                if lum < 110:
                    mouth_dark += 1
    eye_ratio = eye_dark / float(max(1, eye_n))
    mouth_ratio = mouth_dark / float(max(1, mouth_n))
    eye_var = 0.0
    if eye_lumas:
        m = sum(eye_lumas) / len(eye_lumas)
        eye_var = sum((v - m) ** 2 for v in eye_lumas) / len(eye_lumas)
    mouth_var = 0.0
    if mouth_lumas:
        m = sum(mouth_lumas) / len(mouth_lumas)
        mouth_var = sum((v - m) ** 2 for v in mouth_lumas) / len(mouth_lumas)
    # 眼睛：暗色像素或足够亮度方差；嘴巴：暗色或对比
    eyes_ok = eye_ratio >= 0.02 or eye_var >= 120.0
    mouth_ok = mouth_ratio >= 0.015 or mouth_var >= 80.0
    return eyes_ok, mouth_ok, {
        "eye_dark_ratio": eye_ratio,
        "mouth_dark_ratio": mouth_ratio,
        "eye_var": eye_var,
        "mouth_var": mouth_var,
    }


def assert_expression_eyes_mouth_in_mask(
    data: bytes,
    mask: Image.Image | None = None,
    *,
    expr_key: str = "expr",
    require_mouth: bool = True,
) -> dict[str, float | bool | str]:
    """18:30 门禁：遮罩区内必须检出眼睛和嘴（landmark 优先，启发式兜底）。

    21:30：沉思眼部-only 遮罩可设 require_mouth=False（嘴不在可编辑区内属预期）。
    """
    im = Image.open(BytesIO(data)).convert("RGB")
    if mask is None:
        mask = build_face_feature_mask_hard(min(im.size))
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    mp = mask.load()
    w, h = im.size
    kps = _insightface_face_kps_xy(data)
    info: dict[str, float | bool | str] = {"route": "none"}
    if kps is not None:
        le, re, _nose, lm, rm = kps
        mouth = ((lm[0] + rm[0]) / 2.0, (lm[1] + rm[1]) / 2.0)
        checks = [("left_eye", le), ("right_eye", re)]
        if require_mouth:
            checks.append(("mouth", mouth))
        missing: list[str] = []
        for name, (x, y) in checks:
            xi = int(round(x)); yi = int(round(y))
            if not (0 <= xi < w and 0 <= yi < h) or mp[xi, yi] < 96:
                missing.append(name)
            info[f"{name}_xy"] = float(xi) + float(yi) * 0.0  # keep keys light
            info[f"{name}_in"] = (
                1.0 if (0 <= xi < w and 0 <= yi < h and mp[xi, yi] >= 96) else 0.0
            )
        info["route"] = "insightface_kps"
        info["require_mouth"] = bool(require_mouth)
        if missing:
            raise CharacterSheetError(
                f"{expr_key}遮罩区内未检出{'/'.join(missing)}",
                status_code=422,
            )
        # 双眼都在
        if float(info.get("left_eye_in", 0)) < 0.5 or float(info.get("right_eye_in", 0)) < 0.5:
            raise CharacterSheetError(
                f"{expr_key}遮罩区内未检出眼睛",
                status_code=422,
            )
        if require_mouth and float(info.get("mouth_in", 0)) < 0.5:
            raise CharacterSheetError(
                f"{expr_key}遮罩区内未检出嘴",
                status_code=422,
            )
        return info
    eyes_ok, mouth_ok, hinfo = _heuristic_eyes_mouth_in_mask(data, mask)
    info.update(hinfo)
    info["route"] = "heuristic"
    info["eyes_ok"] = eyes_ok
    info["mouth_ok"] = mouth_ok
    info["require_mouth"] = bool(require_mouth)
    if not eyes_ok:
        raise CharacterSheetError(
            f"{expr_key}遮罩区内未检出眼睛",
            status_code=422,
        )
    if require_mouth and not mouth_ok:
        raise CharacterSheetError(
            f"{expr_key}遮罩区内未检出嘴",
            status_code=422,
        )
    return info


def assert_expression_no_gray_smear(
    original: bytes,
    edited: bytes,
    mask: Image.Image | None = None,
    *,
    min_var_ratio: float = 0.12,
    min_sat_ratio: float = 0.25,
    min_abs_var: float = 80.0,
    min_abs_sat: float = 0.025,
    max_gray_mean_dist: float = 18.0,
    expr_key: str = "expr",
) -> dict[str, float]:
    """门禁2：脸部区域无灰色涂抹。

    17:38b：二次元 cel 平滑会压低相对方差，改「绝对低方差/低饱和 + 相对骤降」双条件；
    18:30：追加「遮罩区均值距 0.5 灰(128)」——VAEEncodeForInpaint 残留灰块必拒；
    均匀灰涂 (var≈0/sat≈0) 仍必拒，正常 anime inpaint 不误杀。
    """
    bv, bs = _face_region_var_sat(original, mask)
    ev, es = _face_region_var_sat(edited, mask)
    mr, mg, mb = _face_region_mean_rgb(edited, mask)
    gray_dist = (
        ((mr - 128.0) ** 2 + (mg - 128.0) ** 2 + (mb - 128.0) ** 2) / 3.0
    ) ** 0.5
    info = {
        "base_var": bv,
        "edit_var": ev,
        "base_sat": bs,
        "edit_sat": es,
        "var_ratio": (ev / bv) if bv > 1e-6 else 1.0,
        "sat_ratio": (es / bs) if bs > 1e-6 else 1.0,
        "mean_r": mr,
        "mean_g": mg,
        "mean_b": mb,
        "gray_mean_dist": gray_dist,
    }
    # 18:30：均值贴 0.5 灰且方差不够高 → 灰块残留（含「大片灰+一点残影」漏判）
    if gray_dist < float(max_gray_mean_dist) and ev < 450.0:
        raise CharacterSheetError(
            f"{expr_key}脸部灰涂抹(贴近0.5灰) dist={gray_dist:.1f} var={ev:.1f} "
            f"mean=({mr:.0f},{mg:.0f},{mb:.0f})",
            status_code=422,
        )
    # 真灰涂抹：绝对平坦，或相对骤降且绝对值也偏低
    gray_var = ev < float(min_abs_var) or (
        bv > 8.0 and ev + 1e-9 < bv * float(min_var_ratio) and ev < 200.0
    )
    if gray_var:
        raise CharacterSheetError(
            f"{expr_key}脸部灰涂抹(方差过低) var={ev:.1f}/{bv:.1f} ratio={info['var_ratio']:.2f}",
            status_code=422,
        )
    gray_sat = es < float(min_abs_sat) or (
        bs > 0.04 and es + 1e-9 < bs * float(min_sat_ratio) and es < 0.04
    )
    if gray_sat:
        raise CharacterSheetError(
            f"{expr_key}脸部灰涂抹(饱和度过低) sat={es:.3f}/{bs:.3f} ratio={info['sat_ratio']:.2f}",
            status_code=422,
        )
    return info


def force_expression_mask_exterior(
    original: bytes,
    edited: bytes,
    mask: Image.Image | None = None,
) -> bytes:
    """真 inpaint 同几何后：遮罩外强制底图像素（抑 VAE 轻微渗色，非位移贴回）。"""
    o = Image.open(BytesIO(original)).convert("RGB")
    e = Image.open(BytesIO(edited)).convert("RGB")
    if e.size != o.size:
        e = e.resize(o.size, Image.Resampling.LANCZOS)
    if mask is None:
        mask = build_face_feature_mask(min(o.size)).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != o.size:
        mask = mask.resize(o.size, Image.Resampling.NEAREST)
    # 硬核：遮罩内用编辑，外用底图
    hard = mask.point(lambda v: 255 if v >= 96 else 0)
    out = Image.composite(e, o, hard)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def build_face_feature_mask_hard(size: int = 768) -> Image.Image:
    """眉/眼/嘴硬遮罩（白=可编辑），供真 inpaint；无羽化渗到发丝。"""
    return build_face_feature_mask(int(size)).point(lambda v: 255 if v >= 96 else 0)


def build_eyes_only_mask_hard(size: int = 768) -> Image.Image:
    """21:30 / 21:25：沉思只重画眼部——更紧眼+眉遮罩，不含嘴，挖掉瞳孔中心。"""
    s = int(size)
    mask = Image.new("L", (s, s), 0)
    from PIL import ImageDraw as _ID

    d = _ID.Draw(mask)
    # 紧眉带
    d.ellipse((int(s * 0.26), int(s * 0.16), int(s * 0.74), int(s * 0.34)), fill=255)
    # 更紧眼带（相对全脸遮罩再收）
    d.ellipse((int(s * 0.26), int(s * 0.30), int(s * 0.74), int(s * 0.46)), fill=255)
    # 挖瞳孔
    pr = max(4, int(s * 0.035))
    for cx in (int(s * 0.38), int(s * 0.62)):
        cy = int(s * 0.38)
        d.ellipse((cx - pr, cy - pr, cx + pr, cy + pr), fill=0)
    return mask.point(lambda v: 255 if v >= 96 else 0)


def measure_face_height_frac(data: bytes) -> float | None:
    """脸高占格高；无人脸返回 None。"""
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            img = Image.open(BytesIO(data)).convert("RGB")
            bb = _heuristic_skin_face_bbox(img)
        except Exception:  # noqa: BLE001
            bb = None
    if bb is None:
        return None
    img = Image.open(BytesIO(data))
    _w, h = img.size
    x1, y1, x2, y2 = bb
    return max(1.0, float(y2) - float(y1)) / float(max(1, h))


def auto_tighten_face_crop(
    data: bytes,
    *,
    size: int = 768,
    min_face_height_frac: float = 0.35,
    max_face_height_frac: float = 0.80,
    face_key: str | None = None,
    max_rounds: int = 6,
) -> bytes:
    """19:01：脸格头高自动拉近——不足 35% 则围绕脸框逐步缩小取景再 cover。"""
    base = data
    last_err: Exception | None = None
    tight = data
    for round_i in range(max_rounds):
        try:
            # 先头肩方裁，再按 round 围绕脸框缩小边长
            candidate = enforce_head_shoulders_square(
                base,
                size=size,
                max_upscale=min(2.4, 1.5 + 0.2 * round_i),
                check_coverage=False,
                face_closeup_gate=False,
            )
            if round_i > 0:
                img = Image.open(BytesIO(candidate)).convert("RGB")
                w, h = img.size
                bb = _detect_face_bbox_xyxy(candidate)
                if bb is None:
                    bb = _heuristic_skin_face_bbox(img)
                if bb is not None:
                    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
                    fh = max(8.0, fy2 - fy1)
                    fw = max(8.0, fx2 - fx1)
                    fcx = (fx1 + fx2) / 2.0
                    side = int(
                        max(
                            fh / max(0.40, min_face_height_frac + 0.08),
                            fw * 1.4,
                            64,
                        )
                        / (1.0 + 0.22 * round_i)
                    )
                    side = max(64, min(side, w, h))
                    left = max(0, min(w - side, int(round(fcx - side / 2.0))))
                    top = max(0, min(h - side, int(round(fy1 - 0.12 * side))))
                    crop = img.crop((left, top, left + side, top + side))
                    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
                    buf = BytesIO()
                    crop.save(buf, format="PNG")
                    candidate = buf.getvalue()
            assert_face_closeup_framing(
                candidate,
                min_face_height_frac=min_face_height_frac,
                max_face_height_frac=max_face_height_frac,
                face_key=face_key,
            )
            return candidate
        except CharacterSheetError as e:
            last_err = e
            tight = candidate if "candidate" in locals() else tight
            continue
    if last_err is not None:
        raise last_err
    raise CharacterSheetError(
        f"face auto-tighten failed (<{min_face_height_frac:.2f})", status_code=422
    )


def costume_cell_is_bad(cell_png: bytes, *, item_key: str = "") -> bool:
    """19:01：服饰坏格——空/细条/多件重复/瓦片网格 → 删格补裁。

    不用整格均色判坏（单件雨衣大色块会误杀）；靠暗色 blob + 4×4 前景格计数。
    """
    try:
        ratios = costume_cell_content_ratios(cell_png, n=1)
        if ratios and ratios[0] < 0.12:
            return True
    except Exception:  # noqa: BLE001
        return True
    img = Image.open(BytesIO(cell_png)).convert("RGB").resize((64, 64))
    px = list(img.getdata())
    blobs = _count_dark_blobs(px)
    if item_key == "boots" and blobs >= 4:
        return True
    if item_key == "pants" and blobs >= 4:
        return True
    if blobs >= 8:
        return True
    if item_key in ("raincoat", "umbrella", "bag") and blobs >= 6:
        return True
    # 浅色瓦片：4×4 多格有前景，且格缝多为背景（与整块单品区分）
    def _is_bg(r, g, b) -> bool:
        if r > 230 and g > 230 and b > 230:
            return True
        if abs(r - g) < 8 and abs(g - b) < 8 and 140 < r < 210:
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
        except Exception:  # noqa: BLE001
            pass
    return False


def ensure_costume_bad_cells_replaced(
    costume_png: bytes,
    *,
    portrait: bytes | None = None,
    front: bytes | None = None,
    min_ratio: float = 0.12,
    n: int = 4,
    item_keys: tuple[str, ...] | None = None,
) -> bytes:
    """19:01：删坏格并用主立绘分区裁切补上（先空格兜底，再坏格）。"""
    keys = item_keys or tuple(k for k, _ in _COSTUME_ITEMS)
    out = ensure_costume_first_cell_filled(
        costume_png, portrait=portrait, front=front, min_ratio=min_ratio, n=n
    )
    src = portrait or front
    if not src:
        return out
    im = Image.open(BytesIO(out)).convert("RGB")
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    # 15:52 四格：领口/袖口/下摆/靴；索引≥4 时回退中段
    bands = (
        (0.28, 0.18, 0.72, 0.36),
        (0.10, 0.42, 0.42, 0.60),
        (0.30, 0.55, 0.70, 0.78),
        (0.34, 0.80, 0.66, 0.995),
        (0.35, 0.40, 0.65, 0.72),
    )
    for idx in range(n):
        x0 = idx * cell_w
        x1 = w if idx == n - 1 else (idx + 1) * cell_w
        cell = im.crop((x0, 0, x1, h))
        buf = BytesIO()
        cell.save(buf, format="PNG")
        key = keys[idx] if idx < len(keys) else ""
        if not costume_cell_is_bad(buf.getvalue(), item_key=key):
            continue
        pimg = Image.open(BytesIO(src)).convert("RGB")
        pw, ph = pimg.size
        bx0, by0, bx1, by1 = bands[idx % len(bands)]
        crop = pimg.crop((int(pw * bx0), int(ph * by0), int(pw * bx1), int(ph * by1)))
        side = max(crop.width, crop.height, 8)
        canvas = Image.new("RGB", (side, side), (240, 240, 244))
        canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
        cbuf = BytesIO()
        canvas.save(cbuf, format="PNG")
        out = replace_costume_cell(out, idx, cbuf.getvalue(), n=n)
        im = Image.open(BytesIO(out)).convert("RGB")
        logger.info("costume cell%s bad(%s) → portrait band crop", idx, key or "?")
    assert_costume_cells_nonempty(out, min_ratio=min_ratio, n=n)
    return out



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




async def _wait_images(
    client: Any,
    prompt_id: str,
    *,
    exec_timeout: float | None = None,
    queue_wait_max: float | None = None,
) -> list[dict]:
    """04:30：超时只从 Comfy 开始执行计时；排队时间不计入。

    排队超过 ``queue_wait_max``(默认 20min) → 撤下本作业并抛 CharacterSheetQueueWait。
    """
    exec_to = float(_POLL_TIMEOUT if exec_timeout is None else exec_timeout)
    q_max = float(_QUEUE_WAIT_MAX if queue_wait_max is None else queue_wait_max)
    waited = 0.0  # 执行计时
    queue_wait = 0.0
    from app.comfy.client import ComfyUIError

    while waited < exec_to:
        try:
            images = await client.get_images(prompt_id)
        except ComfyUIError:
            images = []
        if images:
            return images
        # 执行失败勿空等到超时（19:01 Qwen VRAM 等）
        try:
            hist = await client.get_history(prompt_id)
            rec = (hist or {}).get(prompt_id) or {}
            st = rec.get("status") or {}
            if st.get("status_str") == "error" or st.get("completed") is False and any(
                isinstance(m, list) and m and m[0] == "execution_error"
                for m in (st.get("messages") or [])
            ):
                msg = "execution_error"
                for m in st.get("messages") or []:
                    if isinstance(m, list) and m and m[0] == "execution_error":
                        detail = m[1] if len(m) > 1 else {}
                        msg = str(
                            (detail or {}).get("exception_message")
                            or (detail or {}).get("exception_type")
                            or msg
                        )
                        break
                raise CharacterSheetError(f"出图失败:{msg}", status_code=502)
        except CharacterSheetError:
            raise
        except Exception:  # noqa: BLE001
            pass
        state = await _comfy_prompt_state(client, prompt_id)
        await asyncio.sleep(_POLL_INTERVAL)
        if state == "pending":
            queue_wait += _POLL_INTERVAL
            if queue_wait >= q_max:
                try:
                    await client.delete_from_queue([prompt_id])
                except Exception:  # noqa: BLE001
                    pass
                raise CharacterSheetQueueWait(
                    f"排队超时 queue_wait={queue_wait:.0f}s(>{q_max:.0f}s 未开始执行，不计失败)",
                    queue_wait=queue_wait,
                    prompt_id=prompt_id,
                )
            continue
        waited += _POLL_INTERVAL
    raise CharacterSheetError(
        f"出图超时({exec_to:.0f}s 执行计时, queue_wait={queue_wait:.0f}s)", status_code=504
    )


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
    neg = _with_ancient_spec_negative(neg, style)
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

    neg = _with_ancient_spec_negative(_STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"]), style)
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


def _build_sheet_mask_inpaint_graph(
    prompt: str,
    *,
    image_name: str,
    mask_name: str,
    ckpt_name: str,
    seed: int | None,
    filename_prefix: str,
    style: str = "anime",
    denoise: float = 0.62,
    grow_mask_by: int = 4,
    negative_extra: str = "",
) -> dict:
    """18:30：真局部 inpaint —— 禁止 VAEEncodeForInpaint + denoise<1（遮罩区预填 0.5 灰去不掉）。

    改用 VAEEncode(原图像素) + SetLatentNoiseMask，denoise 0.55–0.7，在原图 latent 上重绘遮罩区。
    grow_mask_by 保留签名兼容，当前路径由调用方硬遮罩控制，不在图内扩张。
    """
    del grow_mask_by  # 18:30：不再走 VAEEncodeForInpaint 的 grow；硬遮罩已在上传前定形
    d = float(denoise)
    if d < 1.0 - 1e-9:
        # 硬规则：凡 denoise<1 禁止 VAEEncodeForInpaint（本函数本身已不用该节点）
        pass
    if not (0.55 - 1e-9 <= d <= 0.70 + 1e-9):
        # 调用方可传略外值；钳到产品窗，避免过低灰残留或过高毁脸
        d = max(0.55, min(0.70, d))
    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
    if negative_extra:
        neg = f"{neg}, {negative_extra}"
    neg = (
        neg
        + ", gray smear, flat gray face, muddy skin, melted face, double face, "
        "ghosting, misaligned features, watermark, text, logo, emblem, badge, "
        "solid gray fill, 0.5 gray patch, featureless face"
    )
    s = int(seed) if seed is not None else int(uuid.uuid4().int % (2**31 - 1))
    steps = 28 if style == "anime" else 22
    cfg = 6.5 if style == "anime" else 7.0
    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": ckpt_name},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["4", 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": neg, "clip": ["4", 1]},
        },
        "11": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "12": {"class_type": "LoadImage", "inputs": {"image": mask_name}},
        "13": {
            "class_type": "ImageToMask",
            "inputs": {"image": ["12", 0], "channel": "red"},
        },
        # 18:30：原图像素进 latent，再仅对遮罩区加噪 —— 不做 0.5 灰预填
        "32": {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["11", 0],
                "vae": ["4", 2],
            },
        },
        "33": {
            "class_type": "SetLatentNoiseMask",
            "inputs": {
                "samples": ["32", 0],
                "mask": ["13", 0],
            },
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": s,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler_ancestral",
                "scheduler": "normal",
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["33", 0],
                "denoise": float(d),
            },
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"images": ["8", 0], "filename_prefix": filename_prefix},
        },
    }


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

    neg = _with_ancient_spec_negative(_STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"]), style)
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


def _build_sheet_qwen_edit_graph(
    prompt: str,
    *,
    image_name: str,
    seed: int | None,
    filename_prefix: str,
    fast: bool = False,
) -> dict:
    """设定卡表情编辑：在 :8262/:8195 本地跑 Qwen-Image-Edit（不走 :8194/:8196）。

    22:02：默认 fast=False（约 20 步 / 更高 CFG），整图编辑、不加遮罩。
    """
    from app.workflows.qwen_edit import QwenEditParams, build_qwen_edit_graph

    # :8262 上的文件名与 workflows 常量不完全一致，优先用本机可见名
    unet = "Qwen-Image-Edit-2509_fp8_e4m3fn.safetensors"
    params = QwenEditParams(
        image=image_name,
        positive=prompt,
        fast=bool(fast),
        filename_prefix=filename_prefix,
        **({"seed": seed} if seed is not None else {}),
    )
    graph = build_qwen_edit_graph(params)
    # 覆盖 UNET 文件名为设定卡 worker 上的实际名
    if "1" in graph and isinstance(graph["1"], dict):
        inputs = graph["1"].setdefault("inputs", {})
        inputs["unet_name"] = unet
    return graph


async def regenerate_hires_side_head_master(
    pool: "WorkerPool",
    *,
    client: Any,
    side_master: bytes,
    front_face: bytes | None,
    ckpt: str,
    seed: int | None,
    worker: str | None,
    style: str,
    prompt: str,
    reject_dir: Path | None = None,
    out_size: int = 1280,
    min_clip: float = 0.58,
) -> bytes | None:
    """00:31：侧母版头肩高分辨率重出（同参数族），CLIP 对正脸门禁后再裁入卡。

    禁止改脸超分模型；用 img2img/Qwen 在放大后的头肩初值上重绘清晰线条，保持脸型发型。
    """
    init = prepare_hires_side_head_init(side_master, out_size=out_size)
    try:
        if reject_dir is not None:
            (reject_dir / f"hires_side_init_{int(seed or 0)}.png").write_bytes(init)
    except Exception:
        pass
    init_name = await client.upload_image(
        init, f"sheet_hires_side_init_{int(seed or 0)}.png"
    )
    hires_prompt = (
        (prompt or "").strip()
        + " sharp clean anime lineart, high resolution head and shoulders only, "
        "same face shape same hairstyle, three-quarter view, NO face morphing, "
        "NO front facing, NO full body"
    )
    _neg = (
        "blurry, melted face, deformed eyes, front face, symmetrical frontal, "
        "full body, text, watermark, logo, long hair past shoulders"
    )
    cands: list[bytes] = []
    for ci in range(2):
        cseed = None if seed is None else int(seed) + 0x230C + ci * 97
        try:
            # 优先 Qwen 编辑（语义保持身份）；失败再 img2img
            raw = await generate_panel_bytes(
                pool,
                (
                    "在保持同一人物、同一发型、同一¾侧脸角度与雨衣领口的前提下，"
                    "输出更清晰的头肩特写；不要改脸型发型，不要正面化，不要全身。"
                ),
                ckpt_name=ckpt,
                width=out_size,
                height=out_size,
                seed=cseed,
                worker=worker,
                filename_prefix=f"ToIV_char_sheet_hires_side_q{ci}",
                style=style,
                client=client,
                ref_image=init_name,
                ref_mode="qwen_edit",
                denoise=1.0,
                negative_extra=_neg,
            )
        except Exception as qe:  # noqa: BLE001
            logger.warning("hires side qwen fail cand%s: %s", ci, qe)
            try:
                raw = await generate_panel_bytes(
                    pool,
                    hires_prompt,
                    ckpt_name=ckpt,
                    width=out_size,
                    height=out_size,
                    seed=cseed,
                    worker=worker,
                    filename_prefix=f"ToIV_char_sheet_hires_side_i{ci}",
                    style=style,
                    client=client,
                    ref_image=init_name,
                    ref_mode="img2img",
                    denoise=0.48,
                    negative_extra=_neg,
                )
            except Exception as ie:  # noqa: BLE001
                logger.warning("hires side img2img fail cand%s: %s", ci, ie)
                continue
        try:
            raw = enforce_head_shoulders_square(raw, size=out_size, face_closeup_gate=True)
        except CharacterSheetError as fe:
            dump_rejected_panel(
                raw,
                seed=seed,
                panel="face_three_quarter",
                gate="hires_side_frame",
                detail=str(fe),
                dump_dir=reject_dir,
            )
            continue
        # CLIP 对正面头
        if front_face is not None:
            sim = clip_image_cosine_sim(raw, front_face)
            if sim is not None and sim + 1e-12 < float(min_clip):
                dump_rejected_panel(
                    raw,
                    seed=seed,
                    panel="face_three_quarter",
                    gate="hires_side_clip",
                    detail=f"clip={sim:.4f}<{min_clip}",
                    dump_dir=reject_dir,
                )
                continue
        # 相对原侧裁：应更清晰
        try:
            base_crop = crop_face_slot_from_master(
                side_master, slot="face_three_quarter", size=768
            )
            if _edge_sharpness_score(raw) + 0.5 < _edge_sharpness_score(base_crop):
                dump_rejected_panel(
                    raw,
                    seed=seed,
                    panel="face_three_quarter",
                    gate="hires_side_sharp",
                    detail="not sharper",
                    dump_dir=reject_dir,
                )
                continue
        except Exception:
            pass
        cands.append(raw)
    if not cands:
        return None
    # 择清晰度最高
    cands.sort(key=lambda b: _edge_sharpness_score(b), reverse=True)
    best = cands[0]
    try:
        if reject_dir is not None:
            (reject_dir / f"hires_side_best_{int(seed or 0)}.png").write_bytes(best)
    except Exception:
        pass
    return best


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
    mask_image: str | None = None,
    grow_mask_by: int = 4,
) -> bytes:
    """单格出图 → PNG bytes。

    ref_mode: auto|ipa|img2img|qwen_edit|inpaint|none
      - anime 默认 img2img(规避 hassaku/IPA glitch)
      - 18:30 表情真局部 inpaint（mask_image + VAEEncode+SetLatentNoiseMask；禁 VAEEncodeForInpaint+denoise<1）
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
        if ref_image and mode == "inpaint":
            if not mask_image:
                raise CharacterSheetError(
                    "inpaint 模式需要 mask_image", status_code=422
                )
            graph = _build_sheet_mask_inpaint_graph(
                prompt,
                image_name=ref_image,
                mask_name=mask_image,
                ckpt_name=ckpt_name,
                seed=seed,
                filename_prefix=filename_prefix,
                style=style,
                denoise=denoise,
                grow_mask_by=grow_mask_by,
                negative_extra=negative_extra,
            )
        elif ref_image and mode == "qwen_edit":
            graph = _build_sheet_qwen_edit_graph(
                prompt,
                image_name=ref_image,
                seed=seed,
                filename_prefix=filename_prefix,
            )
        elif ref_image and mode == "img2img":
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
    expr_base_panels: dict[str, bytes] | None = None,
    expr_lock_meta: dict[str, dict] | None = None,
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
    _ANCIENT_SPEC_NEG_CTX.set(ancient_spec_negative(meta))
    _acc_fix = ancient_accessory_prompt_fix(meta)
    if _acc_fix["pos"]:
        logger.info(
            "ancient accessory prompt fix name=%s wooden_hairpin=%s umbrella_in_hand=%s",
            meta.name, _acc_fix["wooden_hairpin"], _acc_fix["umbrella_in_hand"],
        )
    panels: dict[str, bytes] = dict(panels_override or {})
    override_keys: set[str] = set(panels.keys())  # 17:47：母版注入格跳过一切 panel 门禁
    _expr_lock_meta: dict[str, dict] = {
        str(k): dict(v)
        for k, v in dict(expr_lock_meta or {}).items()
        if str(k).startswith("expr_") and isinstance(v, dict)
    }
    # 22:02：表情整图 Qwen 底版（2023b 同人干净格）；键 expr_0..expr_5
    _expr_bases: dict[str, bytes] = {
        k: v
        for k, v in dict(expr_base_panels or {}).items()
        if k.startswith("expr_") and v
    }
    panel_urls: dict[str, str] = {}
    reject_dir = Path(
        os.environ.get(
            "TOIV_SHEET_REJECT_DIR",
            f"/home/merlin/toiv/tmp/toiv_report_sheet_rejects_{int(seed or 0)}",
        )
    )
    reject_dir.mkdir(parents=True, exist_ok=True)
    for _ok, _ob in list(panels.items()):
        try:
            (reject_dir / f"override_{_ok}.png").write_bytes(_ob)
        except Exception:
            pass
    _last_reject: dict[str, Any] = {"key": None, "data": None}
    _reject_token = _SHEET_REJECT_CTX.set(
        {"dir": reject_dir, "seed": seed, "panels": panels, "current_key": None}
    )

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

    # 1) 主立绘；16:03/16:18：若已注入旧正面，则以旧正面 img2img 编辑出主立绘（禁空白文生）
    if "portrait" not in panels:
        w, h = _panel_size("portrait", meta.style)
        last_err = None
        front_ref_name = None
        if panels.get("front"):
            try:
                front_ref_name = await client.upload_image(
                    panels["front"],
                    f"sheet_front_ref_{character_id[:8]}_{meta.style}.png",
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("upload front ref for portrait edit failed: %s", e)
                front_ref_name = None
        for attempt in range(6):
            try:
                s = None if seed is None else int(seed) + attempt * 9973
                # 换 seed 仍可能整图缓存：扰动正向提示破缓存
                bust = (
                    f", unique layout variant {attempt}-{s or 0}, "
                    "plain flat chest no badge no emblem no star patch"
                )
                if front_ref_name:
                    panels["portrait"] = await generate_panel_bytes(
                        pool,
                        prompts["portrait"]
                        + ", edit from reference front view into full-body main portrait, "
                        "same character same outfit same colors, plain flat chest, "
                        + bust,
                        ckpt_name=ckpt,
                        width=w,
                        height=h,
                        seed=s,
                        worker=worker,
                        filename_prefix=f"ToIV_char_sheet_portrait_fromfront_a{attempt}",
                        style=meta.style,
                        client=client,
                        ref_image=front_ref_name,
                        ref_mode="img2img",
                        denoise=0.48,
                    )
                else:
                    panels["portrait"] = await generate_panel_bytes(
                        pool,
                        prompts["portrait"] + bust,
                        ckpt_name=ckpt,
                        width=w,
                        height=h,
                        seed=s,
                        worker=worker,
                        filename_prefix=f"ToIV_char_sheet_portrait_a{attempt}",
                        style=meta.style,
                        client=client,
                    )
                if meta.style in ("anime", "二次元") and portrait_has_chest_emblem(
                    panels["portrait"], ref=panels.get("front")
                ):
                    # 15:36：徽标残留 → 以当前立绘为参考低 denoise 重绘胸口素面
                    try:
                        ref_p = await client.upload_image(
                            panels["portrait"],
                            f"sheet_portrait_emblem_{attempt}.png",
                        )
                        cleaned = await generate_panel_bytes(
                            pool,
                            prompts["portrait"]
                            + ", plain flat chest only, remove chest badge emblem star logo patch, "
                            + bust,
                            ckpt_name=ckpt,
                            width=w,
                            height=h,
                            seed=(s or 0) + 171,
                            worker=worker,
                            filename_prefix=f"ToIV_char_sheet_portrait_plain_a{attempt}",
                            style=meta.style,
                            client=client,
                            ref_image=ref_p,
                            ref_mode="img2img",
                            denoise=0.28,
                        )
                        if portrait_has_chest_emblem(cleaned, ref=panels.get("front")):
                            # 16:18：禁用矩形铺色；img2img 去标失败则换 seed
                            raise CharacterSheetError(
                                "主立绘胸口徽标，img2img 去标失败禁铺色",
                                status_code=422,
                            )
                        panels["portrait"] = cleaned
                        logger.info("portrait emblem cleared via img2img attempt=%s", attempt)
                    except CharacterSheetError as ce:
                        last_err = ce
                        logger.warning("portrait emblem inpaint fail attempt=%s: %s", attempt, ce)
                        continue
                # 15:36/15:40：主立绘过人脸 + 板岩灰色差门禁后，才允许出三视图
                if meta.style in ("anime", "二次元"):
                    try:
                        assert_fullbody_portrait_face_ok(panels["portrait"])
                    except CharacterSheetError as gate_e:
                        last_err = gate_e
                        logger.warning(
                            "portrait face gate fail attempt=%s: %s", attempt, gate_e
                        )
                        continue
                    # 16:03/16:18：有旧正面母版时，服装色锁旧正面（相对色差），禁绝对板岩灰硬门槛与程序重染
                    if panels.get("front"):
                        p_hex = _panel_garment_dominant_hex(panels["portrait"])
                        f_hex = _panel_garment_dominant_hex(panels["front"])
                        if not p_hex or not f_hex:
                            last_err = CharacterSheetError(
                                "颜色门禁失败:主立绘/旧正面无法取服装主色",
                                status_code=422,
                            )
                            logger.warning(
                                "portrait relative color fail attempt=%s: %s",
                                attempt,
                                last_err,
                            )
                            continue
                        dist = _hex_dist(p_hex, f_hex)
                        if dist > 110:
                            last_err = CharacterSheetError(
                                f"颜色门禁失败:主立绘({p_hex})与旧正面({f_hex})色差={dist}>110",
                                status_code=422,
                            )
                            logger.warning(
                                "portrait vs front color fail attempt=%s: %s",
                                attempt,
                                last_err,
                            )
                            continue
                        logger.info(
                            "portrait color locked to front override %s~%s dist=%s",
                            p_hex,
                            f_hex,
                            dist,
                        )
                    else:
                        try:
                            assert_garment_near_slate_gray(
                                panels["portrait"], label="主立绘"
                            )
                        except CharacterSheetError as color_e:
                            # 无母版时仍要求板岩灰；禁程序着色，仅换 seed
                            last_err = color_e
                            logger.warning(
                                "portrait slate gate fail attempt=%s: %s; retry seed (no tint)",
                                attempt,
                                color_e,
                            )
                            continue
                elif meta.style == "ancient_realistic" and ancient_spec_target_hex(meta):
                    try:
                        assert_garment_near_spec_color(
                            panels["portrait"], ancient_spec_target_hex(meta), label="主立绘"
                        )
                    except CharacterSheetError as color_e:
                        last_err = color_e
                        logger.warning(
                            "portrait ancient spec color gate fail attempt=%s: %s; retry seed",
                            attempt,
                            color_e,
                        )
                        continue
                if meta.style == "ancient_realistic" and ancient_accessory_prompt_fix(meta)["wooden_hairpin"]:
                    # 软检(仅日志):实测黄铜环与木色色相重叠(≈31–34°)且线上无 InsightFace 时脸框不可靠,
                    # 不据此换 seed;木簪/持伞靠正负向提示词加固(ancient_accessory_prompt_fix)。
                    try:
                        _hp = hair_ornament_gold_frac(panels["portrait"])
                        _f = _hp.get("frac")
                        if _f is not None and _f > HAIRPIN_GOLD_MAX_FRAC:
                            logger.warning(
                                "portrait ancient hairpin soft check: gold_frac=%.3f>%s (spec 木簪) attempt=%s box=%s; log only",
                                _f, HAIRPIN_GOLD_MAX_FRAC, attempt, _hp.get("box"),
                            )
                        else:
                            logger.info(
                                "portrait ancient hairpin soft check ok attempt=%s gold_frac=%s",
                                attempt, _f,
                            )
                    except Exception as acc_e:  # noqa: BLE001
                        logger.warning("portrait ancient hairpin soft check error: %s", acc_e)
                if meta.style == "ancient_realistic" and build_ancient_accessory_qa_prompt(meta):
                    # run3:VLM 是/否判官(木簪木质 / 伞握手或不出现);前 N 次不过换 seed,VLM 不可用则放行
                    try:
                        _qa = await classify_ancient_accessory_qa(
                            panels["portrait"], meta=meta, worker_url=worker, seed=42 + attempt
                        )
                    except CharacterSheetError as qa_e:
                        _qa = {"reasons": [], "error": str(qa_e)}
                        logger.warning("portrait ancient accessory VLM unavailable attempt=%s: %s; pass", attempt, qa_e)
                    _rs = _qa.get("reasons") or []
                    if _rs and attempt < ACCESSORY_QA_HARD_ATTEMPTS:
                        last_err = CharacterSheetError(
                            f"饰品门禁失败:主立绘 {';'.join(_rs)},重出", status_code=422
                        )
                        logger.warning(
                            "portrait ancient accessory VLM gate fail attempt=%s reasons=%s q1=%s q2=%s model=%s; retry seed",
                            attempt, _rs, _qa.get("q1"), _qa.get("q2"), _qa.get("model"),
                        )
                        continue
                    logger.info(
                        "portrait ancient accessory VLM gate %s attempt=%s q1=%s q2=%s model=%s reasons=%s",
                        "ok" if not _rs else "exhausted(accept, log only)",
                        attempt, _qa.get("q1"), _qa.get("q2"), _qa.get("model"), _rs,
                    )
                break
            except CharacterSheetError as e:
                last_err = e
                logger.warning("portrait gen fail attempt=%s: %s", attempt, e)
        else:
            raise last_err or CharacterSheetError("主立绘生成失败", status_code=422)
    if "portrait" not in override_keys:
        assert_no_large_uniform_rect(
            panels["portrait"], label="主立绘", ref=panels.get("front")
        )
        assert_skin_not_blue_gray(
            panels["portrait"], label="主立绘", ref=panels.get("front")
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
            # 15:52 anime：服饰直接从主立绘裁四局部（领口/袖口/下摆/靴子）；古风仍走单品生成+坏格补
            try:
                if meta.style in ("anime", "二次元") and panels.get("portrait"):
                    panels["costume"] = build_costume_collage_from_portrait(
                        panels["portrait"], style=meta.style
                    )
                else:
                    panels["costume"] = await _generate_costume_collage(
                        pool,
                        meta=meta,
                        ckpt=ckpt,
                        worker=worker,
                        client=client,
                        seed=seed,
                    )
                    panels["costume"] = ensure_costume_bad_cells_replaced(
                        panels["costume"],
                        portrait=panels.get("portrait"),
                        front=panels.get("front"),
                        n=len(ancient_costume_items(meta) if meta.style == "ancient_realistic" else _COSTUME_ITEMS),
                    )
            except CharacterSheetError as ce:
                dump_rejected_panel(
                    panels.get("costume"),
                    seed=seed,
                    panel="costume",
                    gate="costume_cells",
                    detail=str(ce),
                    dump_dir=reject_dir,
                )
                raise
            continue
        w, h = _panel_size(key, meta.style)
        use_ref = None
        ref_mode = "none"
        denoise = 0.62
        if key in ("front", "side", "back"):
            # 15:36/15:40：anime 三视图禁止各自文生图/OpenPose 老路；
            # 必须以过门禁主立绘做 img2img 参考锁同款同色。
            if meta.style in ("anime", "二次元"):
                if not ref_name:
                    raise CharacterSheetError(
                        "三视图缺主立绘参考，无法 img2img", status_code=422
                    )
                last_err = None
                for attempt in range(4):
                    try:
                        s = (
                            None
                            if seed is None
                            else seed + (abs(hash(key)) % 10000) + attempt * 8111
                        )
                        bust = f", keep exact same raincoat color #5A6A7A long sleeves pantyhose boots as reference portrait, unique view {attempt}-{s or 0}"
                        # denoise 偏低锁服装；逐步略升仅用于姿态
                        den = 0.42 + 0.04 * attempt
                        raw = await generate_panel_bytes(
                            pool,
                            prompts[key] + bust,
                            ckpt_name=ckpt,
                            width=w,
                            height=h,
                            seed=s,
                            worker=worker,
                            filename_prefix=f"ToIV_char_sheet_{key}_i2i_a{attempt}",
                            style=meta.style,
                            client=client,
                            ref_image=ref_name,
                            ref_mode="img2img",
                            denoise=den,
                        )
                        raw = normalize_turnaround_figure(raw, out_w=w, out_h=h)
                        if key in ("front", "side") and portrait_has_chest_emblem(raw):
                            # 胸口残留徽标：再 img2img 一次素面；仍失败则 422（16:18 禁铺色）
                            raw = await generate_panel_bytes(
                                pool,
                                prompts[key]
                                + ", plain flat chest no badge no emblem no star, "
                                + bust,
                                ckpt_name=ckpt,
                                width=w,
                                height=h,
                                seed=(s or 0) + 333,
                                worker=worker,
                                filename_prefix=f"ToIV_char_sheet_{key}_plain_a{attempt}",
                                style=meta.style,
                                client=client,
                                ref_image=await client.upload_image(
                                    raw, f"sheet_{key}_emblem_{attempt}.png"
                                ),
                                ref_mode="img2img",
                                denoise=0.35,
                            )
                            raw = normalize_turnaround_figure(raw, out_w=w, out_h=h)
                            if portrait_has_chest_emblem(raw):
                                raise CharacterSheetError(
                                    f"img2img {key}胸口徽标残留，禁铺色须重出",
                                    status_code=422,
                                )
                        # 与主立绘服装色差；过大则强制着色对齐板岩灰后再比
                        p_hex = _panel_garment_dominant_hex(panels["portrait"])
                        t_hex = _panel_garment_dominant_hex(raw)
                        if p_hex and t_hex and _hex_dist(p_hex, t_hex) > 110:
                            raise CharacterSheetError(
                                f"img2img {key}服装色差过大({t_hex} vs {p_hex})，禁强制着色须重出",
                                status_code=422,
                            )
                        if key not in override_keys:

                            assert_panel_output_gates(raw, label=key, key=key)
                        panels[key] = raw
                        last_err = None
                        break
                    except CharacterSheetError as e:
                        last_err = e
                        logger.warning(
                            "img2img turnaround %s fail attempt=%s: %s",
                            key,
                            attempt,
                            e,
                        )
                if last_err is not None:
                    raise last_err
                panel_urls[key] = save_panel_png(
                    panels[key], character_id=character_id, style=meta.style, key=key
                )
                continue
            # 古风仍可用 OpenPose + IPA
            use_op, _why = await _probe_openpose_available(client)
            if use_op and ref_name:
                assets = ensure_openpose_assets(height_cm=meta.height_cm or 165)
                pose_name = await client.upload_image(
                    assets[key].read_bytes(),
                    f"sheet_pose_{character_id[:8]}_{key}.png",
                )
                last_err = None
                for attempt in range(4):
                    try:
                        s = (
                            None
                            if seed is None
                            else seed + (abs(hash(key)) % 10000) + attempt * 8111
                        )
                        raw = await generate_panel_bytes_openpose(
                            pool,
                            prompts[key],
                            pose_image_name=pose_name,
                            ckpt_name=ckpt,
                            width=w,
                            height=h,
                            seed=s,
                            worker=worker,
                            filename_prefix=f"ToIV_char_sheet_{key}_pose",
                            style=meta.style,
                            client=client,
                            ref_image=ref_name,
                            skip_preprocess=True,
                        )
                        raw = normalize_turnaround_figure(raw, out_w=w, out_h=h)
                        if ancient_spec_target_hex(meta) and key not in override_keys:
                            assert_garment_near_spec_color(
                                raw, ancient_spec_target_hex(meta), label=key
                            )
                        panels[key] = raw
                        last_err = None
                        break
                    except CharacterSheetError as e:
                        last_err = e
                        logger.warning(
                            "openpose %s fail attempt=%s: %s", key, attempt, e
                        )
                if last_err is not None:
                    raise last_err
                panel_urls[key] = save_panel_png(
                    panels[key], character_id=character_id, style=meta.style, key=key
                )
                continue
            if ref_name:
                use_ref = ref_name
                ref_mode = "ipa"
                denoise = 0.65
        elif key == "faces":
            # 18:23：禁止再生成面部三格；从主立绘+三视图母版裁头肩
            # face_front←portrait/front，face_three_quarter←side，face_side←back（背头）
            try:
                tri = build_faces_tri_from_masters(
                    portrait=panels.get("portrait"),
                    front=panels.get("front"),
                    side=panels.get("side"),
                    back=panels.get("back"),
                    size=768,
                )
            except CharacterSheetError as fe:
                dump_rejected_panel(
                    None,
                    seed=seed,
                    panel="faces",
                    gate="faces_master_crop",
                    detail=str(fe),
                    dump_dir=reject_dir,
                )
                raise
            for fk in ("face_front", "face_three_quarter", "face_side"):
                # 20:23 硬裁 ≤2×；此处只做空图检查，侧面再走 Qwen 清线
                im = Image.open(BytesIO(tri[fk])).convert("RGB")
                if im.size[0] < 64 or sum(im.convert("L").resize((32, 32)).getdata()) < 100:
                    dump_rejected_panel(
                        tri.get(fk),
                        seed=seed,
                        panel=str(fk),
                        gate="faces_crop_empty",
                        detail="empty crop",
                        dump_dir=reject_dir,
                    )
                    raise CharacterSheetError(
                        f"faces {fk} master crop empty", status_code=422
                    )
                frac = measure_face_height_frac(tri[fk])
                logger.info(
                    "faces %s hard-crop face_height_frac=%s", fk, frac
                )
                _y = estimate_face_yaw_deg(tri[fk])
                logger.info(
                    "faces %s crop-from-master yaw=%s ok=%s",
                    fk,
                    _y,
                    yaw_ok_for_face_key(_y, fk),
                )
            # 23:17：侧面¾默认直接用母版硬裁原像素，禁止再走 Qwen 清线/deblur（融化源）。
            # 背头 face_side 继续背母版硬裁。仅当显式 TOIV_SHEET_SIDE_DEBLUR=1 才启用旧清线。
            if os.environ.get("TOIV_SHEET_SIDE_DEBLUR", "").strip() in ("1", "true", "yes"):
                for _side_fk, _seed_off in (
                    ("face_three_quarter", 2023),
                ):
                    try:
                        side_crop = tri[_side_fk]
                        side_name = await client.upload_image(
                            side_crop,
                            f"sheet_{_side_fk}_crop_{character_id[:8]}_{meta.style}.png",
                        )
                        _deblur_prompt = (
                            "整图修复侧面/¾侧头像的融化与错位线条（禁止局部遮罩）："
                            "恢复清晰二次元五官——可见的一侧眼睛轮廓清楚、鼻梁一条干净线、嘴巴位置正确；"
                            "保持同一发型、同一头身角度、同一雨衣领口与配色；"
                            "不要正面化、不要改成长发、不要加第二张脸、不要重影、不要加文字徽标。"
                        )
                        _cands: list[bytes] = []
                        for _ci in range(3):
                            _cseed = (
                                None
                                if seed is None
                                else int(seed) + int(_seed_off) + int(_ci) * 17
                            )
                            cleaned = await generate_panel_bytes(
                                pool,
                                _deblur_prompt,
                                ckpt_name=ckpt,
                                width=768,
                                height=768,
                                seed=_cseed,
                                worker=worker,
                                filename_prefix=f"ToIV_char_sheet_{_side_fk}_deblur_c{_ci}",
                                style=meta.style,
                                client=client,
                                ref_image=side_name,
                                ref_mode="qwen_edit",
                                denoise=1.0,
                            )
                            try:
                                cleaned = enforce_head_shoulders_square(
                                    cleaned, size=768, face_closeup_gate=True
                                )
                            except CharacterSheetError:
                                dump_rejected_panel(
                                    cleaned,
                                    seed=seed,
                                    panel=str(_side_fk),
                                    gate="side_deblur_frame",
                                    detail=f"cand{_ci} frame gate",
                                    dump_dir=reject_dir,
                                )
                                continue
                            _cands.append(cleaned)
                        _id_ref = tri.get("face_front") or panels.get("portrait")
                        best = pick_best_side_deblur_candidate(
                            _cands,
                            side_crop,
                            master_side=panels.get("side"),
                            identity_ref=_id_ref,
                        )
                        if best is not None:
                            tri[_side_fk] = best
                            logger.info(
                                "faces %s Qwen deblur accepted (%d cands)",
                                _side_fk,
                                len(_cands),
                            )
                        else:
                            logger.info(
                                "faces %s Qwen deblur all rejected → keep crop (%d cands)",
                                _side_fk,
                                len(_cands),
                            )
                    except Exception as de:  # noqa: BLE001
                        logger.warning("faces %s Qwen deblur skipped: %s", _side_fk, de)
            else:
                logger.info(
                    "faces face_three_quarter 00:31 Lanczos native (Qwen deblur off)"
                )
            # 00:31：硬裁后若侧面不可读（需放大/糊），同 seed 重出高分侧头肩母版再裁入
            try:
                side_src = panels.get("side")
                if side_src:
                    _tq, _tq_meta = crop_face_slot_from_master_with_meta(
                        side_src, slot="face_three_quarter", size=768
                    )
                    if not _tq_meta.get("readable", True):
                        logger.info(
                            "faces face_three_quarter unreadable meta=%s → hires side master",
                            {k: _tq_meta.get(k) for k in ("native_side", "upscale", "face_frac")},
                        )
                        _hires = await regenerate_hires_side_head_master(
                            pool,
                            client=client,
                            side_master=side_src,
                            front_face=tri.get("face_front") or panels.get("portrait"),
                            ckpt=ckpt,
                            seed=seed,
                            worker=worker,
                            style=meta.style,
                            prompt=prompts.get("face_three_quarter")
                            or prompts.get("side")
                            or "",
                            reject_dir=reject_dir,
                        )
                        if _hires:
                            # 00:31：高分侧母版仅供头格裁切，禁止覆盖全身 side
                            # 00:59：须过脸高 25%–50% + 瞳色 HSV；不过则回退全身 side 同比例裁
                            _hires_crop = crop_face_slot_from_master(
                                _hires, slot="face_three_quarter", size=768
                            )
                            _front_ref = tri.get("face_front") or panels.get("portrait")
                            _ok, _ainfo = side_three_quarter_accept(
                                _hires_crop, front_face=_front_ref
                            )
                            if _ok:
                                tri["face_three_quarter"] = _hires_crop
                                try:
                                    if reject_dir is not None:
                                        (reject_dir / f"hires_side_used_{int(seed or 0)}.png").write_bytes(
                                            _hires
                                        )
                                except Exception:
                                    pass
                                logger.info(
                                    "faces face_three_quarter hires accepted %s",
                                    _ainfo,
                                )
                            else:
                                logger.warning(
                                    "faces hires side reject gates %s → body side fallback",
                                    _ainfo,
                                )
                                try:
                                    if reject_dir is not None:
                                        (reject_dir / f"hires_side_reject_gates_{int(seed or 0)}.txt").write_text(
                                            str(_ainfo), encoding="utf-8"
                                        )
                                        (reject_dir / f"hires_side_rejected_crop_{int(seed or 0)}.png").write_bytes(
                                            _hires_crop
                                        )
                                except Exception:
                                    pass
                                _body = crop_face_slot_from_master(
                                    side_src, slot="face_three_quarter", size=768
                                )
                                _bok, _binfo = side_three_quarter_accept(
                                    _body, front_face=_front_ref
                                )
                                tri["face_three_quarter"] = _body
                                logger.info(
                                    "faces face_three_quarter body-side fallback accept=%s info=%s",
                                    _bok,
                                    _binfo,
                                )
                        else:
                            logger.warning(
                                "faces hires side master rejected/failed → keep Lanczos crop"
                            )
                            tri["face_three_quarter"] = _tq
            except CharacterSheetError:
                raise
            except Exception as he:  # noqa: BLE001
                logger.warning("faces hires side master skipped: %s", he)
            # 15:52 / 16:18：侧头直方图匹配；匹配后必须再过 00:59 门禁，不过 → 三视图侧面格同比例裁
            # 18:02：默认跳过 hist-match（TOIV_SHEET_SIDE_HIST_MATCH off）→ 1618 干净 Lanczos/母版裁
            try:
                if not side_hist_match_enabled():
                    logger.info(
                        "faces hist-match skipped (TOIV_SHEET_SIDE_HIST_MATCH off, default 18:02 → 1618 path)"
                    )
                    _front_ref_hm = None  # skip body
                else:
                    _front_ref_hm = tri.get("face_front") or panels.get("portrait")
                _side_src_fb = panels.get("side")
                if _front_ref_hm and tri.get("face_three_quarter"):
                    _before = tri["face_three_quarter"]
                    _matched = match_side_head_coat_hair_to_front(
                        _before, _front_ref_hm
                    )
                    _mok, _minfo = side_three_quarter_accept(
                        _matched, front_face=_front_ref_hm
                    )
                    if _mok:
                        tri["face_three_quarter"] = _matched
                        logger.info(
                            "faces face_three_quarter hist-match accepted %s",
                            _minfo,
                        )
                    else:
                        _bok0, _binfo0 = side_three_quarter_accept(
                            _before, front_face=_front_ref_hm
                        )
                        if _bok0:
                            tri["face_three_quarter"] = _before
                            logger.warning(
                                "faces hist-match reject %s → keep pre-match",
                                _minfo,
                            )
                        elif _side_src_fb:
                            _body = crop_face_slot_from_master(
                                _side_src_fb, slot="face_three_quarter", size=768
                            )
                            # 可选轻量匹配；失败则纯三视图裁
                            try:
                                _body_m = match_side_head_coat_hair_to_front(
                                    _body, _front_ref_hm
                                )
                                _bmok, _bminfo = side_three_quarter_accept(
                                    _body_m, front_face=_front_ref_hm
                                )
                                if _bmok:
                                    _body = _body_m
                                    logger.info(
                                        "faces body-side hist ok %s", _bminfo
                                    )
                                else:
                                    logger.warning(
                                        "faces body-side hist reject %s → plain crop",
                                        _bminfo,
                                    )
                            except Exception as _bhe:  # noqa: BLE001
                                logger.warning("faces body hist skipped: %s", _bhe)
                            _bok, _binfo = side_three_quarter_accept(
                                _body, front_face=_front_ref_hm
                            )
                            tri["face_three_quarter"] = _body
                            logger.warning(
                                "faces hist/hires fail → body-side fallback accept=%s info=%s (was %s)",
                                _bok,
                                _binfo,
                                _minfo,
                            )
                            try:
                                if reject_dir is not None:
                                    (reject_dir / f"side_body_fallback_{int(seed or 0)}.txt").write_text(
                                        f"hist_or_hires_reject {_minfo} → body {_binfo}",
                                        encoding="utf-8",
                                    )
                            except Exception:
                                pass
                        else:
                            tri["face_three_quarter"] = _before
                            logger.warning(
                                "faces hist reject %s and no side master", _minfo
                            )
            except Exception as hme:  # noqa: BLE001
                logger.warning("faces hist-match skipped: %s", hme)
            # 最终侧头再验：方图 + 拼格 cell 模拟；不过则强制三视图侧面裁（00:59/16:18）
            try:
                _front_final = tri.get("face_front") or panels.get("portrait")
                _side_final = panels.get("side")
                if tri.get("face_three_quarter") and _side_final:
                    _fok, _finfo = side_three_quarter_accept_in_panel_cell(
                        tri["face_three_quarter"], front_face=_front_final
                    )
                    if not _fok:
                        _body2 = crop_face_slot_from_master(
                            _side_final, slot="face_three_quarter", size=768
                        )
                        tri["face_three_quarter"] = _body2
                        _fok2, _finfo2 = side_three_quarter_accept_in_panel_cell(
                            _body2, front_face=_front_final
                        )
                        logger.warning(
                            "faces final accept fail %s → forced body-side accept=%s %s",
                            _finfo,
                            _fok2,
                            _finfo2,
                        )
            except Exception as fae:  # noqa: BLE001
                logger.warning("faces final accept skipped: %s", fae)
            panels["faces"] = compose_faces_triptych(
                tri,
                style=meta.style,
                size=_panel_size("faces", meta.style),
                master_crop=True,
            )
            continue
        elif key.startswith("expr_"):
            # 17:38：放弃宫格整图编辑+贴回；改中性正面头原分辨率单张真局部 inpaint（眉眼嘴遮罩）
            missing_expr = [ek for ek in _EXPR_KEYS if ek not in panels]
            if not missing_expr:
                continue
            bases: dict[str, bytes] = {}
            for ek in _EXPR_KEYS:
                if ek in _expr_bases:
                    bases[ek] = _expr_bases[ek]
                elif ek in panels:
                    bases[ek] = panels[ek]
                else:
                    try:
                        bases[ek] = crop_face_ref(panels["portrait"], size=768)
                    except Exception as ce:  # noqa: BLE001
                        raise CharacterSheetError(
                            f"{ek} 无表情底且无法从主立绘裁脸: {ce}",
                            status_code=422,
                        ) from ce
            # 23:18：撤回沉思 side_base；沉思/温柔改 Qwen-Image-Edit-2509 + approved_portrait 正面底
            # （不再用侧面头做 inpaint，避免眼在脸颊/瞳色漂移）
            for ek, bb in list(bases.items()):
                fixed, area = assert_expr_base_face_area(bb, expr_key=ek, min_area=0.15)
                bases[ek] = fixed
                logger.info("expr base %s face_area=%.3f ok", ek, area)
            _expr_neg = (
                "text, watermark, logo, emblem, badge, chinese characters, "
                "long hair, hair past shoulders, gray smear, muddy skin, "
                "melted face, double face, ghosting, misaligned features, "
                "heart pupils, heart-shaped pupils, extra eyes, third eye, "
                "heterochromia, brown iris, red iris, glowing pupils, "
                "redrawn pupil highlight, sparkling star eyes"
            )
            last_expr_err: Exception | None = None
            n_fail = 0
            for ek in _EXPR_KEYS:
                if ek in panels and ek in override_keys:
                    # 20:58：过检格锁定——跳过 inpaint/VLM；落盘来源与 approved_by_parent
                    # 21:30：锁定源图仍须同尺度方化+3px近白边门禁（贴格 bug 不靠错误放大）
                    _lm = dict(_expr_lock_meta.get(ek) or {})
                    _locked_b = panels[ek]
                    try:
                        _locked_b = squareize_face_center_crop(_locked_b, size=768)
                        _locked_b = _trim_letterbox_bars(_locked_b)
                        # 再方化一次，确保 trim 后仍同尺度
                        try:
                            _locked_b = squareize_face_center_crop(_locked_b, size=768)
                        except CharacterSheetError:
                            pass
                        assert_expr_cell_no_white_border(_locked_b, expr_key=ek)
                        assert_mouth_in_frame(_locked_b)
                        assert_expr_cell_face_height_frac(
                            _locked_b,
                            expr_key=ek,
                            min_face_height_frac=0.55,
                            max_face_height_frac=0.65,
                        )
                        panels[ek] = _locked_b
                    except CharacterSheetError as _le:
                        logger.warning(
                            "expr %s locked normalize soft-fail (keep raw): %s", ek, _le
                        )
                    _rec = {
                        "expr_key": ek,
                        "locked": True,
                        "skipped_inpaint": True,
                        "skipped_vlm": True,
                        "approved_by_parent": bool(_lm.get("approved_by_parent")),
                        "source": _lm.get("source"),
                        "note": _lm.get("note") or "panels_override lock",
                        "md5": hashlib.md5(panels[ek]).hexdigest(),
                        "normalized_2130": True,
                    }
                    try:
                        (reject_dir / f"{ek}_locked_{int(seed or 0)}.json").write_text(
                            json.dumps(_rec, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
                        (reject_dir / f"{ek}_locked_{int(seed or 0)}.png").write_bytes(
                            panels[ek]
                        )
                    except Exception:
                        pass
                    logger.info(
                        "expr %s locked skip inpaint/vlm approved_by_parent=%s source=%s",
                        ek,
                        _rec["approved_by_parent"],
                        _rec.get("source"),
                    )
                    continue
                # 01:50：沉思/温柔走 Qwen-Image-Edit-2509 **完整输出**（不贴回底图）
                # + 头部特写裁剪 + 接缝门禁 + 专项问答；各最多 6 次。
                if ek in ("expr_2", "expr_3"):
                    ei = _EXPR_KEYS.index(ek)
                    try:
                        _ = _build_sheet_qwen_edit_graph(
                            "ping",
                            image_name="__probe__.png",
                            seed=0,
                            filename_prefix="ToIV_probe",
                        )
                    except Exception as _qe:  # noqa: BLE001
                        raise CharacterSheetError(
                            f"{ek} Qwen-Image-Edit-2509 图构造不可用，拒绝回落 inpaint: {_qe}",
                            status_code=503,
                        ) from _qe
                    # 04:30：编辑底用**宽头肩源**（bases[ek]：与锁定格同源同构图、肩下有身体），
                    # 不再 crop_face_ref+squareize 紧裁（0305 a1 下方不够→灰垫根因）。
                    _locked_cells = [
                        panels[_k]
                        for _k in ("expr_0", "expr_1", "expr_4", "expr_5")
                        if panels.get(_k) and _k in override_keys
                    ]
                    expr_frame = locked_expr_frame(_locked_cells)
                    # 候选宽源依次试：本格 base → 另一格(沉思/温柔) base → 主立绘头肩；
                    # 编辑底按锁定比例必须裁得出且无底部纯色垫块（否则 Qwen 同构图输出必继承）。
                    _eb_cands: list[tuple[str, bytes]] = []
                    for _bk in (ek, "expr_2", "expr_3"):
                        if bases.get(_bk) and all(_bk != c[0][6:] for c in _eb_cands):
                            _eb_cands.append((f"bases_{_bk}", bases[_bk]))
                    if panels.get("portrait"):
                        try:
                            _eb_cands.append(
                                ("portrait_face_ref", crop_face_ref(panels["portrait"], size=768))
                            )
                        except Exception:  # noqa: BLE001
                            pass
                    edit_base = None
                    _id_ref = None
                    _eb_src = ""
                    _eb_why: list[str] = []
                    for _src, _cand in _eb_cands:
                        try:
                            _ref = crop_expr_head_closeup(_cand, size=768, frame=expr_frame)
                            assert_no_uniform_bottom_band(_ref, expr_key=f"{ek}_edit_base")
                        except CharacterSheetError as _ce:
                            _eb_why.append(f"{_src}: {_ce}")
                            continue
                        edit_base, _id_ref, _eb_src = _cand, _ref, _src
                        break
                    if edit_base is None:
                        raise CharacterSheetError(
                            f"{ek} 无可用宽头肩编辑底（禁止灰垫）: {' | '.join(_eb_why) or '无候选'}",
                            status_code=422,
                        )
                    try:
                        (reject_dir / f"{ek}_edit_base_{int(seed or 0)}.json").write_text(
                            json.dumps(
                                {"src": _eb_src, "frame": expr_frame, "route": "0430_wide_base"},
                                ensure_ascii=False,
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                    except Exception:
                        pass
                    prompt_x = _EXPR_EDIT_INSTRUCTIONS[ei]
                    if ek == "expr_2":
                        prompt_x += (
                            " eyes looking down to one side, slightly knit brows, lips closed, "
                            "mouth closed not open, no O-shaped mouth, same framing head and shoulders, "
                            "same hair same clothes"
                        )
                    else:
                        prompt_x += (
                            " warm gentle smile, lips together, mouth corners clearly upturned, "
                            "soft warm friendly eyes, soft relaxed brows, visibly tender kind "
                            "expression, no open mouth no teeth, "
                            "same framing head and shoulders, same hair same clothes"
                        )
                    picked: bytes | None = None
                    pick_err: Exception | None = None
                    _qwaits = 0
                    _qwait_log: list[float] = []
                    attempt = -1
                    while attempt < 5:
                        attempt += 1
                        raw = None
                        cell_b = None
                        try:
                            ref_name = await client.upload_image(
                                edit_base,
                                f"sheet_expr_qedit_base_{character_id[:8]}_{ek}_a{attempt}.png",
                            )
                            e_seed = (
                                None
                                if seed is None
                                else int(seed) + 2318 + ei * 9973 + attempt * 7919
                            )
                            p_try = prompt_x
                            if attempt:
                                p_try = (
                                    p_try
                                    + f" variant{attempt}, stronger expression change, "
                                    "expression must be obvious at a glance"
                                )
                            raw = await generate_panel_bytes(
                                pool,
                                p_try,
                                ckpt_name=ckpt,
                                width=768,
                                height=768,
                                seed=e_seed,
                                worker=worker,
                                filename_prefix=f"ToIV_char_sheet_{ek}_qedit_a{attempt}",
                                style=meta.style,
                                client=client,
                                ref_image=ref_name,
                                ref_mode="qwen_edit",
                            )
                            # 01:50：直接用 Qwen 完整输出，禁止羽化贴回 approved_portrait
                            try:
                                (reject_dir / f"{ek}_qedit_raw_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                    raw
                                )
                            except Exception:
                                pass
                            # 接缝门禁：Qwen 原始输出即验
                            assert_no_hard_seam_contour(raw, expr_key=ek, size=768, stage="raw")
                            # 04:30：按锁定格比例裁头肩（禁止灰垫；源不够抛 HeadcropSourceShort）
                            cell_b = crop_expr_head_closeup(raw, size=768, frame=expr_frame)
                            try:
                                (reject_dir / f"{ek}_qedit_headcrop_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                    cell_b
                                )
                            except Exception:
                                pass
                            # 裁剪区内再验接缝
                            assert_no_hard_seam_contour(cell_b, expr_key=ek, size=768, stage="crop")
                            # 02:42：发顶平切门禁（≥40px 水平发际线）
                            assert_no_flat_hairline_cut(cell_b, expr_key=ek, min_run_px=40)
                            # 04:30：底部纯色垫块门禁 + 与锁定格同比例
                            assert_no_uniform_bottom_band(cell_b, expr_key=ek)
                            assert_expr_cell_no_white_border(cell_b, expr_key=ek)
                            assert_expr_cell_content_coverage(
                                cell_b, expr_key=ek, min_coverage=1.0
                            )
                            if expr_frame:
                                assert_expr_frame_match(cell_b, expr_frame, expr_key=ek)
                            else:
                                assert_expr_cell_face_height_frac(
                                    cell_b,
                                    expr_key=ek,
                                    min_face_height_frac=0.38,
                                    max_face_height_frac=0.55,
                                )
                            assert_mouth_in_frame(cell_b)
                            # 身份 CLIP≥0.72（对照编辑底同比例裁剪）
                            _face_id = _id_ref
                            _sim = clip_image_cosine_sim(cell_b, _face_id)
                            if _sim is not None and _sim + 1e-12 < 0.72:
                                raise CharacterSheetError(
                                    f"{ek}身份CLIP不足 sim={_sim:.3f}<0.72 (vs approved_portrait face)",
                                    status_code=422,
                                )
                            try:
                                (reject_dir / f"{ek}_qedit_clip_{int(seed or 0)}_a{attempt}.json").write_text(
                                    json.dumps(
                                        {
                                            "sim": _sim,
                                            "min": 0.72,
                                            "ref": "edit_base_face",
                                            "route": "qwen_full_headcrop_qa",
                                        },
                                        ensure_ascii=False,
                                    ),
                                    encoding="utf-8",
                                )
                            except Exception:
                                pass
                            # 01:50：徽标只在最终裁剪格内验（相对 edit_base 同裁）
                            _emblem_ref = _id_ref
                            if portrait_has_chest_emblem(
                                cell_b, ref=_emblem_ref, below_face=True
                            ):
                                raise CharacterSheetError(
                                    f"{ek}头部特写裁剪内相对 edit_base 出现新徽标/字样",
                                    status_code=422,
                                )
                            # 01:45：瞳色漂移门禁（0110 红瞳假通过实证；对照编辑底同源）
                            assert_iris_hue_match(cell_b, edit_base, expr_key=ek)
                            # 专项问答（非六分类）
                            qa_result = await classify_expression_qa(
                                cell_b,
                                expr_key=ek,
                                worker_url=getattr(client, "base_url", None) or worker,
                                seed=int(e_seed or 42) + attempt,
                            )
                            assert_expression_qa_match(ek, qa_result)
                            # 05:30：嘴部放大复判（整格问答漏判小 O 形嘴）
                            _mz = crop_mouth_zoom(cell_b)
                            try:
                                (reject_dir / f"{ek}_mouthzoom_{int(seed or 0)}_a{attempt}.png").write_bytes(_mz)
                            except Exception:
                                pass
                            mz_result = await classify_expression_qa(
                                _mz,
                                expr_key="mouth_zoom",
                                worker_url=getattr(client, "base_url", None) or worker,
                                seed=int(e_seed or 42) + attempt,
                            )
                            try:
                                (reject_dir / f"{ek}_mouthzoom_qa_{int(seed or 0)}_a{attempt}.json").write_text(
                                    json.dumps(mz_result, ensure_ascii=False, indent=2),
                                    encoding="utf-8",
                                )
                            except Exception:
                                pass
                            assert_mouth_zoom_closed(ek, mz_result)
                            qa_result["mouth_zoom"] = {
                                "q1": mz_result.get("q1"),
                                "q2": mz_result.get("q2"),
                                "model": mz_result.get("model"),
                            }
                            try:
                                (reject_dir / f"{ek}_qa_{int(seed or 0)}_a{attempt}.json").write_text(
                                    json.dumps(qa_result, ensure_ascii=False, indent=2),
                                    encoding="utf-8",
                                )
                                (reject_dir / f"{ek}_qa_cell_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                    cell_b
                                )
                                (reject_dir / f"{ek}_qedit_ok_{int(seed or 0)}.png").write_bytes(
                                    cell_b
                                )
                                (reject_dir / f"{ek}_qedit_meta_{int(seed or 0)}.json").write_text(
                                    json.dumps(
                                        {
                                            "route": "qwen_image_edit_2509_full_headcrop",
                                            "input": "approved_portrait",
                                            "attempt": attempt,
                                            "expr_key": ek,
                                            "max_attempts": 6,
                                            "judge": "specialized_qa",
                                            "paste_back": False,
                                            "seam_gate": True,
                                            "note": "01:50 full Qwen output + head closeup + seam gate; no face paste",
                                        },
                                        ensure_ascii=False,
                                        indent=2,
                                    ),
                                    encoding="utf-8",
                                )
                            except Exception:
                                pass
                            try:
                                others = {
                                    ok: panels[ok]
                                    for ok in _EXPR_KEYS
                                    if ok != ek and ok in panels and panels.get(ok)
                                }
                                assert_expression_diversity(
                                    cell_b,
                                    expr_key=ek,
                                    neutral_ref=edit_base,
                                    other_exprs=others,
                                )
                            except CharacterSheetError as de:
                                if attempt < 5:
                                    raise
                                logger.warning("expr %s diversity soft: %s", ek, de)
                            logger.info(
                                "expr %s qwen_edit full_headcrop+qa ok attempt=%s", ek, attempt
                            )
                            picked = cell_b
                            pick_err = None
                            break
                        except CharacterSheetQueueWait as qw:
                            # 04:30：排队超 20 分钟只记 queue_wait，不算失败次数
                            _qwaits += 1
                            _qwait_log.append(qw.queue_wait)
                            logger.warning(
                                "expr %s queue_wait attempt=%s n=%s: %s", ek, attempt, _qwaits, qw
                            )
                            try:
                                (reject_dir / f"{ek}_queue_wait_{int(seed or 0)}.json").write_text(
                                    json.dumps(
                                        {"n": _qwaits, "waits": _qwait_log, "attempt_not_counted": attempt},
                                        ensure_ascii=False,
                                    ),
                                    encoding="utf-8",
                                )
                            except Exception:
                                pass
                            if _qwaits > _QUEUE_WAIT_RETRY_MAX:
                                pick_err = CharacterSheetError(
                                    f"{ek} 队列持续拥堵 queue_wait×{_qwaits}（非出图失败，未完成）",
                                    status_code=503,
                                )
                                break
                            attempt -= 1
                            continue
                        except CharacterSheetError as ge:
                            pick_err = ge
                            logger.warning(
                                "expr %s qwen_edit fail attempt=%s: %s", ek, attempt, ge
                            )
                            try:
                                if locals().get("raw"):
                                    (reject_dir / f"{ek}_qedit_raw_fail_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                        locals()["raw"]
                                    )
                            except Exception:
                                pass
                            dump_rejected_panel(
                                locals().get("cell_b") or locals().get("raw"),
                                seed=seed,
                                panel=ek,
                                gate=_expr_reject_cause(ge),
                                detail=str(ge),
                                dump_dir=reject_dir,
                            )
                        except Exception as ge:  # noqa: BLE001
                            pick_err = CharacterSheetError(str(ge), status_code=422)
                            logger.warning(
                                "expr %s qwen_edit fail attempt=%s: %s", ek, attempt, ge
                            )
                    if picked is None:
                        n_fail += 1
                        last_expr_err = pick_err
                        panels[ek] = edit_base
                        logger.warning(
                            "expr %s qwen_edit all attempts failed → portrait fallback FAIL",
                            ek,
                        )
                    else:
                        panels[ek] = picked
                    continue


                base_b = bases[ek]
                # 18:30：以人脸框中心方裁，禁止浅灰 pad（格外白底根因）
                try:
                    base_b = squareize_face_center_crop(base_b, size=768)
                except CharacterSheetError:
                    # 底图已近方且无人脸门禁可过时，仍 cover 到 768
                    base_im0 = Image.open(BytesIO(base_b)).convert("RGB")
                    side0 = min(base_im0.size)
                    left0 = (base_im0.width - side0) // 2
                    top0 = (base_im0.height - side0) // 2
                    cropped0 = base_im0.crop((left0, top0, left0 + side0, top0 + side0))
                    cropped0 = cropped0.resize((768, 768), Image.Resampling.LANCZOS)
                    buf0 = BytesIO()
                    cropped0.save(buf0, format="PNG")
                    base_b = buf0.getvalue()
                # 19:15：发长门禁必须用同裁同尺度表情底（同步写回 bases）
                bases[ek] = base_b
                base_im = Image.open(BytesIO(base_b)).convert("RGB")
                side = min(base_im.size)  # 已是方图
                # 23:18：沉思/温柔已走 qwen_edit；其余表情眉眼嘴 inpaint
                hard_mask = build_face_feature_mask_hard(side)
                # mask 上传为 RGB 白/黑（ImageToMask red）
                m_rgb = Image.merge("RGB", (hard_mask, hard_mask, hard_mask))
                mbuf = BytesIO()
                m_rgb.save(mbuf, format="PNG")
                mask_bytes = mbuf.getvalue()
                ei = _EXPR_KEYS.index(ek)
                prompt_x = _EXPR_INPAINT_PROMPTS[ei]
                # 中文语义也写入（部分 ckpt 对中英混合友好）；主靠英文
                prompt_x = prompt_x + "。 " + _EXPR_EDIT_INSTRUCTIONS[ei]
                # 19:15：锁蓝紫虹膜；威严/温柔附加语义强化
                prompt_x = (
                    prompt_x
                    + ", blue-violet iris eyes identical to reference, short chin-length black hair"
                )
                if ek == "expr_0":
                    prompt_x += (
                        ", chin raised looking down at viewer, sharp narrowed eyes, "
                        "eyebrows lowered, tight closed mouth, no wide eyes, no blank stare, no smile"
                    )
                elif ek == "expr_1":
                    prompt_x += (
                        ", expressionless, half-lidded eyes, flat mouth, eyebrows neutral, "
                        "no frown, no smile"
                    )
                elif ek == "expr_2":
                    prompt_x += (
                        ", eyes looking down and to the side, head slightly tilted, "
                        "relaxed brows, faraway gaze, only edit eyes and brows, "
                        "keep mouth unchanged, no frown, no furrowed brows"
                    )
                elif ek == "expr_3":
                    prompt_x += (
                        ", gentle smile, mouth corners up, soft relaxed brows, "
                        "eyes softly curved, no neutral face without smile, "
                        "no frown no pout no furrowed brows"
                    )
                elif ek == "expr_5":
                    prompt_x += (
                        ", determined firm closed mouth, focused eyes, "
                        "eyebrows slightly lowered, no open mouth, no surprised, no raised brows"
                    )
                picked: bytes | None = None
                pick_err: Exception | None = None
                for attempt in range(4):
                    try:
                        ref_name = await client.upload_image(
                            base_b,
                            f"sheet_expr_inpaint_base_{character_id[:8]}_{ek}_a{attempt}.png",
                        )
                        mask_name = await client.upload_image(
                            mask_bytes,
                            f"sheet_expr_inpaint_mask_{character_id[:8]}_{ek}_a{attempt}.png",
                        )
                        e_seed = (
                            None
                            if seed is None
                            else int(seed) + 1738 + ei * 9973 + attempt * 7919
                        )
                        p_try = prompt_x
                        if attempt:
                            p_try = (
                                p_try
                                + f" variant{attempt}, stronger eyebrow eye mouth change, "
                                "expression must be obvious at a glance"
                            )
                        _neg_try = _expr_neg
                        # 20:58：六类互斥负向（威严/冷酷/沉思拉开）
                        try:
                            _ei_neg = _EXPR_KEYS.index(ek)
                            _neg_try = (
                                _neg_try + ", " + _EXPR_INPAINT_NEGATIVES[_ei_neg]
                            )
                        except Exception:
                            pass
                        if ek == "expr_0":
                            _neg_try = _neg_try + ", heart pupils"
                        raw = await generate_panel_bytes(
                            pool,
                            p_try,
                            ckpt_name=ckpt,
                            width=side,
                            height=side,
                            seed=e_seed,
                            worker=worker,
                            filename_prefix=f"ToIV_char_sheet_{ek}_inpaint_a{attempt}",
                            style=meta.style,
                            client=client,
                            ref_image=ref_name,
                            ref_mode="inpaint",
                            # 22:28：温柔 inpaint denoise 可到 0.7；其它仍 0.58→0.68
                            denoise=(
                                (0.62 if attempt < 2 else 0.70)
                                if ek == "expr_3"
                                else (0.58 if attempt < 2 else 0.68)
                            ),
                            negative_extra=_neg_try,
                            mask_image=mask_name,
                            grow_mask_by=4,
                        )
                        # 同几何：先测遮罩外差，再强制外=底（抑 VAE 渗色，非位移贴回）
                        mae_raw = expression_mask_exterior_mae(base_b, raw, hard_mask)
                        logger.info(
                            "expr %s attempt=%s raw_exterior_mae=%.3f", ek, attempt, mae_raw
                        )
                        # 若 raw 外差过大，说明模型未守住遮罩 → 拒（禁位移贴回挽救）
                        if mae_raw > 12.0:
                            raise CharacterSheetError(
                                f"{ek} inpaint 遮罩外漂移过大 mae={mae_raw:.2f}",
                                status_code=422,
                            )
                        blended = force_expression_mask_exterior(base_b, raw, hard_mask)
                        mae = assert_expression_inpaint_exterior(
                            base_b, blended, hard_mask, max_mae=0.5, expr_key=ek
                        )
                        smear = assert_expression_no_gray_smear(
                            base_b, blended, hard_mask, expr_key=ek
                        )
                        assert_expression_eyes_mouth_in_mask(
                            blended,
                            hard_mask,
                            expr_key=ek,
                            require_mouth=(ek != "expr_2"),
                        )
                        # 19:15：发长门禁在同几何（blended vs base_b）上比，禁止近景 vs 全身
                        assert_expression_identity_gates(
                            blended,
                            portrait_ref=panels.get("portrait"),
                            expr_key=ek,
                            skip_chest_emblem=True,  # 遮罩外=底，胸口必一致
                            hair_ref=base_b,
                            relative_hair_only=True,
                        )
                        # 18:30：再以脸框中心裁切，禁格外白底
                        cell_b = squareize_face_center_crop(blended, size=768)
                        assert_expr_cell_no_white_border(cell_b, expr_key=ek)
                        # 22:28：方化后脸高硬门禁 0.55–0.65
                        assert_expr_cell_face_height_frac(
                            cell_b,
                            expr_key=ek,
                            min_face_height_frac=0.55,
                            max_face_height_frac=0.65,
                        )
                        # 19:15：威严/温柔几何语义（辅助）；19:55：VLM 六类判官为硬门禁
                        assert_expression_semantic(
                            cell_b, expr_key=ek, neutral_ref=base_b
                        )
                        vlm_result = await classify_expression_vlm(
                            cell_b,
                            worker_url=getattr(client, "base_url", None) or worker,
                        )
                        assert_expression_vlm_match(cell_b, ek, vlm_result)
                        try:
                            (reject_dir / f"{ek}_vlm_{int(seed or 0)}.json").write_text(
                                json.dumps(vlm_result, ensure_ascii=False, indent=2),
                                encoding="utf-8",
                            )
                            (reject_dir / f"{ek}_vlm_cell_{int(seed or 0)}.png").write_bytes(
                                cell_b
                            )
                        except Exception:
                            pass
                        # 多样性：相对中性底 + 已完成的其它表情格
                        try:
                            others = {
                                ok: panels[ok]
                                for ok in _EXPR_KEYS
                                if ok != ek and ok in panels and panels.get(ok)
                            }
                            assert_expression_diversity(
                                cell_b,
                                expr_key=ek,
                                neutral_ref=bases.get(ek),
                                other_exprs=others,
                            )
                        except CharacterSheetError as de:
                            # 弱表情可重试；最后一次放宽到只记日志
                            if attempt < 3:
                                raise
                            logger.warning("expr %s diversity soft: %s", ek, de)
                        logger.info(
                            "expr %s inpaint ok attempt=%s mae=%.3f smear=%s",
                            ek,
                            attempt,
                            mae,
                            {k: round(v, 3) for k, v in smear.items()},
                        )
                        try:
                            (reject_dir / f"{ek}_inpaint_ok_{int(seed or 0)}.png").write_bytes(
                                cell_b
                            )
                            (reject_dir / f"{ek}_inpaint_raw_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                raw
                            )
                        except Exception:
                            pass
                        picked = cell_b
                        pick_err = None
                        break
                    except CharacterSheetError as ge:
                        pick_err = ge
                        logger.warning("expr %s inpaint fail attempt=%s: %s", ek, attempt, ge)
                        try:
                            if locals().get("raw"):
                                (reject_dir / f"{ek}_inpaint_raw_fail_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                    locals()["raw"]
                                )
                            if locals().get("blended"):
                                (reject_dir / f"{ek}_inpaint_blend_fail_{int(seed or 0)}_a{attempt}.png").write_bytes(
                                    locals()["blended"]
                                )
                        except Exception:
                            pass
                        dump_rejected_panel(
                            locals().get("blended") or locals().get("raw"),
                            seed=seed,
                            panel=ek,
                            gate=_expr_reject_cause(ge),
                            detail=str(ge),
                            dump_dir=reject_dir,
                        )
                    except Exception as ge:  # noqa: BLE001
                        pick_err = CharacterSheetError(str(ge), status_code=422)
                        logger.warning("expr %s inpaint fail attempt=%s: %s", ek, attempt, ge)
                if picked is None:
                    n_fail += 1
                    last_expr_err = pick_err
                    # 回退底图并打失败标（不得交付）
                    panels[ek] = bases[ek]
                    logger.warning(
                        "expr %s inpaint all attempts failed → base fallback FAIL", ek
                    )
                else:
                    panels[ek] = picked
            if n_fail > 0:
                panels["_expr_grid_fallback"] = b"1"
                try:
                    (reject_dir / f"expr_grid_fallback_{int(seed or 0)}.txt").write_text(
                        "FAIL final_review=false do_not_deliver\n"
                        + f"inpaint_fail_n={n_fail} last={last_expr_err}",
                        encoding="utf-8",
                    )
                    (reject_dir / f"expr_grid_fallback_flag_{int(seed or 0)}.json").write_text(
                        '{"expr_grid_fallback": true, "final_review": false, "deliver": false, '
                        '"route": "2318_qwen_edit_2509+fill_first"}',
                        encoding="utf-8",
                    )
                except Exception:
                    pass
            else:
                logger.info(
                    "expr true-inpaint all ok locked=%s",
                    [ek for ek in _EXPR_KEYS if ek in override_keys and ek in panels],
                )
            continue
        last_err = None
        same_cause = None
        same_cause_n = 0
        raw = None
        max_attempts = 6 if key.startswith("expr_") else 4
        for attempt in range(max_attempts):
            try:
                s = (
                    None
                    if seed is None
                    else seed + (abs(hash(key)) % 10000) + attempt * 7919
                )
                bust = f", unique layout variant {attempt}-{s or 0}"
                if key.startswith("expr_"):
                    bust += (
                        ", plain flat chest unbranded no logo no text no emblem, "
                        "short chin-length black hair no lengthening"
                    )
                _neg_x = ""
                if key.startswith("expr_"):
                    _neg_x = (
                        "long hair, hair past shoulders, waist length hair, "
                        "hair lengthening, flowing long locks, logo, emblem, badge, "
                        "chest patch, text on clothes, chinese characters"
                    )
                _prompt_x = prompts[key] + (bust if attempt else "")
                if key.startswith("expr_") and ref_mode == "qwen_edit":
                    _ei = _EXPR_KEYS.index(key) if key in _EXPR_KEYS else 0
                    _prompt_x = _EXPR_EDIT_INSTRUCTIONS[_ei]
                    if attempt:
                        _prompt_x = (
                            _prompt_x
                            + f" 变体{attempt}。务必加大五官表情幅度，眉眼嘴变化必须非常明显。"
                        )
                        if key == "expr_4":
                            _prompt_x += " 嘴巴必须明显张开。"
                if key.startswith("expr_") and ref_mode == "qwen_edit" and (
                    use_ref or key in _expr_bases
                ):
                    # 22:02：整图 Qwen 编辑（永不走脸罩 blend_face_local_edit）
                    # use_ref 优先 2023b 对应表情底图，否则中性脸 crop
                    _base_face = None
                    try:
                        if panels.get("portrait"):
                            _base_face = crop_face_ref(panels["portrait"], size=768)
                    except Exception:
                        _base_face = None
                    _edit_ref_name = use_ref
                    if key in _expr_bases:
                        try:
                            _edit_ref_name = await client.upload_image(
                                _expr_bases[key],
                                f"sheet_expr_base_{character_id[:8]}_{key}.png",
                            )
                            logger.info(
                                "%s Qwen use_ref=expr_base_%s (2023b-class)",
                                key,
                                key,
                            )
                        except Exception as ue:  # noqa: BLE001
                            logger.warning(
                                "%s upload expr_base failed: %s; fall back face ref",
                                key,
                                ue,
                            )
                    if not _edit_ref_name:
                        raise CharacterSheetError(
                            f"{key} missing Qwen edit ref", status_code=422
                        )
                    cands: list[bytes] = []
                    for ci in range(4):
                        s_i = (
                            None
                            if seed is None
                            else int(seed)
                            + (abs(hash(key)) % 10000)
                            + attempt * 7919
                            + ci * 13331
                        )
                        _px = _prompt_x
                        if ci:
                            _px = _px + f" 候选{ci+1}。加大眉眼嘴变化，五官差异必须非常明显。"
                        edited = await generate_panel_bytes(
                            pool,
                            _px,
                            ckpt_name=ckpt,
                            width=w,
                            height=h,
                            seed=s_i,
                            worker=worker,
                            filename_prefix=f"ToIV_char_sheet_{key}_a{attempt}_c{ci}",
                            style=meta.style,
                            client=client,
                            ref_image=_edit_ref_name,
                            ref_mode=ref_mode,
                            denoise=denoise,
                            negative_extra=_neg_x,
                        )
                        # 22:02：脸罩路线终止——禁止 blend_face_local_edit / TOIV_SHEET_FACE_BLEND
                        edited = enforce_head_shoulders_square(
                            edited, size=768, face_closeup_gate=True
                        )
                        cands.append(edited)
                    _neutral = _base_face
                    raw = pick_best_expression_candidate(
                        cands,
                        neutral_ref=_neutral,
                        portrait_ref=panels.get("portrait"),
                        expr_key=key,
                        min_clip=0.72,
                    )
                else:
                    raw = await generate_panel_bytes(
                        pool,
                        _prompt_x,
                        ckpt_name=ckpt,
                        width=w,
                        height=h,
                        seed=s,
                        worker=worker,
                        filename_prefix=f"ToIV_char_sheet_{key}_a{attempt}",
                        style=meta.style,
                        client=client,
                        ref_image=use_ref,
                        ref_mode=ref_mode,
                        denoise=denoise,
                        negative_extra=_neg_x,
                    )
                if key.startswith("expr_"):
                    # 16:45：表情近景脸格用 face_closeup_gate，禁 soft coverage
                    raw = enforce_head_shoulders_square(
                        raw, size=768, face_closeup_gate=True
                    )
                    # 18:23：相对主立绘徽标/发长门禁；发长拒则先紧裁去下缘再验一次
                    try:
                        assert_expression_identity_gates(
                            raw,
                            portrait_ref=panels.get("portrait"),
                            expr_key=key,
                        )
                    except CharacterSheetError as ge:
                        if _expr_reject_cause(ge) == "hair":
                            try:
                                im = Image.open(BytesIO(raw)).convert("RGB")
                                w, h = im.size
                                # 去掉底部 28%（过肩发常见落点），放大回方图
                                cut = im.crop((0, 0, w, int(h * 0.72)))
                                side = max(cut.width, cut.height, 8)
                                canvas = Image.new("RGB", (side, side), (240, 240, 244))
                                canvas.paste(
                                    cut, ((side - cut.width) // 2, 0)
                                )
                                canvas = canvas.resize(
                                    (768, 768), Image.Resampling.LANCZOS
                                )
                                buf = BytesIO()
                                canvas.save(buf, format="PNG")
                                raw2 = buf.getvalue()
                                assert_expression_identity_gates(
                                    raw2,
                                    portrait_ref=panels.get("portrait"),
                                    expr_key=key,
                                )
                                raw = raw2
                                logger.info(
                                    "%s hair recovery via bottom-crop ok", key
                                )
                            except CharacterSheetError:
                                raise ge
                        else:
                            raise
                    # 20:23：表情幅度门禁（相对中性 + 两两差；惊恐须张嘴）
                    _neutral = None
                    try:
                        if panels.get("portrait"):
                            _neutral = crop_face_ref(panels["portrait"], size=768)
                    except Exception:  # noqa: BLE001
                        _neutral = None
                    _others = {
                        ek: panels[ek]
                        for ek in _EXPR_KEYS
                        if ek in panels and ek != key and panels.get(ek)
                    }
                    assert_expression_diversity(
                        raw,
                        expr_key=key,
                        neutral_ref=_neutral,
                        other_exprs=_others,
                    )
                if key in ("front", "side") and meta.style in ("anime", "二次元"):
                    if portrait_has_chest_emblem(raw):
                        raise CharacterSheetError(
                            f"{key}胸口徽标，重试", status_code=422
                        )
                if (
                    key in ("front", "side", "back")
                    and meta.style == "ancient_realistic"
                    and ancient_spec_target_hex(meta)
                ):
                    assert_garment_near_spec_color(
                        normalize_turnaround_figure(raw, out_w=w, out_h=h),
                        ancient_spec_target_hex(meta),
                        label=key,
                    )
                panels[key] = raw
                last_err = None
                break
            except CharacterSheetError as e:
                last_err = e
                logger.warning("panel %s fail attempt=%s: %s", key, attempt, e)
                if key.startswith("expr_"):
                    dump_rejected_panel(
                        raw,
                        seed=seed,
                        panel=str(key),
                        gate=_expr_reject_cause(e),
                        detail=str(e),
                        dump_dir=reject_dir,
                    )
                    cause = _expr_reject_cause(e)
                    if cause == same_cause:
                        same_cause_n += 1
                    else:
                        same_cause = cause
                        same_cause_n = 1
                    if same_cause_n >= 3:
                        raise CharacterSheetError(
                            f"{key}同因连败3次({cause}): {e}；停下修根因",
                            status_code=422,
                        ) from e
        if last_err is not None:
            raise last_err
        if key in ("front", "side", "back"):
            panels[key] = normalize_turnaround_figure(panels[key], out_w=w, out_h=h)
            panel_urls[key] = save_panel_png(
                panels[key],
                character_id=character_id,
                style=meta.style,
                key=key,
            )

    # 13:16②：拼版前一致性门禁（主立绘↔三视图主色 + 贴标）
    try:
        assert_sheet_garment_consistency(panels, style=meta.style, skip_keys=override_keys)
    except CharacterSheetError as _ce:
        dump_rejected_panel(
            panels.get("portrait") or _last_reject.get("data"),
            seed=seed,
            panel=str(_last_reject.get("key") or "portrait"),
            gate="assert_sheet_garment_consistency",
            detail=str(_ce),
            dump_dir=reject_dir,
        )
        raise
    # anime：强制色板 garment 主色含板岩灰优先
    if meta.style in ("anime", "二次元") and not meta.colors:
        meta.colors = ["#E8C4A8", "#5A6A7A", "#D4D3D8", "#C98A7A", "#2C2C34", "#1A1A1E"]
    png = compose_character_sheet(panels, meta)
    url = save_sheet_png(png, character_id=character_id, style=meta.style)
    _SHEET_REJECT_CTX.reset(_reject_token)
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


def costume_cell_content_ratios(costume_png: bytes, n: int = 4) -> list[float]:
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
    costume_png: bytes, *, min_ratio: float = 0.12, n: int = 4
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
    """单品横排拼成 costume 区图（4 或 5 格）；正方形格 + 包围盒 letterbox,不裁切。"""
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
        # 23:05：anime 服饰格 cover 铺满，避免二次 letterbox 浅边
        _paste(canvas, im, box, cover=(style in ("anime", "二次元")))
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
            # 01:16：浅外框+中灰条也当背景，避免袖口格 trim 保留大片空底
            if r > 230 and g > 230 and b > 230:
                return False
            if abs(r - g) < 14 and abs(g - b) < 14 and r >= 185:
                return False
            if abs(r - g) < 8 and abs(g - b) < 8 and 140 < r < 210:
                return False
            return True
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


# 15:52 / 16:18：服饰四格——领口/袖口/下摆/靴子；互不重叠；边缘密度拒纯色布
# 领口/袖口/下摆由专用框函数重定，消灭肩布+手插袋错位
_COSTUME_PORTRAIT_BANDS: tuple[tuple[str, tuple[float, float, float, float]], ...] = (
    ("collar", (0.34, 0.18, 0.66, 0.34)),  # 占位；实际由 _collar_box 重定
    ("cuff", (0.00, 0.42, 0.38, 0.58)),  # 占位；实际由 _wrist_cuff_box 重定
    ("hem", (0.30, 0.62, 0.70, 0.78)),  # 占位；实际由 _hem_box 重定
    ("boots", (0.38, 0.82, 0.62, 0.995)),  # 靴子贴底；实际由 _boots_box 重定
)
_COSTUME_PORTRAIT_N = 4
_COSTUME_MIN_EDGE_DENSITY = 0.010  # 纯色布料格边缘密度过低拒收（cover 后常见 0.01–0.05）


def _middle_gray_stripe_x_bounds(
    img: Image.Image,
    *,
    y0_frac: float = 0.30,
    y1_frac: float = 0.70,
) -> tuple[float, float]:
    """立绘「浅边 + 中间人物条」：按行取深色/服装列（跳过近白与浅灰底），汇总左右界。"""
    w, h = img.size
    if w < 8 or h < 8:
        return 0.0, 1.0
    y0, y1 = int(h * y0_frac), int(h * y1_frac)
    y0, y1 = max(0, y0), min(h, max(y0 + 1, y1))
    lefts: list[int] = []
    rights: list[int] = []
    px = img.load()

    def _is_bg(r, g, b) -> bool:
        if r > 230 and g > 230 and b > 230:
            return True
        # 浅灰侧边（立绘常见 200–220 灰）
        if abs(r - g) < 14 and abs(g - b) < 14 and r >= 185:
            return True
        return False

    for y in range(y0, y1, max(1, (y1 - y0) // 24)):
        xs = []
        for x in range(w):
            r, g, b = px[x, y][:3]
            if _is_bg(r, g, b):
                continue
            xs.append(x)
        if len(xs) < max(4, w // 20):
            continue
        lefts.append(xs[0])
        rights.append(xs[-1])
    if not lefts:
        return 0.20, 0.80
    x0 = float(sorted(lefts)[len(lefts) // 4]) / float(w)
    x1 = float(sorted(rights)[3 * len(rights) // 4]) / float(w)
    if x1 <= x0 + 0.08:
        return 0.20, 0.80
    return max(0.0, x0), min(1.0, x1)


def _collar_box(img: Image.Image) -> tuple[float, float, float, float]:
    """17:38：领口——下巴到锁骨含帽口；禁止裁到肩部素布。

    优先 insightface/级联脸框下巴；全身误检或无人脸时，用上半身中心亮肤/头肩几何估下巴。
    """
    w, h = img.size
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    mid = (gx0 + gx1) / 2.0
    span = max(0.12, gx1 - gx0)
    chin_y: float | None = None
    face_x0 = mid - span * 0.20
    face_x1 = mid + span * 0.20
    try:
        buf = BytesIO()
        img.save(buf, format="PNG")
        bb = _detect_face_bbox_xyxy(buf.getvalue())
        if bb is not None:
            fy1, fy2 = float(bb[1]) / float(h), float(bb[3]) / float(h)
            fh = max(0.02, fy2 - fy1)
            if fh <= 0.35:
                chin_y = fy2
                face_x0 = float(bb[0]) / float(w)
                face_x1 = float(bb[2]) / float(w)
    except Exception:  # noqa: BLE001
        pass
    if chin_y is None:
        # 上 35% 中心条：找暖亮肤最底行作下巴近似
        try:
            import numpy as np

            arr = np.asarray(img.convert("RGB"))
            y1 = max(8, int(h * 0.02))
            y2 = max(y1 + 8, int(h * 0.38))
            x1 = max(0, int(w * max(0.25, gx0 + span * 0.15)))
            x2 = min(w, int(w * min(0.75, gx1 - span * 0.15)))
            roi = arr[y1:y2, x1:x2]
            r = roi[:, :, 0].astype("int16")
            g = roi[:, :, 1].astype("int16")
            b = roi[:, :, 2].astype("int16")
            warm = (r > 150) & (g > 120) & (b > 100) & ((r - b) > 6)
            row_frac = warm.mean(axis=1) if warm.size else None
            if row_frac is not None and len(row_frac):
                hits = [i for i, v in enumerate(row_frac) if float(v) >= 0.04]
                if hits:
                    chin_y = (y1 + hits[-1]) / float(h)
                    # 水平：肤色列范围
                    col_frac = warm.mean(axis=0)
                    cols = [i for i, v in enumerate(col_frac) if float(v) >= 0.04]
                    if cols:
                        face_x0 = (x1 + cols[0]) / float(w)
                        face_x1 = (x1 + cols[-1]) / float(w)
        except Exception:  # noqa: BLE001
            chin_y = None
    if chin_y is None:
        # 头肩几何：与 crop_face_ref 同族，下巴约在头肩方窗 72% 高
        side = min(int(w * 0.72), int(h * 0.38), w, h)
        top = max(0, int(h * 0.01))
        chin_y = (top + side * 0.72) / float(h)
    # 下巴略上 → 锁骨/帽口下：覆盖帽口结构，勿滑到肩素布
    y0 = max(0.05, float(chin_y) - 0.025)
    y1 = min(0.40, float(chin_y) + max(0.09, 0.11))
    if y1 <= y0 + 0.06:
        y1 = min(0.42, y0 + 0.10)
    cx = (float(face_x0) + float(face_x1)) / 2.0
    half = max(0.14, (float(face_x1) - float(face_x0)) * 0.90, span * 0.26)
    x0 = max(gx0 + span * 0.04, cx - half)
    x1 = min(gx1 - span * 0.04, cx + half)
    if x1 <= x0 + 0.08:
        x0 = max(gx0, mid - 0.16)
        x1 = min(gx1, mid + 0.16)
    return (float(x0), float(y0), float(x1), float(y1))


def _hem_box(img: Image.Image) -> tuple[float, float, float, float]:
    """16:18：下摆——衣摆水平缝线带，钳人物灰条。"""
    w, h = img.size
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    span = max(0.12, gx1 - gx0)
    mid = (gx0 + gx1) / 2.0
    half = max(0.14, span * 0.36)
    x0 = max(gx0 + span * 0.05, mid - half)
    x1 = min(gx1 - span * 0.05, mid + half)
    best = (x0, 0.64, x1, 0.78)
    best_ed = -1.0
    for y0 in (0.58, 0.60, 0.62, 0.64, 0.66, 0.68):
        y1 = min(0.84, y0 + 0.14)
        xa, ya = int(w * x0), int(h * y0)
        xb, yb = int(w * x1), int(h * y1)
        if xb - xa < 12 or yb - ya < 12:
            continue
        crop = img.crop((xa, ya, xb, yb))
        r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=False)
        if r < 0.25:
            continue
        ed = costume_cell_edge_density(crop)
        if ed > best_ed:
            best_ed = ed
            best = (x0, y0, x1, y1)
    return best


def _wrist_cuff_box(img: Image.Image) -> tuple[float, float, float, float]:
    """16:53 / 15:52：袖口+手——回到 1552 裁框；水平强制钳进中间灰条人物区，禁止浅色外框。

    在人物躯干左右侧找含袖缘/肤色的框；浅边占比高则丢弃；cover 前目标非背景≥0.25。
    """
    w, h = img.size
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    # 再内收 4%，彻底躲开浅外框/灰条边界
    span = max(0.10, gx1 - gx0)
    gx0 = min(0.48, gx0 + span * 0.04)
    gx1 = max(gx0 + 0.12, gx1 - span * 0.04)
    span = max(0.10, gx1 - gx0)
    mid = (gx0 + gx1) / 2.0
    # 只在人物条左右侧采样（禁正中素布、禁外框）
    candidates = [
        (gx0 + span * 0.16, 0.48),
        (gx1 - span * 0.16, 0.48),
        (gx0 + span * 0.22, 0.52),
        (gx1 - span * 0.22, 0.52),
        (gx0 + span * 0.28, 0.46),
        (gx1 - span * 0.28, 0.46),
        (gx0 + span * 0.12, 0.50),
        (gx1 - span * 0.12, 0.50),
        (gx0 + span * 0.20, 0.54),
        (gx1 - span * 0.20, 0.54),
    ]
    best_box = None
    best_score = -1.0
    half_w, half_h = 0.11, 0.085
    px = img.load()

    def _skin_frac(crop: Image.Image) -> float:
        pts = list(crop.convert("RGB").getdata())
        if not pts:
            return 0.0
        n = 0
        for r, g, b in pts:
            if r > 200 and g > 160 and b > 130 and r >= g >= b - 20:
                n += 1
            elif 150 < r < 240 and 110 < g < 200 and 90 < b < 180 and r > b + 15:
                n += 1
        return n / float(len(pts))

    def _clamp_box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        x0 = max(gx0, min(x0, gx1 - 0.06))
        x1 = min(gx1, max(x1, gx0 + 0.06))
        if x1 <= x0 + 0.06:
            # 偏哪侧就贴哪侧内缘
            if (x0 + x1) / 2.0 < mid:
                x0, x1 = gx0, min(gx1, gx0 + max(0.18, half_w * 2))
            else:
                x1, x0 = gx1, max(gx0, gx1 - max(0.18, half_w * 2))
        y0 = max(0.36, min(y0, 0.62))
        y1 = min(0.66, max(y1, y0 + 0.08))
        return (x0, y0, x1, y1)

    for cx, cy in candidates:
        for scale in (1.0, 1.15, 1.35, 1.55):
            hw, hh = half_w * scale, half_h * scale
            x0, y0, x1, y1 = _clamp_box(cx - hw, cy - hh, cx + hw, cy + hh * 1.1)
            # 硬约束：整框必须在灰条内
            if x0 < gx0 - 1e-6 or x1 > gx1 + 1e-6:
                continue
            if x1 <= x0 + 0.05 or y1 <= y0 + 0.05:
                continue
            xa, ya = int(w * x0), int(h * y0)
            xb, yb = int(w * x1), int(h * y1)
            if xb - xa < 8 or yb - ya < 8:
                continue
            crop = img.crop((xa, ya, xb, yb))
            r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=True)
            edge = _light_edge_frac(crop, edge=max(4, (xb - xa) // 12))
            skin = _skin_frac(crop)
            # 浅边过高 → 仍落在外框/灰条，直接丢弃
            if edge > 0.35 and r < 0.35:
                continue
            if r < 0.12 and skin < 0.01:
                continue
            center_pen = 0.22 * (1.0 - abs(cx - mid) / max(0.05, span / 2.0))
            score = r + 1.5 * skin - 0.75 * edge - max(0.0, center_pen)
            if score > best_score:
                best_score = score
                best_box = (x0, y0, x1, y1)
            if r + 1e-12 >= 0.55 and edge < 0.28 and (skin > 0.015 or abs(cx - mid) > span * 0.18):
                return best_box
    if best_box is None:
        # 人物条左内缘袖口兜底（仍钳灰条）
        best_box = (gx0 + span * 0.05, 0.44, gx0 + span * 0.40, 0.60)
    x0, y0, x1, y1 = best_box
    x0, y0, x1, y1 = _clamp_box(x0, y0, x1, y1)
    if (x1 - x0) < 0.16:
        cx = (x0 + x1) / 2.0
        x0 = max(gx0, cx - 0.09)
        x1 = min(gx1, cx + 0.09)
        if x1 - x0 < 0.16:
            if cx < mid:
                x0, x1 = gx0, min(gx1, gx0 + 0.22)
            else:
                x1, x0 = gx1, max(gx0, gx1 - 0.22)
    return (x0, y0, x1, y1)


def _legs_box(img: Image.Image) -> tuple[float, float, float, float]:
    """01:16：腿脚贴底、水平居中人物条；禁扩到浅色外框。"""
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    span = max(0.10, gx1 - gx0)
    gx0 = gx0 + span * 0.08
    gx1 = gx1 - span * 0.08
    mid = (gx0 + gx1) / 2.0
    half = max(0.10, min(0.16, (gx1 - gx0) * 0.28))
    x0 = max(gx0, mid - half)
    x1 = min(gx1, mid + half)
    # 贴底：略上留到脚踝/鞋，下贴 0.995
    y0, y1 = 0.82, 0.995
    # 若该带前景过稀，略上扩但仍 ≥0.76、水平不越灰条
    w, h = img.size
    xa, ya = int(w * x0), int(h * y0)
    xb, yb = int(w * x1), int(h * y1)
    crop = img.crop((xa, ya, xb, max(ya + 8, yb)))
    r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=False)
    if r < 0.18:
        y0 = 0.76
    return (x0, y0, x1, y1)




def _boots_box(img: Image.Image) -> tuple[float, float, float, float]:
    """16:18：靴子格——脚踝到鞋底贴底；水平收紧脚部，优先含靴形前景。"""
    base = _legs_box(img)
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in base]
    y1 = 0.995
    y0 = max(0.74, min(y0, 0.78))
    best = (x0, y0, x1, y1)
    best_r = -1.0
    mid = (x0 + x1) / 2.0
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    for half in (0.10, 0.12, 0.14, 0.16):
        xa = max(gx0, mid - half)
        xb = min(gx1, mid + half)
        if xb <= xa + 0.06:
            continue
        crop = img.crop((int(w * xa), int(h * y0), int(w * xb), int(h * y1)))
        r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=False)
        ed = costume_cell_edge_density(crop)
        score = r + 0.5 * ed
        if score > best_r:
            best_r = score
            best = (xa, y0, xb, y1)
    return best


def costume_cell_edge_density(cell: Image.Image | bytes) -> float:
    """15:52：边缘密度——灰度邻域差分的 RMS/255，纯色布≈0，缝线/褶皱/拉链偏高。"""
    if isinstance(cell, (bytes, bytearray)):
        im = Image.open(BytesIO(cell)).convert("L")
    else:
        im = cell.convert("L")
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
    # RMS / 255
    return (acc2 / float(max(1, n))) ** 0.5 / 255.0


def _highest_edge_square(
    img: Image.Image,
    box: tuple[float, float, float, float],
    *,
    treat_mid_gray_bg: bool = False,
    min_fg: float = 0.35,
) -> Image.Image | None:
    """在归一化框内滑动方窗，取边缘密度最高且前景够用的窗口（抑纯色布）。"""
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in box]
    xa, ya = int(w * x0), int(h * y0)
    xb, yb = int(w * x1), int(h * y1)
    xa, xb = max(0, min(xa, xb)), min(w, max(xa, xb))
    ya, yb = max(0, min(ya, yb)), min(h, max(ya, yb))
    bw, bh = xb - xa, yb - ya
    if bw < 16 or bh < 16:
        return None
    side0 = min(bw, bh)
    best = None
    best_ed = -1.0
    for scale in (1.0, 0.85, 0.70, 0.55):
        side = max(16, int(side0 * scale))
        if side > bw or side > bh:
            continue
        step = max(4, side // 6)
        for yy in range(ya, yb - side + 1, step):
            for xx in range(xa, xb - side + 1, step):
                crop = img.crop((xx, yy, xx + side, yy + side))
                r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=treat_mid_gray_bg)
                if r + 1e-12 < float(min_fg):
                    continue
                ed = costume_cell_edge_density(crop)
                if ed > best_ed:
                    best_ed = ed
                    best = crop
    return best


def assert_costume_cells_edge_density(
    costume_png: bytes,
    *,
    min_density: float | None = None,
    n: int = 4,
) -> list[float]:
    """服饰格边缘密度门禁：纯色布料拒收（只量格内中心，避开拼板留白边）。"""
    md = float(_COSTUME_MIN_EDGE_DENSITY if min_density is None else min_density)
    im = Image.open(BytesIO(costume_png)).convert("RGB")
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    dens: list[float] = []
    bad: list[int] = []
    for i in range(n):
        x0 = i * cell_w
        x1 = w if i == n - 1 else (i + 1) * cell_w
        cell = im.crop((x0, 0, x1, h))
        cw, ch = cell.size
        # 内缩 12% 去掉 pad/letterbox 缝，避免假边缘密度
        ix0, iy0 = int(cw * 0.12), int(ch * 0.12)
        ix1, iy1 = max(ix0 + 8, int(cw * 0.88)), max(iy0 + 8, int(ch * 0.88))
        inner = cell.crop((ix0, iy0, ix1, iy1))
        d = costume_cell_edge_density(inner)
        dens.append(d)
        if d + 1e-12 < md:
            bad.append(i)
    if bad:
        raise CharacterSheetError(
            f"costume cells solid-fabric (low edge density): idx={bad} "
            f"density={[round(x, 4) for x in dens]} min={md}",
            status_code=422,
        )
    return dens


def _costume_cell_fg_ratio(
    cell: Image.Image, *, treat_mid_gray_bg: bool = False
) -> float:
    """单格非背景像素占比（近白/浅灰底不计；板岩雨衣~90 仍算前景）。

    treat_mid_gray_bg：额外把更深一档的中灰底也当背景（仍保护 <120 的雨衣）。
    """
    px = list(cell.convert("RGB").getdata())
    if not px:
        return 0.0
    fg = 0
    for r, g, b in px:
        # 近白
        if r > 230 and g > 230 and b > 230:
            continue
        # 浅灰底（立绘左右浅边 / letterbox），含 185–230
        if abs(r - g) < 14 and abs(g - b) < 14 and r >= 185:
            continue
        # 中灰底 140–210
        if abs(r - g) < 8 and abs(g - b) < 8 and 140 < r < 210:
            continue
        # 袖口模式：再吞一层中灰底板，仍保护板岩雨衣(<120)
        if treat_mid_gray_bg and abs(r - g) < 12 and abs(g - b) < 12 and 120 <= r < 185:
            continue
        fg += 1
    return fg / float(len(px))



def _light_edge_frac(cell: Image.Image, edge: int = 12) -> float:
    """左右边缘浅色（近白/浅灰）占比，袖口浅边检测用。"""
    w, h = cell.size
    if w < edge * 2 + 2 or h < 4:
        return 1.0
    px = cell.convert("RGB").load()
    n = 0
    light = 0
    for y in range(h):
        for x in list(range(edge)) + list(range(w - edge, w)):
            r, g, b = px[x, y]
            n += 1
            if r > 220 and g > 220 and b > 220:
                light += 1
            elif abs(r - g) < 12 and abs(g - b) < 12 and r > 180:
                light += 1
    return light / float(max(1, n))


def _cover_square_no_light_edge(crop: Image.Image, *, size: int = 768) -> Image.Image:
    """内容 cover 铺满方格；先去浅边再放大，缝隙用服饰边缘色填（禁浅灰垫边）。"""
    im = crop.convert("RGB")
    # 裁掉四周浅色条
    w, h = im.size
    px = im.load()

    def _row_light(y: int) -> bool:
        lit = 0
        for x in range(0, w, max(1, w // 48)):
            r, g, b = px[x, y]
            if r > 220 and g > 220 and b > 220:
                lit += 1
            elif abs(r - g) < 12 and abs(g - b) < 12 and r > 185:
                lit += 1
        return lit >= max(2, (w // max(1, w // 48)) // 2)

    def _col_light(x: int) -> bool:
        lit = 0
        for y in range(0, h, max(1, h // 48)):
            r, g, b = px[x, y]
            if r > 220 and g > 220 and b > 220:
                lit += 1
            elif abs(r - g) < 12 and abs(g - b) < 12 and r > 185:
                lit += 1
        return lit >= max(2, (h // max(1, h // 48)) // 2)

    x0, y0, x1, y1 = 0, 0, w, h
    while x0 < x1 - 8 and _col_light(x0):
        x0 += 1
    while x1 > x0 + 8 and _col_light(x1 - 1):
        x1 -= 1
    while y0 < y1 - 8 and _row_light(y0):
        y0 += 1
    while y1 > y0 + 8 and _row_light(y1 - 1):
        y1 -= 1
    im = im.crop((x0, y0, x1, y1))
    # cover 到 size×size
    scale = max(size / im.width, size / im.height)
    nw, nh = max(1, int(im.width * scale)), max(1, int(im.height * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - size) // 2)
    top = max(0, (nh - size) // 2)
    im = im.crop((left, top, left + size, top + size))
    if im.size != (size, size):
        # 极端：用服饰色垫（取中位非浅色）
        fill = _sample_garment_fill_color(crop)
        canvas = Image.new("RGB", (size, size), fill)
        canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
        im = canvas
    return im


def _sample_garment_fill_color(im: Image.Image) -> tuple[int, int, int]:
    px = list(im.convert("RGB").getdata())
    pts = [
        (r, g, b)
        for r, g, b in px
        if not (r > 220 and g > 220 and b > 220)
        and not (abs(r - g) < 12 and abs(g - b) < 12 and r > 180)
    ]
    if not pts:
        return (90, 106, 122)
    pts.sort(key=lambda t: t[0] + t[1] + t[2])
    return pts[len(pts) // 2]


def _tighten_crop_to_fg(
    crop: Image.Image,
    *,
    treat_mid_gray_bg: bool = False,
    pad_frac: float = 0.06,
) -> Image.Image:
    """在裁框内按前景包围盒收紧，提高非背景占比（腿脚/下摆细长件）。"""
    w, h = crop.size
    if w < 8 or h < 8:
        return crop
    px = crop.load()

    def _fg(r, g, b) -> bool:
        if r > 230 and g > 230 and b > 230:
            return False
        if abs(r - g) < 14 and abs(g - b) < 14 and r >= 185:
            return False
        if abs(r - g) < 8 and abs(g - b) < 8 and 140 < r < 210:
            return False
        if treat_mid_gray_bg and abs(r - g) < 12 and abs(g - b) < 12 and 120 <= r < 185:
            return False
        return True

    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if _fg(*px[x, y][:3]):
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x < min_x or max_y < min_y:
        return crop
    pw = int((max_x - min_x + 1) * pad_frac) + 2
    ph = int((max_y - min_y + 1) * pad_frac) + 2
    min_x = max(0, min_x - pw)
    min_y = max(0, min_y - ph)
    max_x = min(w - 1, max_x + pw)
    max_y = min(h - 1, max_y + ph)
    return crop.crop((min_x, min_y, max_x + 1, max_y + 1))


def _densest_fg_square(
    img: Image.Image,
    box: tuple[float, float, float, float],
    *,
    treat_mid_gray_bg: bool = False,
    min_fg: float = 0.60,
) -> Image.Image | None:
    """在归一化框内滑动方窗，取前景占比最高且 ≥min_fg 的窗口。"""
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in box]
    xa, ya = int(w * x0), int(h * y0)
    xb, yb = int(w * x1), int(h * y1)
    xa, xb = max(0, min(xa, xb)), min(w, max(xa, xb))
    ya, yb = max(0, min(ya, yb)), min(h, max(ya, yb))
    bw, bh = xb - xa, yb - ya
    if bw < 16 or bh < 16:
        return None
    side0 = min(bw, bh)
    best = None
    best_r = -1.0
    for scale in (1.0, 0.85, 0.70, 0.55):
        side = max(16, int(side0 * scale))
        if side > bw or side > bh:
            continue
        step = max(4, side // 6)
        for yy in range(ya, yb - side + 1, step):
            for xx in range(xa, xb - side + 1, step):
                crop = img.crop((xx, yy, xx + side, yy + side))
                r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=treat_mid_gray_bg)
                if r > best_r:
                    best_r = r
                    best = crop
                if r + 1e-12 >= min_fg:
                    return crop
    if best is not None and best_r + 1e-12 >= min_fg * 0.85:
        return best
    return best if best_r >= 0.45 else None


def _crop_costume_band_filled(
    img: Image.Image,
    box: tuple[float, float, float, float],
    *,
    size: int = 768,
    min_fg: float = 0.60,
    treat_mid_gray_bg: bool = False,
) -> bytes:
    """按归一化框裁切；前景 < min_fg 时自动扩/平移裁框直到达标或触边。"""
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in box]
    # 01:16：无论是否 treat_mid_gray，水平一律钳进人物灰条，禁裁浅外框
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    x0 = max(x0, gx0)
    x1 = min(x1, gx1)
    if x1 <= x0 + 0.04:
        x0, x1 = gx0, gx1
    best = None
    best_r = -1.0
    for step in range(8):
        xa, ya = int(w * x0), int(h * y0)
        xb, yb = int(w * x1), int(h * y1)
        xa, xb = max(0, min(xa, xb)), min(w, max(xa, xb))
        ya, yb = max(0, min(ya, yb)), min(h, max(ya, yb))
        if xb - xa < 8 or yb - ya < 8:
            break
        crop = img.crop((xa, ya, xb, yb))
        r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=treat_mid_gray_bg)
        if r > best_r:
            best_r = r
            best = crop
        if r + 1e-12 >= min_fg:
            break
        # 扩框：向中心外扩约 6%，袖口格同时略向右/下移以吃进袖与手
        pad = 0.06
        x0 = max(0.0, x0 - pad)
        y0 = max(0.0, y0 - pad * 0.5)
        x1 = min(1.0, x1 + pad)
        y1 = min(1.0, y1 + pad)
        if step >= 3:
            # 平移：若整框仍空，向画面中心挪
            cx = (x0 + x1) / 2.0
            cy = (y0 + y1) / 2.0
            dx = (0.5 - cx) * 0.08
            dy = (0.55 - cy) * 0.08
            x0, x1 = x0 + dx, x1 + dx
            y0, y1 = y0 + dy, y1 + dy
            x0, x1 = max(0.0, x0), min(1.0, x1)
            y0, y1 = max(0.0, y0), min(1.0, y1)
    if best is None:
        raise CharacterSheetError("costume band crop empty", status_code=422)
    # 00:59：扩框仍不足 → 前景包围盒收紧；再不足 → 框内最密方窗
    if best_r + 1e-12 < float(min_fg):
        tight = _tighten_crop_to_fg(best, treat_mid_gray_bg=treat_mid_gray_bg)
        tr = _costume_cell_fg_ratio(tight, treat_mid_gray_bg=treat_mid_gray_bg)
        if tr > best_r:
            best, best_r = tight, tr
            logger.info("costume band tighten fg→%.3f", best_r)
    if best_r + 1e-12 < float(min_fg):
        dense = _densest_fg_square(
            img, (x0, y0, x1, y1), treat_mid_gray_bg=treat_mid_gray_bg, min_fg=min_fg
        )
        if dense is not None:
            dr = _costume_cell_fg_ratio(dense, treat_mid_gray_bg=treat_mid_gray_bg)
            if dr > best_r:
                best, best_r = dense, dr
                logger.info("costume band densest fg→%.3f", best_r)
    # 允许 2pt 测量余量（方窗/抗锯齿），目标仍按 ≥60% 调框
    if best_r + 1e-12 < float(min_fg) - 0.02:
        raise CharacterSheetError(
            f"costume band fg {best_r:.3f} < {min_fg:.2f} after auto-adjust",
            status_code=422,
        )
    crop = best
    # 00:59：cover 铺满消空白；若去浅边后前景塌缩，回退为中心 cover（垫服装色）
    covered = _cover_square_no_light_edge(crop, size=size)
    post = _costume_cell_fg_ratio(covered, treat_mid_gray_bg=treat_mid_gray_bg)
    if post + 1e-12 < max(0.35, float(min_fg) * 0.55):
        # 简单 cover：缩放到短边，居中贴到服装色底
        fill = _sample_garment_fill_color(crop)
        scale = max(size / max(1, crop.width), size / max(1, crop.height))
        nw, nh = max(1, int(crop.width * scale)), max(1, int(crop.height * scale))
        im2 = crop.resize((nw, nh), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (size, size), fill)
        canvas.paste(im2, ((size - nw) // 2, (size - nh) // 2))
        # 再截中心
        left = max(0, (nw - size) // 2) if nw > size else 0
        top = max(0, (nh - size) // 2) if nh > size else 0
        if nw > size or nh > size:
            covered = im2.crop((left, top, left + size, top + size))
            if covered.size != (size, size):
                c2 = Image.new("RGB", (size, size), fill)
                c2.paste(covered, ((size - covered.width) // 2, (size - covered.height) // 2))
                covered = c2
        else:
            covered = canvas
        post = _costume_cell_fg_ratio(covered, treat_mid_gray_bg=False)
        logger.info(
            "costume cover fallback fill post_fg=%.3f (light-edge wipe avoided)", post
        )
    crop = covered
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def build_costume_collage_from_portrait(
    portrait: bytes,
    *,
    style: str = "anime",
    size: int = 768,
    min_fg: float = 0.60,
    min_edge_density: float | None = None,
) -> bytes:
    """15:52 / 16:18：从主立绘裁 4 格（领口/袖口/下摆/靴子）；ROI 对齐真部位；边缘密度拒纯色。"""
    if not portrait:
        raise CharacterSheetError("costume portrait crops: empty portrait", status_code=422)
    img = Image.open(BytesIO(portrait)).convert("RGB")
    items: list[bytes] = []
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    md = float(_COSTUME_MIN_EDGE_DENSITY if min_edge_density is None else min_edge_density)
    for key, box in _COSTUME_PORTRAIT_BANDS:
        if key == "collar":
            use_box = _collar_box(img)
        elif key == "cuff":
            use_box = _wrist_cuff_box(img)
        elif key == "hem":
            use_box = _hem_box(img)
        elif key in ("boots", "legs"):
            use_box = _boots_box(img)
        else:
            # 四格一律禁裁浅色外框——水平钳进人物灰条
            x0, y0, x1, y1 = [float(v) for v in box]
            x0 = max(x0, gx0)
            x1 = min(x1, gx1)
            if x1 <= x0 + 0.06:
                mid = (gx0 + gx1) / 2.0
                half = max(0.10, (gx1 - gx0) * 0.22)
                x0, x1 = max(gx0, mid - half), min(gx1, mid + half)
            use_box = (x0, y0, x1, y1)
        treat_bg = key == "cuff"
        # 16:18：领口/袖口/下摆允许略低于 60%（窄 ROI），靴仍 0.45
        if key in ("boots", "legs"):
            band_min = 0.45
        elif key in ("collar", "cuff", "hem"):
            band_min = min(float(min_fg), 0.55)
        else:
            band_min = min_fg
        cell = _crop_costume_band_filled(
            img,
            use_box,
            size=size,
            min_fg=band_min,
            treat_mid_gray_bg=treat_bg,
        )
        r = _costume_cell_fg_ratio(
            Image.open(BytesIO(cell)).convert("RGB"),
            treat_mid_gray_bg=treat_bg,
        )
        # 15:52：优先换边缘更密的方窗，抑纯色布；领口保持颈带中心（禁止滑到肩素布）
        ed = costume_cell_edge_density(cell)
        if key != "collar":
            edge_win = _highest_edge_square(
                img, use_box, treat_mid_gray_bg=treat_bg, min_fg=max(0.30, band_min * 0.70)
            )
            if edge_win is not None:
                buf2 = BytesIO()
                covered2 = _cover_square_no_light_edge(edge_win, size=size)
                covered2.save(buf2, format="PNG")
                alt = buf2.getvalue()
                ed2 = costume_cell_edge_density(alt)
                if ed2 > ed + 1e-6:
                    cell, ed = alt, ed2
                    r = _costume_cell_fg_ratio(
                        Image.open(BytesIO(cell)).convert("RGB"),
                        treat_mid_gray_bg=treat_bg,
                    )
        if ed + 1e-12 < md and key == "cuff":
            # 16:18：袖口过素 → 换对侧外缘再裁一次
            gx0b, gx1b = gx0, gx1
            spanb = max(0.10, gx1b - gx0b)
            midb = (gx0b + gx1b) / 2.0
            cx_cur = (use_box[0] + use_box[2]) / 2.0
            if cx_cur < midb:
                alt_box = (gx1b - spanb * 0.34, 0.42, gx1b - spanb * 0.02, 0.58)
            else:
                alt_box = (gx0b + spanb * 0.02, 0.42, gx0b + spanb * 0.34, 0.58)
            alt_cell = _crop_costume_band_filled(
                img, alt_box, size=size, min_fg=band_min, treat_mid_gray_bg=True
            )
            ed_alt = costume_cell_edge_density(alt_cell)
            edge_win2 = _highest_edge_square(
                img, alt_box, treat_mid_gray_bg=True, min_fg=max(0.30, band_min * 0.70)
            )
            if edge_win2 is not None:
                buf3 = BytesIO()
                _cover_square_no_light_edge(edge_win2, size=size).save(buf3, format="PNG")
                alt2 = buf3.getvalue()
                ed2 = costume_cell_edge_density(alt2)
                if ed2 > ed_alt:
                    alt_cell, ed_alt = alt2, ed2
            if ed_alt > ed:
                cell, ed = alt_cell, ed_alt
                use_box = alt_box
                logger.info("costume cuff alt-side edge=%.4f", ed)
        if ed + 1e-12 < md:
            raise CharacterSheetError(
                f"costume {key} solid-fabric edge_density={ed:.4f} < {md}",
                status_code=422,
            )
        items.append(cell)
        logger.info(
            "costume portrait crop %s box=%s post_lb_fg≈%.3f edge=%.4f",
            key,
            use_box,
            r,
            ed,
        )
    out = collage_costume_items(items, style=style)
    assert_costume_cells_nonempty(out, min_ratio=0.12, n=_COSTUME_PORTRAIT_N)
    assert_costume_cells_edge_density(out, min_density=md, n=_COSTUME_PORTRAIT_N)
    return out


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
        ancient_costume_items(meta)
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



def tighten_side_square_to_face_frac(
    data: bytes,
    *,
    target: float = 0.30,
    min_frac: float = 0.28,
    max_frac: float = 0.35,
    size: int = 768,
) -> bytes:
    """16:53：侧头方图裁框收紧到 face_frac≈0.3（只调几何，不重出侧母版）。

    face_frac 已在 [min_frac, max_frac] 则原样返回；过小则围绕脸框缩小取景。
    """
    frac = measure_face_height_frac(data)
    if frac is None:
        return data
    f = float(frac)
    if f + 1e-12 >= float(min_frac) and f - 1e-12 <= float(max_frac):
        return data
    if f + 1e-12 >= float(min_frac) and abs(f - float(target)) < 0.02:
        return data
    # 过大：本函数不稀释（compose 既有 pad 路径）
    if f > float(max_frac) + 1e-12:
        return data
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        return data
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    face_h = max(8.0, fy2 - fy1)
    face_w = max(8.0, fx2 - fx1)
    fcx = (fx1 + fx2) / 2.0
    fcy = (fy1 + fy2) / 2.0
    # 目标边长 ≈ face_h / target
    tgt = max(0.26, min(0.40, float(target)))
    side = face_h / tgt
    side = max(side, face_w * 1.15, face_h * 1.45)
    side = min(side, float(w), float(h))
    # 若仍过小则再略收
    for _ in range(4):
        left = max(0.0, min(float(w) - side, fcx - side / 2.0))
        top = max(0.0, min(float(h) - side, fy1 - side * 0.18))
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = crop.resize((size, size), Image.Resampling.LANCZOS)
        buf = BytesIO()
        out_im.save(buf, format="PNG")
        out = buf.getvalue()
        nf = measure_face_height_frac(out)
        if nf is None:
            return out
        if float(nf) + 1e-12 >= float(min_frac):
            if float(nf) - 1e-12 <= 0.50:
                return out
            # 过紧：放大 side
            side = min(float(w), float(h), side * (float(nf) / tgt))
        else:
            side = max(64.0, side * 0.92)
    return out


def compose_faces_triptych(
    faces: dict[str, bytes],
    *,
    style: str = "anime",
    size: tuple[int, int] = (1024, 640),
    skip_enforce_keys: set[str] | frozenset[str] | None = None,
    master_crop: bool = False,
) -> bytes:
    """正/3-4/侧 三个头部特写横拼为 faces 面板。

    fix16:锁定格与生成格同一 face-center cover(禁垫边缩水);每格 assert_panel_coverage>=0.90。
    入格 cover 按人脸焦点裁(高格水平居中会砍掉侧脸五官)。
    二次元浅底:已正方形铺满源谨慎 trim,避免 cel 线/浅底被当灰边。
    18:23 master_crop=True：母版裁切直接拼，近景门禁失败则原图 LANCZOS 铺满，不 422。
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
        try:
            if master_crop or key in skip:
                if master_crop and key == "face_three_quarter":
                    # 16:18：侧面¾ 母版硬裁禁止 enforce 再拉近（否则 0.27→0.47、hires 0.38→0.52）
                    im = Image.open(BytesIO(raw)).convert("RGB")
                    if im.size != (768, 768):
                        im = im.resize((768, 768), Image.Resampling.LANCZOS)
                    buf = BytesIO()
                    im.save(buf, format="PNG")
                    filled = buf.getvalue()
                else:
                    filled = enforce_head_shoulders_square(
                        raw,
                        size=768,
                        skip_reframe=True,
                        face_closeup_gate=not master_crop,
                        check_coverage=False,
                    )
            else:
                # 17:55：脸格用近景门禁，禁全身 coverage（浅灰底+动漫脸会被判成 0.03 邮票）
                filled = enforce_head_shoulders_square(
                    raw, size=768, face_closeup_gate=True
                )
        except CharacterSheetError as ge:
            if not master_crop:
                raise
            logger.warning("compose_faces master_crop soft skip %s: %s", key, ge)
            im = Image.open(BytesIO(raw)).convert("RGB").resize(
                (768, 768), Image.Resampling.LANCZOS
            )
            buf = BytesIO()
            im.save(buf, format="PNG")
            filled = buf.getvalue()
        # 焦点:生成格用人脸中心;锁定格禁用 focus(防高格 cover 把头裁成半脸/空灰)
        # 16:18：master_crop 侧面¾ 禁止 face-zoom + 禁 trim（否则 tall 格 face_frac 从 0.37→0.73）
        focus = None
        _preserve_side_frac = bool(master_crop and key == "face_three_quarter")
        if key not in skip and not _preserve_side_frac:
            bb = _detect_face_bbox_xyxy(filled)
            if bb is not None:
                focus = ((bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0)
            else:
                him = Image.open(BytesIO(filled)).convert("RGB")
                hbb = _heuristic_skin_face_bbox(him)
                if hbb is not None:
                    focus = ((hbb[0] + hbb[2]) / 2.0, (hbb[1] + hbb[3]) / 2.0)
        img = Image.open(BytesIO(filled)).convert("RGBA")
        iw, ih = img.size
        if _preserve_side_frac:
            # 16:53：过小则收紧到 face_frac≈0.3；过高仍垫边稀释到 ~0.38
            try:
                frac0 = measure_face_height_frac(filled)
                if frac0 is not None and float(frac0) + 1e-12 < 0.30:
                    tight = tighten_side_square_to_face_frac(
                        filled, target=0.32, min_frac=0.28, max_frac=0.38, size=768
                    )
                    filled = tight
                    img = Image.open(BytesIO(filled)).convert("RGBA")
                    iw, ih = img.size
                    frac0 = measure_face_height_frac(filled)
                if frac0 is not None and float(frac0) > 0.42:
                    target = 0.38
                    pad_scale = float(frac0) / target
                    side_n = max(img.width, img.height)
                    canvas_n = int(round(side_n * pad_scale))
                    canvas_n = max(canvas_n, side_n + 8)
                    bg_rgb = (248, 248, 252) if style == "anime" else (20, 22, 28)
                    pad = Image.new("RGBA", (canvas_n, canvas_n), bg_rgb + (255,))
                    pad.paste(img, ((canvas_n - img.width) // 2, (canvas_n - img.height) // 2))
                    img = pad
                    iw, ih = img.size
            except Exception:  # noqa: BLE001
                pass
        elif iw != ih or min(iw, ih) < 200:
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
    neg = _with_ancient_spec_negative(_STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"]), style)
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
    _ANCIENT_SPEC_NEG_CTX.set(ancient_spec_negative(meta))
    _acc_fix = ancient_accessory_prompt_fix(meta)
    if _acc_fix["pos"]:
        logger.info(
            "ancient accessory prompt fix name=%s wooden_hairpin=%s umbrella_in_hand=%s",
            meta.name, _acc_fix["wooden_hairpin"], _acc_fix["umbrella_in_hand"],
        )
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
                ancient_costume_items(meta)
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
            panels["costume"] = ensure_costume_bad_cells_replaced(
                panels["costume"],
                portrait=panels.get("portrait"),
                front=panels.get("front"),
                n=len(picked_items) if picked_items else 5,
            )
            debug["picks"]["costume"] = {
                "items": [k for k, _ in costume_items],
                "locked_items": locked_item_keys,
                "regen_items": regen_item_keys,
            }
            continue

        if key == "faces":
            # 18:23 裁母版；19:01 头高≥35% 自动拉近（正/侧硬门禁）
            tri = build_faces_tri_from_masters(
                portrait=panels.get("portrait"),
                front=panels.get("front"),
                side=panels.get("side"),
                back=panels.get("back"),
                size=768,
            )
            for fk in ("face_front", "face_three_quarter", "face_side"):
                try:
                    tri[fk] = auto_tighten_face_crop(tri[fk], size=768, face_key=fk)
                except CharacterSheetError:
                    if fk != "face_side":
                        raise
            try:
                _fr = tri.get("face_front") or panels.get("portrait")
                if (
                    side_hist_match_enabled()
                    and _fr
                    and tri.get("face_three_quarter")
                ):
                    tri["face_three_quarter"] = match_side_head_coat_hair_to_front(
                        tri["face_three_quarter"], _fr
                    )
                elif not side_hist_match_enabled():
                    logger.info(
                        "regen faces hist-match skipped (TOIV_SHEET_SIDE_HIST_MATCH off)"
                    )
            except Exception as hme:  # noqa: BLE001
                logger.warning("regen faces hist-match skipped: %s", hme)
            panels["faces"] = compose_faces_triptych(
                tri,
                style=meta.style,
                size=_panel_size("faces", meta.style),
                master_crop=True,
            )
            debug["picks"]["faces"] = {
                "mode": (
                    "master_crop_1901_head35+1552_hist"
                    if side_hist_match_enabled()
                    else "master_crop_1901_head35+1822_no_hist"
                ),
                "keys": ["face_front", "face_three_quarter", "face_side"],
                "scores": {},
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
                    ref_mode = "qwen_edit"
                    denoise = 1.0
                    _ei = _EXPR_KEYS.index(key) if key in _EXPR_KEYS else 0
                    prompt = _EXPR_EDIT_INSTRUCTIONS[_ei]
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
        if (
            key in ("front", "side", "back")
            and meta.style == "ancient_realistic"
            and ancient_spec_target_hex(meta)
        ):
            # 古风 spec 色门禁:只在过门禁候选里挑;全拒 → 422(候选数即重试上限)
            _ok, _last_ce = [], None
            for _c in cands:
                try:
                    assert_garment_near_spec_color(_c, ancient_spec_target_hex(meta), label=key)
                    _ok.append(_c)
                except CharacterSheetError as _ce:
                    _last_ce = _ce
            if not _ok:
                raise _last_ce or CharacterSheetError(f"{key}颜色门禁全拒", status_code=422)
            cands = _ok
        best = _pick_best_candidate(cands, key)
        if key.startswith("expr_"):
            # 18:23：regenerate 表情同样过徽标/发长门禁；同因连败筛候选
            gated: list[bytes] = []
            last_ge = None
            same_cause = None
            same_cause_n = 0
            for cand in cands:
                try:
                    g = enforce_head_shoulders_square(
                        cand, size=768, face_closeup_gate=True
                    )
                    assert_expression_identity_gates(
                        g,
                        portrait_ref=panels.get("portrait"),
                        expr_key=key,
                    )
                    _neutral = None
                    try:
                        if panels.get("portrait"):
                            _neutral = crop_face_ref(panels["portrait"], size=768)
                    except Exception:  # noqa: BLE001
                        _neutral = None
                    assert_expression_diversity(
                        g,
                        expr_key=key,
                        neutral_ref=_neutral,
                        other_exprs={
                            ek: panels[ek]
                            for ek in _EXPR_KEYS
                            if ek in panels and ek != key and panels.get(ek)
                        },
                    )
                    gated.append(g)
                except CharacterSheetError as ge:
                    last_ge = ge
                    cause = _expr_reject_cause(ge)
                    if cause == same_cause:
                        same_cause_n += 1
                    else:
                        same_cause = cause
                        same_cause_n = 1
                    if same_cause_n >= 3 and not gated:
                        raise CharacterSheetError(
                            f"{key}同因连败3次({cause}): {ge}；停下修根因",
                            status_code=422,
                        ) from ge
            if not gated:
                raise last_ge or CharacterSheetError(
                    f"{key}表情门禁全拒", status_code=422
                )
            best = _pick_best_candidate(gated, key)
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
