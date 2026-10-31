"""HarnessContext:共享上下文 — 服务注册表 + 可逆效应栈。

对齐 Cordis 思想:
- 一切皆插件,插件把服务/监听器挂到共享 ctx;
- register_service 返回回收器(disposer),并自动压入效应栈;
- unload 时逆序回收效应(LIFO),保证后注册的先拆、先注册的后拆。

重复注册同名服务直接抛 KeyError,防覆盖事故(静默覆盖会让
「换 Provider 全局生效」变成「谁后注册谁赢」的竞态)。
"""
from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from app.harness.events import EventBus

logger = logging.getLogger(__name__)

# 回收器:同步或可 await 的零参 callable
Disposer = Callable[[], Any]


class HarnessContext:
    """进程内共享上下文。服务表与事件总线在 scope 间共享,效应栈各自独立。"""

    def __init__(
        self,
        *,
        _services: dict[str, Any] | None = None,
        _events: EventBus | None = None,
    ) -> None:
        self._services: dict[str, Any] = _services if _services is not None else {}
        self._events: EventBus = _events if _events is not None else EventBus()
        self._effects: list[Disposer] = []

    # ------------------------------------------------------------------
    # 事件总线(三域事件挂载点,见 events.py)
    # ------------------------------------------------------------------
    @property
    def events(self) -> EventBus:
        return self._events

    # ------------------------------------------------------------------
    # 服务注册表
    # ------------------------------------------------------------------
    def register_service(self, key: str, obj: Any) -> Disposer:
        """注册服务并返回回收器。重复注册同名服务抛 KeyError。

        回收器幂等:重复调用不报错;仅当当前登记对象仍是本次注册对象时才移除
        (防误删后注册者)。回收器同时压入本 ctx 的效应栈,unload 时自动回收。
        """
        if key in self._services:
            raise KeyError(f"harness 服务重复注册: {key}")
        self._services[key] = obj

        disposed = False

        def dispose() -> None:
            nonlocal disposed
            if disposed:
                return
            disposed = True
            if self._services.get(key) is obj:
                del self._services[key]

        self._effects.append(dispose)
        return dispose

    def service(self, key: str) -> Any:
        """取服务;未注册抛 KeyError(调用方应先用 has() 或保证已注册)。"""
        try:
            return self._services[key]
        except KeyError:
            raise KeyError(f"harness 服务未注册: {key}") from None

    def has(self, key: str) -> bool:
        return key in self._services

    # ------------------------------------------------------------------
    # 可逆效应
    # ------------------------------------------------------------------
    def on_dispose(self, disposer: Disposer) -> Disposer:
        """把任意回收器压入效应栈(如 events.on 返回的退订器),返回原回收器。"""
        self._effects.append(disposer)
        return disposer

    def scope(self) -> HarnessContext:
        """派生子作用域:共享服务表与事件总线,效应栈独立。

        插件激活时在独立 scope 里注册服务,dispose 插件即 unload 其 scope,
        只回收该插件的效应,不影响其他插件。
        """
        return HarnessContext(_services=self._services, _events=self._events)

    async def unload(self) -> None:
        """逆序回收效应栈(LIFO)。单个回收器异常记日志不中断整体回收。"""
        while self._effects:
            disposer = self._effects.pop()
            try:
                result = disposer()
                if inspect.isawaitable(result):
                    await result
            except Exception:  # noqa: BLE001 — 回收器失败不应拖垮整体卸载
                logger.exception("harness 效应回收失败,继续逆序回收剩余效应")
