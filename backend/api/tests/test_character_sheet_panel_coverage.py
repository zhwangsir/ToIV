"""fix16:拼版面板覆盖率断言 — 拦缩水垫边、放过合格 cover。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc

_FIX15C = Path("/Users/wangzhenyu/Desktop/ALLProject/toiv_report_batch7_fix15c")
_FIX12B_SIDE = Path("/tmp/side12b.jpg")


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _postage_stamp_side(canvas: int = 768, stamp: int = 248) -> bytes:
    """合成复现 fix15c:小侧脸贴在大片深色空白中央。"""
    out = Image.new("RGB", (canvas, canvas), (20, 22, 28))
    face = Image.new("RGB", (stamp, stamp), (180, 175, 170))
    d = ImageDraw.Draw(face)
    d.ellipse((stamp * 0.25, stamp * 0.18, stamp * 0.78, stamp * 0.72), fill=(220, 190, 170))
    d.ellipse((stamp * 0.55, stamp * 0.08, stamp * 0.88, stamp * 0.32), fill=(25, 25, 30))
    d.rectangle((stamp * 0.30, stamp * 0.70, stamp * 0.70, stamp * 0.95), fill=(40, 35, 30))
    ox = (canvas - stamp) // 2
    oy = (canvas - stamp) // 2
    out.paste(face, (ox, oy))
    return _png(out)


def test_panel_coverage_blocks_synthetic_shrink():
    bad = _postage_stamp_side()
    ratio = sheet_svc.panel_content_coverage(bad)
    assert ratio < 0.90, ratio
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_panel_coverage(bad, min_ratio=0.90)
    assert "coverage" in str(ei.value).lower() or "shrunk" in str(ei.value).lower()


@pytest.mark.skipif(not (_FIX15C / "linxia_ancient_face_side_fix15c.jpg").is_file(), reason="no fix15c artifact")
def test_panel_coverage_blocks_real_fix15c_side_shrink():
    bad = (_FIX15C / "linxia_ancient_face_side_fix15c.jpg").read_bytes()
    ratio = sheet_svc.panel_content_coverage(bad)
    assert ratio < 0.50, ratio  # 实测约 0.23
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc.assert_panel_coverage(bad, min_ratio=0.90)


@pytest.mark.skipif(not (_FIX15C / "linxia_ancient_face_front_fix15c.jpg").is_file(), reason="no fix15c artifact")
def test_panel_coverage_passes_real_good_front():
    good = (_FIX15C / "linxia_ancient_face_front_fix15c.jpg").read_bytes()
    ratio = sheet_svc.assert_panel_coverage(good, min_ratio=0.90)
    assert ratio >= 0.90


def test_skip_reframe_lock_cover_fills_not_pad():
    """锁定小源图必须 cover 填满;旧垫边缩水必拦。"""
    bad = _postage_stamp_side()
    assert sheet_svc.panel_content_coverage(bad) < 0.90
    if _FIX12B_SIDE.is_file():
        raw = _FIX12B_SIDE.read_bytes()
    else:
        # 无实文件时造 248x480 头肩源(浅底+侧脸块)
        tall = Image.new("RGB", (248, 480), (175, 170, 165))
        d = ImageDraw.Draw(tall)
        d.ellipse((30, 20, 210, 230), fill=(220, 190, 170))
        d.ellipse((150, 5, 235, 90), fill=(25, 22, 28))
        d.rectangle((50, 220, 200, 400), fill=(55, 48, 40))
        # 贴满四边:左右肩/发丝碰到边,避免被当成空边
        d.rectangle((0, 0, 248, 12), fill=(30, 28, 32))
        d.rectangle((0, 0, 8, 480), fill=(40, 38, 42))
        d.rectangle((240, 0, 248, 480), fill=(40, 38, 42))
        raw = _png(tall)
    out = sheet_svc.enforce_head_shoulders_square(raw, size=768, skip_reframe=True)
    im = Image.open(BytesIO(out))
    assert im.size == (768, 768)
    ratio = sheet_svc.panel_content_coverage(out)
    assert ratio >= 0.90, ratio


def test_enforce_raises_on_empty_pad_canvas():
    empty = _png(Image.new("RGB", (64, 64), (20, 22, 28)))
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc.enforce_head_shoulders_square(empty, size=768, skip_reframe=True)
