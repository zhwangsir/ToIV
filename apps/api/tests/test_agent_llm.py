from __future__ import annotations

import pytest

from app.agent import llm
import app.nsfw_ctx as nsfw_ctx


@pytest.mark.asyncio
async def test_same_model_nsfw_path_raises_once(monkeypatch):
    calls = []

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        calls.append(label)
        raise llm.LLMError("LLM 调用失败(400): maximum context length is 32768 tokens")

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    monkeypatch.setattr(nsfw_ctx, "nsfw_allowed", lambda: True)
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
    monkeypatch.setattr(nsfw_ctx, "nsfw_allowed", lambda: True)
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_nsfw_model", "nsfw-other")
    monkeypatch.setattr(settings, "llm_nsfw_base_url", "http://127.0.0.1:9/v1")
    monkeypatch.setattr(settings, "llm_fallback_model", "")

    with pytest.raises(llm.LLMError) as ei:
        await llm.chat([{"role": "user", "content": "hi"}])
    assert "主备均不可用" in str(ei.value)
    assert len(calls) == 2
