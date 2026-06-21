"""OpenAI 兼容 LLM 客户端(供智能体工具调用)。

韧性:对连接失败/超时/5xx 等瞬时错误自动重试,让 LM Studio 短暂重启或换模型
期间的请求尽量自愈,而不是直接报错。
"""
from __future__ import annotations

import asyncio

import httpx

from app.config import get_settings


class LLMError(RuntimeError):
    """LLM 调用失败。"""


_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (1.0, 3.0)  # 第 1/2 次重试前等待


async def chat(messages: list[dict], tools: list[dict] | None = None) -> dict:
    """一次对话补全;返回 assistant message(可能含 tool_calls)。瞬时错误自动重试。"""
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
    # 连接快速失败(LLM 掉线时不干等),读取留足模型推理时间
    timeout = httpx.Timeout(180.0, connect=8.0)

    last_exc: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{settings.llm_base_url}/chat/completions", json=payload, headers=headers
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
                httpx.RemoteProtocolError, httpx.PoolTimeout) as e:
            last_exc = e  # 瞬时:LM Studio 重启/换模型/网络抖动 → 重试
        except httpx.HTTPStatusError as e:
            if e.response.status_code >= 500:
                last_exc = e  # 服务端瞬时错误 → 重试
            else:
                raise LLMError(f"LLM 调用失败({e.response.status_code}): {e}") from e
        except (httpx.HTTPError, KeyError, IndexError) as e:
            raise LLMError(f"LLM 调用失败: {e}") from e

        if attempt < _MAX_ATTEMPTS - 1:
            await asyncio.sleep(_BACKOFF_SECONDS[min(attempt, len(_BACKOFF_SECONDS) - 1)])

    raise LLMError(
        f"AI 大脑(LLM)暂不可用(已重试 {_MAX_ATTEMPTS} 次)。"
        f"请确认 {settings.llm_base_url} 的 LM Studio 在线且已加载 {settings.llm_model}: {last_exc}"
    )
