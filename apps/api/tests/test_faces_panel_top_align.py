"""22:37 待办：面部面板上方空带不得偏高（顶对齐 + 收矮面板）。"""
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


def _make_panels_ancient() -> dict[str, bytes]:
    # 720×320 三格条：模拟等宽面部拼版（矮于面板内容区，居中会留上方空带）
    strip = Image.new("RGB", (720, 320), (20, 22, 28))
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


def test_fit_contain_valign_top():
    img = Image.new("RGB", (300, 100), (200, 100, 50))
    _fitted, pos = sheet_svc._fit(img, (0, 0, 300, 200), cover=False, valign="top")
    assert pos[1] == 0


def test_layout_faces_height_shrunk():
    assert sheet_svc.LAYOUT["faces"][3] == 400
    assert sheet_svc.LAYOUT["expressions"][3] == 400
    assert sheet_svc.LAYOUT["costume"][1] == 2220


def test_faces_panel_top_empty_band_le_24px():
    panels = _make_panels_ancient()
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="ancient_realistic",
        height_cm=168,
        role="侠女",
        personality="果断",
        design_notes="黑金交领。\n披发。\n同人设定。",
        visual_prompt="ancient",
        description="林夏",
    )
    png = sheet_svc.compose_character_sheet(panels, meta)
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
