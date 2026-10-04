"""17:38：表情真局部 inpaint 门禁 + 领口下巴到锁骨；假数据证明位移贴回 fail / 灰涂抹 fail。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _synth_face(size: int = 256) -> tuple[bytes, Image.Image]:
    """合成中性正面头：肤色脸 + 深发 + 灰衣领。"""
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    # hair
    arr[8:48, 40:216] = (25, 28, 36)
    # face
    arr[48:190, 55:200] = (220, 185, 160)
    # eyes
    arr[90:110, 80:110] = (40, 90, 180)
    arr[90:110, 145:175] = (40, 90, 180)
    # mouth closed
    arr[150:162, 105:150] = (160, 90, 90)
    # collar
    arr[190:250, 50:206] = (90, 106, 122)
    b = _png(arr)
    mask = sheet_svc.build_face_feature_mask_hard(size)
    return b, mask


def test_displaced_pasteback_fails_exterior_gate():
    base, mask = _synth_face(256)
    im = Image.open(BytesIO(base)).convert("RGB")
    # 模拟 Qwen 整图编辑相对底图位移/缩放（1656 重影根因）
    shifted = im.resize((236, 236), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (256, 256), (180, 40, 200))  # 醒目错色底，放大外圈差
    canvas.paste(shifted, (22, 14))
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    edited = buf.getvalue()
    mae_raw = sheet_svc.expression_mask_exterior_mae(base, edited, mask)
    assert mae_raw > 2.5, mae_raw
    with pytest.raises(sheet_svc.CharacterSheetError, match="遮罩外"):
        sheet_svc.assert_expression_inpaint_exterior(
            base, edited, mask, max_mae=2.5, expr_key="expr_1"
        )
    # 旧路径：对错位图做局部合成后，若未硬盖外圈，软遮罩边缘仍渗错位像素
    # 用「整图当编辑结果」直接门禁，证明不得把位移图当合格 inpaint
    assert not sheet_svc.expression_mask_exterior_unchanged(
        base, edited, mask, max_diff=0
    )

def test_true_inpaint_exterior_near_zero():
    base, mask = _synth_face(256)
    # 真 inpaint 语义：只改遮罩内像素，外原样
    im = Image.open(BytesIO(base)).convert("RGB")
    edit = im.copy()
    px = edit.load()
    mp = mask.load()
    w, h = edit.size
    for y in range(h):
        for x in range(w):
            if mp[x, y] >= 96:
                r, g, b = px[x, y]
                px[x, y] = (min(255, r + 40), max(0, g - 20), min(255, b + 10))
    buf = BytesIO()
    edit.save(buf, format="PNG")
    edited = buf.getvalue()
    # 强制外=底后 mae≈0
    forced = sheet_svc.force_expression_mask_exterior(base, edited, mask)
    mae = sheet_svc.assert_expression_inpaint_exterior(
        base, forced, mask, max_mae=0.5, expr_key="expr_0"
    )
    assert mae <= 0.5, mae
    assert sheet_svc.expression_mask_exterior_unchanged(base, forced, mask, max_diff=0)


def test_gray_smear_fails_gate():
    base, mask = _synth_face(256)
    im = Image.open(BytesIO(base)).convert("RGB")
    edit = im.copy()
    # 脸区涂成均匀灰（灰涂抹）
    px = edit.load()
    mp = mask.load()
    w, h = edit.size
    for y in range(h):
        for x in range(w):
            if mp[x, y] >= 96:
                px[x, y] = (128, 128, 128)
    buf = BytesIO()
    edit.save(buf, format="PNG")
    edited = buf.getvalue()
    with pytest.raises(sheet_svc.CharacterSheetError, match="灰涂抹"):
        sheet_svc.assert_expression_no_gray_smear(
            base, edited, mask, expr_key="expr_3"
        )


def test_expr_prompts_match_parent_semantics():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "真局部 inpaint" in src or "true-inpaint" in src or "VAEEncodeForInpaint" in src
    assert "_EXPR_INPAINT_PROMPTS" in src
    assert "ref_mode=\"inpaint\"" in src or "ref_mode == \"inpaint\"" in src or 'mode == "inpaint"' in src
    # 冷酷闭嘴眼神冷；威严眉压低嘴紧；温柔微笑；果断抿嘴；沉思视线偏下
    cold = sheet_svc._EXPR_EDIT_INSTRUCTIONS[1]
    assert "闭嘴" in cold and ("冷" in cold or "斜视" in cold)
    stern = sheet_svc._EXPR_EDIT_INSTRUCTIONS[0]
    assert ("压低" in stern or "下压" in stern) and ("抿紧" in stern or "嘴紧" in stern or "嘴角紧" in stern)
    gentle = sheet_svc._EXPR_EDIT_INSTRUCTIONS[3]
    assert "微笑" in gentle and ("放松" in gentle)
    resolute = sheet_svc._EXPR_EDIT_INSTRUCTIONS[5]
    assert ("抿嘴" in resolute or "抿紧" in resolute) and ("坚定" in resolute)
    think = sheet_svc._EXPR_EDIT_INSTRUCTIONS[2]
    assert ("偏下" in think or "下垂" in think or "斜下方" in think) and ("闭嘴" in think or "微闭" in think)


def test_collar_box_chin_to_collarbone():
    portrait_path = (
        Path(__file__).resolve().parents[3]
        / "tmp"
        / "toiv_report_sheet_anime_1703"
        / "out"
        / "approved_portrait_10031947.png"
    )
    if not portrait_path.is_file():
        pytest.skip(f"missing {portrait_path}")
    img = Image.open(portrait_path).convert("RGB")
    box = sheet_svc._collar_box(img)
    x0, y0, x1, y1 = [float(v) for v in box]
    # 下巴到锁骨：应在上半身，勿落到肩胸素布中段
    assert 0.05 <= y0 <= 0.22, box
    assert y0 < y1 <= 0.35, box
    assert (y1 - y0) >= 0.08, box
    # 水平居中于人物条
    gx0, gx1 = sheet_svc._middle_gray_stripe_x_bounds(img)
    cx = (x0 + x1) / 2.0
    mid = (gx0 + gx1) / 2.0
    assert abs(cx - mid) < (gx1 - gx0) * 0.35, (box, mid)
    # 源码声明
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "下巴到锁骨" in src


def test_inpaint_graph_has_vae_encode_for_inpaint():
    g = sheet_svc._build_sheet_mask_inpaint_graph(
        "test expression",
        image_name="base.png",
        mask_name="mask.png",
        ckpt_name="animagineXL40.safetensors",
        seed=1,
        filename_prefix="t",
        style="anime",
    )
    assert any(
        isinstance(n, dict) and n.get("class_type") == "VAEEncodeForInpaint"
        for n in g.values()
    )
    assert any(
        isinstance(n, dict) and n.get("class_type") == "ImageToMask" for n in g.values()
    )
