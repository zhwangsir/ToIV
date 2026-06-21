"""OpenAI 兼容 LLM 客户端(供智能体工具调用)。"""
from __future__ import annotations

import httpx

from app.config import get_settings


class LLMError(RuntimeError):
    """LLM 调用失败。"""


async def chat(messages: list[dict], tools: list[dict] | None = None) -> dict:
    """一次对话补全;返回 assistant message(可能含 tool_calls)。"""
    settings = get_settings()
    payload: dict = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": 0.4,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{settings.llm_base_url}/chat/completions", json=payload, headers=headers
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]
    except (httpx.HTTPError, KeyError, IndexError) as e:
        raise LLMError(f"LLM 调用失败: {e}") from e
