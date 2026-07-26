"""M6: 视频生成模型聚合层 unit 测试。

覆盖:
  · list_generators() 返回 3 个生成器
  · get_generator("ltx", ...) 返回 LtxVideoGenerator 实例
  · get_generator("xxx") 未知名称抛 ValueError
  · SeedanceVideoGenerator / KlingVideoGenerator stub 返回 success=False
  · LtxVideoGenerator 在缺 pool 时返回失败(不调外部)
"""
from __future__ import annotations

import pytest

from app.services.video_generators import (
    KlingVideoGenerator,
    LtxVideoGenerator,
    SeedanceVideoGenerator,
    get_generator,
    list_generators,
)


def test_list_generators():
    """list_generators() 返回 3 个生成器(ltx/seedance/kling)。"""
    gens = list_generators()
    assert len(gens) == 3
    names = {g["name"] for g in gens}
    assert names == {"ltx", "seedance", "kling"}
    # 每项含必要字段
    for g in gens:
        assert "display_name" in g
        assert "supports_image2video" in g
        assert "supports_text2video" in g


def test_get_generator_ltx():
    """get_generator('ltx', pool, tracker) 返回 LtxVideoGenerator 实例。"""
    gen = get_generator("ltx", pool=None, tracker=lambda c, p: None)
    assert isinstance(gen, LtxVideoGenerator)
    assert gen.name == "ltx"
    assert gen.supports_image2video is True


def test_get_generator_seedance():
    """get_generator('seedance') 返回 SeedanceVideoGenerator 实例。"""
    gen = get_generator("seedance")
    assert isinstance(gen, SeedanceVideoGenerator)
    assert gen.name == "seedance"


def test_get_generator_unknown():
    """未知名称抛 ValueError。"""
    with pytest.raises(ValueError) as ei:
        get_generator("nonexistent")
    assert "未知视频生成器" in str(ei.value)


@pytest.mark.asyncio
async def test_seedance_stub():
    """SeedanceVideoGenerator.generate() 返回 success=False。"""
    gen = SeedanceVideoGenerator()
    result = await gen.generate("a boy walking")
    assert result.success is False
    assert result.model == "seedance"
    assert "stub" in result.error or "尚未接入" in result.error


@pytest.mark.asyncio
async def test_kling_stub():
    """KlingVideoGenerator.generate() 返回 success=False。"""
    gen = KlingVideoGenerator()
    result = await gen.generate("a boy walking")
    assert result.success is False
    assert result.model == "kling"


@pytest.mark.asyncio
async def test_ltx_no_pool_returns_failure():
    """LtxVideoGenerator 未注入 pool → 返回 success=False(不调外部)。"""
    gen = LtxVideoGenerator(pool=None, tracker=lambda c, p: None)
    result = await gen.generate("a boy walking")
    assert result.success is False
    assert result.model == "ltx"


@pytest.mark.asyncio
async def test_ltx_empty_prompt_returns_failure():
    """LtxVideoGenerator 空提示词 → 返回 success=False。"""
    gen = LtxVideoGenerator(pool=None, tracker=lambda c, p: None)
    result = await gen.generate("   ")
    assert result.success is False
    assert "提示词为空" in result.error
