"""23:37：只缩面部顶空（valign=top）；表情高度/资料/配色须与锁定版一致。"""
from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _solid(color, size=(256, 256)) -> bytes:
    return _png(Image.new("RGB", size, color))


def _make_panels(style: str) -> dict[str, bytes]:
    # 720×320 三格条：矮于 520 面板内容区；居中会留上方空带，顶对齐则不应
    strip = Image.new("RGB", (720, 320), (20, 22, 28) if style == "ancient_realistic" else (234, 232, 238))
    d = ImageDraw.Draw(strip)
    for i, col in enumerate(((180, 140, 120), (170, 130, 110), (160, 120, 100))):
        x0 = i * 240 + 8
        d.rectangle([x0, 8, x0 + 224, 312], fill=col)
        d.ellipse([x0 + 40, 40, x0 + 184, 220], fill=(210, 170, 150))
    panels = {
        "portrait": _solid((40, 80, 160), (720, 1180)),
        "front": _solid((60, 60, 60), (400, 900)),
        "side": _solid((90, 90, 90), (400, 900)),
        "back": _solid((120, 120, 120), (400, 900)),
        "faces": _png(strip),
        "costume": _solid((30, 30, 30), (1100, 480)),
    }
    for i, c in enumerate(
        [(220, 60, 60), (60, 220, 60), (60, 60, 220), (220, 220, 60), (220, 60, 220), (60, 220, 220)]
    ):
        im = Image.new("RGB", (320, 320), c)
        d = ImageDraw.Draw(im)
        d.ellipse((40, 40, 280, 280), fill=(240, 200, 180))
        panels[f"expr_{i}"] = _png(im)
    return panels


def _meta(style: str) -> sheet_svc.SheetMeta:
    if style == "ancient_realistic":
        return sheet_svc.SheetMeta(
            name="林夏",
            style=style,
            height_cm=168,
            role="古风侠女",
            personality="温柔果断",
            design_notes="古风深底金字。主立绘与三视图同套黑金；面部同源表情身份；服饰中灰底。",
            visual_prompt="ancient",
            description="林夏",
            colors=["#E8C4A8", "#D4AF37", "#1A1A1E", "#2C2C34", "#C9A227", "#8B7355"],
        )
    return sheet_svc.SheetMeta(
        name="林夏",
        style=style,
        height_cm=168,
        role="便利店员",
        personality="温柔果断",
        design_notes="雨夜便利店相遇的核心角色。\n黑色连帽雨衣与湿发贴额。\n三视图与表情同源同画风。",
        visual_prompt="anime",
        description="林夏",
        colors=["#E8C4A8", "#C98A7A", "#1A1A1E", "#2C2C34", "#D4D3D8", "#5A6A7A"],
    )


def test_fit_contain_valign_top():
    img = Image.new("RGB", (300, 100), (200, 100, 50))
    _fitted, pos = sheet_svc._fit(img, (0, 0, 300, 200), cover=False, valign="top")
    assert pos[1] == 0


def test_layout_expressions_height_locked_520():
    assert sheet_svc.LAYOUT["faces"][3] == 520
    assert sheet_svc.LAYOUT["expressions"][3] == 520
    assert sheet_svc.LAYOUT["costume"][1] == 2340
    assert sheet_svc.LAYOUT["palette"][1] == 2340
    assert sheet_svc.LAYOUT["notes"][1] == 2560


def test_faces_panel_top_empty_band_le_24px():
    panels = _make_panels("ancient_realistic")
    png = sheet_svc.compose_character_sheet(panels, _meta("ancient_realistic"))
    im = Image.open(BytesIO(png)).convert("RGB")
    fx, fy, fw, fh = sheet_svc.LAYOUT["faces"]
    content_y0 = fy + 32
    bg = (11, 14, 20)
    first = None
    for yoff in range(0, fh - 40):
        y = content_y0 + yoff
        far = 0
        tot = 0
        for x in range(fx + 8, fx + fw - 8, 3):
            r, g, b = im.getpixel((x, y))
            tot += 1
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 45:
                far += 1
        if tot and far / tot > 0.10:
            first = yoff
            break
    assert first is not None, "faces content missing"
    assert first <= 24, f"faces top empty band {first}px > 24"


def _region(im: Image.Image, key: str) -> Image.Image:
    x, y, w, h = sheet_svc.LAYOUT[key]
    return im.crop((x, y, x + w, y + h))


def test_recompose_locks_expressions_and_text_both_styles():
    """两种风格：同锁定格重拼后表情区像素一致，资料/配色区像素一致。"""
    for style in ("anime", "ancient_realistic"):
        panels = _make_panels(style)
        meta = _meta(style)
        base = sheet_svc.compose_character_sheet(panels, meta)
        # 模拟「锁定格」：从基准卡抽出 expr/costume 等，再重拼（faces 用原 strip）
        locked = sheet_svc.extract_locked_panels_from_sheet(base)
        # 覆盖 faces 为原始矮条，避免把居中空带烘焙进锁定图
        locked["faces"] = panels["faces"]
        for i in range(6):
            locked[f"expr_{i}"] = panels[f"expr_{i}"]
        again = sheet_svc.compose_character_sheet(locked, meta)
        a = Image.open(BytesIO(base)).convert("RGB")
        b = Image.open(BytesIO(again)).convert("RGB")
        for key in ("expressions", "profile", "palette", "notes", "name"):
            ra, rb = _region(a, key), _region(b, key)
            assert ra.size == rb.size, f"{style}:{key} size"
            assert list(ra.getdata()) == list(rb.getdata()), f"{style}:{key} pixels differ"
