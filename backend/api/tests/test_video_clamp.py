"""WanI2VRequest 数值钳位:越界/小数不再 422,自动落到合法区间。

回归:图片转视频曾因前端灌进大图尺寸 / 复用的巨大 seed / 小数 seed → 后端 422 整条崩。
现在数值字段一律钳位(width/height 128-1280、length 9-121 且 4n+1、fps 4-30、seed 0..2^63-1)。
"""
from app.routes.video import WanI2VRequest

_BASE = {"positive": "motion", "image": "a.png", "worker": "http://w:8000"}


def _req(**over) -> WanI2VRequest:
    return WanI2VRequest(**{**_BASE, **over})


def test_dim_over_max_clamps_to_1280():
    r = _req(width=1536, height=2048)
    assert r.width == 1280 and r.height == 1280


def test_dim_under_min_clamps_to_128():
    assert _req(width=16, height=64).width == 128


def test_length_over_max_clamps_and_snaps_4n1():
    r = _req(length=161)
    assert r.length == 121 and (r.length - 1) % 4 == 0


def test_length_snaps_to_4n1():
    # 100 → 落到 ≤100 的 4n+1 = 97
    assert _req(length=100).length == 97


def test_fps_over_max_clamps():
    assert _req(fps=60).fps == 30


def test_seed_float_floored():
    assert _req(seed=1.9).seed == 1


def test_seed_over_max_clamps():
    assert _req(seed=12345678901234567890).seed == 2**63 - 1


def test_seed_none_stays_none():
    assert _req(seed=None).seed is None


def test_valid_values_unchanged():
    r = _req(width=832, height=480, length=81, fps=16, seed=12345)
    assert (r.width, r.height, r.length, r.fps, r.seed) == (832, 480, 81, 16, 12345)
