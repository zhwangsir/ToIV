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
_EXPR_LABELS = ("威严", "冷酷", "沉思", "温柔", "愤怒", "果断")
_EXPR_PROMPTS = (
    "stern majestic expression, serious face closeup",
    "cold aloof expression, icy gaze closeup",
    "thoughtful contemplative expression, looking slightly down closeup",
    "gentle soft smile, warm kind eyes closeup",
    "angry furious expression, furrowed brows closeup",
    "resolute determined expression, firm gaze closeup",
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
        "hanfu, ancient chinese clothing, white robe, white hanfu, "
        "multiple people, collage, split screen, grid"
    ),
    "anime": (
        "photorealistic, real photo, photograph, realistic skin pores, "
        "3d render, western cartoon, blurry, low quality, text, watermark, "
        "deformed, extra limbs, hanfu, ancient chinese clothing, white robe, "
        "multiple people, collage, split screen, grid"
    ),
}

_SHEET_CKPT = {
    "ancient_realistic": "DreamShaper_8_pruned.safetensors",
    "anime": "hassakuXLIllustrious_v34.safetensors",
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

# 角色服装关键词(现代雨夜便利店设定):服饰拆解强制对齐,禁汉服
_COSTUME_FORCE = (
    "flat lay product breakdown of black hooded raincoat, black windbreaker, "
    "black rain boots, white plastic shopping bag accessory, clothing pieces "
    "isolated on solid seamless background, no person, no face, no hanfu, "
    "no ancient costume, fashion design sheet"
)


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
        if u in ordered:
            continue
        rest.append(u.strip())
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
    # 强化现代雨衣设定,抑制汉服漂移
    extra = (
        "black hooded raincoat, black windbreaker, wet hair on forehead, "
        "young East Asian woman, convenience store clerk vibe"
    )
    if "raincoat" not in base.lower() and "雨衣" not in base and "windbreaker" not in base.lower():
        base = f"{base}, {extra}"
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
    prompts: dict[str, str] = {
        "portrait": (
            f"{base}, full body standing portrait of {name}, facing camera, "
            f"same outfit black hooded raincoat, {solid}, character design, {suf}"
        ),
        "front": (
            f"{base}, front view full body turnaround of {name}, orthographic, "
            f"same character same black hooded raincoat, standing straight, {solid}, {suf}"
        ),
        "side": (
            f"{base}, side view full body turnaround of {name}, orthographic profile, "
            f"same character same black hooded raincoat, standing straight, {solid}, {suf}"
        ),
        "back": (
            f"{base}, back view full body turnaround of {name}, orthographic from behind, "
            f"facing away, same character same black hooded raincoat, {solid}, {suf}"
        ),
        "faces": (
            f"{base}, face and hairstyle multi-angle closeups of {name}, "
            f"front three-quarter profile, hair details, {solid}, {suf}"
        ),
        "costume": f"{_COSTUME_FORCE}, {suf}",
    }
    for i, expr in enumerate(_EXPR_PROMPTS):
        prompts[f"expr_{i}"] = (
            f"{base}, {expr} of {name}, square headshot, shoulders up, "
            f"same face same wet black hair, {solid}, {suf}"
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
    small = img.convert("RGB").resize((48, 48), Image.Resampling.BOX)
    colors = small.getcolors(48 * 48) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    out: list[str] = []
    for _cnt, rgb in colors:
        r, g, b = rgb
        if max(r, g, b) < 28 or min(r, g, b) > 230:
            continue
        hx = f"#{r:02X}{g:02X}{b:02X}"
        if hx not in out:
            out.append(hx)
        if len(out) >= n:
            break
    while len(out) < n:
        h = (len(out) * 0.14) % 1.0
        r, g, b = colorsys.hsv_to_rgb(h, 0.45, 0.75)
        out.append(f"#{int(r*255):02X}{int(g*255):02X}{int(b*255):02X}")
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


def _compose_expression_grid(panels: dict[str, Image.Image]) -> Image.Image:
    """2x3 正方形表情格 + 底部标签区(标签由外层中文绘制,此处留白)。"""
    cell = 320
    label_h = 40
    cols, rows = 3, 2
    grid = Image.new("RGBA", (cols * cell, rows * (cell + label_h)), (0, 0, 0, 0))
    for i, key in enumerate(_EXPR_KEYS):
        img = panels.get(key)
        if img is None:
            raise CharacterSheetError(f"缺面板:{key}", status_code=500)
        row, col = divmod(i, cols)
        fitted, _ = _fit(img.convert("RGBA"), (0, 0, cell - 8, cell - 8), cover=True)
        ox = col * cell + 4
        oy = row * (cell + label_h) + 4
        grid.paste(fitted, (ox, oy), fitted)
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
        grid = _compose_expression_grid(expr_imgs)
        _paste(canvas, grid, (ex + 8, ey + 32, ew - 16, eh - 40), cover=False)
        # 每格下方标签
        cell_w = (ew - 24) // 3
        cell_h = (eh - 48) // 2
        for i, lab in enumerate(_EXPR_LABELS):
            row, col = divmod(i, 3)
            lx = ex + 12 + col * cell_w + cell_w // 2 - 18
            ly = ey + 32 + row * cell_h + int(cell_h * 0.72)
            draw.text((lx, ly), lab, font=font_label, fill=theme["text"])
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
    _paste(canvas, _as_image("costume"), (cx + 8, cy + 32, cw - 16, ch - 40), cover=True)

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
) -> bytes:
    """单格出图 → PNG bytes。有 ref_image 时走 IPAdapter;否则 txt2img。

    注意:忽略 pool.pick,强制 :8261-:8263,避免撞生产 :8195/:8196。
    """
    del pool  # 设定卡不走通用 WorkerPool
    from app.comfy.client import ComfyUIError

    cli = client or await _pick_sheet_client(worker)
    try:
        if ref_image:
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
    try:
        ref_name = await client.upload_image(
            panels["portrait"],
            f"sheet_ref_{character_id[:8]}_{meta.style}.png",
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("设定卡:上传立绘参考失败,三视图退回 txt2img: %s", e)
        ref_name = None

    # 3) 其余面板(三视图/脸/服饰/6 表情)
    need_keys = list(_PANEL_KEYS) + list(_EXPR_KEYS)
    for key in need_keys:
        if key == "portrait" or key in panels:
            continue
        w, h = _panel_size(key, meta.style)
        use_ref = ref_name if key in ("front", "side", "back", "faces", *_EXPR_KEYS) else None
        # costume 不绑脸参考,纯平铺
        panels[key] = await generate_panel_bytes(
            pool,
            prompts[key],
            ckpt_name=ckpt,
            width=w,
            height=h,
            seed=None if seed is None else seed + hash(key) % 10000,
            worker=worker,
            filename_prefix=f"ToIV_char_sheet_{key}",
            style=meta.style,
            client=client,
            ref_image=use_ref,
        )
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
