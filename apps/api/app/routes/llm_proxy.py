"""OpenAI 兼容 LLM 代理：/api/llm/v1/{models,chat/completions}。

给 BeefTV 画布（Web/桌面）助手和其他客户端使用：客户端只认 ToIV 地址 + 用户自己的 ToIV 登录令牌
（Authorization: Bearer <JWT>），永远看不到内网 LLM 地址（settings.llm_base_url）和上游密钥。

- 鉴权：get_current_user（与其他 /api 接口相同的 JWT）。
- 限流：按用户滑动窗口 scope="llm"（默认 60s/30 次），外加每用户并发上限（默认 2）。
- 模型：只放行 settings.llm_proxy_models 列表里的模型 ID；未指定时用第一个。
- 流式：stream=true 时原样透传上游 SSE（text/event-stream），客户端断开即关闭上游连接。
- 超时：连接 settings.llm_proxy_connect_timeout，读 settings.llm_proxy_read_timeout；上游不可达/超时 → 502/504（OpenAI 错误格式）。
- 请求体上限 settings.llm_proxy_max_body_bytes；max_tokens 截到 settings.llm_proxy_max_tokens。
"""
from __future__ import annotations

import json
import logging
import threading
from collections import defaultdict
from contextlib import contextmanager
from typing import Any, AsyncIterator, Iterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from app import ratelimit
from app.config import get_settings
from app.deps import get_current_user
from app.models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/llm/v1", tags=["llm-proxy"])

# 透传给上游的请求字段白名单（OpenAI chat.completions）；其余字段丢弃，避免把客户端杂项送进 vLLM。
_ALLOWED_FIELDS = {
    "model", "messages", "stream", "stream_options", "temperature", "top_p", "max_tokens",
    "max_completion_tokens", "stop", "presence_penalty", "frequency_penalty", "seed", "n",
    "tools", "tool_choice", "parallel_tool_calls", "response_format", "logit_bias", "user",
    "chat_template_kwargs",
}

_inflight: dict[str, int] = defaultdict(int)
_inflight_lock = threading.Lock()


def _error(status: int, message: str, err_type: str, code: str | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": err_type, "code": code}})


def allowed_models() -> list[str]:
    s = get_settings()
    raw = s.llm_proxy_models or s.llm_model
    return [m.strip() for m in raw.split(",") if m.strip()]


def upstream_base() -> str:
    s = get_settings()
    return (s.llm_proxy_base_url or s.llm_base_url).rstrip("/")


def upstream_headers() -> dict[str, str]:
    s = get_settings()
    key = s.llm_proxy_api_key or s.llm_api_key
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _timeout() -> httpx.Timeout:
    s = get_settings()
    return httpx.Timeout(connect=s.llm_proxy_connect_timeout, read=s.llm_proxy_read_timeout, write=30.0, pool=10.0)


@contextmanager
def _concurrency_slot(user: User) -> Iterator[None]:
    limit = get_settings().llm_proxy_max_concurrency
    with _inflight_lock:
        if _inflight[user.id] >= limit:
            raise HTTPException(status_code=429, detail=f"同时进行的对话请求过多（上限 {limit}）", headers={"Retry-After": "2"})
        _inflight[user.id] += 1
    try:
        yield
    finally:
        with _inflight_lock:
            _inflight[user.id] -= 1
            if _inflight[user.id] <= 0:
                _inflight.pop(user.id, None)


def sanitize_body(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")
    models = allowed_models()
    model = body.get("model") or models[0]
    if model not in models:
        raise HTTPException(status_code=400, detail=f"不支持的模型：{model}（可用：{', '.join(models)}）")
    out = {k: v for k, v in body.items() if k in _ALLOWED_FIELDS}
    out["model"] = model
    cap = get_settings().llm_proxy_max_tokens
    for key in ("max_tokens", "max_completion_tokens"):
        if isinstance(out.get(key), int) and out[key] > cap:
            out[key] = cap
    return out


@router.get("/models")
def list_models(user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "toiv"} for m in allowed_models()]}


@router.post("/chat/completions")
async def chat_completions(request: Request, user: User = Depends(get_current_user)):
    s = get_settings()
    raw = await request.body()
    if len(raw) > s.llm_proxy_max_body_bytes:
        return _error(413, "请求体过大", "invalid_request_error", "body_too_large")
    try:
        payload = json.loads(raw or b"null")
    except ValueError:
        return _error(400, "请求体不是合法 JSON", "invalid_request_error", "bad_json")
    try:
        body = sanitize_body(payload)
    except HTTPException as e:
        return _error(e.status_code, str(e.detail), "invalid_request_error")
    ratelimit.enforce_rate_limit(user, scope="llm")  # 超额抛 429（带 Retry-After）

    url = f"{upstream_base()}/chat/completions"
    if body.get("stream"):
        slot = _concurrency_slot(user)
        slot.__enter__()
        client = httpx.AsyncClient(timeout=_timeout())
        try:
            upstream = await client.send(client.build_request("POST", url, json=body, headers=upstream_headers()), stream=True)
        except httpx.TimeoutException:
            await client.aclose(); slot.__exit__(None, None, None)
            return _error(504, "LLM 上游超时", "upstream_timeout")
        except httpx.HTTPError as e:
            await client.aclose(); slot.__exit__(None, None, None)
            log.warning("llm proxy upstream unreachable: %s", type(e).__name__)
            return _error(502, "LLM 上游不可达", "upstream_error")
        if upstream.status_code >= 400:
            detail = (await upstream.aread())[:2000]
            await upstream.aclose(); await client.aclose(); slot.__exit__(None, None, None)
            return _passthrough_error(upstream.status_code, detail)

        closed = False

        async def cleanup() -> None:
            # 幂等：生成器 finally 与 BackgroundTask 都会调用（客户端在首包前断开时只有后者会跑）
            nonlocal closed
            if closed:
                return
            closed = True
            await upstream.aclose()
            await client.aclose()
            slot.__exit__(None, None, None)

        async def relay() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            except httpx.TimeoutException:
                yield b'data: {"error":{"message":"LLM \xe4\xb8\x8a\xe6\xb8\xb8\xe8\xb6\x85\xe6\x97\xb6","type":"upstream_timeout"}}\n\n'
            except httpx.HTTPError:
                yield b'data: {"error":{"message":"LLM upstream stream broken","type":"upstream_error"}}\n\n'
            finally:
                await cleanup()

        return StreamingResponse(relay(), media_type="text/event-stream", background=BackgroundTask(cleanup),
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    with _concurrency_slot(user):
        try:
            async with httpx.AsyncClient(timeout=_timeout()) as client:
                upstream = await client.post(url, json=body, headers=upstream_headers())
        except httpx.TimeoutException:
            return _error(504, "LLM 上游超时", "upstream_timeout")
        except httpx.HTTPError as e:
            log.warning("llm proxy upstream unreachable: %s", type(e).__name__)
            return _error(502, "LLM 上游不可达", "upstream_error")
    if upstream.status_code >= 400:
        return _passthrough_error(upstream.status_code, upstream.content[:2000])
    try:
        return JSONResponse(status_code=200, content=upstream.json())
    except ValueError:
        return _error(502, "LLM 上游返回了非 JSON 响应", "upstream_error")


def _passthrough_error(status: int, detail: bytes) -> JSONResponse:
    """上游 4xx 原样转成 OpenAI 错误（不泄露上游地址）；5xx 统一 502。"""
    message = "LLM 上游错误"
    try:
        parsed = json.loads(detail)
        if isinstance(parsed, dict):
            err = parsed.get("error")
            message = (err.get("message") if isinstance(err, dict) else err) or parsed.get("message") or message
    except ValueError:
        pass
    if status >= 500:
        return _error(502, "LLM 上游错误", "upstream_error")
    return _error(status, str(message)[:500], "invalid_request_error")
