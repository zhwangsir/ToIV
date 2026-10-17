"""设定卡徽标去标升 denoise 重试(0.28→0.45→0.6):真机 15 连败同因=0.28 清不掉。"""
from __future__ import annotations

import asyncio

import pytest


def test_delogo_escalates_until_clean():
    from app.services.studio.character_sheet import _emblem_cleanup

    calls = []

    async def make_plain(denoise):
        calls.append(denoise)
        return b"clean" if denoise >= 0.45 else b"dirty"

    out = asyncio.run(_emblem_cleanup(make_plain=make_plain, is_emblem=lambda img: img == b"dirty"))
    assert out == b"clean"
    assert calls == [0.28, 0.45]


def test_delogo_all_fail_returns_none_keeps_no_flat_patch_rule():
    from app.services.studio.character_sheet import _DELOGO_DENOISE_SCHEDULE, _emblem_cleanup

    calls = []

    async def make_plain(denoise):
        calls.append(denoise)
        return b"dirty"

    out = asyncio.run(_emblem_cleanup(make_plain=make_plain, is_emblem=lambda img: True))
    assert out is None
    assert calls == list(_DELOGO_DENOISE_SCHEDULE)  # 三级都试过才认输,绝不铺色
    assert list(_DELOGO_DENOISE_SCHEDULE) == [0.28, 0.45, 0.6]


def test_delogo_first_try_clean_no_extra_calls():
    from app.services.studio.character_sheet import _emblem_cleanup

    calls = []

    async def make_plain(denoise):
        calls.append(denoise)
        return b"clean"

    out = asyncio.run(_emblem_cleanup(make_plain=make_plain, is_emblem=lambda img: False))
    assert out == b"clean" and calls == [0.28]
