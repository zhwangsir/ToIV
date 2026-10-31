"""重拼前后锁定格像素一致（父代理 17:00）。"""
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


def _make_panels() -> dict[str, bytes]:
    panels = {
        "portrait": _solid((40, 80, 160), (720, 1180)),
        "front": _solid((60, 60, 60), (400, 900)),
        "side": _solid((90, 90, 90), (400, 900)),
        "back": _solid((120, 120, 120), (400, 900)),
        "faces": _solid((180, 140, 120), (720, 480)),
        "costume": _solid((30, 30, 30), (1100, 480)),
    }
    for i, c in enumerate(
        [(220, 60, 60), (60, 220, 60), (60, 60, 220), (220, 220, 60), (220, 60, 220), (60, 220, 220)]
    ):
        im = Image.new("RGB", (320, 320), c)
        d = ImageDraw.Draw(im)
        d.ellipse((40, 40, 280, 280), fill=(240, 200, 180))
        im.putpixel((10, 10), (i + 1, 2, 3))
        panels[f"expr_{i}"] = _png(im)
    return panels


def test_extract_keeps_existing_locked_bytes_identical():
    panels = _make_panels()
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        height_cm=168,
        role="便利店员",
        personality="温柔",
        design_notes="雨夜便利店。\n黑色雨衣。\n同源三视图。",
        visual_prompt="anime girl",
        description="林夏",
    )
    sheet = sheet_svc.compose_character_sheet(panels, meta)
    existing = {
        "faces": panels["faces"],
        "costume": panels["costume"],
        **{k: panels[k] for k in sheet_svc._EXPR_KEYS},
    }
    locked = sheet_svc.extract_locked_panels_from_sheet(sheet, existing=existing)
    for k, v in existing.items():
        assert locked[k] == v, k


def test_recompose_with_locked_panels_roundtrip_preserves_existing():
    """合成只用锁定文件；再次 extract(existing=锁定) 字节不变。"""
    panels = _make_panels()
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        height_cm=168,
        role="便利店员",
        personality="温柔",
        design_notes="雨夜便利店。\n黑色雨衣。\n同源三视图。",
        visual_prompt="anime girl",
        description="林夏",
    )
    locked = dict(panels)
    out1 = sheet_svc.compose_character_sheet(locked, meta)
    again = sheet_svc.extract_locked_panels_from_sheet(out1, existing=locked)
    for k in ("faces", "costume", *sheet_svc._EXPR_KEYS):
        assert again[k] == locked[k], k
    out2 = sheet_svc.compose_character_sheet(again, meta)
    again2 = sheet_svc.extract_locked_panels_from_sheet(out2, existing=locked)
    for k in ("faces", "costume", *sheet_svc._EXPR_KEYS):
        assert again2[k] == locked[k], k
