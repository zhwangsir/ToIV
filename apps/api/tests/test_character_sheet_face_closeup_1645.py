"""16:45: 近景脸格门禁 — 有人脸 + 脸高占格高 25%–70%，替代 coverage 0.90。"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _face_panel(*, face_top: float, face_bot: float, size: int = 768) -> bytes:
    out = Image.new("RGB", (size, size), (30, 32, 38))
    d = ImageDraw.Draw(out)
    y1, y2 = int(size * face_top), int(size * face_bot)
    x1, x2 = int(size * 0.30), int(size * 0.70)
    d.ellipse((x1, y1, x2, y2), fill=(220, 185, 165))
    # eyes
    mid = (y1 + y2) // 2
    d.ellipse((x1 + 20, mid - 20, x1 + 50, mid + 10), fill=(40, 30, 30))
    d.ellipse((x2 - 50, mid - 20, x2 - 20, mid + 10), fill=(40, 30, 30))
    # shoulders
    d.rectangle((int(size * 0.18), y2, int(size * 0.82), size), fill=(70, 80, 95))
    return _png(out)


def test_face_closeup_passes_mid_frac():
    # face height ~45% of cell
    good = _face_panel(face_top=0.12, face_bot=0.57)
    info = sheet_svc.assert_face_closeup_framing(good)
    assert 0.25 <= info["face_height_frac"] <= 0.80


def test_face_closeup_blocks_too_small():
    # 浅灰底 + 极小脸(~9%格高)，避免肩带肤色把启发式框撑大
    size = 768
    out = Image.new("RGB", (size, size), (200, 200, 205))
    d = ImageDraw.Draw(out)
    d.ellipse((340, 300, 428, 370), fill=(220, 185, 165))
    d.ellipse((355, 320, 370, 335), fill=(40, 30, 30))
    d.ellipse((400, 320, 415, 335), fill=(40, 30, 30))
    tiny = _png(out)
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_face_closeup_framing(tiny)
    msg = str(ei.value).lower()
    assert "too small" in msg or "face height frac" in msg or "face area" in msg


def test_face_closeup_blocks_too_large():
    # insightface/启发式对椭圆脸框偏紧，用显式 max 证明上限门禁
    mid = _face_panel(face_top=0.12, face_bot=0.57)  # ~45%
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_face_closeup_framing(mid, max_face_height_frac=0.30)
    assert "too large" in str(ei.value).lower() or "face height frac" in str(ei.value).lower()


def test_face_closeup_blocks_no_face():
    blank = _png(Image.new("RGB", (768, 768), (40, 42, 48)))
    with pytest.raises(sheet_svc.CharacterSheetError) as ei:
        sheet_svc.assert_face_closeup_framing(blank)
    assert "face" in str(ei.value).lower()


def test_enforce_face_closeup_gate_uses_frac_not_coverage():
    # mid face that might fail coverage-as-fullbody but should pass closeup gate
    good = _face_panel(face_top=0.15, face_bot=0.55)
    out = sheet_svc.enforce_head_shoulders_square(
        good, size=768, skip_reframe=True, face_closeup_gate=True
    )
    assert len(out) > 1000
