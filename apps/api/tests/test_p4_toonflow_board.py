"""P4(2026-10-16):Toonflow 四视图参考板模板——特写+正面全身+右侧90°+背面全身。

设计来源 Toonflow(MIT,可并码;此处为模板语义对齐)。默认三视图模板行为保持不变。
"""
from __future__ import annotations

import pytest

from app.services.studio.character_sheet import (
    CharacterSheetError,
    SheetMeta,
    build_panel_prompts,
    compose_reference_board,
)
from app.services.studio.schemas import CharacterSheetRequest


def _meta(template: str = "") -> SheetMeta:
    return SheetMeta(name="林夏", style="anime", visual_prompt="a girl", template=template)


def test_toonflow_board_prompts_are_four_views_with_strict_right90():
    prompts = build_panel_prompts(_meta("toonflow_board"))
    # 参考板消费四格:特写/正面全身/右侧90/背面全身
    for key in ("face_front", "front", "side", "back"):
        assert key in prompts, key
    side = prompts["side"]
    assert "right" in side.lower(), side
    assert "90" in side, side
    assert "NOT front view" in side or "not front" in side.lower()
    front = prompts["front"]
    assert "full body" in front.lower()
    closeup = prompts["face_front"]
    assert "closeup" in closeup.lower() and "NO full body" in closeup
    back = prompts["back"]
    assert "back" in back.lower() and "NO face" in back


def test_default_template_side_still_looking_left():
    prompts = build_panel_prompts(_meta(""))
    assert "looking left" in prompts["side"]
    assert "portrait" in prompts and "faces" in prompts


def test_compose_reference_board_four_cells():
    from PIL import Image

    panels = {
        k: Image.new("RGBA", (320, 480), (30 + i * 40, 30, 30, 255))
        for i, k in enumerate(("face_front", "front", "side", "back"))
    }
    png = compose_reference_board(panels, _meta("toonflow_board"))
    assert isinstance(png, (bytes, bytearray)) and len(png) > 1000
    from io import BytesIO

    im = Image.open(BytesIO(png))
    assert im.width >= 800 and im.height >= 600


def test_compose_reference_board_missing_panel_raises():
    from PIL import Image

    panels = {k: Image.new("RGBA", (64, 64), (10, 10, 10, 255)) for k in ("face_front", "front", "side")}
    with pytest.raises(CharacterSheetError):
        compose_reference_board(panels, _meta("toonflow_board"))


def test_sheet_request_template_whitelist():
    ok = CharacterSheetRequest(name="x", style="anime", template="toonflow_board")
    assert ok.template == "toonflow_board"
    assert CharacterSheetRequest(name="x", style="anime").template == ""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        CharacterSheetRequest(name="x", style="anime", template="bogus")
