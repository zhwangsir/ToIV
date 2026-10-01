"""角色设定卡:分格出图 + Pillow 固定版式拼版 + 真中文字体排版。

版式(用户 10/1 硬规格):
  左:大立绘 + 名字 + 基本资料表
  中:带身高刻度的三视图(正/侧/背)
  下:面部/发型多角度、表情排列、服饰饰品拆解、配色色板、设计说明

风格:ancient_realistic | anime
产出落盘 /api/studio/files/char_sheet_*.png,写入角色 reference_images(设定卡置前)。
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

from PIL import Image, ImageDraw, ImageFont

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

SHEET_STYLES = ("ancient_realistic", "anime")
SHEET_W, SHEET_H = 2400, 3200
_PANEL_KEYS = ("portrait", "front", "side", "back", "faces", "expressions", "costume")
_EXPR_LABELS = ("威严", "冷酷", "沉思", "温柔", "愤怒", "果断")
_CHAR_SHEET_MARK = "char_sheet_"
_POLL_INTERVAL = 2.0
_POLL_TIMEOUT = 420.0
_MAX_REFS = 8

# 固定几何(像素):拼版单测锁定这些矩形
LAYOUT = {
    "canvas": (SHEET_W, SHEET_H),
    "portrait": (48, 48, 720, 1180),  # x,y,w,h
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
        "Chinese ancient historical realism, cinematic lighting, detailed fabric, "
        "photorealistic character design sheet, clean white background"
    ),
    "anime": (
        "anime character design sheet, clean lineart, cel shading, "
        "official art style, white background, highly detailed"
    ),
}

_CJK_FONT_CANDIDATES = (
    # macOS
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    str(Path.home() / "Library/Fonts/SimSun-Regular.ttf"),
    str(Path.home() / "Library/Fonts/SourceHanSansSC-Regular.otf"),
    # Linux / core
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/source-han-sans/SourceHanSansSC-Regular.otf",
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
        # 冒烟:必须能量测汉字宽度
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


def merge_sheet_into_refs(existing: list[str], sheet_url: str) -> list[str]:
    """设定卡置前;去掉旧设定卡 URL;其余三视图等保留;上限 8。"""
    rest = [u for u in existing if isinstance(u, str) and u.strip() and not is_sheet_url(u)]
    merged = [sheet_url] + rest
    return merged[:_MAX_REFS]


def build_panel_prompts(meta: SheetMeta) -> dict[str, str]:
    """各分区英文出图提示(风格后缀统一追加)。"""
    style = meta.style if meta.style in SHEET_STYLES else "anime"
    base = (meta.visual_prompt or meta.description or meta.name).strip()
    if not base:
        raise CharacterSheetError("角色缺少视觉描述", status_code=422)
    suf = _STYLE_SUFFIX[style]
    name = meta.name
    return {
        "portrait": (
            f"{base}, full body standing portrait of {name}, facing camera, "
            f"character design, {suf}"
        ),
        "front": f"{base}, front view full body turnaround, orthographic, {suf}",
        "side": f"{base}, side view full body turnaround, orthographic, {suf}",
        "back": f"{base}, back view full body turnaround, orthographic, {suf}",
        "faces": (
            f"{base}, face and hairstyle multi-angle closeups, "
            f"front three-quarter profile, hair details, {suf}"
        ),
        "expressions": (
            f"{base}, expression sheet six panels: "
            f"stern, cold, thoughtful, gentle, angry, resolute, "
            f"face closeups grid, {suf}"
        ),
        "costume": (
            f"{base}, costume and accessories breakdown, clothing details, "
            f"props callouts, design sheet, {suf}"
        ),
    }


def _fit(img: Image.Image, box: tuple[int, int, int, int], *, cover: bool = True):
    """将 img 缩放贴入 canvas 上的 box(就地画到调用方传入的目标需在外层 paste)。"""
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


def _paste(canvas: Image.Image, img: Image.Image, box: tuple[int, int, int, int], *, cover: bool = True) -> None:
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
    """绘制文本,可选按 max_width 换行;返回占用高度。"""
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
) -> None:
    x, y, w, h = box
    draw.rounded_rectangle([x, y, x + w, y + h], radius=12, outline=(200, 200, 210), width=2)
    if label:
        draw.text((x + 10, y + 8), label, font=font, fill=(120, 120, 130))


def _extract_palette(img: Image.Image, n: int = 6) -> list[str]:
    """从立绘抽样主色 → #RRGGBB 列表。"""
    small = img.convert("RGB").resize((48, 48), Image.Resampling.BOX)
    colors = small.getcolors(48 * 48) or []
    colors.sort(key=lambda c: c[0], reverse=True)
    out: list[str] = []
    for _cnt, rgb in colors:
        r, g, b = rgb
        # 跳过近白/近黑
        if max(r, g, b) < 28 or min(r, g, b) > 230:
            continue
        hx = f"#{r:02X}{g:02X}{b:02X}"
        if hx not in out:
            out.append(hx)
        if len(out) >= n:
            break
    while len(out) < n:
        # 风格兜底色
        h = (len(out) * 0.14) % 1.0
        r, g, b = colorsys.hsv_to_rgb(h, 0.45, 0.75)
        out.append(f"#{int(r*255):02X}{int(g*255):02X}{int(b*255):02X}")
    return out[:n]


def _draw_height_scale(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    height_cm: int,
    font: ImageFont.ImageFont,
) -> None:
    x, y, w, h = box
    scale_x = x + 28
    top, bottom = y + 60, y + h - 40
    draw.line([(scale_x, top), (scale_x, bottom)], fill=(80, 80, 90), width=3)
    ticks = 8
    for i in range(ticks + 1):
        ty = top + int((bottom - top) * i / ticks)
        draw.line([(scale_x - 8, ty), (scale_x + 8, ty)], fill=(80, 80, 90), width=2)
        cm = int(height_cm * (1 - i / ticks))
        draw.text((scale_x + 14, ty - 8), f"{cm}", font=font, fill=(90, 90, 100))
    draw.text((scale_x - 10, bottom + 8), "cm", font=font, fill=(90, 90, 100))


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
    else:  # pragma: no cover - 测试可注入
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

    canvas = Image.new("RGBA", (SHEET_W, SHEET_H), (248, 248, 252, 255))
    draw = ImageDraw.Draw(canvas)

    # 标题条
    style_zh = "古风写实" if meta.style == "ancient_realistic" else "二次元"
    draw.rectangle([0, 0, SHEET_W, 36], fill=(40, 40, 48, 255))
    draw.text((48, 6), f"角色设定卡 · {style_zh}", font=font_label, fill=(230, 230, 235))

    # 左:立绘
    portrait = _as_image("portrait")
    _paste(canvas, portrait, LAYOUT["portrait"], cover=True)
    _draw_panel_frame(draw, LAYOUT["portrait"], "立绘", font_label)

    # 名字
    nx, ny, nw, nh = LAYOUT["name"]
    draw.rounded_rectangle([nx, ny, nx + nw, ny + nh], radius=8, fill=(40, 40, 48))
    draw.text((nx + 20, ny + 12), meta.name.strip(), font=font_title, fill=(250, 250, 252))

    # 资料表
    px, py, pw, ph = LAYOUT["profile"]
    draw.rounded_rectangle([px, py, px + pw, py + ph], radius=10, outline=(200, 200, 210), width=2)
    role = meta.role or _guess_field(meta.description, "身份") or "—"
    personality = meta.personality or _guess_field(meta.description, "性格") or (meta.description[:40] or "—")
    rows = [
        ("身高", f"{meta.height_cm} cm"),
        ("身份", role),
        ("性格", personality),
        ("风格", style_zh),
    ]
    yy = py + 24
    for k, v in rows:
        draw.text((px + 24, yy), k, font=font_small, fill=(120, 120, 130))
        _text(draw, (px + 120, yy), str(v)[:48], font_body, max_width=pw - 160)
        yy += 56

    # 中:三视图 + 身高刻度
    tx, ty, tw, th = LAYOUT["turnaround"]
    draw.rounded_rectangle([tx, ty, tx + tw, ty + th], radius=12, outline=(200, 200, 210), width=2)
    draw.text((tx + 16, ty + 12), "三视图", font=font_label, fill=(120, 120, 130))
    _draw_height_scale(draw, (tx, ty, 100, th), meta.height_cm, font_small)
    view_w = (tw - 140) // 3
    view_box_y = ty + 50
    view_h = th - 90
    for i, key in enumerate(("front", "side", "back")):
        box = (tx + 110 + i * view_w, view_box_y, view_w - 12, view_h)
        _paste(canvas, _as_image(key), box, cover=False)
        label = {"front": "正", "side": "侧", "back": "背"}[key]
        draw.text((box[0] + view_w // 2 - 20, ty + th - 36), label, font=font_body, fill=(60, 60, 70))

    # 下:面部
    _draw_panel_frame(draw, LAYOUT["faces"], "面部/发型", font_label)
    fx, fy, fw, fh = LAYOUT["faces"]
    _paste(canvas, _as_image("faces"), (fx + 8, fy + 32, fw - 16, fh - 40), cover=True)

    # 表情
    _draw_panel_frame(draw, LAYOUT["expressions"], "表情", font_label)
    ex, ey, ew, eh = LAYOUT["expressions"]
    _paste(canvas, _as_image("expressions"), (ex + 8, ey + 32, ew - 16, eh - 72), cover=True)
    chip_w = (ew - 24) // len(_EXPR_LABELS)
    for i, lab in enumerate(_EXPR_LABELS):
        draw.text((ex + 12 + i * chip_w, ey + eh - 36), lab, font=font_label, fill=(70, 70, 80))

    # 服饰
    _draw_panel_frame(draw, LAYOUT["costume"], "服饰/饰品", font_label)
    cx, cy, cw, ch = LAYOUT["costume"]
    _paste(canvas, _as_image("costume"), (cx + 8, cy + 32, cw - 16, ch - 40), cover=True)

    # 色板
    colors = list(meta.colors) if meta.colors else _extract_palette(portrait)
    colors = [_normalize_hex(c) for c in colors if _normalize_hex(c)]
    if not colors:
        colors = _extract_palette(portrait)
    plx, ply, plw, plh = LAYOUT["palette"]
    _draw_panel_frame(draw, LAYOUT["palette"], "配色", font_label)
    sw = (plw - 24) // max(1, len(colors))
    for i, hx in enumerate(colors[:8]):
        rgb = tuple(int(hx[j : j + 2], 16) for j in (1, 3, 5))
        sx = plx + 12 + i * sw
        draw.rounded_rectangle([sx, ply + 40, sx + sw - 8, ply + plh - 36], radius=6, fill=rgb)
        draw.text((sx + 4, ply + plh - 30), hx, font=font_label, fill=(80, 80, 90))

    # 设计说明
    nx2, ny2, nw2, nh2 = LAYOUT["notes"]
    _draw_panel_frame(draw, LAYOUT["notes"], "设计说明", font_label)
    notes = (meta.design_notes or meta.description or meta.visual_prompt or "").strip() or "—"
    _text(
        draw,
        (nx2 + 16, ny2 + 36),
        notes[:280],
        font_small,
        fill=(50, 50, 60),
        max_width=nw2 - 32,
    )

    # footer
    ftx, fty, ftw, _ = LAYOUT["footer"]
    draw.text(
        (ftx, fty + 20),
        f"ToIV · {meta.name} · {style_zh} · Ref2VA",
        font=font_label,
        fill=(140, 140, 150),
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
    # 简单「身份:xxx」「性格：xxx」
    m = re.search(rf"{key}\s*[:：]\s*([^\n;；|/]+)", description)
    return (m.group(1).strip() if m else "")[:40]


def save_sheet_png(data: bytes, *, character_id: str, style: str) -> str:
    """落盘 studio 目录,返回 /api/studio/files URL。"""
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{_CHAR_SHEET_MARK}{character_id[:8]}_{style}_{uuid.uuid4().hex[:12]}.png"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def placeholder_panel(color: tuple[int, int, int], size: tuple[int, int] = (512, 768)) -> Image.Image:
    """单测用纯色面板。"""
    img = Image.new("RGBA", size, (*color, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, size[0] - 20, size[1] - 20], outline=(255, 255, 255, 180), width=4)
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
) -> bytes:
    """单格 txt2img → PNG bytes。无可用 worker → 503。"""
    from app.comfy.client import ComfyUIError
    from app.deps import resolve_worker
    from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

    params_kw: dict = dict(
        positive=prompt,
        negative="blurry, low quality, text, watermark, deformed, extra limbs",
        ckpt_name=ckpt_name,
        width=width,
        height=height,
        filename_prefix=filename_prefix,
    )
    if seed is not None:
        params_kw["seed"] = seed
    graph = build_txt2img_graph(Txt2ImgParams(**params_kw))
    try:
        if worker:
            client = resolve_worker(worker)
        else:
            client = await pool.pick(required={ckpt_name})
        prompt_id = await client.queue_prompt(graph, client_id=uuid.uuid4().hex)
    except ComfyUIError as e:
        raise CharacterSheetError(f"出图后端不可用:{e}", status_code=503) from e
    except Exception as e:  # noqa: BLE001
        raise CharacterSheetError(f"出图提交失败:{e}", status_code=503) from e

    images = await _wait_images(client, prompt_id)
    img = images[0]
    try:
        data, _ = await client.get_image_bytes(
            img["filename"], img.get("subfolder", ""), img.get("type", "output")
        )
    except ComfyUIError as e:
        raise CharacterSheetError(f"取图失败:{e}", status_code=502) from e
    return data


async def load_image_bytes_from_url(url: str) -> bytes | None:
    """读取本服务 studio/files 或可直链图;失败返回 None。"""
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
            r = await client.get(u if u.startswith("http") else f"http://127.0.0.1:8090{u}")
            ctype = r.headers.get("content-type", "")
            if r.status_code == 200 and (
                r.content[:4] == b'\x89PNG' or ctype.startswith("image/")
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
) -> tuple[str, bytes]:
    """出齐分格 → 拼版 → 落盘。返回 (url, png_bytes)。

    reuse_ref_urls:既有三视图 URL(非设定卡),可复用为 front/side/back/portrait 降负载。
    """
    from app.config import get_settings

    if not (meta.name or "").strip():
        raise CharacterSheetError("角色名为空", status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(
            f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422
        )
    # 字体预检(避免出完图才发现)
    resolve_cjk_font(24)

    prompts = build_panel_prompts(meta)
    panels: dict[str, bytes] = dict(panels_override or {})

    # 复用角色已有三视图,减少 GPU 出图次数
    views = [u for u in (reuse_ref_urls or []) if u and not is_sheet_url(u)]
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

    missing = [k for k in _PANEL_KEYS if k not in panels]
    ckpt = ckpt_name or get_settings().default_ckpt
    for key in missing:
        panels[key] = await generate_panel_bytes(
            pool,
            prompts[key],
            ckpt_name=ckpt,
            seed=seed,
            worker=worker,
            filename_prefix=f"ToIV_char_sheet_{key}",
        )
    png = compose_character_sheet(panels, meta)
    url = save_sheet_png(png, character_id=character_id, style=meta.style)
    return url, png
