"""17:14：徽标门禁相对母版正面，避免雨衣高光误杀。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image

from app.services.studio.character_sheet import (
    _chest_emblem_scores,
    portrait_has_chest_emblem,
)


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _slate_portrait(*, bright_patch: bool = False, color_logo: bool = False) -> bytes:
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (90, 106, 122)  # slate-ish
    # soft highlight band (raincoat specular)
    y0, y1 = int(h * 0.36), int(h * 0.48)
    x0, x1 = int(w * 0.40), int(w * 0.60)
    arr[y0:y1, x0:x1] = (130, 140, 150)
    if bright_patch:
        cy, cx = int(h * 0.40), int(w * 0.50)
        arr[cy - 8 : cy + 8, cx - 8 : cx + 8] = (240, 240, 240)
    if color_logo:
        cy, cx = int(h * 0.42), int(w * 0.50)
        arr[cy - 10 : cy + 10, cx - 14 : cx + 14] = (220, 40, 40)
    return _png(arr)


def test_master_like_specular_not_emblem_absolute():
    data = _slate_portrait()
    b, c, n = _chest_emblem_scores(data)
    assert c == 0
    assert portrait_has_chest_emblem(data) is False


def test_color_logo_hits_absolute():
    data = _slate_portrait(color_logo=True)
    assert portrait_has_chest_emblem(data) is True


def test_relative_keeps_specular_like_master():
    ref = _slate_portrait()
    portrait = _slate_portrait()
    assert portrait_has_chest_emblem(portrait, ref=ref) is False


def test_relative_rejects_new_color_logo():
    ref = _slate_portrait()
    portrait = _slate_portrait(color_logo=True)
    assert portrait_has_chest_emblem(portrait, ref=ref) is True
