"""ComfyUI MCP 桥接 client —— 连接 workstation comfyui-mcp HTTP 端点。

MCP 协议:Streamable HTTP (POST /mcp),JSON-RPC 2.0。
会话管理:initialize → 获取 mcp-session-id → 后续请求带 session header。
工具调用:tools/list 获取可用工具, tools/call 执行。

配置:TOIV_MCP_URL / TOIV_MCP_TOKEN(空 = 不启用)。
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# MCP session 缓存(模块级单例)
_session_id: str | None = None
_session_ts: float = 0.0
_SESSION_TTL = 300.0  # 5 分钟会话 TTL

# 可用工具缓存
_tools_cache: list[dict] | None = None
_tools_ts: float = 0.0
_TOOLS_TTL = 120.0


def _base_url() -> str:
    return get_settings().mcp_url.rstrip("/")


def _token() -> str:
    return get_settings().mcp_token


def _headers(session_id: str | None = None) -> dict[str, str]:
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if _token():
        h["Authorization"] = f"Bearer {_token()}"
    if session_id:
        h["Mcp-Session-Id"] = session_id
    return h


def _parse_sse_body(text: str) -> dict:
    """解析 SSE 响应体,提取最后一个 data: 行的 JSON。"""
    last_data = None
    for line in text.split("\n"):
        if line.startswith("data: "):
            last_data = line[6:]
    if last_data:
        return json.loads(last_data)
    return json.loads(text)


async def _post_mcp(payload: dict, session_id: str | None = None) -> tuple[dict, str | None]:
    """POST /mcp,返回 (response_json, session_id_from_header)。"""
    url = f"{_base_url()}/mcp"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=payload, headers=_headers(session_id))
        resp.raise_for_status()
        sid = resp.headers.get("mcp-session-id")
        body = _parse_sse_body(resp.text)
        return body, sid


async def _ensure_session() -> str:
    """确保有有效 MCP session,过期则重新 initialize。"""
    global _session_id, _session_ts
    now = time.monotonic()
    if _session_id and now - _session_ts < _SESSION_TTL:
        return _session_id
    payload = {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "toiv-api", "version": "1.0"},
        },
    }
    body, sid = await _post_mcp(payload)
    if "error" in body:
        raise RuntimeError(f"MCP initialize 失败: {body['error']}")
    _session_id = sid or "default"
    _session_ts = now
    logger.info("MCP session established: %s", _session_id)
    # initialized notification
    notify = {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
    try:
        await _post_mcp(notify, _session_id)
    except Exception:
        pass  # notification 失败不影响
    return _session_id


async def list_mcp_tools() -> list[dict]:
    """获取 MCP server 暴露的工具列表(带缓存)。"""
    global _tools_cache, _tools_ts
    now = time.monotonic()
    if _tools_cache is not None and now - _tools_ts < _TOOLS_TTL:
        return _tools_cache
    sid = await _ensure_session()
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    body, _ = await _post_mcp(payload, sid)
    if "error" in body:
        raise RuntimeError(f"MCP tools/list 失败: {body['error']}")
    tools = body.get("result", {}).get("tools", [])
    _tools_cache = tools
    _tools_ts = now
    return tools


async def call_mcp_tool(name: str, arguments: dict) -> dict:
    """调用 MCP 工具,返回 result 内容。"""
    sid = await _ensure_session()
    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000) % 2**31,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    body, _ = await _post_mcp(payload, sid)
    if "error" in body:
        raise RuntimeError(f"MCP tools/call {name} 失败: {body['error']}")
    return body.get("result", {})


def is_mcp_enabled() -> bool:
    """MCP 桥接是否已配置。"""
    return bool(get_settings().mcp_url)


async def close_mcp() -> None:
    """清理 session(应用关闭时调用)。"""
    global _session_id, _session_ts, _tools_cache, _tools_ts
    _session_id = None
    _session_ts = 0.0
    _tools_cache = None
    _tools_ts = 0.0
