"""18:02：侧头直方图匹配默认关（回 1618 干净路径）；显式 env 才启用。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.studio import character_sheet as sheet_svc


def _png(arr: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(arr.astype(np.uint8), mode="RGB").save(buf, format="PNG")
    return buf.getvalue()


def _head(side_tint=(90, 106, 122), hair=(25, 25, 30), size=256) -> bytes:
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:] = (245, 245, 248)
    arr[int(size * 0.18) : int(size * 0.62), int(size * 0.28) : int(size * 0.72)] = (
        220,
        180,
        150,
    )
    arr[int(size * 0.02) : int(size * 0.22), int(size * 0.22) : int(size * 0.78)] = hair
    arr[int(size * 0.58) : int(size * 0.98), int(size * 0.20) : int(size * 0.80)] = side_tint
    return _png(arr)


def test_hist_match_default_off_returns_identical(monkeypatch):
    monkeypatch.delenv("TOIV_SHEET_SIDE_HIST_MATCH", raising=False)
    assert sheet_svc.side_hist_match_enabled() is False
    front = _head(side_tint=(90, 106, 122), hair=(20, 20, 25))
    side = _head(side_tint=(70, 120, 200), hair=(80, 90, 120))
    out = sheet_svc.match_side_head_coat_hair_to_front(side, front)
    assert out == side


@pytest.mark.parametrize("val", ["1", "true", "YES"])
def test_hist_match_env_on_can_change(monkeypatch, val):
    monkeypatch.setenv("TOIV_SHEET_SIDE_HIST_MATCH", val)
    assert sheet_svc.side_hist_match_enabled() is True
    front = _head(side_tint=(90, 106, 122), hair=(20, 20, 25))
    side = _head(side_tint=(70, 120, 200), hair=(80, 90, 120))
    out = sheet_svc.match_side_head_coat_hair_to_front(side, front)
    assert out and len(out) > 100
    # 启用后允许改色或 face_frac 门禁回退原图
    assert isinstance(out, (bytes, bytearray))


def test_source_has_1822_no_hist_default_off():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "TOIV_SHEET_SIDE_HIST_MATCH" in src
    assert "def side_hist_match_enabled()" in src
    assert "1822_no_hist" in src or "default 18:02" in src
    assert 'os.environ.get("TOIV_SHEET_SIDE_HIST_MATCH"' in src
    # 默认关：空字符串不在 (1,true,yes)
    assert "if not side_hist_match_enabled():" in src
    # face_frac 收紧仍在
    assert "tighten_side_square_to_face_frac" in src
    assert "0.25" in src and "0.5" in src


def test_face_frac_tighten_still_present_independent_of_hist():
    """16:53 收紧与 hist 无关，默认关 hist 时仍可调用。"""
    assert callable(sheet_svc.tighten_side_square_to_face_frac)
