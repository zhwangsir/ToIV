from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.agent import llm
from app.harness.llm_seam import LayeredLLMProvider
import app.nsfw_ctx as nsfw_ctx


@pytest.mark.asyncio
async def test_same_model_nsfw_path_raises_once(monkeypatch):
    calls = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        calls.append(label)
        raise llm.LLMError("LLM 调用失败(400): maximum context length is 32768 tokens")

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    monkeypatch.setattr("app.redline.nsfw_allowed", lambda *a, **k: True)
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_nsfw_model", settings.llm_model)
    monkeypatch.setattr(settings, "llm_nsfw_base_url", "")
    monkeypatch.setattr(settings, "llm_fallback_model", "")

    with pytest.raises(llm.LLMError) as ei:
        await llm.chat([{"role": "user", "content": "hi"}])
    assert "主备均不可用" not in str(ei.value)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_distinct_nsfw_endpoint_still_falls_back(monkeypatch):
    calls = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        calls.append(label)
        raise llm.LLMError(label + " down")

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    monkeypatch.setattr("app.redline.nsfw_allowed", lambda *a, **k: True)
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_nsfw_model", "nsfw-other")
    monkeypatch.setattr(settings, "llm_nsfw_base_url", "http://127.0.0.1:9/v1")
    monkeypatch.setattr(settings, "llm_fallback_model", "")

    with pytest.raises(llm.LLMError) as ei:
        await llm.chat([{"role": "user", "content": "hi"}])
    assert "主备均不可用" in str(ei.value)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_nsfw_route_requires_adult_account_and_layered_forwards_user(monkeypatch):
    labels = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        labels.append(label)
        return {"role": "assistant", "content": "ok"}

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_nsfw_model", "nsfw-other")
    monkeypatch.setattr(settings, "llm_nsfw_base_url", "http://127.0.0.1:9/v1")

    adult = SimpleNamespace(content_mode="adult", birthdate=None)
    result = await llm.chat_layered([{"role": "user", "content": "hi"}], layer="L4", user=adult)
    assert result["content"] == "ok"
    assert labels == ["NSFW 模型 nsfw-other"]

    ordinary = SimpleNamespace(content_mode="ordinary", birthdate=None)
    await llm.chat([{"role": "user", "content": "hi"}], user=ordinary)
    assert labels[-1] == f"主模型 {settings.llm_model}"


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
