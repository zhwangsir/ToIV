from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.agent import llm
from app.harness.llm_seam import LayeredLLMProvider


@pytest.mark.asyncio
async def test_primary_failure_raises_once(monkeypatch):
    calls = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        calls.append(label)
        raise llm.LLMError("LLM 调用失败(400): maximum context length is 32768 tokens")

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_fallback_model", "")

    with pytest.raises(llm.LLMError) as ei:
        await llm.chat([{"role": "user", "content": "hi"}])
    assert "主备均不可用" not in str(ei.value)
    assert calls == [f"主模型 {settings.llm_model}"]


@pytest.mark.asyncio
async def test_content_mode_never_changes_llm_route(monkeypatch):
    """NSFW/SFW 共用同一个 LLM:账号内容态不影响端点与模型选择。"""
    labels = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        labels.append(label)
        return {"role": "assistant", "content": "ok"}

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    settings = llm.get_settings()

    adult = SimpleNamespace(content_mode="adult", birthdate=None)
    ordinary = SimpleNamespace(content_mode="ordinary", birthdate=None)
    await llm.chat([{"role": "user", "content": "hi"}], user=adult)
    await llm.chat([{"role": "user", "content": "hi"}], user=ordinary)
    await llm.chat([{"role": "user", "content": "hi"}])
    assert labels == [f"主模型 {settings.llm_model}"] * 3


@pytest.mark.asyncio
async def test_l4_layer_uses_primary_model(monkeypatch):
    labels = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        labels.append(label)
        return {"role": "assistant", "content": "ok"}

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    settings = llm.get_settings()

    adult = SimpleNamespace(content_mode="adult", birthdate=None)
    result = await llm.chat_layered(
        [{"role": "user", "content": "hi"}], layer="L4", user=adult
    )
    assert result["content"] == "ok"
    assert labels == [f"主模型 {settings.llm_model}"]


@pytest.mark.asyncio
async def test_layered_provider_preserves_account_context(monkeypatch):
    seen = {}

    async def fake_chat_layered(messages, **kwargs):
        seen.update(kwargs)
        return {"role": "assistant", "content": "ok"}

    monkeypatch.setattr(llm, "chat_layered", fake_chat_layered)
    user = SimpleNamespace(content_mode="adult", birthdate=None)
    await LayeredLLMProvider().chat_layered([{"role": "user", "content": "hi"}], user=user)
    assert seen["user"] is user
