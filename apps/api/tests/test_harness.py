"""H1 harness 内核测试:ctx 服务/效应、事件总线、插件生命周期、LLM 适配缝。

关键兼容性锁定:
- 默认 Provider(LayeredLLMProvider)调用时动态查找 app.agent.llm 模块函数,
  monkeypatch llm.chat / llm.chat_layered 后经 ctx 调用仍命中 mock;
- 经 PluginRegistry 换入 fake Provider 后,消费方(optimize/storyboard)走到 fake。

每个用例前后 reset_ctx(),保证单例隔离(消费方在函数内取 ctx,重置后安全)。
"""
from __future__ import annotations

import pytest

from app.agent import llm, rag
from app.harness import events as ev
from app.harness.context import HarnessContext
from app.harness.ctx import get_ctx, get_registry, reset_ctx
from app.harness.llm_seam import LayeredLLMProvider, LLMPlugin
from app.harness.plugin import PluginRegistry


@pytest.fixture(autouse=True)
async def _fresh_ctx():
    """用例间隔离进程级 harness 单例。"""
    await reset_ctx()
    yield
    await reset_ctx()


class FakeProvider:
    """记录调用的 fake LLMProvider(chat/chat_layered/embed 三方法)。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def chat(self, messages, tools=None, max_tokens=None, temperature=0.4):
        self.calls.append(("chat", {"messages": messages, "tools": tools}))
        return {"content": "fake-chat", "_reasoning_tokens": 0}

    async def chat_layered(self, messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        self.calls.append(("chat_layered", {"layer": layer, "messages": messages}))
        return {"content": "fake-layered", "_reasoning_tokens": 0}

    async def embed(self, texts):
        self.calls.append(("embed", {"texts": texts}))
        return [[0.1, 0.2]]


# ===========================================================================
# ctx:服务注册 / 取用 / 重复注册 / 回收逆序
# ===========================================================================


def test_ctx_register_service_and_lookup():
    ctx = HarnessContext()
    obj = object()
    ctx.register_service("svc", obj)
    assert ctx.has("svc")
    assert ctx.service("svc") is obj
    assert not ctx.has("missing")


def test_ctx_service_missing_raises_keyerror():
    ctx = HarnessContext()
    with pytest.raises(KeyError):
        ctx.service("missing")


def test_ctx_duplicate_register_raises_keyerror():
    ctx = HarnessContext()
    ctx.register_service("svc", object())
    with pytest.raises(KeyError):
        ctx.register_service("svc", object())


def test_ctx_disposer_removes_service_and_is_idempotent():
    ctx = HarnessContext()
    dispose = ctx.register_service("svc", object())
    dispose()
    assert not ctx.has("svc")
    dispose()  # 幂等:重复调用不报错
    assert not ctx.has("svc")


async def test_ctx_unload_reclaims_in_reverse_order():
    ctx = HarnessContext()
    order: list[str] = []
    ctx.register_service("a", object())
    ctx.on_dispose(lambda: order.append("first"))
    ctx.on_dispose(lambda: order.append("second"))
    await ctx.unload()
    # 后进先出:second → first → a 的服务回收器(最先压栈,最后回收)
    assert order == ["second", "first"]
    assert not ctx.has("a")


async def test_ctx_unload_continues_after_disposer_error():
    ctx = HarnessContext()
    order: list[str] = []

    def _boom():
        raise RuntimeError("boom")

    ctx.on_dispose(lambda: order.append("first"))
    ctx.on_dispose(_boom)
    ctx.on_dispose(lambda: order.append("third"))
    await ctx.unload()
    # 逆序:third → boom(记日志不中断)→ first
    assert order == ["third", "first"]


# ===========================================================================
# events:emit 并行通知 / 异常不中断;waterfall 顺序 / 中断 / payload 改写
# ===========================================================================


def test_event_name_constants():
    assert ev.AGENT_PRE_STEP == "agent/pre-step"
    assert ev.AGENT_REQUEST == "agent/request"
    assert ev.TOOLS_PRE_EXECUTE == "tools/pre-execute"
    assert ev.TOOLS_POST_EXECUTE == "tools/post-execute"
    assert ev.SESSION_EVENT == "session/event"


async def test_emit_notifies_all_listeners():
    bus = ev.EventBus()
    got: list[str] = []
    bus.on("e", lambda p: got.append(f"a:{p}"))
    bus.on("e", lambda p: got.append(f"b:{p}"))
    await bus.emit("e", "x")
    assert sorted(got) == ["a:x", "b:x"]


async def test_emit_listener_error_does_not_break_others():
    bus = ev.EventBus()
    got: list[str] = []

    def _boom(_p):
        raise RuntimeError("boom")

    bus.on("e", _boom)
    bus.on("e", lambda p: got.append(p))
    await bus.emit("e", "ok")
    assert got == ["ok"]


async def test_emit_unsubscribe():
    bus = ev.EventBus()
    got: list[str] = []
    off = bus.on("e", lambda p: got.append(p))
    off()
    off()  # 幂等
    await bus.emit("e", "x")
    assert got == []


async def test_waterfall_order_and_result_passthrough():
    bus = ev.EventBus()
    trace: list[str] = []

    async def first(payload, nxt):
        trace.append(f"first-in:{payload}")
        result = await nxt()
        trace.append(f"first-out:{result}")
        return result

    async def second(payload, nxt):
        trace.append(f"second-in:{payload}")
        return await nxt()

    bus.on_waterfall("e", first)
    bus.on_waterfall("e", second)
    result = await bus.waterfall("e", "p0", lambda p: f"final:{p}")
    assert result == "final:p0"
    assert trace == ["first-in:p0", "second-in:p0", "first-out:final:p0"]


async def test_waterfall_interrupt_without_next():
    bus = ev.EventBus()
    trace: list[str] = []

    async def blocker(payload, nxt):
        trace.append("blocker")
        return "blocked"  # 不调 next → 链中断

    async def never(payload, nxt):
        trace.append("never")
        return await nxt()

    bus.on_waterfall("e", blocker)
    bus.on_waterfall("e", never)
    result = await bus.waterfall(
        "e", "p", lambda p: trace.append("final") or "final"
    )
    assert result == "blocked"
    assert trace == ["blocker"]


async def test_waterfall_payload_rewrite_layer_by_layer():
    bus = ev.EventBus()

    async def add_a(payload, nxt):
        return await nxt(payload + "a")  # 改写 payload 传给下游

    async def add_b(payload, nxt):
        return await nxt(payload + "b")

    bus.on_waterfall("e", add_a)
    bus.on_waterfall("e", add_b)
    result = await bus.waterfall("e", "", lambda p: p)
    assert result == "ab"


async def test_waterfall_result_rewrite_after_next():
    bus = ev.EventBus()

    async def wrap(payload, nxt):
        result = await nxt()
        return f"[{result}]"  # 调 next 后返回非 None → 改写下游结果

    bus.on_waterfall("e", wrap)
    result = await bus.waterfall("e", "p", lambda p: "core")
    assert result == "[core]"


# ===========================================================================
# plugin:activate / dispose 生命周期
# ===========================================================================


class _DummyPlugin:
    def __init__(self, name: str, service_key: str) -> None:
        self.name = name
        self._key = service_key

    def activate(self, ctx: HarnessContext) -> None:
        ctx.register_service(self._key, f"svc-{self.name}")


async def test_plugin_use_and_dispose():
    ctx = get_ctx()  # 引导默认插件(llm seam)
    registry = get_registry()
    assert "llm-seam" in registry.plugin_names
    assert ctx.has("llm")

    registry.use(_DummyPlugin("p1", "svc1"))
    assert ctx.has("svc1")
    await registry.dispose("p1")
    assert not ctx.has("svc1")
    assert "p1" not in registry.plugin_names
    # dispose 只回收本插件效应,llm 服务不受影响
    assert ctx.has("llm")


async def test_plugin_duplicate_use_raises():
    registry = get_registry()
    registry.use(_DummyPlugin("p1", "svc1"))
    with pytest.raises(KeyError):
        registry.use(_DummyPlugin("p1", "svc2"))
    await registry.dispose("p1")


async def test_plugin_dispose_unknown_raises():
    registry = get_registry()
    with pytest.raises(KeyError):
        await registry.dispose("nope")


async def test_plugin_dispose_all_reverse_order():
    ctx = HarnessContext()
    registry = PluginRegistry(ctx)
    order: list[str] = []

    class _P:
        def __init__(self, name: str) -> None:
            self.name = name

        def activate(self, c: HarnessContext) -> None:
            c.on_dispose(lambda: order.append(f"dispose-{self.name}"))

    registry.use(_P("a"))
    registry.use(_P("b"))
    registry.use(_P("c"))
    await registry.dispose_all()
    assert order == ["dispose-c", "dispose-b", "dispose-a"]
    assert registry.plugin_names == []


# ===========================================================================
# LLM seam:默认 Provider 兼容性 + fake Provider 注入
# ===========================================================================


async def test_default_provider_registered_after_bootstrap():
    ctx = get_ctx()
    provider = ctx.service("llm")
    assert isinstance(provider, LayeredLLMProvider)


async def test_default_provider_hits_monkeypatched_llm_chat(monkeypatch):
    """兼容性铁律:monkeypatch llm.chat 后,经 ctx 调用仍命中 mock。"""
    called: list[dict] = []

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):
        called.append({"messages": messages, "tools": tools})
        return {"content": "mocked"}

    monkeypatch.setattr(llm, "chat", fake_chat)
    get_ctx()  # 引导在 monkeypatch 之前之后都无所谓:动态查找在调用时发生
    msg = await get_ctx().service("llm").chat(
        [{"role": "user", "content": "hi"}], tools=[{"type": "function"}]
    )
    assert msg["content"] == "mocked"
    assert called[0]["tools"] == [{"type": "function"}]


async def test_default_provider_hits_monkeypatched_chat_layered(monkeypatch):
    called: list[str] = []

    async def fake_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        called.append(layer)
        return {"content": f"mocked-{layer}"}

    monkeypatch.setattr(llm, "chat_layered", fake_layered)
    msg = await get_ctx().service("llm").chat_layered(
        [{"role": "user", "content": "hi"}], layer="L3"
    )
    assert msg["content"] == "mocked-L3"
    assert called == ["L3"]


async def test_default_provider_embed_delegates_to_rag(monkeypatch):
    """embed 复用 rag._embed 客户端逻辑,不复制实现。"""
    seen: list[list[str]] = []

    async def fake_embed(texts):
        seen.append(texts)
        return [[1.0, 2.0]]

    monkeypatch.setattr(rag, "_embed", fake_embed)
    vecs = await get_ctx().service("llm").embed(["hello"])
    assert vecs == [[1.0, 2.0]]
    assert seen == [["hello"]]


async def test_fake_provider_swap_hits_consumers():
    """换 Provider 全局生效:dispose 默认 llm 插件 → use fake,消费方走到 fake。"""
    fake = FakeProvider()
    registry = get_registry()
    await registry.dispose("llm-seam")
    registry.use(LLMPlugin(fake))

    from app.routes import optimize

    text = await optimize._llm_text("sys", "prompt", layer="L2")
    assert text == "fake-layered"
    assert fake.calls[0][0] == "chat_layered"
    assert fake.calls[0][1]["layer"] == "L2"


async def test_fake_provider_swap_hits_storyboard_service():
    """services 层消费方(storyboard.parse_script)同样走注入的 fake。"""
    import json as _json

    class _ScriptProvider(FakeProvider):
        async def chat_layered(self, messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
            self.calls.append(("chat_layered", {"layer": layer}))
            return {
                "content": _json.dumps(
                    {
                        "characters": [{"name": "阿明", "visual_prompt": "短发少年"}],
                        "shots": [{"prompt": "阿明走进教室", "characters": ["阿明"]}],
                    },
                    ensure_ascii=False,
                )
            }

    fake = _ScriptProvider()
    registry = get_registry()
    await registry.dispose("llm-seam")
    registry.use(LLMPlugin(fake))

    from app.services.studio import storyboard

    characters, shots = await storyboard.parse_script("剧情", num_shots=1)
    assert characters[0].name == "阿明"
    assert len(shots) == 1
    # parse_script 固定走 L3 层
    assert ("chat_layered", {"layer": "L3"}) in fake.calls


async def test_consumers_use_fresh_ctx_after_reset():
    """reset_ctx 后消费方在函数内取 ctx → 拿到重新引导的默认 Provider。"""
    get_ctx()
    await reset_ctx()
    ctx2 = get_ctx()
    assert isinstance(ctx2.service("llm"), LayeredLLMProvider)
    # H3 起 bootstrap 按 profile 注册:llm seam → tool seam → engine seam → quality seam
    assert get_registry().plugin_names == ["llm-seam", "tool-seam", "engine-seam", "quality-seam"]
