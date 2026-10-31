"""18:23：面部三格母版裁切；表情徽标/发长门禁；服饰首格兜底。"""
from __future__ import annotations

from io import BytesIO

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _figure(*, face_y0=0.08, face_y1=0.28, hair_long=False, emblem=False) -> bytes:
    h, w = 1216, 832
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (240, 240, 244)
    # slate raincoat body
    arr[int(h * 0.30) : int(h * 0.95), int(w * 0.25) : int(w * 0.75)] = (90, 106, 122)
    # face skin
    fy0, fy1 = int(h * face_y0), int(h * face_y1)
    fx0, fx1 = int(w * 0.38), int(w * 0.62)
    arr[fy0:fy1, fx0:fx1] = (220, 180, 150)
    # short black hair above face
    arr[max(0, fy0 - 40) : fy0 + 10, fx0 - 10 : fx1 + 10] = (20, 20, 25)
    if hair_long:
        # hair past shoulder
        arr[fy1 : int(h * 0.55), fx0 - 20 : fx0 + 8] = (15, 15, 20)
        arr[fy1 : int(h * 0.55), fx1 - 8 : fx1 + 20] = (15, 15, 20)
    if emblem:
        cy, cx = int(h * 0.42), int(w * 0.50)
        arr[cy - 12 : cy + 12, cx - 16 : cx + 16] = (220, 40, 40)
    return _png(arr)


def _figure_variant(tag: int, **kw) -> bytes:
    """同构图但改 1 像素，保证源 md5 互异。"""
    from io import BytesIO
    from PIL import Image as _I
    im = _I.open(BytesIO(_figure(**kw))).convert("RGB")
    px = im.load()
    r, g, b = px[0, 0]
    px[0, 0] = ((r + tag) % 256, g, b)
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_build_faces_tri_from_masters_nonempty_and_decoupled():
    portrait = _figure_variant(1)
    front = _figure_variant(2)
    side = _figure_variant(3)
    back = _figure_variant(4)
    tri = sheet_svc.build_faces_tri_from_masters(
        portrait=portrait, front=front, side=side, back=back, size=256
    )
    assert set(tri) == {"face_front", "face_three_quarter", "face_side"}
    for k, b in tri.items():
        im = Image.open(BytesIO(b))
        assert im.size == (256, 256), (k, im.size)
        assert sum(im.convert("L").resize((16, 16)).getdata()) > 50


def test_faces_crop_skips_generation_path(monkeypatch):
    """build_faces_tri_from_masters 不得依赖 generate_panel_bytes。"""
    calls = []

    async def boom(*a, **k):
        calls.append(1)
        raise AssertionError("must not generate")

    monkeypatch.setattr(sheet_svc, "generate_panel_bytes", boom)
    tri = sheet_svc.build_faces_tri_from_masters(
        portrait=_figure_variant(11),
        front=_figure_variant(12),
        side=_figure_variant(13),
        back=_figure_variant(14),
        size=128,
    )
    assert len(tri) == 3
    assert calls == []


def _closeup(*, badge=False) -> bytes:
    """近景头肩合成图：脸在上半，胸口在下 40%。"""
    h, w = 768, 768
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (90, 106, 122)
    arr[int(h * 0.08) : int(h * 0.42), int(w * 0.28) : int(w * 0.72)] = (220, 180, 150)
    arr[int(h * 0.18) : int(h * 0.24), int(w * 0.38) : int(w * 0.44)] = (50, 90, 210)
    arr[int(h * 0.18) : int(h * 0.24), int(w * 0.56) : int(w * 0.62)] = (50, 90, 210)
    if badge:
        arr[int(h * 0.68) : int(h * 0.80), int(w * 0.40) : int(w * 0.60)] = (220, 40, 40)
    return _png(arr)


def test_expression_new_emblem_rejected_relative():
    ref = _figure(emblem=False)
    bad = _closeup(badge=True)
    assert sheet_svc.portrait_has_chest_emblem(bad, ref=ref, below_face=True) is True
    with pytest.raises(sheet_svc.CharacterSheetError, match="徽标"):
        sheet_svc.assert_expression_identity_gates(
            bad, portrait_ref=ref, expr_key="expr_0"
        )


def test_expression_hair_too_long_gentle():
    ref = _figure(hair_long=False)
    long_hair = _figure(hair_long=True)
    assert sheet_svc.expression_hair_too_long(long_hair, ref=ref, chin_only=True)
    with pytest.raises(sheet_svc.CharacterSheetError, match="发长|齐下巴"):
        sheet_svc.assert_expression_identity_gates(
            long_hair, portrait_ref=ref, expr_key="expr_3"
        )


def test_expression_plain_like_ref_passes():
    ref = _figure()
    same = _figure()
    sheet_svc.assert_expression_identity_gates(
        same, portrait_ref=ref, expr_key="expr_2"
    )


def test_costume_first_cell_empty_replaced():
    # 5 cells: first empty (near white), others filled dark
    cell = 256
    canvas = Image.new("RGB", (5 * cell, cell), (240, 240, 244))
    for i in range(1, 5):
        d = ImageDraw.Draw(canvas)
        d.rectangle(
            (i * cell + 20, 20, (i + 1) * cell - 20, cell - 20),
            fill=(30, 30, 35),
        )
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    costume = buf.getvalue()
    ratios0 = sheet_svc.costume_cell_content_ratios(costume, n=5)
    assert ratios0[0] < 0.12
    out = sheet_svc.ensure_costume_first_cell_filled(
        costume, portrait=_figure(), front=_figure()
    )
    ratios = sheet_svc.assert_costume_cells_nonempty(out, min_ratio=0.12, n=5)
    assert ratios[0] >= 0.12


def test_expr_reject_cause_bucket():
    assert sheet_svc._expr_reject_cause("expr_0胸口相对主立绘出现新徽标/字样") == "emblem"
    assert sheet_svc._expr_reject_cause("expr_3发长相对主立绘过长（须齐下巴）") == "hair"


def test_expr_closeup_eyes_not_emblem_below_face():
    """近景五官不得被 below_face=False 的旧 ROI 思路误杀；below_face 应过。"""
    h, w = 768, 768
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:] = (90, 106, 122)
    # face upper half with blue eyes (high chroma mid frame)
    arr[int(h * 0.12) : int(h * 0.45), int(w * 0.30) : int(w * 0.70)] = (220, 180, 150)
    arr[int(h * 0.22) : int(h * 0.28), int(w * 0.38) : int(w * 0.44)] = (40, 80, 220)
    arr[int(h * 0.22) : int(h * 0.28), int(w * 0.56) : int(w * 0.62)] = (40, 80, 220)
    # plain chest lower
    arr[int(h * 0.55) : int(h * 0.95), int(w * 0.25) : int(w * 0.75)] = (90, 106, 122)
    data = _png(arr)
    ref = _figure(emblem=False)
    assert sheet_svc.portrait_has_chest_emblem(data, ref=ref, below_face=True) is False
    sheet_svc.assert_expression_identity_gates(
        data, portrait_ref=ref, expr_key="expr_0"
    )


def test_expr_real_chest_badge_below_face_still_rejects():
    data = _closeup(badge=True)
    ref = _figure(emblem=False)
    assert sheet_svc.portrait_has_chest_emblem(data, ref=ref, below_face=True) is True
    with pytest.raises(sheet_svc.CharacterSheetError, match="徽标"):
        sheet_svc.assert_expression_identity_gates(
            data, portrait_ref=ref, expr_key="expr_1"
        )
