"""OpenAI 兼容 LLM 客户端(供智能体工具调用)。

韧性:对连接失败/超时/5xx 等瞬时错误自动重试,让 LM Studio / EXO 短暂重启
或换模型期间的请求尽量自愈,而不是直接报错。

兼容三种 reasoning 形态:
- vLLM --reasoning-parser qwen3:推理放在 message.reasoning,content 为 null
- EXO/GLM-5.2-fp8:推理放在 message.reasoning_content,content 为空字符串
- 普通 OpenAI 兼容(LM Studio/mlx-lm):无 reasoning 字段,content 直接给内容

融合策略:content 为空且任一 reasoning 字段有值时,把 reasoning 内容回填到 content,
使上层 runner 无需感知 reasoning 字段。原 reasoning 字段保留(供日志/调试)。

深化要点(2026-07-26):
1. 分级超时:L1(30s)/L2(120s)/L3(300s)/L4(180s) 默认值,可被 max_tokens 大小动态调整。
2. 降级链可观测性:每次降级记录结构化日志(层→模型→原因→耗时),便于排查。
3. reasoning token 计数:从 usage.completion_tokens_details.reasoning_tokens 提取,
   暴露给上层做配额/质量评估。
4. 重试退避优化:首次重试 1s,二次 3s,指数退避;429 单独处理(读 Retry-After)。
5. 请求级 context 支持:通过 asyncio.Task 取消时正确中止 httpx 请求。
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """LLM 调用失败。"""


_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (1.0, 3.0)  # 第 1/2 次重试前等待

# 分层默认超时(秒):L1 快速交互 / L2 中等润色 / L3 深度精修 / L4 NSFW
_LAYER_TIMEOUTS = {"L1": 30.0, "L2": 120.0, "L3": 300.0, "L4": 180.0}


def _merge_reasoning(message: dict, usage: dict | None = None) -> dict:
    """reasoning 字段兼容:content 为空且 reasoning/reasoning_content 有值时,
    把 reasoning 内容作为 content 返回(上层只读 content,不感知 reasoning 字段)。

    优先 reasoning_content(EXO/GLM-5.2-fp8 格式),次之 reasoning(vLLM 格式)。
    若两者都为空且 content 有值,原样返回(LM Studio/mlx-lm 普通格式)。

    深化:从 usage.completion_tokens_details.reasoning_tokens 提取 reasoning token 数,
    写入 message["_reasoning_tokens"] 供上层做配额/质量评估(无则 0)。
    """
    content = message.get("content")
    if isinstance(content, str) and "</think>" in content:
        # 思考型模型(如 Nemotron omni)把推理包在 <think>…</think> 混进 content;
        # 对话展示只保留正式回答,与 optimize/drama_studio/manju 的剥离逻辑一致
        message["content"] = content.split("</think>", 1)[1].strip()
    elif not content or (isinstance(content, str) and not content.strip()):
        reasoning = message.get("reasoning_content") or message.get("reasoning")
        if reasoning:
            message["content"] = reasoning
    # 提取 reasoning token 计数(OpenAI 1.x+ / vLLM / EXO 可能提供)
    rtokens = 0
    if usage:
        details = usage.get("completion_tokens_details") or {}
        rtokens = int(details.get("reasoning_tokens") or 0)
    message["_reasoning_tokens"] = rtokens
    return message


async def _call_once(
    base_url: str, model: str, api_key: str,
    messages: list[dict], tools: list[dict] | None,
    max_tokens: int | None, temperature: float,
    *,
    chat_template_kwargs: dict | None = None,
    enable_thinking: bool | None = None,
    read_timeout: float = 600.0,
) -> dict:
    """单次 LLM 调用(无重试);返回 assistant message。失败抛对应异常。

    thinking 抑制(2026-07-27 实测确认):
    - EXO 认**顶层** `enable_thinking: false`(原生字段,PR #1654),不认
      `chat_template_kwargs.enable_thinking`(Pydantic 静默丢弃未知字段)。
    - GLM-5.2-fp8 实测:baseline 50s/reasoning=799 → enable_thinking=false
      3.4s/reasoning=0,14.7x 加速,reasoning 100% 抑制。
    - Kimi-K2.7-Code mlx-community 转 chat_template 缺 enable_thinking 逻辑,
      传了不报错但不生效(未来模型修复自动受益)。
    - 其他项目不传该参数 = 默认开 thinking,零影响。
    """
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
    # chat_template_kwargs:vLLM/SGLang 风格,EXO 静默丢弃,其他服务可能用
    if chat_template_kwargs:
        payload["chat_template_kwargs"] = chat_template_kwargs
    # 顶层 enable_thinking:EXO 原生字段,关 thinking 省 reasoning token/延迟
    if enable_thinking is not None:
        payload["enable_thinking"] = enable_thinking
    headers = {"Authorization": f"Bearer {api_key}"}
    timeout = httpx.Timeout(read_timeout, connect=8.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url}/chat/completions", json=payload, headers=headers
        )
        resp.raise_for_status()
        body = resp.json()
        usage = body.get("usage")
        return _merge_reasoning(body["choices"][0]["message"], usage)


async def _call_with_retry(
    base_url: str, model: str, api_key: str,
    messages: list[dict], tools: list[dict] | None,
    max_tokens: int | None, temperature: float,
    label: str,
    *,
    chat_template_kwargs: dict | None = None,
    enable_thinking: bool | None = None,
    read_timeout: float = 600.0,
) -> dict:
    """带重试的 LLM 调用;瞬时错误自动重试 _MAX_ATTEMPTS 次。

    深化:429 单独处理(读 Retry-After 头);降级链日志结构化;reasoning token 计数日志。
    透传 enable_thinking 给 _call_once(EXO 顶层 thinking 抑制字段)。
    """
    last_exc: Exception | None = None
    start = time.monotonic()
    for attempt in range(_MAX_ATTEMPTS):
        try:
            msg = await _call_once(
                base_url, model, api_key, messages, tools, max_tokens, temperature,
                chat_template_kwargs=chat_template_kwargs,
                enable_thinking=enable_thinking,
                read_timeout=read_timeout,
            )
            elapsed = time.monotonic() - start
            rtokens = msg.get("_reasoning_tokens", 0)
            if rtokens > 0 or attempt > 0:
                logger.info(
                    "LLM 调用成功 label=%s model=%s elapsed=%.2fs attempts=%d "
                    "reasoning_tokens=%d",
                    label, model, elapsed, attempt + 1, rtokens,
                )
            return msg
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
                httpx.RemoteProtocolError, httpx.PoolTimeout) as e:
            last_exc = e  # 瞬时:LM Studio 重启/换模型/网络抖动 → 重试
            logger.warning(
                "LLM 瞬时错误 label=%s model=%s attempt=%d error=%s",
                label, model, attempt + 1, e,
            )
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                # 限流:读 Retry-After,无则用默认退避
                ra = e.response.headers.get("Retry-After")
                wait = float(ra) if ra and ra.isdigit() else \
                    _BACKOFF_SECONDS[min(attempt, len(_BACKOFF_SECONDS) - 1)]
                last_exc = e
                logger.warning(
                    "LLM 限流 429 label=%s model=%s attempt=%d retry_after=%.1fs",
                    label, model, attempt + 1, wait,
                )
                if attempt < _MAX_ATTEMPTS - 1:
                    await asyncio.sleep(wait)
                continue
            if e.response.status_code >= 500:
                last_exc = e  # 服务端瞬时错误 → 重试
            else:
                # 4xx:必须带响应体。vLLM 拒绝工具调用(未开 --enable-auto-tool-choice)
                # 时错误细节只在 body 里,chat() 的「无工具回退」靠匹配 body 文本触发
                detail = ""
                try:
                    detail = e.response.text[:300]
                except Exception:  # noqa: BLE001
                    pass
                raise LLMError(
                    f"LLM 调用失败({e.response.status_code}): {e} body={detail}"
                ) from e
        except (httpx.HTTPError, KeyError, IndexError) as e:
            raise LLMError(f"LLM 调用失败: {e}") from e

        if attempt < _MAX_ATTEMPTS - 1:
            await asyncio.sleep(_BACKOFF_SECONDS[min(attempt, len(_BACKOFF_SECONDS) - 1)])

    raise LLMError(
        f"{label}暂不可用(已重试 {_MAX_ATTEMPTS} 次,耗时 {time.monotonic() - start:.1f}s)。"
        f"请确认 {base_url} 的 LLM 服务在线且已加载 {model}: {last_exc}"
    )


async def chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    max_tokens: int | None = None,
    temperature: float = 0.4,
) -> dict:
    """一次对话补全;返回 assistant message(可能含 tool_calls)。

    NSFW 路由:当前请求带 X-NSFW 标记且配了 NSFW 专用 LLM(settings.llm_nsfw_model)
    时,优先用 NSFW LLM;失败则 fallback 到主 LLM(默认模型也 uncensored,可兜底)。
    非 NSFW 请求走主备路由:主模型重试 _MAX_ATTEMPTS 次,全失败且配了备用模型时切备用。

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

    # NSFW 模式:优先用 NSFW 专用 LLM;未配则复用主 LLM
    from app.nsfw_ctx import nsfw_allowed
    if nsfw_allowed() and settings.llm_nsfw_model.strip():
        nsfw_url = (settings.llm_nsfw_base_url or settings.llm_base_url).rstrip("/")
        nsfw_key = settings.llm_nsfw_api_key or settings.llm_api_key
        nsfw_model = settings.llm_nsfw_model.strip()
        try:
            return await _call_with_retry(
                nsfw_url, nsfw_model, nsfw_key,
                messages, tools, max_tokens, temperature,
                label=f"NSFW 模型 {nsfw_model}",
            )
        except LLMError as nsfw_err:
            # NSFW LLM 不可用 → fallback 到主 LLM(默认模型也 uncensored,可兜底)
            try:
                return await _call_with_retry(
                    primary_url, primary_model, primary_key,
                    messages, tools, max_tokens, temperature,
                    label=f"主模型 {primary_model}(NSFW fallback)",
                )
            except LLMError as primary_err:
                raise LLMError(
                    f"NSFW LLM 主备均不可用。NSFW({nsfw_model}@{nsfw_url}): {nsfw_err}; "
                    f"主({primary_model}@{primary_url}): {primary_err}"
                ) from primary_err

    try:
        return await _call_with_retry(
            primary_url, primary_model, primary_key,
            messages, tools, max_tokens, temperature,
            label=f"主模型 {primary_model}",
        )
    except LLMError as primary_err:
        # 兜底：服务端未启用 tool-call-parser 时，带 tools 的调用会 400。
        # 先尝试不带 tools 的纯文本调用，保证 AI 助手至少能正常对话；
        # 工具调用能力需运维侧在 vLLM/SGLang 启动参数追加
        # --enable-auto-tool-choice --tool-call-parser <parser>。
        if tools and (
            "tool-call-parser" in str(primary_err).lower()
            or "tool choice" in str(primary_err).lower()
        ):
            logger.warning(
                "LLM 工具调用被服务端拒绝，回退到纯文本模式: %s", primary_err
            )
            try:
                return await _call_with_retry(
                    primary_url, primary_model, primary_key,
                    messages, None, max_tokens, temperature,
                    label=f"主模型 {primary_model}(无工具)",
                )
            except LLMError as plain_err:
                raise LLMError(
                    f"AI 大脑暂不可用（工具模式与纯文本模式均失败）。"
                    f"主({primary_model}@{primary_url}): {plain_err}"
                ) from plain_err

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


# ===========================================================================
# AICG 四层模型流水线（2026-07-24 项目管家确认 / 2026-07-27 thinking 抑制实测）
# ===========================================================================
# L1 初稿: qwen3.6-uncensored @ workstation:8000 (1-3s, 实时交互)
# L2 主力润色: Kimi-K2.7-Code-4bit @ EXO:52415 (6.6s, 关键场景)
# L3 终稿精修: GLM-5.2-fp8 @ EXO:52415 (3.4s 关 thinking / 50s 开 thinking, 异步批量)
# L4 NSFW: euryale-70b @ spark01:8000 (60-90s, 无审查)
#
# thinking 抑制(2026-07-27 实测):EXO 认顶层 enable_thinking=false(原生字段,PR #1654),
# 不认 chat_template_kwargs(Pydantic 静默丢弃未知字段)。L2/L3 路径默认传 enable_thinking=False:
# - GLM-5.2-fp8(L3):完美生效,reasoning 799→0,50s→3.4s(14.7x 加速)
# - Kimi-K2.7-Code(L2):mlx-community 转 chat_template 缺 enable_thinking 逻辑,
#   传了不报错但不生效(未来模型修复自动受益),当前仍由 _merge_reasoning 兜底
# 其他项目调 EXO 不传该参数 = 默认开 thinking,零影响。


async def chat_layered(
    messages: list[dict],
    layer: str = "L1",
    max_tokens: int | None = None,
    temperature: float = 0.5,
) -> dict:
    """四层模型流水线调用。

    Args:
        messages: 对话消息列表。
        layer: 模型层级 — "L1"(初稿) / "L2"(润色) / "L3"(精修) / "L4"(NSFW)。
        max_tokens: 最大输出 token;L2/L3 默认增大补偿 reasoning 消耗。
        temperature: 采样温度。

    Returns:
        assistant message(dict),与 chat() 返回格式一致。

    Raises:
        LLMError: 指定层级的模型不可用。
    """
    settings = get_settings()
    api_key = settings.llm_api_key

    if layer == "L4":
        # L4 NSFW: 复用现有 NSFW 路由
        return await chat(messages, max_tokens=max_tokens, temperature=temperature)

    if layer == "L2":
        url = settings.llm_l2_base_url.rstrip("/")
        model = settings.llm_l2_model
        timeout = settings.llm_l2_timeout
        # L2 未配 max_tokens 时默认 4000(补偿 reasoning,实际 content ~800)
        if max_tokens is None:
            max_tokens = 4000
        # EXO 顶层 enable_thinking=False:Kimi-K2.7-Code 当前 chat_template 缺逻辑
        # 不生效(未来修复自动受益),传了不报错,零风险
        return await _call_with_retry(
            url, model, api_key, messages, None, max_tokens, temperature,
            label=f"L2 润色 {model}",
            enable_thinking=False,
            read_timeout=timeout,
        )

    if layer == "L3":
        url = settings.llm_l3_base_url.rstrip("/")
        model = settings.llm_l3_model
        timeout = settings.llm_l3_timeout
        # L3 未配 max_tokens 时默认 8000(开 thinking 时 reasoning 占 80%+,需 5-6x 补偿;
        # 关 thinking 后实测一句仅 43 tokens,8000 留足剧本精修长文本余量)
        if max_tokens is None:
            max_tokens = 8000
        # EXO 顶层 enable_thinking=False:GLM-5.2-fp8 完美生效
        # 实测 reasoning 799→0,50s→3.4s(14.7x 加速)
        try:
            return await _call_with_retry(
                url, model, api_key, messages, None, max_tokens, temperature,
                label=f"L3 精修 {model}",
                enable_thinking=False,
                read_timeout=timeout,
            )
        except LLMError as l3_err:
            # 深化:L3 降级到 L2(GLM-5.2 不可用时用 Kimi 兜底,质量略降但可用)
            logger.warning(
                "L3 降级到 L2 原因=%s model=%s → %s",
                l3_err, model, settings.llm_l2_model,
            )
            try:
                l2_max = 4000 if max_tokens == 8000 else max_tokens
                return await _call_with_retry(
                    settings.llm_l2_base_url.rstrip("/"), settings.llm_l2_model,
                    api_key, messages, None, l2_max, temperature,
                    label=f"L3→L2 降级 {settings.llm_l2_model}",
                    enable_thinking=False,
                    read_timeout=settings.llm_l2_timeout,
                )
            except LLMError as l2_err:
                # L2 也不可用 → 降级到 L1(主模型)
                logger.warning(
                    "L2 降级到 L1 原因=%s model=%s → 主模型",
                    l2_err, settings.llm_l2_model,
                )
                return await chat(messages, max_tokens=max_tokens, temperature=temperature)

    # L1 默认:走标准 chat() 路由
    return await chat(messages, max_tokens=max_tokens, temperature=temperature)
