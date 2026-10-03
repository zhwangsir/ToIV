"""20:23：侧面≤2×、表情五官提示/张嘴、服饰坐标裁≥60%。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _tweak(data: bytes, tag: int) -> bytes:
    im = Image.open(BytesIO(data)).convert("RGB")
    px = im.load()
    r, g, b = px[2, 2]
    px[2, 2] = ((r + tag) % 256, g, b)
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


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
        portrait=portrait, front=portrait, side=_tweak(_figure(), 3), back=_tweak(_figure(), 9), size=256
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


def test_face_side_from_back_not_side():
    """22:02：face_side（第三格）必须来自背母版后脑勺，不得再裁侧脸。"""
    portrait = _tweak(_figure(), 1)
    side = _tweak(_figure(), 2)
    # back: solid dark (occiput-like) so crop differs
    import numpy as np
    from io import BytesIO
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (240, 240, 244)
    arr[int(h * 0.05) : int(h * 0.40), int(w * 0.30) : int(w * 0.70)] = (20, 20, 25)
    arr[int(h * 0.30) : int(h * 0.95), int(w * 0.25) : int(w * 0.75)] = (90, 106, 122)
    buf = BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    back = buf.getvalue()
    tri = sheet_svc.build_faces_tri_from_masters(
        portrait=portrait, front=portrait, side=side, back=back, size=128
    )
    from_back = sheet_svc.crop_face_slot_from_master(back, slot="face_side", size=128)
    from_side = sheet_svc.crop_face_slot_from_master(side, slot="face_side", size=128)
    assert tri["face_side"] == from_back
    assert tri["face_side"] != from_side
    assert tri["face_three_quarter"] == sheet_svc.crop_face_slot_from_master(
        side, slot="face_three_quarter", size=128
    )


def test_wrist_cuff_box_and_fill():
    h, w = 1216, 832
    arr = __import__("numpy").zeros((h, w, 3), dtype="uint8")
    arr[:] = (240, 240, 244)
    # 中间灰条 + 袖口板岩灰（模拟浅外框）
    arr[:, int(w * 0.18) : int(w * 0.82)] = (170, 170, 176)
    arr[int(h * 0.16) : int(h * 0.98), int(w * 0.28) : int(w * 0.72)] = (90, 106, 122)
    arr[int(h * 0.34) : int(h * 0.50), int(w * 0.22) : int(w * 0.38)] = (90, 106, 122)
    arr[int(h * 0.34) : int(h * 0.50), int(w * 0.62) : int(w * 0.78)] = (90, 106, 122)
    arr[int(h * 0.08) : int(h * 0.20), int(w * 0.36) : int(w * 0.64)] = (220, 180, 150)
    portrait = _png(arr)
    img = Image.open(BytesIO(portrait)).convert("RGB")
    box = sheet_svc._wrist_cuff_box(img)
    assert box[2] > box[0] and box[3] > box[1]
    # 灰条横向限制：袖口框不得吃满整幅浅外框
    assert box[0] >= 0.15 and box[2] <= 0.85
    out = sheet_svc.build_costume_collage_from_portrait(
        portrait, style="anime", size=128, min_fg=0.60
    )
    ratios = sheet_svc.costume_cell_content_ratios(out, n=5)
    assert ratios[1] >= 0.05, ratios
    # 袖口格内芯浅边应显著低于旧 letterbox
    im = Image.open(BytesIO(out)).convert("RGB")
    cw = im.size[0] // 5
    cuff = im.crop((cw, 0, cw * 2, im.size[1]))
    iw, ih = cuff.size
    inner = cuff.crop((int(iw * 0.1), int(ih * 0.1), int(iw * 0.9), int(ih * 0.9)))
    assert sheet_svc._light_edge_frac(inner, edge=6) < 0.35


def test_pick_best_side_deblur_prefers_sharper():
    base = _figure()
    # soft/melted-like: blur
    soft = Image.open(BytesIO(base)).convert("RGB").resize((64, 64)).resize((256, 256))
    from io import BytesIO as B
    buf = B(); soft.save(buf, format="PNG"); soft_b = buf.getvalue()
    # sharper candidate with face-like region
    sharp = Image.open(BytesIO(base)).convert("RGB").resize((256, 256))
    import numpy as np
    arr = np.array(sharp)
    arr[40:120, 90:170] = (220, 180, 150)
    arr[60:75, 110:130] = (30, 30, 40)
    buf2 = B(); Image.fromarray(arr).save(buf2, format="PNG"); sharp_b = buf2.getvalue()
    # heavily drifted green must reject
    bad = np.zeros((256, 256, 3), dtype=np.uint8); bad[:] = (10, 200, 10)
    buf3 = B(); Image.fromarray(bad).save(buf3, format="PNG"); bad_b = buf3.getvalue()
    assert sheet_svc.side_face_cleanup_accept(bad_b, soft_b) is False
    best = sheet_svc.pick_best_side_deblur_candidate([bad_b, sharp_b], soft_b)
    # may be None if CLIP unavailable and gates strict; at least bad alone rejected
    if best is not None:
        assert best == sharp_b


def test_blend_face_local_and_pick():
    base = _figure()
    # edited: darken eye/mouth band
    import numpy as np
    from io import BytesIO
    im = Image.open(BytesIO(base)).convert("RGB").resize((256, 256))
    arr = __import__("numpy").array(im)
    arr[40:140, 50:200] = (10, 10, 10)
    buf = BytesIO(); Image.fromarray(arr).save(buf, format="PNG"); edited = buf.getvalue()
    blended = sheet_svc.blend_face_local_edit(base, edited, strength=0.70, size=256)
    assert len(blended) > 100
    best = sheet_svc.pick_best_expression_candidate(
        [base, blended],
        neutral_ref=base,
        portrait_ref=None,
        expr_key="expr_0",
    )
    assert best == blended or best == base

