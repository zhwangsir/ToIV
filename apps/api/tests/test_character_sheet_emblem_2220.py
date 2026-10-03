"""22:20：表情近景徽标 ROI 不得误杀干净胸（漫布皮肤 chroma）。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.studio.character_sheet import portrait_has_chest_emblem

FIX = Path(__file__).resolve().parent / "fixtures" / "sheet_emblem_2220"


@pytest.mark.parametrize(
    "name",
    [
        "must_not_flag_expr_0.png",
        "must_not_flag_expr_4.png",
    ],
)
def test_below_face_must_not_flag(name: str) -> None:
    data = (FIX / name).read_bytes()
    assert portrait_has_chest_emblem(data, below_face=True) is False
    # 有 portrait ref 时相对路径也不得误杀
    assert portrait_has_chest_emblem(data, ref=data, below_face=True) is False


def test_below_face_must_flag_local_logo() -> None:
    data = (FIX / "must_flag_synth_logo.png").read_bytes()
    assert portrait_has_chest_emblem(data, below_face=True) is True
