"""chat() 的工具 400 回退测试。

回归背景:vLLM 未开 --enable-auto-tool-choice 时带 tools 调用返回 400,
错误细节只在响应 body 里("auto" tool choice requires ...)。此前
_call_with_retry 抛 LLMError 不含 body,chat() 的「无工具回退」永远匹配
不到 "tool choice" → AI 助手直接报错。修复后 4xx LLMError 必须带 body 文本,
回退链才能生效。
"""
from __future__ import annotations

import pytest

from app.agent import llm


@pytest.mark.asyncio
async def test_chat_falls_back_to_plain_text_when_tools_rejected(monkeypatch):
    """带 tools 被拒(body 含 tool choice)→ 自动回退无工具纯文本调用并成功。"""
    calls: list[bool] = []  # 记录每次调用是否带 tools

    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        calls.append(tools is not None)
        if tools is not None:
            # 模拟修复后的 4xx LLMError:含响应 body(vLLM 拒绝工具调用的原文)
            raise llm.LLMError(
                'LLM 调用失败(400): Client error ... body={"error":{"message":'
                '"\\"auto\\" tool choice requires --enable-auto-tool-choice and '
                '--tool-call-parser to be set"}}'
            )
        return {"role": "assistant", "content": "你好!"}

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    # 清空 NSFW / fallback 配置,走主模型路径
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_nsfw_model", "")
    monkeypatch.setattr(settings, "llm_fallback_model", "")

    result = await llm.chat([{"role": "user", "content": "你好"}], tools=[{"type": "function", "function": {"name": "t", "parameters": {}}}])
    assert result["content"] == "你好!"
    assert calls == [True, False], "必须先带 tools 尝试,被拒后回退无工具"


@pytest.mark.asyncio
async def test_chat_tool_fallback_not_triggered_by_unrelated_400(monkeypatch):
    """body 不含 tool choice 的 400(如参数错误)→ 不回退,直接报错(未配备用时)。"""
    async def fake_retry(base_url, model, api_key, messages, tools, max_tokens, temperature, label, **kw):
        raise llm.LLMError('LLM 调用失败(400): Client error ... body={"error":{"message":"invalid temperature"}}')

    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)
    settings = llm.get_settings()
    monkeypatch.setattr(settings, "llm_nsfw_model", "")
    monkeypatch.setattr(settings, "llm_fallback_model", "")

    with pytest.raises(llm.LLMError):
        await llm.chat([{"role": "user", "content": "hi"}], tools=[{"type": "function", "function": {"name": "t", "parameters": {}}}])


def test_merge_reasoning_strips_think_prefix():
    """content 混入 <think> 推理前缀时,_merge_reasoning 只保留正式回答。"""
    msg = {"role": "assistant", "content": "我先想想怎么回答。\n</think>\n你好,有什么可以帮你?"}
    out = llm._merge_reasoning(msg)
    assert out["content"] == "你好,有什么可以帮你?"


def test_merge_reasoning_keeps_content_without_think():
    """普通 content(无 think 标记)原样保留。"""
    msg = {"role": "assistant", "content": "正常回答"}
    out = llm._merge_reasoning(msg)
    assert out["content"] == "正常回答"


def test_merge_reasoning_empty_content_falls_back_to_reasoning():
    """content 为空时仍回退 reasoning 字段(原行为不回归)。"""
    msg = {"role": "assistant", "content": "", "reasoning_content": "推理内容"}
    out = llm._merge_reasoning(msg)
    assert out["content"] == "推理内容"
