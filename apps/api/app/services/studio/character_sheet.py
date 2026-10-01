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

import asyncio
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
_FORBIDDEN_WORKER_PORTS = {8195, 8196, 8197, 8205}

# 固定几何(像素):拼版单测锁定这些矩形
LAYOUT = {
    "canvas": (SHEET_W, SHEET_H),
    "portrait": (48, 48, 720, 1180),
    "name": (48, 1240, 720, 72),
    "profile": (48, 1320, 720, 420),
    "turnaround": (800, 48, 1552, 1692),
    "faces": (48, 1780, 760, 520),
    "expressions": (840, 1780, 980, 520),
    "costume": (48, 2340, 1180, 520),
    "palette": (1260, 2340, 520, 200),
    "notes": (1260, 2560, 1092, 300),
    "footer": (48, 3080, 2304, 80),
}

_STYLE_SUFFIX = {
    "ancient_realistic": (
        "cinematic photorealistic character design, detailed fabric texture, "
        "rain droplets, solid seamless dark gray background, no scenery, "
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
        "hanfu, ancient chinese clothing, white robe, white hanfu, white dress, "
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
        "baseball cap, hat on stand, ceiling lamp, dome light, opaque black dome, hard hat, helmet, bowl"
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
        "product still life, single object only, one complete matte jet-black hooded raincoat "
        "garment laid flat open on table like e-commerce flat lay, attached hood at collar, "
        "two long sleeves spread left and right, full torso, front zipper, "
        "entire garment pure jet black nylon, no white panels, no navy panels, no grey panels, "
        "fills most of frame, solid seamless pure white background, studio lighting, "
        "no person, no face, no mannequin, no worn clothes, no white t-shirt, no hoodie, "
        "no cloak, no cape, no poncho, no beige, no brown, no tan, no khaki, no red, no text",
    ),
    (
        "pants",
        "product still life, single object only, one complete pair matte jet-black trousers "
        "laid flat fully visible, two long pant legs clearly separated side by side, "
        "waistband visible, pure jet black fabric only, clothing flat lay catalog photo, "
        "solid seamless pure white background, studio lighting, "
        "no person, no face, no body, no mannequin, no shorts, no short pants, no bermuda, no cropped pants, no knee-length, no skirt, "
        "no navy, no blue, no grey, no beige, no brown, no cloak, no text",
    ),
    (
        "boots",
        "product still life, single object only, one pair glossy jet-black rubber rain boots "
        "standing side by side, footwear only, empty boots, pure black rubber, "
        "solid seamless pure white background, studio lighting, "
        "no person, no face, no body, no mannequin, no legs, no feet inside, "
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
_COSTUME_FORCE = (
    "overhead flat lay product photography, garments and props laid flat on table, "
    "ONLY these five items: ONE black hooded raincoat, ONE pair full-length black long pants (not shorts), "
    "ONE pair black rain boots, ONE clear transparent rain umbrella with shaft and handle (not a lamp, not a hat), ONE white plastic shopping bag, "
    "black garments only, clothing pieces arranged neatly as product shots, "
    "isolated on solid seamless background, no person, no face, no mannequin, "
    "no model wearing clothes, no hanging rack display, no color variants, "
    "no hanfu, no ancient costume, no white robe, no white jacket, no white coat, "
    "no beige jacket, no blue jacket, no red cloak, no beige cloak, no brown cloak, "
    "fashion design sheet"
)


def _costume_template_bytes(item_key: str, size: int = 768) -> bytes:
    """程序化单品轮廓底图,供服饰 img2img 锚定形状(防白卫衣/畸变伞)。"""
    bg = (245, 245, 248) if item_key in ("umbrella", "bag") else (255, 255, 255)
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    m = size // 10
    if item_key == "raincoat":
        # 张开的黑雨衣:帽兜+双袖+躯干
        body = [m * 3, m * 3, size - m * 3, size - m * 2]
        d.rectangle(body, fill=(12, 12, 14))
        # hood
        d.ellipse([size // 2 - m * 2, m, size // 2 + m * 2, m * 4], fill=(12, 12, 14))
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
        for ox in (size // 2 - m * 3, size // 2 + m):
            d.rounded_rectangle([ox, m * 3, ox + m * 2, size - m], radius=20, fill=(12, 12, 14))
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


def _costume_item_penalty(data: bytes, item_key: str) -> float:
    """越大越差;按单品约束(雨衣必须够黑、伞不能实心黑、袋偏白)。"""
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
        try:
            font = ImageFont.truetype(str(p), size=size)
        except OSError:
            continue
        try:
            bbox = font.getbbox("角色")
        except Exception:  # noqa: BLE001
            continue
        if bbox and (bbox[2] - bbox[0]) > 8:
            return font
    raise CharacterSheetError(
        "中文字体缺失(需 PingFang/思源/STHeiti/Noto Sans CJK 等)",
        status_code=503,
    )


def is_sheet_url(url: str) -> bool:
    return _CHAR_SHEET_MARK in (url or "")


def is_panel_url(url: str) -> bool:
    return _CHAR_PANEL_MARK in (url or "")


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
        # 21:30:清掉 sample_linxia_* 旧样片,只保留立绘+三视图进 Ref2VA
        if "sample_linxia_" in u:
            continue
        if u in ordered:
            continue
        rest.append(u.strip())
    # 仅立绘+三视图;不再回填其它旧参考
    return ordered[:_MAX_REFS]


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
    auto = [
        f"{name}：雨夜便利店相遇的核心角色，身份为{role}，性格{personality}。",
        "视觉主轴为黑色连帽雨衣/冲锋衣、湿发贴额与冷白灯光，辅以白色塑料袋道具。",
        "三视图与表情均以主立绘为同一人参考，统一服装与纯色底，保证 Ref2VA 跨镜一致。",
        f"本卡风格滤镜为{style_zh}；服饰拆解对齐现代雨夜设定，禁止汉服等错位单品。",
    ]
    if desc and desc not in auto[0]:
        auto.insert(1, desc[:80])
    if lines:
        # 保留用户短句,补足到至少 3 行
        merged = lines + [a for a in auto if a not in lines]
        return "\n".join(merged[:5])
    return "\n".join(auto[:5])


def _character_base(meta: SheetMeta) -> str:
    base = (meta.visual_prompt or meta.description or meta.name).strip()
    if not base:
        raise CharacterSheetError("角色缺少视觉描述", status_code=422)
    # 强制黑发+现代雨衣;抑制银发/汉服漂移(21:01 纠偏)
    low = base.lower()
    for bad in ("silver hair", "white hair", "grey hair", "gray hair", "blue hair", "blonde"):
        if bad in low:
            import re as _re
            base = _re.sub(bad, "black hair", base, flags=_re.I)
            low = base.lower()
    extra = (
        "jet black hair, black hair, black hooded raincoat, black windbreaker, "
        "wet black hair on forehead, young East Asian woman, convenience store clerk vibe"
    )
    if "black hair" not in low and "黑发" not in base:
        base = f"{base}, jet black hair, black hair"
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
    prompts: dict[str, str] = {
        "portrait": (
            f"{solo}, {base}, full body standing portrait of {name}, facing camera, "
            f"jet black hair, black hair, same outfit black hooded raincoat, "
            f"hood optional, no silver hair, {solid}, character design, {suf}"
        ),
        "front": (
            f"{solo}, {base}, ONE figure only, front view full body turnaround of {name}, orthographic, "
            f"jet black hair, same character same black hooded raincoat, standing straight, "
            f"single person only, empty background, {solid}, {suf}"
        ),
        "side": (
            f"{solo}, {base}, ONE figure only, STRICT side profile full body turnaround of {name}, "
            f"looking left, 90 degree side view, jet black hair, "
            f"orthographic, same character same black hooded raincoat, standing straight, "
            f"single person only, NOT front view, NOT back view, empty background, {solid}, {suf}"
        ),
        "back": (
            f"{solo}, {base}, ONE figure only, STRICT back view full body turnaround of {name}, "
            f"facing completely away from camera, back of head and hood visible, "
            f"jet black hair, orthographic, single person only, "
            f"same character same black hooded raincoat, NOT front view, NOT face, "
            f"NOT side view, empty background, {solid}, {suf}"
        ),
        "faces": (
            f"{base}, face and hairstyle multi-angle closeups of {name}, "
            f"front three-quarter profile, hair details, {solid}, {suf}"
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


def _fit(img: Image.Image, box: tuple[int, int, int, int], *, cover: bool = True):
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
    oy = y + (h - src.height) // 2
    return src, (ox, oy)


def _paste(
    canvas: Image.Image,
    img: Image.Image,
    box: tuple[int, int, int, int],
    *,
    cover: bool = True,
) -> None:
    fitted, pos = _fit(img, box, cover=cover)
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


def _extract_palette(img: Image.Image, n: int = 6) -> list[str]:
    """从人物前景取色(中心裁切 + 剔除近背景色),避免灰/近黑色板(21:01)。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    # 四角估背景
    corners = [
        rgb.getpixel((2, 2)),
        rgb.getpixel((w - 3, 2)),
        rgb.getpixel((2, h - 3)),
        rgb.getpixel((w - 3, h - 3)),
    ]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    # 中心人物区
    crop = rgb.crop((int(w * 0.18), int(h * 0.06), int(w * 0.82), int(h * 0.92)))
    small = crop.resize((64, 64), Image.Resampling.BOX)
    colors = small.getcolors(64 * 64) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    out: list[str] = []
    skin_cands: list[tuple[int, tuple[int, int, int]]] = []
    for cnt, (r, g, b) in colors:
        # 跳过近背景 / 极端黑白
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 45:
            continue
        if max(r, g, b) < 18 or min(r, g, b) > 245:
            continue
        # 灰背景带(低饱和)
        mx, mn = max(r, g, b), min(r, g, b)
        if mx - mn < 12 and 70 <= mx <= 190:
            continue
        hx = f"#{r:02X}{g:02X}{b:02X}"
        if hx not in out:
            out.append(hx)
        # 肤色候选
        if 90 < r < 245 and 60 < g < 210 and 45 < b < 190 and r >= g >= b - 10:
            skin_cands.append((cnt, (r, g, b)))
        if len(out) >= n:
            break
    # 保证有肤色/唇色/透明伞灰可辨;全近黑则重置
    fallback = ["#E8C4A8", "#C98A7A", "#1A1A1E", "#2C2C34", "#C8C8C8", "#5A6A7A"]
    if skin_cands:
        sr, sg, sb = skin_cands[0][1]
        skin_hx = f"#{sr:02X}{sg:02X}{sb:02X}"
        if skin_hx not in out:
            out.insert(0, skin_hx)
    dark_n = sum(1 for hx in out[:4] if int(hx[1:3], 16) + int(hx[3:5], 16) + int(hx[5:7], 16) < 120)
    if dark_n >= 3:
        out = list(fallback)
    for hx in fallback:
        if len(out) >= n:
            break
        if hx not in out:
            out.append(hx)
    return out[:n]


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


def _compose_expression_grid(
    panels: dict[str, Image.Image],
    *,
    label_fill: tuple[int, ...] = (30, 30, 36),
    draw_labels: bool = True,
) -> Image.Image:
    """2x3 头肩特写格 + 格下标签区(标签只画在留白带,绝不压进生成图)。"""
    cell = 320
    label_h = 44
    cols, rows = 3, 2
    grid = Image.new("RGBA", (cols * cell, rows * (cell + label_h)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(grid)
    font = None
    if draw_labels:
        try:
            font = resolve_cjk_font(22)
        except CharacterSheetError:
            font = ImageFont.load_default()
    for i, key in enumerate(_EXPR_KEYS):
        img = panels.get(key)
        if img is None:
            raise CharacterSheetError(f"缺面板:{key}", status_code=500)
        row, col = divmod(i, cols)
        # 头肩图 letterbox 入格(contain),避免 cover 把脸裁到格边
        fitted, _ = _fit(img.convert("RGBA"), (0, 0, cell - 8, cell - 8), cover=False)
        ox = col * cell + 4
        oy = row * (cell + label_h) + 4
        grid.paste(fitted, (ox, oy), fitted)
        if draw_labels and i < len(_EXPR_LABELS):
            lab = _EXPR_LABELS[i]
            lx = col * cell + cell // 2
            ly = row * (cell + label_h) + cell + 6
            if font is not None:
                tw = draw.textlength(lab, font=font)
                draw.text((lx - tw / 2, ly), lab, font=font, fill=label_fill)
            else:
                draw.text((lx - 18, ly), lab, fill=label_fill)
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

    portrait = _as_image("portrait")
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
        _paste(canvas, _as_image(key), box, cover=False)
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
    _paste(canvas, _as_image("faces"), (fx + 8, fy + 32, fw - 16, fh - 40), cover=True)

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
        # 标签已画在 grid 格下留白;cover=False 保完整格带
        grid = _compose_expression_grid(expr_imgs, label_fill=theme["text"])
        _paste(canvas, grid, (ex + 8, ey + 32, ew - 16, eh - 40), cover=False)
    else:
        _paste(
            canvas,
            _as_image("expressions"),
            (ex + 8, ey + 32, ew - 16, eh - 72),
            cover=True,
        )
        chip_w = (ew - 24) // len(_EXPR_LABELS)
        for i, lab in enumerate(_EXPR_LABELS):
            draw.text(
                (ex + 12 + i * chip_w, ey + eh - 36),
                lab,
                font=font_label,
                fill=theme["text"],
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
    # letterbox:完整物品可见,禁止竖长条中心裁切
    _paste(canvas, _as_image("costume"), (cx + 8, cy + 32, cw - 16, ch - 40), cover=False)

    colors = list(meta.colors) if meta.colors else _extract_palette(portrait)
    colors = [_normalize_hex(c) for c in colors if _normalize_hex(c)]
    if not colors:
        colors = _extract_palette(portrait)
    plx, ply, plw, plh = LAYOUT["palette"]
    _draw_panel_frame(
        draw,
        LAYOUT["palette"],
        "配色",
        font_label,
        outline=theme["outline"],
        label_fill=theme["text_dim"],
    )
    sw = (plw - 24) // max(1, len(colors))
    for i, hx in enumerate(colors[:8]):
        rgb = tuple(int(hx[j : j + 2], 16) for j in (1, 3, 5))
        sx = plx + 12 + i * sw
        draw.rounded_rectangle(
            [sx, ply + 40, sx + sw - 8, ply + plh - 36], radius=6, fill=rgb
        )
        draw.text((sx + 4, ply + plh - 30), hx, font=font_label, fill=theme["text_dim"])

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


def enforce_head_shoulders_square(data: bytes, size: int = 768) -> bytes:
    """表情出图后强制头肩正方形:按非背景质心居中,避免脸被挤到格边。

    模型常无视 closeup 提示画出半身;此步是硬裁,标签仍由拼版画在格下。
    """
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    # 找非灰/非白前景质心(脸/头发)
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    sp = small.load()
    xs, ys, nfg = [], [], 0
    for y in range(64):
        for x in range(64):
            r, g, b = sp[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            # 跳过近白/近纯灰底
            if r > 230 and g > 230 and b > 230:
                continue
            if mx - mn < 14 and 70 <= mx <= 200:
                continue
            xs.append(x)
            ys.append(y)
            nfg += 1
    if nfg >= 20:
        cx = int(sum(xs) / nfg * w / 64)
        cy = int(sum(ys) / nfg * h / 64)
    else:
        cx, cy = w // 2, int(h * 0.28)
    side = min(w, max(int(h * 0.52), int(w * 0.78)))
    side = min(side, w, h)
    left = max(0, min(w - side, cx - side // 2))
    top = max(0, min(h - side, cy - side // 2))
    # 偏上一点,保住额头
    top = max(0, top - int(side * 0.08))
    if top + side > h:
        top = max(0, h - side)
    crop = img.crop((left, top, left + side, top + side))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


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
) -> dict:
    from app.workflows.img2img import Img2ImgParams, build_img2img_graph

    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
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
    if port in _FORBIDDEN_WORKER_PORTS:
        raise CharacterSheetError(
            f"禁止使用生产/视频端口 :{port},设定卡仅允许 :8261-:8263",
            status_code=400,
        )


async def _pick_sheet_client(worker: str | None = None) -> Any:
    """仅从超分 fleet :8261-:8263 取客户端;禁止 pool/:8195/:8196/:8197/:8205。"""
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
            if port not in {8261, 8262, 8263}:
                raise CharacterSheetError(
                    f"worker 不在设定卡允许列表(:8261-:8263):{u}",
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
            if p.port not in {8261, 8262, 8263}:
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
            "出图 fleet :8261-:8263 不可用", status_code=503
        )
    # 优先 8263(常更空闲),其次 8261,8262
    def _rank(u: str) -> int:
        port = urlsplit(u).port or 0
        return {8263: 0, 8261: 1, 8262: 2}.get(port, 9)

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
) -> bytes:
    """单格出图 → PNG bytes。

    ref_mode: auto|ipa|img2img|none
      - anime 默认 img2img(规避 hassaku/IPA glitch)
      - ancient 默认 ipa
    注意:忽略 pool.pick,强制 :8261-:8263。
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
        if key in ("front", "side", "back") and ref_name:
            use_ref = ref_name
            # 三视图:优先 openpose;不可用则强 IPA(见 regenerate / _turnaround_mode)
            ref_mode = "ipa"
            denoise = 0.65
        elif key == "faces" and (face_ref_name or ref_name):
            use_ref = face_ref_name or ref_name
            ref_mode = "img2img" if meta.style == "anime" else "ipa"
            denoise = 0.58
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
            panel_urls[key] = save_panel_png(
                panels[key],
                character_id=character_id,
                style=meta.style,
                key=key,
            )

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
    """分数越高越好;side/back 优先非正脸(左右不对称 + 非居中大脸块)。"""
    if _panel_is_blank_or_glitch(data):
        return -1e9
    img = Image.open(BytesIO(data)).convert("RGB")
    w, h = img.size
    small = img.resize((48, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = small.size
    # 左右差:侧面/背面通常不对称或发际线偏一侧
    left = px[: sw * sh // 2] if False else [px[y * sw + x] for y in range(sh) for x in range(sw // 2)]
    right = [px[y * sw + x] for y in range(sh) for x in range(sw // 2, sw)]
    def _mean(cells):
        n = max(1, len(cells))
        return tuple(sum(c[i] for c in cells) / n for i in range(3))
    ml, mr = _mean(left), _mean(right)
    asym = sum(abs(ml[i] - mr[i]) for i in range(3))
    # 上半部中心肤色块面积(正脸偏高)
    face_score = 0.0
    for y in range(int(sh * 0.1), int(sh * 0.45)):
        for x in range(int(sw * 0.3), int(sw * 0.7)):
            r, g, b = px[y * sw + x]
            if r > 90 and g > 70 and b > 60 and r >= g - 10:
                face_score += 1.0
    face_score /= max(1, sw * sh)
    score = 100.0 - (face_score * 200.0 if key in ("side", "back") else 0.0)
    if key in ("side", "back"):
        score += asym * 0.8
    else:
        score += face_score * 50.0
    # 非空白奖励
    score += 10.0
    return score


def _pick_best_candidate(cands: list[bytes], key: str) -> bytes:
    if not cands:
        raise CharacterSheetError(f"无候选:{key}", status_code=500)
    if key in ("front", "side", "back"):
        ranked = sorted(
            cands, key=lambda b: _score_turnaround_candidate(b, key), reverse=True
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
    return ranked[0]


def collage_costume_items(items: list[bytes], *, style: str) -> bytes:
    """五件单品横排拼成 costume 区图;正方形格 + 包围盒 letterbox,不裁切。"""
    # 用接近版式区的宽扁画布,每格近似正方形,避免竖长条中心裁切
    n = max(1, len(items))
    cell = 256
    pad = 8
    w = n * cell + pad * 2
    h = cell + pad * 2
    bg = (240, 240, 244) if style == "anime" else (30, 32, 38)
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
            return not (r < 45 and g < 45 and b < 50)
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
    """五件(雨衣/裤/靴/伞/袋)各出图再 collage;禁真人穿着。"""
    del n_candidates  # 整卡路径各 1;分区重跑路径在 regenerate 里加候选
    suf = _STYLE_SUFFIX.get(meta.style, _STYLE_SUFFIX["anime"])
    item_bytes: list[bytes] = []
    for idx, (item_key, item_prompt) in enumerate(_COSTUME_ITEMS):
        prompt = f"{item_prompt}, {suf}"
        if item_key == "boots":
            prompt = (
                "pair of black rain boots, product shot, no person, "
                + prompt
                + ", footwear product photography only"
            )
        elif item_key == "pants":
            prompt = (
                "flat lay complete full-length black long pants trousers only, two long legs to ankles, "
                "NOT shorts, NOT knee-length, product shot, no person, no mannequin, garment fills frame, "
                + prompt
                + ", clothing only, not empty"
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
                "flat lay complete black hooded raincoat only, hood and sleeves visible, "
                "product shot, no person, no mannequin, garment fills frame, "
                + prompt
                + ", clothing only, not empty white frame"
            )
        w, h = (768, 768) if meta.style == "anime" else (512, 512)
        data = await generate_panel_bytes(
            pool,
            prompt,
            ckpt_name=ckpt,
            width=w,
            height=h,
            seed=None if seed is None else seed + 7000 + idx,
            worker=worker,
            filename_prefix=f"ToIV_char_sheet_costume_{item_key}",
            style=meta.style,
            client=client,
            ref_image=None,
            ref_mode="none",
            denoise=1.0,
        )
        item_bytes.append(data)
    return collage_costume_items(item_bytes, style=meta.style)


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

    # 还需预置正/侧/背骨架图资产;当前仓库无标准资产 → 不可用
    return False, "无预置正/侧/背 openpose 骨架图资产"


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
) -> bytes:
    """openpose ControlNet 出图(尺寸覆盖 EmptyLatent)。"""
    del pool
    from app.comfy.client import ComfyUIError
    from app.workflows.controlnet import ControlNetParams, build_controlnet_graph

    cli = client or await _pick_sheet_client(worker)
    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE["anime"])
    kw: dict[str, Any] = dict(
        positive=prompt,
        image=pose_image_name,
        control_type="openpose",
        negative=neg,
        ckpt_name=ckpt_name,
        strength=0.85,
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
            # 五件各出 n_candidates 再挑,再 collage
            picked_items: list[bytes] = []
            suf = _STYLE_SUFFIX.get(meta.style, _STYLE_SUFFIX["anime"])
            for idx, (item_key, item_prompt) in enumerate(_COSTUME_ITEMS):
                cands: list[bytes] = []
                prompt = f"{item_prompt}, {suf}"
                if item_key == "boots":
                    prompt = (
                        "pair of black rain boots, product shot, no person, "
                        + prompt
                        + ", footwear product photography only"
                    )
                elif item_key == "pants":
                    prompt = (
                        "flat lay complete black trousers only, two legs visible, product shot, "
                        "no person, no mannequin, garment fills frame, "
                        + prompt
                        + ", clothing only, not empty"
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
                # 00:01 父代理:回退文生图,不用模板 img2img(易出剪影)
                for ci in range(max(1, n_candidates)):
                    w, h = (768, 768) if meta.style == "anime" else (512, 512)
                    cands.append(
                        await generate_panel_bytes(
                            pool,
                            prompt,
                            ckpt_name=ckpt,
                            width=w,
                            height=h,
                            seed=None
                            if seed is None
                            else seed + 8000 + idx * 10 + ci,
                            worker=worker,
                            filename_prefix=f"ToIV_char_sheet_costume_{item_key}",
                            style=meta.style,
                            client=client,
                            ref_image=None,
                            ref_mode="none",
                            denoise=1.0,
                        )
                    )
                picked_items.append(_pick_best_candidate(cands, f"costume_{item_key}"))
            panels["costume"] = collage_costume_items(picked_items, style=meta.style)
            debug["picks"]["costume"] = {"items": [k for k, _ in _COSTUME_ITEMS]}
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
                    # 预留:有骨架图时走 openpose(当前 probe 恒 False)
                    pass
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
            elif key == "faces" and (face_ref_name or ref_name):
                use_ref = face_ref_name or ref_name
                ref_mode = "img2img" if meta.style == "anime" else "ipa"
                denoise = 0.58
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
