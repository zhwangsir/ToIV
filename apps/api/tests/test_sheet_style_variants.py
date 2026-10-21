
"""扩展画风 API：SHEET_STYLES allowlist + prompt/ckpt 映射（无 Comfy）。"""
from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from app.services.studio.character_sheet.templates import (
    SHEET_STYLE_PATTERN,
    SHEET_STYLES,
    _STYLE_NEGATIVE,
    _STYLE_SUFFIX,
    sheet_is_hanfu,
    sheet_is_photoreal,
    sheet_style_zh,
    sheet_uses_anime_gates,
    sheet_uses_anime_xl,
)
from app.services.studio.character_sheet.constants import _SHEET_CKPT, _THEME
from app.services.studio.character_asset import STYLE_VARIANTS, _CARD_THEMES
from app.services.studio.schemas import CharacterSheetRequest


EXTENDED = ("realistic", "ink_wash", "cyberpunk", "three_d")


def test_sheet_styles_six_keys_aligned_with_style_variants():
    assert SHEET_STYLES == (
        "ancient_realistic",
        "anime",
        "realistic",
        "ink_wash",
        "cyberpunk",
        "three_d",
    )
    assert set(SHEET_STYLES) == set(STYLE_VARIANTS.keys())


def test_sheet_style_pattern_accepts_all_six():
    rx = re.compile(SHEET_STYLE_PATTERN)
    for s in SHEET_STYLES:
        assert rx.match(s), s
    assert rx.match("noir") is None


@pytest.mark.parametrize("style", list(SHEET_STYLES))
def test_prompt_pack_and_ckpt_theme_cover_every_style(style: str):
    assert style in _STYLE_SUFFIX and _STYLE_SUFFIX[style]
    assert style in _STYLE_NEGATIVE and _STYLE_NEGATIVE[style]
    assert style in _SHEET_CKPT
    assert style in _THEME
    assert style in _CARD_THEMES


def test_mapping_helpers():
    assert sheet_is_hanfu("ancient_realistic") and not sheet_is_hanfu("realistic")
    assert sheet_is_photoreal("realistic") and sheet_is_photoreal("ancient_realistic")
    assert not sheet_is_photoreal("anime")
    for s in ("anime", "ink_wash", "cyberpunk", "three_d"):
        assert sheet_uses_anime_xl(s)
        assert sheet_uses_anime_gates(s)
    assert not sheet_uses_anime_xl("realistic")
    assert not sheet_uses_anime_xl("ancient_realistic")
    assert sheet_style_zh("cyberpunk") == "赛博朋克"
    assert _SHEET_CKPT["realistic"] == _SHEET_CKPT["ancient_realistic"]
    assert _SHEET_CKPT["ink_wash"] == _SHEET_CKPT["anime"]


@pytest.mark.parametrize("style", list(EXTENDED))
def test_character_sheet_request_accepts_extended_styles(style: str):
    req = CharacterSheetRequest(style=style)
    assert req.style == style


def test_character_sheet_request_rejects_unknown_style():
    with pytest.raises(ValidationError):
        CharacterSheetRequest(style="oil_painting")
