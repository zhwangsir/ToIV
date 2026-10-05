"""01:45：瞳色漂移门禁——0110 局红瞳假通过（整卡六门禁全过但眼变红）后的色相硬门禁。"""
from __future__ import annotations

import math
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _eye_band_png(hue_deg: float, size: int = 256) -> bytes:
    """纯色眼带测试图：中间一条目标色相的饱和带。"""
    im = Image.new("RGB", (size, size), (176, 175, 181))
    d = ImageDraw.Draw(im)
    h = hue_deg / 360.0
    r, g, b = _hsv_to_rgb(h, 0.8, 0.75)
    d.rectangle((32, 96, size - 32, 160), fill=(r, g, b))
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
    import colorsys

    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


def test_iris_hue_blue_vs_red_separated():
    blue = sheet_svc._iris_hue_in_band(
        Image.open(BytesIO(_eye_band_png(220.0))), (32, 96, 224, 160)
    )
    red = sheet_svc._iris_hue_in_band(
        Image.open(BytesIO(_eye_band_png(359.0))), (32, 96, 224, 160)
    )
    assert blue is not None and red is not None
    bh, _ = blue
    rh, _ = red
    diff = min(abs(bh - rh), 360 - abs(bh - rh))
    assert diff > 40.0  # 门禁阈值量级


def test_iris_hue_blue_variants_close():
    a = sheet_svc._iris_hue_in_band(
        Image.open(BytesIO(_eye_band_png(225.0))), (32, 96, 224, 160)
    )
    b = sheet_svc._iris_hue_in_band(
        Image.open(BytesIO(_eye_band_png(233.0))), (32, 96, 224, 160)
    )
    assert a is not None and b is not None
    diff = min(abs(a[0] - b[0]), 360 - abs(a[0] - b[0]))
    assert diff <= 40.0


def test_iris_hue_low_saturation_returns_none():
    im = Image.new("RGB", (256, 256), (176, 175, 181))  # 全低饱和灰
    assert sheet_svc._iris_hue_in_band(im, (32, 96, 224, 160)) is None


def test_assert_iris_hue_match_rejects_red_vs_blue(monkeypatch):
    hues = {"cell": 359.0, "ref": 233.0}
    seq = {"i": 0}

    def _fake(data):
        v = hues["cell"] if seq["i"] == 0 else hues["ref"]
        seq["i"] += 1
        return (v, 1000)

    monkeypatch.setattr(sheet_svc, "measure_iris_hue", _fake)
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_iris_hue_match(b"cell", b"ref", expr_key="expr_2")
    assert "瞳色漂移" in str(ei.value)


def test_assert_iris_hue_match_passes_blue_variants(monkeypatch):
    hues = {"cell": 231.0, "ref": 233.0}
    seq = {"i": 0}

    def _fake(data):
        v = hues["cell"] if seq["i"] == 0 else hues["ref"]
        seq["i"] += 1
        return (v, 1000)

    monkeypatch.setattr(sheet_svc, "measure_iris_hue", _fake)
    info = sheet_svc.assert_iris_hue_match(b"cell", b"ref", expr_key="expr_2")
    assert info["diff"] <= 40.0


def test_assert_iris_hue_match_skips_when_unmeasurable(monkeypatch):
    monkeypatch.setattr(sheet_svc, "measure_iris_hue", lambda data: None)
    info = sheet_svc.assert_iris_hue_match(b"cell", b"ref", expr_key="expr_2")
    assert info.get("skipped") is True


def test_real_images_blue_bases_agree_red_eye_flagged():
    """真图回归：0110 红瞳假通过必须被拦；蓝系底图互差须达标。"""
    import os

    blue2 = os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "tmp", "toiv_report_sheet_anime_1224", "out", "base_expr_2.png"
    )
    red = os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "tmp", "expr_2_ok_0110.png"
    )
    if not (os.path.isfile(blue2) and os.path.isfile(red)):
        pytest.skip("真图证据不在本机（CI 跳过）")
    b2 = open(blue2, "rb").read()
    rd = open(red, "rb").read()
    hb = sheet_svc.measure_iris_hue(b2)
    hr = sheet_svc.measure_iris_hue(rd)
    assert hb is not None and hr is not None
    diff = min(abs(hb[0] - hr[0]), 360 - abs(hb[0] - hr[0]))
    assert diff > 40.0
