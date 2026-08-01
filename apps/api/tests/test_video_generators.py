"""M6: 视频生成模型聚合层 unit 测试。

覆盖:
  · list_generators() 返回 4 个生成器
  · get_generator("ltx", ...) 返回 LtxVideoGenerator 实例
  · get_generator("xxx") 未知名称抛 ValueError
  · SeedanceVideoGenerator / KlingVideoGenerator stub 返回 success=False
  · LtxVideoGenerator 在缺 pool 时返回失败(不调外部)
  · LiveActVideoGenerator 未部署/缺输入/提交成功(mock httpx)
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.video_generators import (
    KlingVideoGenerator,
    LiveActVideoGenerator,
    LtxVideoGenerator,
    SeedanceVideoGenerator,
    get_generator,
    list_generators,
)


def test_list_generators():
    """list_generators() 返回 4 个生成器(ltx/seedance/kling/liveact)。"""
    gens = list_generators()
    assert len(gens) == 4
    names = {g["name"] for g in gens}
    assert names == {"ltx", "seedance", "kling", "liveact"}
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


@pytest.mark.asyncio
async def test_ltx_video_ckpt_sfw_nsfw_split():
    """SFW/NSFW 底模分流:默认 SFW(default_video_ckpt),nsfw=True 才用 10Eros。"""
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="pid-x")
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=client)

    fake_settings = MagicMock()
    fake_settings.default_video_ckpt = "ltx-2.3-distilled.safetensors"
    fake_settings.nsfw_default_video_ckpt = "10eros_v14.safetensors"
    fake_settings.nsfw_default_gemma = "gemma3_12b_it_bf16/model.safetensors"
    fake_settings.nsfw_default_vae = "LTX23_video_vae_bf16.safetensors"

    gen = LtxVideoGenerator(pool=pool, tracker=lambda c, p: None)
    with patch("app.services.video_generators.get_settings", return_value=fake_settings):
        r_sfw = await gen.generate("a boy walking")
        r_nsfw = await gen.generate("a boy walking", nsfw=True)

    assert r_sfw.success and r_nsfw.success
    g_sfw = client.queue_prompt.call_args_list[0][0][0]
    g_nsfw = client.queue_prompt.call_args_list[1][0][0]
    assert g_sfw["1"]["inputs"]["unet_name"] == "ltx-2.3-distilled.safetensors"
    assert g_nsfw["1"]["inputs"]["unet_name"] == "10eros_v14.safetensors"


def test_get_generator_liveact():
    """get_generator('liveact') 返回 LiveActVideoGenerator 实例。"""
    gen = get_generator("liveact")
    assert isinstance(gen, LiveActVideoGenerator)
    assert gen.name == "liveact"
    assert gen.supports_image2video is True
    assert gen.supports_text2video is False


@pytest.mark.asyncio
async def test_liveact_not_deployed():
    """liveact_base_url 为空 → 返回「LiveAct 未部署」,不调外部。"""
    gen = LiveActVideoGenerator()
    fake_settings = MagicMock()
    fake_settings.liveact_base = ""
    with patch("app.services.video_generators.get_settings", return_value=fake_settings):
        result = await gen.generate(
            "a boy walking", ref_image_bytes=b"img", audio_bytes=b"wav"
        )
    assert result.success is False
    assert result.model == "liveact"
    assert "未部署" in result.error


@pytest.mark.asyncio
async def test_liveact_missing_inputs():
    """缺参考图或配音音频 → 失败,不提交。"""
    gen = LiveActVideoGenerator()
    fake_settings = MagicMock()
    fake_settings.liveact_base = "http://192.168.71.127:9400"
    with patch("app.services.video_generators.get_settings", return_value=fake_settings):
        r1 = await gen.generate("a boy walking", audio_bytes=b"wav")
        r2 = await gen.generate("a boy walking", ref_image_bytes=b"img")
    assert r1.success is False and "参考图" in r1.error
    assert r2.success is False and "音频" in r2.error


@pytest.mark.asyncio
async def test_liveact_submit_success():
    """LiveAct 提交成功 → raw 携带 task_id,multipart 字段齐全。"""
    gen = LiveActVideoGenerator()
    fake_settings = MagicMock()
    fake_settings.liveact_base = "http://192.168.71.127:9400"

    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"task_id": "abc123"}
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.post = AsyncMock(return_value=resp)

    with patch("app.services.video_generators.get_settings", return_value=fake_settings), \
         patch("app.services.video_generators.httpx.AsyncClient", return_value=client):
        result = await gen.generate(
            "a boy walking",
            fps=20,
            seed=7,
            ref_image_bytes=b"img",
            audio_bytes=b"wav",
        )

    assert result.success is True
    assert result.job_id == "abc123"
    assert result.raw["task_id"] == "abc123"
    args, kwargs = client.post.call_args
    assert args[0] == "http://192.168.71.127:9400/generate"
    assert kwargs["data"]["prompt"] == "a boy walking"
    assert kwargs["data"]["fps"] == "20"
    assert kwargs["data"]["seed"] == "7"
    assert kwargs["files"]["image"][1] == b"img"
    assert kwargs["files"]["audio"][1] == b"wav"


@pytest.mark.asyncio
async def test_liveact_worker_unreachable():
    """worker 不可达(httpx.HTTPError)→ 返回失败,不抛异常。"""
    import httpx as _httpx

    gen = LiveActVideoGenerator()
    fake_settings = MagicMock()
    fake_settings.liveact_base = "http://192.168.71.127:9400"
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.post = AsyncMock(side_effect=_httpx.ConnectError("refused"))
    with patch("app.services.video_generators.get_settings", return_value=fake_settings), \
         patch("app.services.video_generators.httpx.AsyncClient", return_value=client):
        result = await gen.generate(
            "a boy walking", ref_image_bytes=b"img", audio_bytes=b"wav"
        )
    assert result.success is False
    assert "不可达" in result.error
