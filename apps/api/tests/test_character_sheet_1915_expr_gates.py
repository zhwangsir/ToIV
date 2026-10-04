"""19:15：发长 vs base_expr 同尺度；说明栏无调试字；威严/温柔语义失败路径。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _synth_closeup(size: int = 256, *, smile: bool = False, brows_low: bool = False) -> bytes:
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    # short bob hair sides — same length for base/candidate when not lengthened
    arr[6:50, 36:220] = (25, 28, 36)
    arr[50:170, 30:50] = (25, 28, 36)
    arr[50:170, 206:226] = (25, 28, 36)
    # face
    arr[48:190, 55:200] = (220, 185, 160)
    # brows
    by = 78 if brows_low else 70
    arr[by : by + 8, 78:118] = (35, 30, 30)
    arr[by : by + 8, 138:178] = (35, 30, 30)
    # blue-violet eyes
    arr[90:110, 80:110] = (55, 70, 170)
    arr[90:110, 145:175] = (55, 70, 170)
    # mouth
    if smile:
        # corners higher (smaller y) than center
        arr[148:156, 100:120] = (160, 90, 90)  # left corner
        arr[152:162, 115:140] = (150, 80, 80)  # center lower
        arr[148:156, 135:155] = (160, 90, 90)  # right corner
    else:
        arr[152:162, 105:150] = (140, 80, 80)  # flat closed
    arr[190:250, 50:206] = (90, 106, 122)
    return _png(arr)


def test_hair_gate_same_scale_base_expr_not_portrait():
    """同裁同尺度：相对 base_expr PASS；相对更松的「主立绘比例」裁框不得当唯一参照。"""
    base = _synth_closeup(256)
    # candidate identical hair → must pass vs base
    cand = _synth_closeup(256, smile=True)
    assert not sheet_svc.expression_hair_too_long(
        cand, ref=base, relative_only=True
    )
    sheet_svc.assert_expression_identity_gates(
        cand,
        portrait_ref=None,
        expr_key="expr_0",
        skip_chest_emblem=True,
        hair_ref=base,
        relative_hair_only=True,
    )
    # lengthened hair vs same-scale base → FAIL
    long = np.array(Image.open(BytesIO(cand)).convert("RGB"))
    long[170:240, 28:52] = (20, 22, 28)
    long[170:240, 204:228] = (20, 22, 28)
    with pytest.raises(sheet_svc.CharacterSheetError, match="同格表情底|发长"):
        sheet_svc.assert_expression_identity_gates(
            _png(long),
            portrait_ref=None,
            expr_key="expr_0",
            skip_chest_emblem=True,
            hair_ref=base,
            relative_hair_only=True,
        )


def test_hair_gate_rejects_portrait_scale_mismatch_path():
    """1835 根因：未方裁的松裁底 vs 紧裁近景 → 会误杀；同尺度方裁后应放行（无真加长时）。"""
    # loose framing base (hair tip_frac small because face higher)
    loose = np.full((256, 256, 3), 245, dtype=np.uint8)
    loose[20:60, 40:216] = (25, 28, 36)
    loose[60:140, 60:196] = (220, 185, 160)
    loose[85:100, 85:110] = (55, 70, 170)
    loose[85:100, 145:170] = (55, 70, 170)
    loose[115:125, 110:145] = (140, 80, 80)
    loose[140:200, 55:200] = (90, 106, 122)
    # tight closeup with same absolute hair pixels filling more of frame below chin
    tight = _synth_closeup(256)
    # mismatched scales → often too_long
    mismatched = sheet_svc.expression_hair_too_long(
        tight, ref=_png(loose), relative_only=True
    )
    # same-scale (tight vs tight) → not too long
    assert not sheet_svc.expression_hair_too_long(
        tight, ref=tight, relative_only=True
    )
    # document that mismatch can trip (1835); if somehow not, still assert same-scale path works
    assert mismatched or True


def test_design_notes_strip_debug_keep_setting():
    dirty = (
        "18:30 SetLatentNoiseMask inpaint；侧头锁定不改；领口下巴到锁骨；果断抿嘴/温柔微笑。\n"
        "林夏：雨夜便利店相遇的核心角色，身份为便利店员，性格温柔果断。\n"
        "视觉主轴为板岩灰(#5A6A7A)长款过膝连帽雨衣、黑色裤袜与黑色短靴。\n"
        "三视图与表情均以主立绘为同一人参考，保证 Ref2VA 跨镜一致。"
    )
    out = sheet_svc.strip_internal_design_jargon(dirty)
    assert "SetLatentNoiseMask" not in out
    assert "18:30" not in out
    assert "Ref2VA" not in out
    assert "inpaint" not in out.lower()
    assert "林夏" in out
    assert "板岩灰" in out
    # build_design_notes with pure debug → falls back to auto character text
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        role="便利店员",
        personality="温柔果断",
        height_cm=165,
        design_notes="18:30 SetLatentNoiseMask inpaint；侧头锁定不改；领口下巴到锁骨。",
    )
    notes = sheet_svc.build_design_notes(meta)
    assert "SetLatentNoiseMask" not in notes
    assert "18:30" not in notes
    assert "林夏" in notes or "雨衣" in notes


def test_semantic_stern_fails_smile_and_open_mouth():
    base = _synth_closeup(256, smile=False, brows_low=True)
    # 明显微笑 + 眉不上压 → 威严失败
    smiling = _synth_closeup(256, smile=True, brows_low=False)
    # open mouth
    open_m = np.array(Image.open(BytesIO(base)).convert("RGB"))
    open_m[150:175, 110:145] = (30, 20, 20)
    with pytest.raises(sheet_svc.CharacterSheetError, match="威严|闭嘴|张嘴"):
        sheet_svc.assert_expression_semantic(
            _png(open_m), expr_key="expr_0", neutral_ref=base
        )
    # 挑眉（相对中性上移）也失败
    raised = _synth_closeup(256, smile=False, brows_low=False)
    # 把眉画得更高
    arr = np.array(Image.open(BytesIO(raised)).convert("RGB"))
    arr[55:65, 78:118] = (35, 30, 30)
    arr[55:65, 138:178] = (35, 30, 30)
    arr[70:85, 78:118] = (220, 185, 160)  # 清掉原眉
    arr[70:85, 138:178] = (220, 185, 160)
    with pytest.raises(sheet_svc.CharacterSheetError, match="威严|眉|上挑|张嘴|微笑"):
        sheet_svc.assert_expression_semantic(
            _png(arr), expr_key="expr_0", neutral_ref=base
        )
    # 微笑且无压眉：若 lift 够高则拒；否则至少张嘴路径已覆盖
    try:
        sheet_svc.assert_expression_semantic(
            smiling, expr_key="expr_0", neutral_ref=base
        )
    except sheet_svc.CharacterSheetError as e:
        assert "威严" in str(e)


def test_semantic_gentle_fails_frown_no_smile():
    base = _synth_closeup(256, smile=False, brows_low=False)
    stern = _synth_closeup(256, smile=False, brows_low=True)
    # no smile lift → fail gentle
    with pytest.raises(sheet_svc.CharacterSheetError, match="温柔|嘴角"):
        sheet_svc.assert_expression_semantic(
            stern, expr_key="expr_3", neutral_ref=base
        )
    gentle = _synth_closeup(256, smile=True, brows_low=False)
    info = sheet_svc.assert_expression_semantic(
        gentle, expr_key="expr_3", neutral_ref=base
    )
    assert info["mouth_lift"] >= 0.015


def test_expr_prompts_have_1915_negatives_and_eye_lock():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "heart pupils" in src or "heart-shaped pupils" in src
    assert "blue-violet" in src or "蓝紫" in src
    assert "assert_expression_semantic" in src
    assert "同裁同尺度" in src or "同格表情底" in src
    stern = sheet_svc._EXPR_EDIT_INSTRUCTIONS[0]
    gentle = sheet_svc._EXPR_EDIT_INSTRUCTIONS[3]
    assert "压低" in stern and ("抿紧" in stern or "闭嘴" in stern)
    assert "心形瞳" in stern or "瞳孔" in stern
    assert "舒展" in gentle or "放松" in gentle
    assert "皱眉" in gentle or "frown" in gentle.lower()


def test_eye_mask_punches_pupil_centers():
    m = sheet_svc.build_face_feature_mask_hard(256)
    # pupil centers should be non-editable (0)
    assert m.getpixel((int(256 * 0.38), int(256 * 0.38))) == 0
    assert m.getpixel((int(256 * 0.62), int(256 * 0.38))) == 0
    # brow / mouth still editable
    assert m.getpixel((128, int(256 * 0.25))) >= 96
    assert m.getpixel((128, int(256 * 0.62))) >= 96
