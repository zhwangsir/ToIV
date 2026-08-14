"""进程级 harness 单例:get_ctx() 懒引导,reset_ctx() 仅供测试。

懒引导:首次 get_ctx() 时建 HarnessContext + PluginRegistry 并跑
bootstrap_default(注册内建插件,本期 llm seam)。默认 Provider
(LayeredLLMProvider)动态委托 app.agent.llm,保证未显式注入时
行为与直调 llm.chat / llm.chat_layered 完全一致。

消费方纪律:在函数内取 ctx(get_ctx().service("llm")),不在模块级捕获——
测试 reset_ctx() 后拿到的是新 ctx,模块级捕获会拿到已回收的旧实例。
"""
from __future__ import annotations

from app.harness.context import HarnessContext
from app.harness.plugin import PluginRegistry, bootstrap_default

_ctx: HarnessContext | None = None
_registry: PluginRegistry | None = None


def get_ctx() -> HarnessContext:
    """进程级共享 ctx(懒引导)。"""
    global _ctx, _registry
    if _ctx is None:
        _ctx = HarnessContext()
        _registry = PluginRegistry(_ctx)
        bootstrap_default(_ctx, _registry)
    return _ctx


def get_registry() -> PluginRegistry:
    """进程级插件注册表(随 get_ctx() 一并懒引导)。"""
    get_ctx()
    assert _registry is not None  # get_ctx() 已引导
    return _registry


async def reset_ctx() -> None:
    """仅供测试:回收全部插件效应并清空单例,下次 get_ctx() 重新引导。"""
    global _ctx, _registry
    if _registry is not None:
        await _registry.dispose_all()
    elif _ctx is not None:
        await _ctx.unload()
    _ctx = None
    _registry = None
