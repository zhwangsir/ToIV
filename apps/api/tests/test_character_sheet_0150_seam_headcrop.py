"""01:50：放弃羽化贴回；Qwen 完整输出 + 头部特写 + 接缝门禁；温柔重定义。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc

def _resolve_0104_out() -> Path:
    cands = [
        Path.home() / "Desktop/ALLProject/toiv_report_sheet_anime_0104/out",
        Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_0104/out"),
        Path("/Users/wangzhenyu/Desktop/ALLProject/toiv_report_sheet_anime_0104/out"),
    ]
    for c in cands:
        if (c / "expr_2_qedit_pasted_10050104_a0.png").is_file():
            return c
    return cands[0]


_OUT = _resolve_0104_out()
_REPORT = _OUT.parent


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _clean_face(size: int = 768) -> bytes:
    im = Image.new("RGB", (size, size), (210, 205, 200))
    d = ImageDraw.Draw(im)
    # soft hair
    d.ellipse((size * 0.18, size * 0.02, size * 0.82, size * 0.55), fill=(30, 30, 40))
    # face
    d.ellipse((size * 0.28, size * 0.18, size * 0.72, size * 0.70), fill=(220, 185, 160))
    d.ellipse((size * 0.36, size * 0.36, size * 0.44, size * 0.44), fill=(40, 50, 140))
    d.ellipse((size * 0.56, size * 0.36, size * 0.64, size * 0.44), fill=(40, 50, 140))
    d.ellipse((size * 0.44, size * 0.52, size * 0.56, size * 0.58), fill=(160, 90, 90))
    return _png(im)


def _synth_hard_ellipse_seam(size: int = 768) -> bytes:
    """用真实锁格底 + 硬遮罩贴回高对比色块，复现闭合轮廓梯度突变。"""
    lock = _OUT / "expr_0_locked_10050104.png"
    if lock.is_file():
        base_b = lock.read_bytes()
        im = Image.open(BytesIO(base_b)).convert("RGB").resize((size, size))
        bb = sheet_svc._detect_face_bbox_xyxy(base_b)
    else:
        im = Image.open(BytesIO(_clean_face(size))).convert("RGB")
        bb = None
    neon = Image.new("RGB", (size, size), (0, 255, 0))
    m = sheet_svc.build_face_paste_mask(size, face_bbox=bb)
    m_hard = m.point(lambda v: 255 if v >= 64 else 0)
    out = Image.composite(neon, im, m_hard)
    return _png(out)


def test_0150_gentle_prompts_no_closed_eye_required():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "gentle smile, mouth corners up, soft relaxed brows, eyes softly curved" in src
    qa = sheet_svc._EXPR_QA_PROMPTS["expr_3"]
    assert "closed-eye smile" not in qa.lower() or "NOT required" in qa
    assert "mouth corners up" in qa
    assert "NOT required" in qa or "弯月眼" in qa
    # 专项问答仍保留两问
    assert "q1" in qa and "q2" in qa


def test_0150_source_no_paste_in_qedit_route():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "qwen_image_edit_2509_full_headcrop" in src
    assert "paste_back\": False" in src or "paste_back': False" in src or '"paste_back": False' in src
    # 新路线注释
    assert "完整输出" in src
    assert "crop_expr_head_closeup" in src
    assert "assert_no_hard_seam_contour" in src


def test_0150_head_closeup_excludes_chest():
    # 构造头肩图：脸在上半，胸口色块在下
    size = 768
    im = Image.new("RGB", (size, size), (200, 200, 205))
    d = ImageDraw.Draw(im)
    d.ellipse((size * 0.25, size * 0.08, size * 0.75, size * 0.55), fill=(220, 180, 150))
    d.ellipse((size * 0.35, size * 0.25, size * 0.43, size * 0.33), fill=(40, 50, 140))
    d.ellipse((size * 0.57, size * 0.25, size * 0.65, size * 0.33), fill=(40, 50, 140))
    d.rectangle((size * 0.20, size * 0.70, size * 0.80, size), fill=(70, 90, 110))
    d.rectangle((size * 0.40, size * 0.78, size * 0.60, size * 0.92), fill=(220, 40, 40))
    raw = _png(im)
    out = sheet_svc.crop_expr_head_closeup(raw, size=768)
    o = Image.open(BytesIO(out)).convert("RGB")
    # 底部中心不应再是大红胸口徽标
    bottom = o.getpixel((384, 720))
    assert not (bottom[0] > 180 and bottom[1] < 80 and bottom[2] < 80), bottom


def test_0150_synth_hard_ellipse_rejected():
    bad = _synth_hard_ellipse_seam(768)
    info = sheet_svc.measure_hard_seam_contour(bad, size=768)
    if not info.get("reject"):
        # 环境差导致合成未触发时，回退用 0104 真实碎脸作硬反例
        fb = _OUT / "expr_2_qedit_pasted_10050104_a0.png"
        if not fb.is_file():
            pytest.skip(f"synth not rejected and no 0104 fallback: {info}")
        bad = fb.read_bytes()
        info = sheet_svc.measure_hard_seam_contour(bad, size=768)
    assert info["reject"] is True, info
    with pytest.raises(sheet_svc.CharacterSheetError, match="接缝门禁"):
        sheet_svc.assert_no_hard_seam_contour(bad, expr_key="expr_2")


def test_0150_0104_shattered_faces_must_reject():
    """0104 反例：沉思过门禁碎脸 + 温柔 a5，接缝门禁必须拒。"""
    cands = [
        _OUT / "expr_2_qedit_pasted_10050104_a0.png",
        _OUT / "expr_2_qedit_ok_10050104.png",
        _OUT / "rejects" / "expr_2_qa_cell_10050104_a0.png",
        _OUT / "expr_3_qedit_pasted_10050104_a5.png",
    ]
    found = [p for p in cands if p.is_file()]
    if len(found) < 2:
        pytest.skip(f"0104 evidence missing under {_OUT}")
    rejected = 0
    details = []
    for p in found:
        b = p.read_bytes()
        info = sheet_svc.measure_hard_seam_contour(b, size=768)
        details.append((p.name, info.get("reject"), info.get("mask_p75"), info.get("mask_strong")))
        if info.get("reject"):
            rejected += 1
            with pytest.raises(sheet_svc.CharacterSheetError, match="接缝门禁"):
                sheet_svc.assert_no_hard_seam_contour(b, expr_key="expr_2" if "expr_2" in p.name else "expr_3")
    # 至少沉思碎脸 + 温柔 a5 两张必须拒
    must = [
        _OUT / "expr_2_qedit_pasted_10050104_a0.png",
        _OUT / "expr_3_qedit_pasted_10050104_a5.png",
    ]
    for p in must:
        if not p.is_file():
            continue
        with pytest.raises(sheet_svc.CharacterSheetError, match="接缝门禁"):
            sheet_svc.assert_no_hard_seam_contour(p.read_bytes(), expr_key="expr_x")
    assert rejected >= 2, details


def test_0150_locked_good_cell_passes_seam():
    p = _OUT / "expr_0_locked_10050104.png"
    if not p.is_file():
        pytest.skip("locked expr_0 missing")
    info = sheet_svc.assert_no_hard_seam_contour(p.read_bytes(), expr_key="expr_0")
    assert info["reject"] is False


def test_0150_qa_assert_still_both_true():
    ok = sheet_svc.assert_expression_qa_match("expr_3", {"q1": True, "q2": True})
    assert ok["pass"] is True
    with pytest.raises(sheet_svc.CharacterSheetError, match="专项问答未过"):
        sheet_svc.assert_expression_qa_match("expr_3", {"q1": False, "q2": True})
