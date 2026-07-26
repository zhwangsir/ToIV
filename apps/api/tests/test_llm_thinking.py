"""LLM thinking 抑制参数透传测试（2026-07-27）。

验证:
1. _call_once 传 enable_thinking=False 时,payload 顶层有该字段(EXO 原生字段)。
2. _call_once 不传 enable_thinking 时,payload 无该字段(其他项目默认开 thinking)。
3. _call_once 传 chat_template_kwargs 时,payload 有该字段(向后兼容 vLLM/SGLang)。
4. _call_with_retry 透传 enable_thinking 给 _call_once。
5. chat_layered L2/L3 路径默认传 enable_thinking=False(零影响其他项目)。

实测依据:EXO 认顶层 enable_thinking=false,不认 chat_template_kwargs(Pydantic 静默丢弃)。
GLM-5.2-fp8 实测 reasoning 799→0,50s→3.4s(14.7x 加速)。
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from app.agent import llm


# ---------------------------------------------------------------------------
# Fake httpx.AsyncClient:捕获 post 的 json payload,返回固定响应
# ---------------------------------------------------------------------------


class _FakeResp:
    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {
            "choices": [{"message": {"content": "ok", "role": "assistant"}}],
            "usage": {"completion_tokens": 10, "completion_tokens_details": {"reasoning_tokens": 0}},
        }


class _FakeClient:
    """模拟 httpx.AsyncClient 上下文管理器,捕获 post 调用的 json 参数。"""

    captured: dict = {}

    def __init__(self, *args, **kwargs) -> None:
        # 忽略 timeout 等参数
        pass

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *args) -> bool:
        return False

    async def post(self, url: str, json: dict | None = None, headers: dict | None = None) -> _FakeResp:
        type(self).captured["url"] = url
        type(self).captured["payload"] = json or {}
        type(self).captured["headers"] = headers or {}
        return _FakeResp()


@pytest.fixture(autouse=True)
def _reset_captured():
    _FakeClient.captured = {}
    yield
    _FakeClient.captured = {}


# ---------------------------------------------------------------------------
# 1. _call_once:enable_thinking=False → payload 顶层有该字段
# ---------------------------------------------------------------------------


async def test_call_once_enable_thinking_false_in_payload():
    """enable_thinking=False 时,payload 顶层应含 enable_thinking: False(EXO 原生字段)。"""
    with patch.object(llm.httpx, "AsyncClient", _FakeClient):
        await llm._call_once(
            "http://exo:52415", "GLM-5.2-fp8", "k",
            [{"role": "user", "content": "hi"}], None, 800, 0.5,
            enable_thinking=False,
        )
    payload = _FakeClient.captured["payload"]
    assert payload["enable_thinking"] is False, "顶层 enable_thinking=False 必须进 payload"
    # 不应同时注入 chat_template_kwargs
    assert "chat_template_kwargs" not in payload


# ---------------------------------------------------------------------------
# 2. _call_once:不传 enable_thinking → payload 无该字段(其他项目默认开 thinking)
# ---------------------------------------------------------------------------


async def test_call_once_no_enable_thinking_omitted_from_payload():
    """不传 enable_thinking 时,payload 不应有该字段(让服务端用默认行为)。"""
    with patch.object(llm.httpx, "AsyncClient", _FakeClient):
        await llm._call_once(
            "http://exo:52415", "GLM-5.2-fp8", "k",
            [{"role": "user", "content": "hi"}], None, 800, 0.5,
        )
    payload = _FakeClient.captured["payload"]
    assert "enable_thinking" not in payload, "未传 enable_thinking 时不应注入(保护其他项目默认 thinking)"


# ---------------------------------------------------------------------------
# 3. _call_once:chat_template_kwargs 向后兼容(vLLM/SGLang 风格)
# ---------------------------------------------------------------------------


async def test_call_once_chat_template_kwargs_backward_compat():
    """chat_template_kwargs 仍应进 payload(其他服务如 vLLM/SGLang 认这个字段)。"""
    with patch.object(llm.httpx, "AsyncClient", _FakeClient):
        await llm._call_once(
            "http://vllm:8000", "qwen3", "k",
            [{"role": "user", "content": "hi"}], None, 800, 0.5,
            chat_template_kwargs={"enable_thinking": False},
        )
    payload = _FakeClient.captured["payload"]
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}


# ---------------------------------------------------------------------------
# 4. _call_with_retry 透传 enable_thinking 给 _call_once
# ---------------------------------------------------------------------------


async def test_call_with_retry_passes_enable_thinking_through():
    """_call_with_retry 必须把 enable_thinking 透传给 _call_once。"""
    captured: dict = {}

    async def fake_call_once(*args, **kwargs):
        captured["enable_thinking"] = kwargs.get("enable_thinking")
        return {"content": "ok", "_reasoning_tokens": 0}

    with patch.object(llm, "_call_once", fake_call_once):
        await llm._call_with_retry(
            "http://exo:52415", "GLM-5.2-fp8", "k",
            [{"role": "user", "content": "hi"}], None, 800, 0.5,
            label="test",
            enable_thinking=False,
        )
    assert captured["enable_thinking"] is False, "_call_with_retry 必须透传 enable_thinking"


# ---------------------------------------------------------------------------
# 5. chat_layered L2/L3 路径默认传 enable_thinking=False
# ---------------------------------------------------------------------------


async def test_chat_layered_l2_passes_enable_thinking_false(monkeypatch):
    """L2 路径(Kimi-K2.7-Code)必须传 enable_thinking=False。"""
    captured: dict = {}

    async def fake_retry(*args, **kwargs):
        captured["enable_thinking"] = kwargs.get("enable_thinking")
        captured["label"] = kwargs.get("label")
        return {"content": "ok", "_reasoning_tokens": 0}

    # 喂入 L2 配置,避免 settings 未配
    from app.config import Settings
    fake_settings = Settings(
        llm_l2_base_url="http://exo:52415",
        llm_l2_model="mlx-community/Kimi-K2.7-Code-4bit",
        llm_l2_timeout=120.0,
    )
    monkeypatch.setattr(llm, "get_settings", lambda: fake_settings)
    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)

    await llm.chat_layered([{"role": "user", "content": "hi"}], layer="L2")
    assert captured["enable_thinking"] is False, "L2 路径必须传 enable_thinking=False"
    assert "L2" in captured["label"]


async def test_chat_layered_l3_passes_enable_thinking_false(monkeypatch):
    """L3 路径(GLM-5.2-fp8)必须传 enable_thinking=False。"""
    captured: dict = {}

    async def fake_retry(*args, **kwargs):
        captured["enable_thinking"] = kwargs.get("enable_thinking")
        captured["label"] = kwargs.get("label")
        return {"content": "ok", "_reasoning_tokens": 0}

    from app.config import Settings
    fake_settings = Settings(
        llm_l3_base_url="http://exo:52415",
        llm_l3_model="mlx-community/GLM-5.2-fp8",
        llm_l3_timeout=300.0,
    )
    monkeypatch.setattr(llm, "get_settings", lambda: fake_settings)
    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)

    await llm.chat_layered([{"role": "user", "content": "hi"}], layer="L3")
    assert captured["enable_thinking"] is False, "L3 路径必须传 enable_thinking=False"
    assert "L3" in captured["label"]


async def test_chat_layered_l3_degrade_to_l2_keeps_enable_thinking_false(monkeypatch):
    """L3 降级到 L2 时,降级路径也必须传 enable_thinking=False。"""
    call_count = {"n": 0}
    captured: dict = {}

    async def fake_retry(*args, **kwargs):
        call_count["n"] += 1
        captured.setdefault("calls", []).append({
            "enable_thinking": kwargs.get("enable_thinking"),
            "label": kwargs.get("label"),
        })
        # 第一次(L3)抛错触发降级,第二次(L2)成功
        if call_count["n"] == 1:
            raise llm.LLMError("L3 unavailable (simulated)")
        return {"content": "ok", "_reasoning_tokens": 0}

    from app.config import Settings
    fake_settings = Settings(
        llm_l2_base_url="http://exo:52415",
        llm_l2_model="mlx-community/Kimi-K2.7-Code-4bit",
        llm_l2_timeout=120.0,
        llm_l3_base_url="http://exo:52415",
        llm_l3_model="mlx-community/GLM-5.2-fp8",
        llm_l3_timeout=300.0,
    )
    monkeypatch.setattr(llm, "get_settings", lambda: fake_settings)
    monkeypatch.setattr(llm, "_call_with_retry", fake_retry)

    await llm.chat_layered([{"role": "user", "content": "hi"}], layer="L3")
    assert len(captured["calls"]) == 2, "应触发 L3→L2 降级(2 次调用)"
    # 两次调用都必须传 enable_thinking=False
    assert captured["calls"][0]["enable_thinking"] is False, "L3 主路径必须传 enable_thinking=False"
    assert captured["calls"][1]["enable_thinking"] is False, "L3→L2 降级路径必须传 enable_thinking=False"
