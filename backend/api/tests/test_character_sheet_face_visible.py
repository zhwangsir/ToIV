"""fix17:锁定格人脸可见断言 + merge_video_refs 保留 sample 参考。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _chin_ear_crop(size: int = 768) -> bytes:
    """复现 06:48 锁定侧脸被裁成只剩下巴/耳朵:脸在底部小角。"""
    out = Image.new("RGB", (size, size), (20, 22, 28))
    d = ImageDraw.Draw(out)
    # 只在右下角一小块肤色(像耳/下巴)
    d.ellipse((size * 0.62, size * 0.72, size * 0.95, size * 0.98), fill=(210, 175, 155))
    d.ellipse((size * 0.78, size * 0.55, size * 0.98, size * 0.78), fill=(40, 35, 30))
    return _png(out)


def _good_face_panel(size: int = 768) -> bytes:
    out = Image.new("RGB", (size, size), (30, 32, 38))
    d = ImageDraw.Draw(out)
    # 头肩:脸居中偏上,面积足够
    d.ellipse((size * 0.28, size * 0.12, size * 0.72, size * 0.62), fill=(220, 185, 165))
    d.ellipse((size * 0.38, size * 0.28, size * 0.46, size * 0.36), fill=(40, 30, 30))
    d.ellipse((size * 0.54, size * 0.28, size * 0.62, size * 0.36), fill=(40, 30, 30))
    d.rectangle((size * 0.22, size * 0.58, size * 0.78, size * 0.98), fill=(45, 50, 70))
    return _png(out)


def test_assert_face_visible_blocks_chin_ear_crop():
    bad = _chin_ear_crop()
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_face_visible(bad, min_face_area=0.04)
    msg = str(ei.value).lower()
    assert "face" in msg


def test_assert_face_visible_passes_good_panel():
    good = _good_face_panel()
    bb = sheet_svc.assert_face_visible(good, min_face_area=0.04)
    assert bb[2] > bb[0] and bb[3] > bb[1]


def test_skip_reframe_lock_requires_face():
    bad = _chin_ear_crop()
    with pytest.raises(sheet_svc.CharacterSheetError):
        sheet_svc.enforce_head_shoulders_square(bad, size=768, skip_reframe=True)


def test_merge_video_refs_preserves_sample_linxia():
    existing = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/sample_linxia_side.png",
        "/api/studio/files/sample_linxia_full.png",
        "/api/studio/files/char_sheet_old.png",
    ]
    panels = {
        "portrait": "/api/studio/files/char_panel_x_portrait.png",
        "front": "/api/studio/files/char_panel_x_front.png",
        "side": "/api/studio/files/char_panel_x_side.png",
        "back": "/api/studio/files/char_panel_x_back.png",
    }
    out = sheet_svc.merge_video_refs(existing, panel_urls=panels, sheet_url="/api/studio/files/char_sheet_new.png")
    assert out[0] == panels["portrait"]
    assert panels["front"] in out and panels["side"] in out and panels["back"] in out
    assert "/api/studio/files/sample_linxia_front.png" in out
    assert "/api/studio/files/sample_linxia_side.png" in out
    assert "/api/studio/files/sample_linxia_full.png" in out
    assert all("char_sheet_" not in u for u in out)
    # JSON round-trip must succeed
    import json
    dumped = json.dumps(out, ensure_ascii=False)
    loaded = json.loads(dumped)
    assert loaded == out
    assert all(isinstance(u, str) for u in loaded)
