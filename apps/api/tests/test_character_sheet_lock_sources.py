"""锁定格不得从整卡 char_sheet_* 抠图（父代理 10:34）。"""
from __future__ import annotations

from pathlib import Path


def _assert_not_whole_sheet(path: str | Path) -> None:
    name = Path(path).name.lower()
    if name.startswith("char_sheet_") or "/char_sheet_" in str(path).replace("\\", "/").lower():
        raise AssertionError(f"locked panel must not come from whole sheet file: {path}")


def test_lock_source_rejects_char_sheet_filename():
    try:
        _assert_not_whole_sheet("/mnt/x/char_sheet_803fb69b_ancient_realistic_abc.png")
        raised = False
    except AssertionError:
        raised = True
    assert raised


def test_lock_source_allows_char_panel():
    _assert_not_whole_sheet(
        "/mnt/toiv-nas/toiv/outputs/drama/final/studio/char_panel_803fb69b_ancient_realistic_front_304dfc6b9a.png"
    )


def test_lock_source_allows_pick_png():
    _assert_not_whole_sheet("/home/merlin/toiv/tmp/batch7_v2/linxia_ancient_back_pick_fix21.png")
