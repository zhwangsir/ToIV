"""类型化事件总线:emit(fire-and-forget 并行通知)+ waterfall(next() 链式委托)。

事件三域(对齐 dsh,本期最小集):
- agent/*(在飞拦截,waterfall):AGENT_PRE_STEP / AGENT_REQUEST
- tools/*(守卫管线):TOOLS_PRE_EXECUTE(waterfall) / TOOLS_POST_EXECUTE(emit)
- session/*(持久事实,emit):SESSION_EVENT

waterfall 语义(对齐 dsh):
- 每个监听器收到 (payload, next);
- 调 next(可携带改写后的 payload)→ 委托给下一个监听器,最终到 final;
- 不调 next 直接返回值 → 链中断,该值即最终结果;
- 调 next 后返回 None → 透传下游结果;返回非 None → 改写下游结果。
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 事件名常量(类型化事件的事实源;新增事件域在此登记)
# ---------------------------------------------------------------------------
AGENT_PRE_STEP = "agent/pre-step"
AGENT_REQUEST = "agent/request"
TOOLS_PRE_EXECUTE = "tools/pre-execute"
TOOLS_POST_EXECUTE = "tools/post-execute"
SESSION_EVENT = "session/event"
# H3 质量门事件域:orchestrator 渲染完成后 emit,QualityPlugin 订阅执行 advisory 评估
QUALITY_ADVISORY = "quality/advisory"

# emit 监听器:payload → None(可为协程)
Listener = Callable[[Any], Any]
# waterfall 监听器:(payload, next) → 结果(可为协程)
WaterfallNext = Callable[[Any], Awaitable[Any]]
WaterfallListener = Callable[[Any, WaterfallNext], Any]


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class EventBus:
    """进程内事件总线。emit 与 waterfall 监听器分开登记,互不串扰。"""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Listener]] = {}
        self._waterfall_listeners: dict[str, list[WaterfallListener]] = {}

    # ------------------------------------------------------------------
    # emit 域:并行通知,异常记日志不中断
    # ------------------------------------------------------------------
    def on(self, event: str, listener: Listener) -> Callable[[], None]:
        """订阅 emit 事件,返回退订器(幂等)。"""
        self._listeners.setdefault(event, []).append(listener)

        def off() -> None:
            try:
                self._listeners.get(event, []).remove(listener)
            except ValueError:
                pass  # 已退订/从未生效:幂等吞掉

        return off

    async def emit(self, event: str, payload: Any = None) -> None:
        """并行通知全部监听器;单个监听器异常记日志,不影响其他监听器。"""
        listeners = list(self._listeners.get(event, ()))
        if not listeners:
            return

        async def _safe(listener: Listener) -> None:
            try:
                await _maybe_await(listener(payload))
            except Exception:  # noqa: BLE001 — 监听器失败不中断事件分发
                logger.exception("事件监听器异常 event=%s", event)

        await asyncio.gather(*(_safe(ln) for ln in listeners))

    # ------------------------------------------------------------------
    # waterfall 域:next() 链式委托
    # ------------------------------------------------------------------
    def on_waterfall(
        self, event: str, listener: WaterfallListener
    ) -> Callable[[], None]:
        """订阅 waterfall 事件,返回退订器(幂等)。"""
        self._waterfall_listeners.setdefault(event, []).append(listener)

        def off() -> None:
            try:
                self._waterfall_listeners.get(event, []).remove(listener)
            except ValueError:
                pass

        return off

    async def waterfall(
        self,
        event: str,
        payload: Any,
        final: Callable[[Any], Any],
    ) -> Any:
        """按注册顺序穿监听器链;链尾执行 final(payload) 并沿链回传结果。"""
        listeners = list(self._waterfall_listeners.get(event, ()))

        async def _call(index: int, current: Any) -> Any:
            if index >= len(listeners):
                return await _maybe_await(final(current))
            listener = listeners[index]
            called = False
            downstream: Any = None

            async def _next(new_payload: Any = None) -> Any:
                nonlocal called, downstream
                if called:
                    raise RuntimeError(
                        f"waterfall next() 重复调用 event={event}"
                    )
                called = True
                # next() 不带参 → 原样透传;带参 → payload 逐层改写
                downstream = await _call(
                    index + 1, current if new_payload is None else new_payload
                )
                return downstream

            result = await _maybe_await(listener(current, _next))
            if not called:
                return result  # 未调 next:中断,监听器返回值即最终结果
            # 调了 next:返回 None 透传下游结果,非 None 改写下游结果
            return downstream if result is None else result

        return await _call(0, payload)
