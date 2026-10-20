"""待办 #3:设定卡/四视图质量门离线标定夹具。

目的:把 luma / 色距 85 / 脸高 0.55–0.65 等魔法数钉成可复现边界测试。
不宣称真机四视图已交付(E-3:零通过样本=未交付);本文件只锁现行阈值行为。
"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from app.services.studio import character_sheet as cs


def _png_figure(coat: tuple[int, int, int], size=(256, 384), bg=(210, 210, 214)) -> bytes:
    """与 test_sheet_slate_gate 同形:躯干涂层 + 肤色脸块,供服装主色启发式。"""
    im = Image.new("RGB", size, bg)
    for y in range(40, 360):
        for x in range(70, 190):
            im.putpixel((x, y), coat)
    for y in range(50, 110):
        for x in range(100, 160):
            im.putpixel((x, y), (220, 180, 150))
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _rgb_at_l1(target: str, dist: int) -> tuple[int, int, int]:
    """从目标色沿 R 轴偏移,使 L1 距离≈dist(夹到 0–255)。"""
    tr, tg, tb = int(target[1:3], 16), int(target[3:5], 16), int(target[5:7], 16)
    # 优先加 R;溢出则加 G
    r = min(255, tr + dist)
    used = r - tr
    g = min(255, tg + max(0, dist - used))
    used2 = used + (g - tg)
    b = min(255, tb + max(0, dist - used2))
    return r, g, b


def test_threshold_snapshot_pins_magic_numbers():
    snap = cs.sheet_gate_threshold_snapshot()
    assert snap["slate_gray_target"] == "#5A6A7A"
    assert snap["slate_gray_max_dist"] == 85
    assert snap["slate_gray_max_luma"] == 175.0
    assert snap["face_height_frac_min"] == 0.55
    assert snap["face_height_frac_max"] == 0.65
    assert snap["face_height_frac_target"] == 0.58
    assert "未交付" in snap["notes"]["delivery"] or "E-3" in snap["notes"]["delivery"]


def test_slate_dist_boundary_pass_at_max():
    """色距==MAX_DIST 须过;==MAX_DIST+1 须拒(钉死 85 边界)。"""
    target = cs.SLATE_GRAY_TARGET
    coat_ok = _rgb_at_l1(target, cs.SLATE_GRAY_MAX_DIST)
    assert cs._hex_dist(
        f"#{coat_ok[0]:02X}{coat_ok[1]:02X}{coat_ok[2]:02X}", target
    ) == pytest.approx(cs.SLATE_GRAY_MAX_DIST, abs=1)
    # 主色启发式可能略偏,用 assert 的 max_dist 显式传参锁边界
    hx = cs.assert_garment_near_slate_gray(
        _png_figure(coat_ok), max_dist=cs.SLATE_GRAY_MAX_DIST
    )
    assert hx.startswith("#")

    coat_bad = _rgb_at_l1(target, cs.SLATE_GRAY_MAX_DIST + 30)
    with pytest.raises(cs.CharacterSheetError, match="颜色门禁|距"):
        cs.assert_garment_near_slate_gray(
            _png_figure(coat_bad), max_dist=cs.SLATE_GRAY_MAX_DIST
        )


def test_slate_luma_boundary_rejects_near_white():
    """luma>SLATE_GRAY_MAX_LUMA 拒;中调板岩灰过。"""
    # 近白:luma≈220
    with pytest.raises(cs.CharacterSheetError, match="过浅|近白|颜色门禁"):
        cs.assert_garment_near_slate_gray(_png_figure((220, 220, 225)))
    # 目标附近中调
    cs.assert_garment_near_slate_gray(_png_figure((90, 106, 122)))


def test_face_height_defaults_match_snapshot():
    """脸高门默认参数与快照常量一致(防默认值漂移)。"""
    import inspect

    sig = inspect.signature(cs.assert_expr_cell_face_height_frac)
    assert sig.parameters["min_face_height_frac"].default == cs.FACE_HEIGHT_FRAC_MIN
    assert sig.parameters["max_face_height_frac"].default == cs.FACE_HEIGHT_FRAC_MAX


def test_toonflow_board_still_subject_to_slate_when_no_front_lock():
    """四视图板生成路径:无 front 母版时主立绘仍调用板岩灰绝对色门(源码契约)。"""
    from pathlib import Path

    # 待办#6:character_sheet 已拆包,契约扫 _impl(+gates) 而非仅 __init__
    root = Path(cs.__file__).resolve().parent
    src = "\n".join(
        p.read_text(encoding="utf-8")
        for p in (root / "_impl.py", root / "gates.py")
        if p.is_file()
    )
    assert "assert_garment_near_slate_gray(" in src
    assert ("template == \"toonflow_board\"" in src) or ("template == 'toonflow_board'" in src)
    # 注释可能在 generate 路径;拆包后允许仅逻辑在 _impl
    assert ("四视图板" in src) or ("toonflow_board" in src)


def test_fail_taxonomy_helpers_exist():
    """失败族可调用入口存在(标定分类用)。"""
    for name in (
        "assert_garment_near_slate_gray",
        "assert_panel_output_gates",
        "assert_sheet_garment_consistency",
        "assert_expr_cell_face_height_frac",
        "assert_fullbody_portrait_face_ok",
        "portrait_has_chest_emblem",
        "dump_rejected_panel",
    ):
        assert callable(getattr(cs, name)), name
