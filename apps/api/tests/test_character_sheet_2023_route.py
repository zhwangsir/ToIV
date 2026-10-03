"""20:23：侧面≤2×、表情五官提示/张嘴、服饰坐标裁≥60%。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _figure() -> bytes:
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (240, 240, 244)
    # body slate
    arr[int(h * 0.30) : int(h * 0.95), int(w * 0.25) : int(w * 0.75)] = (90, 106, 122)
    # face
    fy0, fy1 = int(h * 0.08), int(h * 0.22)
    fx0, fx1 = int(w * 0.38), int(w * 0.62)
    arr[fy0:fy1, fx0:fx1] = (220, 180, 150)
    arr[max(0, fy0 - 40) : fy0 + 10, fx0 - 10 : fx1 + 10] = (20, 20, 25)
    return _png(arr)


def test_hard_crop_max_upscale_2x():
    portrait = _figure()
    tri = sheet_svc.build_faces_tri_from_masters(
        portrait=portrait, front=portrait, side=_figure(), back=_figure(), size=256
    )
    for k, b in tri.items():
        im = Image.open(BytesIO(b))
        assert im.size == (256, 256), (k, im.size)


def test_expr_instructions_have_facial_cues():
    inst = sheet_svc._EXPR_EDIT_INSTRUCTIONS
    assert "眉头" in inst[0] or "下压" in inst[0]
    assert "半睁" in inst[1] or "斜视" in inst[1]
    assert "下垂" in inst[2]
    assert "微笑" in inst[3]
    assert "张开" in inst[4]
    assert "压平" in inst[5] or "紧闭" in inst[5]
    assert inst[0] != inst[5]


def test_mouth_open_and_diversity():
    # closed mouth: uniform lower face
    closed = np.zeros((256, 256, 3), dtype=np.uint8)
    closed[:] = (200, 170, 150)
    closed[30:90, 80:176] = (40, 40, 45)  # eyes/brows dark
    # open mouth: dark oval
    opened = closed.copy()
    opened[150:190, 100:156] = (20, 10, 10)
    assert sheet_svc.mouth_appears_open(_png(opened))
    assert not sheet_svc.mouth_appears_open(_png(closed))
    # diversity: different eye region
    other = closed.copy()
    other[40:80, 90:166] = (10, 10, 10)
    d = sheet_svc.expression_roi_pixel_diff(_png(opened), _png(closed))
    assert d >= 4.0


def test_costume_bands_no_face_and_fill():
    # denser body so auto-fill hits ≥60% on crop body
    h, w = 1216, 832
    arr = __import__("numpy").zeros((h, w, 3), dtype="uint8")
    arr[:] = (240, 240, 244)
    arr[int(h * 0.16) : int(h * 0.98), int(w * 0.18) : int(w * 0.82)] = (90, 106, 122)
    arr[int(h * 0.08) : int(h * 0.20), int(w * 0.36) : int(w * 0.64)] = (220, 180, 150)
    portrait = _png(arr)
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=128, min_fg=0.60
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=5)
    assert len(ratios) == 5
    assert sheet_svc._COSTUME_PORTRAIT_BANDS[0][0] == "hood_collar"
    assert sheet_svc._COSTUME_PORTRAIT_BANDS[0][1][1] >= 0.15  # 下巴下
    assert all(r >= 0.05 for r in ratios), ratios


def test_side_cleanup_accept_rejects_large_drift():
    a = _figure()
    # heavily altered
    arr = np.array(Image.open(BytesIO(a)).resize((128, 128)))
    arr[:] = (10, 200, 10)
    from io import BytesIO as B
    buf = B()
    Image.fromarray(arr).save(buf, format="PNG")
    assert sheet_svc.side_face_cleanup_accept(buf.getvalue(), a) is False
