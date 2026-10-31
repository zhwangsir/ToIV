"""agent chat/resume SSE 保活(_events_with_keepalive)单测。

背景(2026-08-24):前端 30s 首块超时曾在大上下文/spark02 高负载/瞬时重试时
误杀「思考中」的流(「回复失败:服务暂时不可用」);后端改为空闲 10s 下发
SSE comment(`: ping`)保活,前端按字节活动重置 120s 不活跃计时。

覆盖:
- 事件流空闲 > ping_interval → 产出 comment 保活帧,事件本身不丢
- 事件连续产出 → 零保活帧(不污染协议)
- 生产者异常 → 已产事件保留,迭代结束后原样重抛(不吞)
- sse-starlette comment 帧序列化为 `: ping`(前端按字节即视为活动)
"""
import asyncio

import pytest

from app.routes.agent import _events_with_keepalive


async def _collect(agen) -> list[dict]:
    return [item async for item in agen]


async def test_idle_stream_yields_comment_keepalive():
    async def events():
        await asyncio.sleep(0.22)
        yield {"type": "text", "content": "首块"}

    out = await _collect(_events_with_keepalive(events(), ping_interval=0.05))
    comments = [i for i in out if "comment" in i]
    assert len(comments) >= 2, "空闲期应持续下发保活 comment"
    assert out[-1] == {"type": "text", "content": "首块"}, "保活帧不得吞掉真实事件"


async def test_busy_stream_has_no_keepalive():
    async def events():
        yield {"type": "text", "content": "a"}
        yield {"type": "tool_event", "data": {"id": "t1"}}

    out = await _collect(_events_with_keepalive(events(), ping_interval=30.0))
    assert out == [{"type": "text", "content": "a"},
                   {"type": "tool_event", "data": {"id": "t1"}}]


async def test_producer_exception_reraised_after_drain():
    async def events():
        yield {"type": "text", "content": "partial"}
        await asyncio.sleep(0.01)
        raise RuntimeError("LLM boom")

    out: list[dict] = []
    with pytest.raises(RuntimeError, match="LLM boom"):
        async for item in _events_with_keepalive(events(), ping_interval=0.05):
            out.append(item)
    assert out == [{"type": "text", "content": "partial"}], "重抛前不得丢已产事件"


async def test_producer_immediate_exception_still_reraised():
    async def events():
        raise ValueError("bad")
        yield  # pragma: no cover — 使其成为 async generator

    with pytest.raises(ValueError, match="bad"):
        await _collect(_events_with_keepalive(events(), ping_interval=0.05))


def test_sse_comment_frame_serializes_as_colon_ping():
    """sse-starlette dict 的 comment 键 → `: ping` 帧(前端 onActivity 的判定依据)。"""
    from sse_starlette.sse import ServerSentEvent

    assert ServerSentEvent(comment="ping").encode() == b": ping\r\n\r\n"
