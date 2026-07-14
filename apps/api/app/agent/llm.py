"""OpenAI 兼容 LLM 客户端(供智能体工具调用)。

韧性:对连接失败/超时/5xx 等瞬时错误自动重试,让 LM Studio / EXO 短暂重启
或换模型期间的请求尽量自愈,而不是直接报错。

兼容三种 reasoning 形态:
- vLLM --reasoning-parser qwen3:推理放在 message.reasoning,content 为 null
- EXO/GLM-5.2-fp8:推理放在 message.reasoning_content,content 为空字符串
- 普通 OpenAI 兼容(LM Studio/mlx-lm):无 reasoning 字段,content 直接给内容

融合策略:content 为空且任一 reasoning 字段有值时,把 reasoning 内容回填到 content,
使上层 runner 无需感知 reasoning 字段。原 reasoning 字段保留(供日志/调试)。
"""
from __future__ import annotations

import asyncio

import httpx

from app.config import get_settings


class LLMError(RuntimeError):
    """LLM 调用失败。"""


_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (1.0, 3.0)  # 第 1/2 次重试前等待


def _merge_reasoning(message: dict) -> dict:
    """reasoning 字段兼容:content 为空且 reasoning/reasoning_content 有值时,
    把 reasoning 内容作为 content 返回(上层只读 content,不感知 reasoning 字段)。

    优先 reasoning_content(EXO/GLM-5.2-fp8 格式),次之 reasoning(vLLM 格式)。
    若两者都为空且 content 有值,原样返回(LM Studio/mlx-lm 普通格式)。
    """
    if not message.get("content") or (isinstance(message.get("content"), str)
                                       and not message.get("content", "").strip()):
        reasoning = message.get("reasoning_content") or message.get("reasoning")
        if reasoning:
            message["content"] = reasoning
    return message


async def _call_once(
    base_url: str, model: str, api_key: str,
    messages: list[dict], tools: list[dict] | None,
    max_tokens: int | None, temperature: float,
) -> dict:
    """单次 LLM 调用(无重试);返回 assistant message。失败抛对应异常。"""
    payload: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    headers = {"Authorization": f"Bearer {api_key}"}
    # 连接快速失败(LLM/EXO 掉线时不干等),读取留足思考型模型推理时间(GLM-5.2-fp8)
    timeout = httpx.Timeout(600.0, connect=8.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url}/chat/completions", json=payload, headers=headers
        )
        resp.raise_for_status()
        return _merge_reasoning(resp.json()["choices"][0]["message"])


async def _call_with_retry(
    base_url: str, model: str, api_key: str,
    messages: list[dict], tools: list[dict] | None,
    max_tokens: int | None, temperature: float,
    label: str,
) -> dict:
    """带重试的 LLM 调用;瞬时错误自动重试 _MAX_ATTEMPTS 次。"""
    last_exc: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            return await _call_once(
                base_url, model, api_key, messages, tools, max_tokens, temperature
            )
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
        f"{label}暂不可用(已重试 {_MAX_ATTEMPTS} 次)。"
        f"请确认 {base_url} 的 LLM 服务在线且已加载 {model}: {last_exc}"
    )


async def chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    max_tokens: int | None = None,
    temperature: float = 0.4,
) -> dict:
    """一次对话补全;返回 assistant message(可能含 tool_calls)。

    主备路由:先用主模型(settings.llm_model)重试 _MAX_ATTEMPTS 次;全部失败且
    配了备用模型(settings.llm_fallback_model)时,自动切备用再试 _MAX_ATTEMPTS 次。
    两者都失败才抛 LLMError。EXO 单端点多模型场景下 fallback 只需换 model 名,
    base_url/api_key 留空即复用主。

    Args:
        messages: 对话消息列表。
        tools: OpenAI 函数调用工具定义;None 不带工具。
        max_tokens: 最大输出 token 数;None 由模型/服务端默认。GLM-5.2-fp8 等
            思考型模型需要充足 token(建议 ≥2000)否则被 reasoning 吃光。
        temperature: 采样温度,默认 0.4(平衡多样性与一致性)。
    """
    settings = get_settings()
    primary_url = settings.llm_base_url.rstrip("/")
    primary_key = settings.llm_api_key
    primary_model = settings.llm_model

    try:
        return await _call_with_retry(
            primary_url, primary_model, primary_key,
            messages, tools, max_tokens, temperature,
            label=f"主模型 {primary_model}",
        )
    except LLMError as primary_err:
        fb_model = settings.llm_fallback_model.strip()
        if not fb_model:
            raise  # 未配备用 → 直接抛主模型错误

        # 启用备用:base_url/api_key 留空则复用主(EXO 单端点多模型)
        fb_url = (settings.llm_fallback_base_url or settings.llm_base_url).rstrip("/")
        fb_key = settings.llm_fallback_api_key or settings.llm_api_key
        try:
            return await _call_with_retry(
                fb_url, fb_model, fb_key,
                messages, tools, max_tokens, temperature,
                label=f"备用模型 {fb_model}",
            )
        except LLMError as fb_err:
            raise LLMError(
                f"AI 大脑主备均不可用。主({primary_model}@{primary_url}): {primary_err}; "
                f"备({fb_model}@{fb_url}): {fb_err}"
            ) from fb_err
