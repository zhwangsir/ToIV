"""18:30：禁止 VAEEncodeForInpaint+denoise<1；灰块/无眼嘴 FAIL；脸框居中裁无白底。"""
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


def _synth_face(size: int = 256) -> tuple[bytes, Image.Image]:
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[8:48, 40:216] = (25, 28, 36)
    arr[48:190, 55:200] = (220, 185, 160)
    arr[90:110, 80:110] = (40, 90, 180)
    arr[90:110, 145:175] = (40, 90, 180)
    arr[150:162, 105:150] = (160, 90, 90)
    arr[190:250, 50:206] = (90, 106, 122)
    b = _png(arr)
    mask = sheet_svc.build_face_feature_mask_hard(size)
    return b, mask


def test_forbid_vae_encode_for_inpaint_with_denoise_lt_1():
    """图构建不得含 VAEEncodeForInpaint；denoise<1 走 SetLatentNoiseMask。"""
    for d in (0.55, 0.62, 0.70, 0.40, 0.90):
        g = sheet_svc._build_sheet_mask_inpaint_graph(
            "expr",
            image_name="a.png",
            mask_name="m.png",
            ckpt_name="animagineXL40.safetensors",
            seed=42,
            filename_prefix="t",
            style="anime",
            denoise=d,
        )
        cts = {n.get("class_type") for n in g.values() if isinstance(n, dict)}
        assert "VAEEncodeForInpaint" not in cts, cts
        assert "VAEEncode" in cts and "SetLatentNoiseMask" in cts, cts
        dd = float(g["3"]["inputs"]["denoise"])
        assert 0.55 - 1e-9 <= dd <= 0.70 + 1e-9, dd
        # latent 来自 SetLatentNoiseMask(33) 而非 VAEEncodeForInpaint
        assert g["3"]["inputs"]["latent_image"] == ["33", 0]


def test_gray_half_fill_fails_mean_dist_gate():
    """贴近 0.5 灰的大片涂抹必须 FAIL（1822 ok2 漏判根因）。"""
    base, mask = _synth_face(256)
    im = Image.open(BytesIO(base)).convert("RGB")
    edit = im.copy()
    px = edit.load(); mp = mask.load()
    w, h = edit.size
    for y in range(h):
        for x in range(w):
            if mp[x, y] >= 96:
                # 泥灰 + 极少残影（模拟漏判）
                px[x, y] = (126, 132, 120) if (x + y) % 17 else (130, 128, 125)
    buf = BytesIO(); edit.save(buf, format="PNG")
    with pytest.raises(sheet_svc.CharacterSheetError, match=r"灰涂抹|0\.5灰|方差"):
        sheet_svc.assert_expression_no_gray_smear(
            base, buf.getvalue(), mask, expr_key="expr_2"
        )


def test_no_eyes_mouth_fails_gate():
    """遮罩内无眼/嘴结构 → FAIL。"""
    base, mask = _synth_face(256)
    im = Image.open(BytesIO(base)).convert("RGB")
    edit = im.copy()
    # 整脸涂成均匀肤色，抹掉五官
    px = edit.load(); mp = mask.load()
    w, h = edit.size
    for y in range(h):
        for x in range(w):
            if mp[x, y] >= 96:
                px[x, y] = (210, 175, 150)
    buf = BytesIO(); edit.save(buf, format="PNG")
    with pytest.raises(sheet_svc.CharacterSheetError, match="眼睛|嘴"):
        sheet_svc.assert_expression_eyes_mouth_in_mask(
            buf.getvalue(), mask, expr_key="expr_2"
        )


def test_face_center_crop_no_white_border():
    """脸框居中裁切后无格外白底；白底垫边原图直接门禁 FAIL。"""
    size = 400
    # 深灰底 + 居中充实人脸（避免启发式框过大仍带白边）
    arr = np.full((size, size, 3), 90, dtype=np.uint8)
    arr[30:280, 80:320] = (220, 185, 160)
    arr[90:120, 120:160] = (30, 70, 160)
    arr[90:120, 240:280] = (30, 70, 160)
    arr[180:200, 170:230] = (150, 80, 80)
    arr[10:40, 70:330] = (20, 22, 30)
    data = _png(arr)
    cropped = sheet_svc.squareize_face_center_crop(data, size=256)
    frac = sheet_svc.assert_expr_cell_no_white_border(
        cropped, expr_key="expr_0", max_border_frac=0.12
    )
    assert frac <= 0.12, frac
    # 显式白底垫边图 → 门禁 FAIL（模拟旧 pad 路径）
    padded = np.full((300, 300, 3), 248, dtype=np.uint8)
    face = np.array(Image.open(BytesIO(cropped)).resize((180, 180)))
    padded[60:240, 60:240] = face
    with pytest.raises(sheet_svc.CharacterSheetError, match="白底"):
        sheet_svc.assert_expr_cell_no_white_border(
            _png(padded), expr_key="expr_0", max_border_frac=0.08
        )


def test_heuristic_eyes_mouth_pass_on_synth():
    base, mask = _synth_face(256)
    info = sheet_svc.assert_expression_eyes_mouth_in_mask(
        base, mask, expr_key="expr_0"
    )
    assert info.get("route") in ("insightface_kps", "heuristic")
