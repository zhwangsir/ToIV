"""待办 #6:character_sheet 拆包后导入/公开面烟测(无 GPU)。"""
from __future__ import annotations

from pathlib import Path


def test_package_layout_and_public_reexports():
    import app.services.studio.character_sheet as cs

    root = Path(cs.__file__).resolve().parent
    for name in ("constants.py", "templates.py", "gates.py", "layout.py", "retry.py", "_impl.py"):
        assert (root / name).is_file(), name

    # 公开入口仍挂在包上(路由/测试既有导入路径)
    for attr in (
        "generate_character_sheet",
        "compose_character_sheet",
        "sheet_gate_threshold_snapshot",
        "SLATE_GRAY_MAX_DIST",
        "FACE_HEIGHT_FRAC_MIN",
        "LAYOUT",
        "CharacterSheetError",
        "build_panel_prompts",
    ):
        assert hasattr(cs, attr), attr

    snap = cs.sheet_gate_threshold_snapshot()
    assert snap["slate_gray_max_dist"] == 85
    assert snap["face_height_frac_min"] == 0.55


def test_submodules_are_importable():
    from app.services.studio.character_sheet import gates, layout, retry, templates

    assert gates.sheet_gate_threshold_snapshot is not None
    assert layout.compose_character_sheet is not None
    assert templates.LAYOUT["canvas"][0] == 2400
    assert retry.CharacterSheetQueueWait is not None
