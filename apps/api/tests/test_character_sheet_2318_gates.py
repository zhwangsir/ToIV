"""23:18：铺满 coverage=1.0（禁棚灰垫边缩小）+ 无 side_base + 沉思/温柔走 Qwen-Edit 契约。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image | np.ndarray) -> bytes:
    if isinstance(img, np.ndarray):
        img = Image.fromarray(img.astype(np.uint8), mode="RGB")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _synth_face(size: int = 512) -> Image.Image:
    """带边缘纹理，避免被当成均匀垫边。"""
    arr = np.full((size, size, 3), 198, dtype=np.uint8)
    # 四角噪声，保证铺满度量不把源浅底当垫边
    rng = np.random.default_rng(2318)
    noise = rng.integers(0, 25, size=(size, size, 3), dtype=np.uint8)
    arr = np.clip(arr.astype(np.int16) + noise - 12, 0, 255).astype(np.uint8)
    arr[8:70, 40 : size - 40] = (25, 28, 36)
    arr[55 : int(size * 0.65), int(size * 0.18) : int(size * 0.82)] = (220, 185, 160)
    mid = size // 2
    arr[int(size * 0.32) : int(size * 0.40), mid - 60 : mid - 20] = (55, 70, 170)
    arr[int(size * 0.32) : int(size * 0.40), mid + 20 : mid + 60] = (55, 70, 170)
    my = int(size * 0.62)
    arr[my : my + 12, mid - 35 : mid + 35] = (150, 80, 80)
    arr[int(size * 0.65) : int(size * 0.90), int(size * 0.22) : int(size * 0.78)] = (
        90,
        106,
        122,
    )
    return Image.fromarray(arr, mode="RGB")


def test_2318_fit_no_studio_pad_full_coverage():
    """扩大裁剪铺满格；禁止棚灰垫边；content coverage == 1.0。"""
    im = _synth_face(640)
    fitted, _ = sheet_svc._fit_expr_cell_face_fill(
        im,
        (0, 0, 315, 190),
        target_face_height_frac=0.58,
        allow_studio_pad_for_face_gate=True,  # 即使传入 True 也必须忽略
    )
    assert fitted.size == (315, 190)
    cov = sheet_svc.expr_cell_content_coverage(fitted)
    assert cov >= 1.0 - 1e-9, cov
    sheet_svc.assert_expr_cell_content_coverage(fitted, expr_key="expr_0", min_coverage=1.0)
    # 不得出现明显棚灰垫边条
    assert sheet_svc._studio_pad_edge_frac(fitted) <= 0.02


def test_2318_fit_rejects_padded_postage_stamp():
    """人工棚灰缩水图必须被 coverage 门禁拒绝。"""
    face = _synth_face(200).resize((120, 90), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (315, 190), (220, 220, 224))
    canvas.paste(face, ((315 - 120) // 2, (190 - 90) // 2))
    with pytest.raises(sheet_svc.CharacterSheetError, match="未全铺满|铺满|stamp|pad"):
        sheet_svc.assert_expr_cell_content_coverage(
            canvas, expr_key="expr_2", min_coverage=1.0
        )


def test_2318_compose_grid_full_coverage():
    panels = {f"expr_{i}": _synth_face(512) for i in range(6)}
    grid = sheet_svc._compose_expression_grid(
        panels, box_w=980 - 16, box_h=520 - 40, draw_labels=True
    )
    cols, rows = 3, 2
    cw, ch = grid.size[0] // cols, grid.size[1] // rows
    label_h = 44
    img_h = ch - label_h
    for i in range(6):
        row, col = divmod(i, cols)
        cell = grid.crop(
            (
                col * cw + 3,
                row * ch + 3,
                col * cw + cw - 3,
                row * ch + img_h - 3,
            )
        ).convert("RGB")
        sheet_svc.assert_expr_cell_content_coverage(
            cell, expr_key=f"expr_{i}", min_coverage=1.0
        )


def test_2318_no_side_base_in_source():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "撤回沉思 side_base" in src or "23:18：撤回沉思" in src
    assert "22:28 contemplative uses side-face base" not in src
    # 不得再写 expr_2 side_base 落盘
    assert "expr_2_side_base_" not in src


def test_2318_contemplative_gentle_qwen_edit_contract():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert 'if ek in ("expr_2", "expr_3")' in src or "ek in (\"expr_2\", \"expr_3\")" in src
    assert 'ref_mode="qwen_edit"' in src
    assert "qwen_image_edit_2509" in src
    assert "approved_portrait" in src
    assert "clip_image_cosine_sim" in src or "身份CLIP" in src
    assert "拒绝回落 inpaint" in src or "禁止静默回落" in src or "no silent inpaint" in src
    # 指令含 23:18 关键词
    assert "eyes looking down" in sheet_svc._EXPR_EDIT_INSTRUCTIONS[2].lower()
    assert "eyelids half closed" in sheet_svc._EXPR_EDIT_INSTRUCTIONS[2].lower() or (
        "half closed" in sheet_svc._EXPR_EDIT_INSTRUCTIONS[2].lower()
    )
    assert "calm closed mouth" in sheet_svc._EXPR_EDIT_INSTRUCTIONS[2].lower()
    g = sheet_svc._EXPR_EDIT_INSTRUCTIONS[3].lower()
    assert "gentle closed-eye smile" in g or "closed-eye smile" in g
    assert "mouth corners up" in g


def test_2318_build_sheet_qwen_edit_graph_uses_2509():
    g = sheet_svc._build_sheet_qwen_edit_graph(
        "test prompt",
        image_name="portrait.png",
        seed=10042318,
        filename_prefix="ToIV_test_2318",
    )
    assert isinstance(g, dict)
    unet = (g.get("1") or {}).get("inputs", {}).get("unet_name", "")
    assert "2509" in unet.lower() or "qwen" in unet.lower()
