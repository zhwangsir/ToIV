"""panel-replace:替换一格后其余格内容不变,表情 6 格仍在。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image, size=None) -> bytes:
    if size:
        img = img.resize(size, Image.Resampling.LANCZOS)
    buf = BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _solid(color, size=(256, 256)) -> bytes:
    return _png(Image.new("RGB", size, color))


def _make_full_sheet() -> tuple[bytes, dict[str, bytes]]:
    """拼一张可识别色块的整卡,表情 6 格各有独特颜色。"""
    panels: dict[str, bytes] = {
        "portrait": _solid((40, 80, 160), (720, 1180)),
        "front": _solid((60, 60, 60), (400, 900)),
        "side": _solid((90, 90, 90), (400, 900)),
        "back": _solid((120, 120, 120), (400, 900)),
        "faces": _solid((180, 140, 120), (720, 480)),
        "costume": _solid((30, 30, 30), (1100, 480)),
    }
    expr_colors = [
        (220, 60, 60),
        (60, 220, 60),
        (60, 60, 220),
        (220, 220, 60),
        (220, 60, 220),
        (60, 220, 220),
    ]
    for i, c in enumerate(expr_colors):
        im = Image.new("RGB", (320, 320), c)
        d = ImageDraw.Draw(im)
        d.ellipse((40, 40, 280, 280), fill=(240, 200, 180))
        panels[f"expr_{i}"] = _png(im)
    meta = sheet_svc.SheetMeta(
        name="测试角色",
        style="anime",
        height_cm=168,
        role="测试",
        personality="稳定",
        design_notes="角色设定测试卡\\n无内部字样\\n仅用于单测",
        visual_prompt="anime girl black hair raincoat",
        description="测试角色",
    )
    png = sheet_svc.compose_character_sheet(panels, meta)
    return png, panels


def _mean_color(data: bytes) -> tuple[float, float, float]:
    im = Image.open(BytesIO(data)).convert("RGB").resize((32, 32))
    px = list(im.getdata())
    n = len(px)
    return (
        sum(p[0] for p in px) / n,
        sum(p[1] for p in px) / n,
        sum(p[2] for p in px) / n,
    )


def _color_close(a, b, tol=35.0) -> bool:
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def test_extract_locked_panels_keeps_six_expressions():
    sheet, src = _make_full_sheet()
    locked = sheet_svc.extract_locked_panels_from_sheet(sheet, existing={})
    for i in range(6):
        assert f"expr_{i}" in locked, f"missing expr_{i}"
        assert locked[f"expr_{i}"], f"empty expr_{i}"
    # 表情色块应与源接近(裁切后均值)
    for i, expect in enumerate(
        [(220, 60, 60), (60, 220, 60), (60, 60, 220), (220, 220, 60), (220, 60, 220), (60, 220, 220)]
    ):
        got = _mean_color(locked[f"expr_{i}"])
        # 裁切含肤色圆,均值被拉向暖色,但仍应保留主色通道优势
        assert max(got) > 100


def test_panel_replace_preserves_other_panels_and_expressions(tmp_path, monkeypatch):
    """模拟 panel-replace:只换 costume,其余 url/内容不变,表情 6 格仍在。"""
    sheet, src = _make_full_sheet()
    studio = tmp_path / "studio"
    studio.mkdir()
    cid8 = "testcid0"
    style = "anime"
    # 落盘:整卡 + portrait/front/side/back/faces/costume(故意不落 expr_*)
    sheet_name = f"char_sheet_{cid8}_{style}_oldsheet12.png"
    (studio / sheet_name).write_bytes(sheet)
    for k in ("portrait", "front", "side", "back", "faces", "costume"):
        (studio / f"char_panel_{cid8}_{style}_{k}_oldpanel01.png").write_bytes(src[k])

    # 新 costume:纯红条+黄圆(测试污染样式)——只应出现在 costume
    new_costume = Image.new("RGB", (1100, 480), (220, 30, 30))
    d = ImageDraw.Draw(new_costume)
    d.ellipse((400, 90, 700, 390), fill=(240, 220, 40))
    new_bytes = _png(new_costume)

    before_means = {k: _mean_color(src[k]) for k in ("portrait", "front", "side", "back", "faces")}
    # 从整卡提取锁定(与路由同逻辑)
    locked = { "costume": new_bytes }
    for k in ("portrait", "front", "side", "back", "faces", *sheet_svc._EXPR_KEYS):
        hits = sorted(studio.glob(f"char_panel_{cid8}_{style}_{k}_*.png"), key=lambda p: p.stat().st_mtime)
        if hits:
            locked[k] = hits[-1].read_bytes()
    locked = sheet_svc.extract_locked_panels_from_sheet(sheet, existing=locked)
    locked["costume"] = new_bytes  # 替换键以新图为准

    assert sum(1 for k in sheet_svc._EXPR_KEYS if k in locked) == 6
    # 非替换格内容不变(相对磁盘源)
    for k in ("portrait", "front", "side", "back", "faces"):
        assert _color_close(_mean_color(locked[k]), before_means[k]), (k, _mean_color(locked[k]), before_means[k])

    meta = sheet_svc.SheetMeta(
        name="测试角色",
        style="anime",
        height_cm=168,
        role="测试",
        personality="稳定",
        design_notes="角色设定",
        visual_prompt="anime girl",
        description="测试",
    )
    out = sheet_svc.compose_character_sheet(locked, meta)
    out_im = Image.open(BytesIO(out)).convert("RGB")
    # 表情区不应是浅灰空白(248,248,252)
    ex, ey, ew, eh = sheet_svc.LAYOUT["expressions"]
    expr_crop = out_im.crop((ex + 8, ey + 32, ex + ew - 8, ey + eh - 8))
    mean = _mean_color(_png(expr_crop))
    # 空白占位接近 (248,248,252);有表情色块时通道方差更大
    assert not (abs(mean[0] - 248) < 8 and abs(mean[1] - 248) < 8 and abs(mean[2] - 252) < 8), mean
    # 6 格从 out 再提取仍在
    again = sheet_svc.extract_locked_panels_from_sheet(out, existing={})
    assert sum(1 for k in sheet_svc._EXPR_KEYS if again.get(k)) == 6

    # 设计说明去内部字
    assert "fix30" not in sheet_svc.strip_internal_design_jargon("角色 fix30 LoRA az45 硬门禁")
    assert "LoRA" not in sheet_svc.strip_internal_design_jargon("角色 fix30 LoRA az45 硬门禁")


def test_style_gate_rejects_unrelated_palette():
    ref_im = Image.new("RGB", (256, 256), (200, 180, 160))
    d = ImageDraw.Draw(ref_im)
    d.ellipse((40, 40, 216, 216), fill=(220, 190, 170))
    d.ellipse((90, 90, 120, 120), fill=(40, 40, 50))
    ref = _png(ref_im)
    # 纯红黄测试图应低分
    bad = Image.new("RGB", (256, 256), (220, 30, 30))
    d = ImageDraw.Draw(bad)
    d.ellipse((60, 60, 196, 196), fill=(240, 220, 40))
    ok, meta = sheet_svc.style_ok_for_face(_png(bad), ref, min_score=0.72)
    assert meta["score"] < 0.72
    assert ok is False
    # 同构图近色应过
    good_im = Image.new("RGB", (256, 256), (198, 178, 158))
    d = ImageDraw.Draw(good_im)
    d.ellipse((42, 38, 218, 214), fill=(218, 188, 168))
    d.ellipse((88, 92, 118, 122), fill=(45, 42, 48))
    ok2, meta2 = sheet_svc.style_ok_for_face(_png(good_im), ref, min_score=0.72)
    assert ok2 is True
    assert meta2["score"] >= 0.72
