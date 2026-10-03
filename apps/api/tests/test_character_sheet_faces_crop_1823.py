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


def test_build_faces_tri_from_masters_nonempty_and_decoupled():
    portrait = _figure()
    front = _figure()
    side = _figure()
    back = _figure()
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
        portrait=_figure(),
        front=_figure(),
        side=_figure(),
        back=_figure(),
        size=128,
    )
    assert len(tri) == 3
    assert calls == []


def test_expression_new_emblem_rejected_relative():
    ref = _figure(emblem=False)
    bad = _figure(emblem=True)
    assert sheet_svc.portrait_has_chest_emblem(bad, ref=ref) is True
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
