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
    H3VideoGenerator,
    KlingVideoGenerator,
    LiveActVideoGenerator,
    LtxVideoGenerator,
    SeedanceVideoGenerator,
    get_generator,
    list_generators,
)


def test_list_generators():
    """list_generators() 返回 5 个生成器(ltx/h3/seedance/kling/liveact)。"""
    gens = list_generators()
    assert len(gens) == 5
    names = {g["name"] for g in gens}
    assert names == {"ltx", "h3", "seedance", "kling", "liveact"}
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


def test_get_generator_h3():
    """get_generator('h3', tracker) 返回 H3VideoGenerator 实例。"""
    gen = get_generator("h3", tracker=lambda c, p: None)
    assert isinstance(gen, H3VideoGenerator)
    assert gen.name == "h3"
    assert gen.supports_text2video is True
    assert gen.supports_image2video is False


def test_h3_snap32():
    """分辨率吸附 32 对齐并钳位 [256, 1344]。"""
    assert H3VideoGenerator._snap32(1000) == 992
    assert H3VideoGenerator._snap32(700) == 672
    assert H3VideoGenerator._snap32(100) == 256
    assert H3VideoGenerator._snap32(2000) == 1344


def test_h3_frames_grid():
    """帧数吸附 17k+5 网格并钳位 [22, 362](2026-08-16 统一时长策略层口径)。

    策略层 services/duration.py 为唯一事实源:up(生成解析默认,向上取整+
    超出 0.25s 走 trim 精裁)与 down(drama 续写段兼容口径,向下取整)双方向。
    """
    from app.services.duration import snap_engine_frames

    # up:时长解析默认(向上吸附,宁可多给帧再精裁,不少给)
    assert snap_engine_frames("h3", 124, direction="up") == 124
    assert snap_engine_frames("h3", 144, direction="up") == 158  # 6s@24fps → 158(trim 裁回)
    assert snap_engine_frames("h3", 10000, direction="up") == 362  # 钳位上限
    # down:drama 末帧续写段口径(与旧 _frames_grid 行为一致)
    assert snap_engine_frames("h3", 144, direction="down") == 141
    assert snap_engine_frames("h3", 24, direction="down") == 22  # 钳位下限
    assert snap_engine_frames("h3", 10000, direction="down") == 362


@pytest.mark.asyncio
async def test_h3_empty_prompt_returns_failure():
    """H3VideoGenerator 空提示词 → 返回 success=False(不调外部)。"""
    gen = H3VideoGenerator(tracker=lambda c, p: None)
    result = await gen.generate("   ")
    assert result.success is False
    assert "提示词为空" in result.error


@pytest.mark.asyncio
async def test_h3_disabled_returns_failure():
    """H3 被配置关闭 → 返回失败原因(HTTPException detail 翻译为 error,不抛异常)。"""
    from fastapi import HTTPException

    gen = H3VideoGenerator(tracker=lambda c, p: None)
    with patch(
        "app.services.h3.ensure_h3_enabled",
        side_effect=HTTPException(status_code=503, detail="H3 视频生成引擎已禁用"),
    ):
        result = await gen.generate("a boy walking")
    assert result.success is False
    assert result.model == "h3"
    assert "已禁用" in result.error


@pytest.mark.asyncio
async def test_h3_submit_success():
    """H3 提交成功:图参数 32 对齐 + 17k+5 帧网格,raw 携带 prompt_id/seed。

    6s@24fps=144 → 向上吸附 158(差 0.58s > 0.25)→ trim 计划:挂后处理链精裁至 6s,
    notice 透出(链路本身在 test_duration.py 覆盖,这里捕获 spawn 不真跑)。
    """
    client = AsyncMock()
    client.base_url = "http://192.168.71.127:8195"
    client.queue_prompt = AsyncMock(return_value="pid-h3")

    gen = H3VideoGenerator(tracker=lambda c, p: None)
    with patch("app.services.h3.ensure_h3_enabled"), \
         patch("app.services.h3.get_h3_client", return_value=client), \
         patch("app.services.h3.ensure_h3_ready", new=AsyncMock()), \
         patch("app.services.h3.ensure_h3_vram", new=AsyncMock()), \
         patch("app.services.video_generators.spawn_duration_chain") as spawn_mock:
        result = await gen.generate(
            "a boy walking", width=1000, height=700, duration_sec=6, seed=7,
        )

    assert result.success is True
    assert result.job_id == "pid-h3"
    assert result.raw["worker"] == "http://192.168.71.127:8195"
    assert result.raw["seed"] == 7
    graph = client.queue_prompt.call_args[0][0]
    h3_inputs = graph["104"]["inputs"]
    assert h3_inputs["width"] == 992
    assert h3_inputs["height"] == 672
    assert h3_inputs["length"] == 158  # 24fps × 6s = 144 → 向上吸附 158(trim 精裁至 6s)
    assert (h3_inputs["length"] - 5) % 17 == 0
    # trim 计划:后处理链挂起 + notice 透出
    spawn_mock.assert_called_once()
    assert spawn_mock.call_args.kwargs["plan"].strategy == "trim"
    assert "精确裁至 6 秒" in result.duration_notice
    assert result.raw["duration_notice"] == result.duration_notice


@pytest.mark.asyncio
async def test_h3_extend_plan_spawns_chain():
    """H3 duration_sec=20(超 15s 单段上限)→ extend 计划:首段 362 帧,挂 2 段续写链。"""
    client = AsyncMock()
    client.base_url = "http://192.168.71.127:8195"
    client.queue_prompt = AsyncMock(return_value="pid-h3-ext")

    gen = H3VideoGenerator(tracker=lambda c, p: None)
    with patch("app.services.h3.ensure_h3_enabled"), \
         patch("app.services.h3.get_h3_client", return_value=client), \
         patch("app.services.h3.ensure_h3_ready", new=AsyncMock()), \
         patch("app.services.h3.ensure_h3_vram", new=AsyncMock()), \
         patch("app.services.video_generators.spawn_duration_chain") as spawn_mock:
        result = await gen.generate("a boy walking", duration_sec=20, seed=7)

    assert result.success is True
    graph = client.queue_prompt.call_args[0][0]
    assert graph["104"]["inputs"]["length"] == 362  # 首段满网格
    plan = spawn_mock.call_args.kwargs["plan"]
    assert plan.strategy == "extend" and plan.segment_frames == (362, 124)
    assert callable(spawn_mock.call_args.kwargs["submit_next"])
    assert "分 2 段续写" in result.duration_notice


@pytest.mark.asyncio
async def test_h3_over_60s_returns_failure():
    """H3 duration_sec=61 超分段续写安全上限 → 返回失败原因(不提交,不抛异常)。"""
    client = AsyncMock()
    client.base_url = "http://192.168.71.127:8195"

    gen = H3VideoGenerator(tracker=lambda c, p: None)
    with patch("app.services.h3.ensure_h3_enabled"), \
         patch("app.services.h3.get_h3_client", return_value=client), \
         patch("app.services.h3.ensure_h3_ready", new=AsyncMock()), \
         patch("app.services.h3.ensure_h3_vram", new=AsyncMock()):
        result = await gen.generate("a boy walking", duration_sec=61)

    assert result.success is False
    assert "最长支持 60 秒" in result.error
    client.queue_prompt.assert_not_called()


@pytest.mark.asyncio
async def test_h3_vram_shortage_returns_failure():
    """显存预检不足 → 返回错峰原因(不抛 503 异常给调用方)。"""
    from fastapi import HTTPException

    gen = H3VideoGenerator(tracker=lambda c, p: None)
    with patch("app.services.h3.ensure_h3_enabled"), \
         patch("app.services.h3.get_h3_client", return_value=AsyncMock()), \
         patch("app.services.h3.ensure_h3_ready", new=AsyncMock()), \
         patch(
            "app.services.h3.ensure_h3_vram",
            new=AsyncMock(side_effect=HTTPException(status_code=503, detail="H3 显卡空闲显存不足:当前 32.0GiB,需要 ≥36GiB")),
         ):
        result = await gen.generate("a boy walking")
    assert result.success is False
    assert "显存不足" in result.error


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
    """LtxVideoGenerator NSFW 链路(pool)未注入 pool → 返回 success=False(不调外部)。"""
    gen = LtxVideoGenerator(pool=None, tracker=lambda c, p: None)
    result = await gen.generate("a boy walking", nsfw=True)
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
async def test_ltx_sfw_retired_returns_failure():
    """SFW 链路已随 LTX-2.5 退役(2026-08-23):直接返回失败原因,不提交任何作业。"""
    gen = LtxVideoGenerator(pool=None, tracker=lambda c, p: None)
    result = await gen.generate("a boy walking", duration_sec=6, fps=24)
    assert result.success is False
    assert result.model == "ltx"
    assert "已退役" in result.error


@pytest.mark.asyncio
async def test_ltx_nsfw_over_limit_returns_failure():
    """LTX-2.3(NSFW)不支持 extend:15s@30fps=450>241 → 返回失败原因(单段上限)。"""
    client = AsyncMock()
    client.base_url = "http://worker"
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=client)

    fake_settings = MagicMock()
    fake_settings.nsfw_default_video_ckpt = "10eros_v14.safetensors"
    fake_settings.nsfw_default_gemma = "gemma3_12b_it_bf16/model.safetensors"
    fake_settings.nsfw_default_vae = "LTX23_video_vae_bf16.safetensors"

    gen = LtxVideoGenerator(pool=pool, tracker=lambda c, p: None)
    with patch("app.services.video_generators.get_settings", return_value=fake_settings):
        result = await gen.generate("a boy walking", duration_sec=15, fps=30, nsfw=True)

    assert result.success is False
    assert "单段上限" in result.error
    client.queue_prompt.assert_not_called()


@pytest.mark.asyncio
async def test_ltx_nsfw_trim_plan_spawns_chain():
    """LTX-2.3(NSFW)trim 计划:4.6s@16fps=74 帧 → 向上吸附 81(5.06s,差 0.46s)→ 挂精裁链。"""
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="pid-x")
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=client)

    fake_settings = MagicMock()
    fake_settings.nsfw_default_video_ckpt = "10eros_v14.safetensors"
    fake_settings.nsfw_default_gemma = "gemma3_12b_it_bf16/model.safetensors"
    fake_settings.nsfw_default_vae = "LTX23_video_vae_bf16.safetensors"

    gen = LtxVideoGenerator(pool=pool, tracker=lambda c, p: None)
    with patch("app.services.video_generators.get_settings", return_value=fake_settings), \
         patch("app.services.video_generators.spawn_duration_chain") as spawn_mock:
        result = await gen.generate("a boy walking", duration_sec=4.6, fps=16, nsfw=True)

    assert result.success is True
    g = client.queue_prompt.call_args[0][0]
    assert g["10"]["inputs"]["length"] == 81  # 74 → 向上吸附 8k+1=81
    assert spawn_mock.call_args.kwargs["plan"].strategy == "trim"
    assert "精确裁至 4.6 秒" in result.duration_notice


@pytest.mark.asyncio
async def test_ltx_nsfw_routes_to_pool_10eros():
    """NSFW 链路保留 LTX-2.3 + 10Eros(pool):nsfw=True 用 NSFW 专用底模。"""
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="pid-x")
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=client)

    fake_settings = MagicMock()
    fake_settings.nsfw_default_video_ckpt = "10eros_v14.safetensors"
    fake_settings.nsfw_default_gemma = "gemma3_12b_it_bf16/model.safetensors"
    fake_settings.nsfw_default_vae = "LTX23_video_vae_bf16.safetensors"

    gen = LtxVideoGenerator(pool=pool, tracker=lambda c, p: None)
    with patch("app.services.video_generators.get_settings", return_value=fake_settings):
        r_nsfw = await gen.generate("a boy walking", nsfw=True)

    assert r_nsfw.success
    g_nsfw = client.queue_prompt.call_args[0][0]
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
