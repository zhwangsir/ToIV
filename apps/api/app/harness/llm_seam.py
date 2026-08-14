"""LLM 适配缝(ctx.llm):Provider 三角色收编 agent/llm.py 全部能力。

- Definition:LLMProvider 协议 — chat / chat_layered / embed。
- Provider:LayeredLLMProvider — 薄包装 app.agent.llm(重试/降级链/fallback/
  NSFW 路由/reasoning 合并全部保留,零行为变更)。
- Consumer:各路由/服务经 get_ctx().service("llm") 取用。

🔒 兼容性铁律:chat/chat_layered 必须在**调用时**经 getattr 动态查找
app.agent.llm 的模块函数,禁止在构造时捕获函数引用——既有大量测试
monkeypatch llm.chat / llm.chat_layered(模块属性替换),构造时捕获会让
mock 全部失效。

embed:复用 app.agent.rag._embed 的客户端逻辑(settings.embed_url 发
OpenAI 兼容 /v1/embeddings,失败优雅降级返回 None),不复制实现。
"""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from app.agent import llm as _llm_module
from app.agent import rag as _rag_module
from app.harness.context import HarnessContext


@runtime_checkable
class LLMProvider(Protocol):
    """LLM 服务协议(ctx.llm 的 Definition)。"""

    async def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.4,
    ) -> dict: ...

    async def chat_layered(
        self,
        messages: list[dict],
        layer: str = "L1",
        max_tokens: int | None = None,
        temperature: float = 0.5,
    ) -> dict: ...

    async def embed(self, texts: list[str]) -> list[list[float]] | None: ...


class LayeredLLMProvider:
    """默认 Provider:动态委托 app.agent.llm;embed 委托 app.agent.rag._embed。

    settings 参数保留给未来直发实现的 Provider(如 vLLM 直连适配器);
    本实现每次调用经 llm.py 内部的 get_settings() 取配置,不自行持有。
    """

    def __init__(self, settings: Any = None) -> None:
        self._settings = settings

    async def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.4,
    ) -> dict:
        # 调用时动态查找:monkeypatch llm.chat 后仍命中 mock(兼容性铁律)
        return await getattr(_llm_module, "chat")(
            messages, tools=tools, max_tokens=max_tokens, temperature=temperature
        )

    async def chat_layered(
        self,
        messages: list[dict],
        layer: str = "L1",
        max_tokens: int | None = None,
        temperature: float = 0.5,
    ) -> dict:
        return await getattr(_llm_module, "chat_layered")(
            messages, layer=layer, max_tokens=max_tokens, temperature=temperature
        )

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        # 复用 rag 的 embedding 客户端(settings.embed_url/embed_model,失败降级 None)
        return await _rag_module._embed(list(texts))


class LLMPlugin:
    """把 LLMProvider 注册为 ctx.llm 的内建插件。可注入自定义 Provider(测试/替换)。"""

    name = "llm-seam"

    def __init__(self, provider: LLMProvider | None = None) -> None:
        self._provider: LLMProvider = provider or LayeredLLMProvider()

    def activate(self, ctx: HarnessContext) -> None:
        ctx.register_service("llm", self._provider)
