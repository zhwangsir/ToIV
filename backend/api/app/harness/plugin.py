"""Plugin 协议与注册表:一切皆插件,use 激活、dispose 逆序回收其效应。

- Plugin:name + activate(ctx)。activate 在独立 scope 里执行,
  期间 register_service / on_dispose 压入的效应都归属该插件。
- PluginRegistry.use(plugin):激活并登记;重名抛 KeyError。
- PluginRegistry.dispose(name):unload 该插件的 scope,逆序回收其全部效应。
- dispose_all():按激活逆序逐个 dispose(先装的后拆)。
"""
from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

from app.harness.context import HarnessContext

logger = logging.getLogger(__name__)


@runtime_checkable
class Plugin(Protocol):
    """harness 插件协议。activate 只做同步注册(挂服务/事件),不做异步初始化。"""

    name: str

    def activate(self, ctx: HarnessContext) -> None: ...


class PluginRegistry:
    """启动组合器:按 use 顺序激活插件,按逆序回收。"""

    def __init__(self, ctx: HarnessContext) -> None:
        self._ctx = ctx
        self._plugins: dict[str, HarnessContext] = {}
        self._order: list[str] = []

    @property
    def plugin_names(self) -> list[str]:
        """已激活插件名(按激活顺序),供启动日志/诊断端点展示。"""
        return list(self._order)

    def use(self, plugin: Plugin) -> None:
        """激活插件:在独立 scope 执行 activate,效应归属该插件。"""
        if plugin.name in self._plugins:
            raise KeyError(f"harness 插件重复激活: {plugin.name}")
        scope = self._ctx.scope()
        plugin.activate(scope)
        self._plugins[plugin.name] = scope
        self._order.append(plugin.name)
        logger.info("harness 插件已激活: %s", plugin.name)

    async def dispose(self, name: str) -> None:
        """回收单个插件:unload 其 scope(逆序回收其效应)。"""
        scope = self._plugins.pop(name, None)
        if scope is None:
            raise KeyError(f"harness 插件未激活: {name}")
        self._order.remove(name)
        await scope.unload()
        logger.info("harness 插件已回收: %s", name)

    async def dispose_all(self) -> None:
        """按激活逆序回收全部插件。单插件异常记日志不中断。"""
        for name in reversed(self._order):
            try:
                await self.dispose(name)
            except Exception:  # noqa: BLE001 — 回收失败不拖垮整体关停
                logger.exception("harness 插件回收失败: %s", name)


def bootstrap_default(ctx: HarnessContext, registry: PluginRegistry) -> None:
    """注册内建插件。H3 起按 profile 裁剪(harness/profile.py);
    测试/特殊场景可直接 registry.use() 追加。"""
    from app.harness.profile import bootstrap_profile

    bootstrap_profile(ctx, registry)
