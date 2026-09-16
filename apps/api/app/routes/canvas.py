"""ComfyUI 画布同源反向代理(2026-08-30 画布公网不可用根治)。

背景:画布页(CanvasView)iframe 直连 ComfyUI(Tailscale/LAN http://*:8188),
公网 HTTPS 域名下被浏览器混合内容拦截,架构性不可用,旧错误页还泄露内网 IP。
本路由把 ComfyUI 透传到同源 /api/canvas/proxy 下,iframe 与页面同源,绕开拦截。

- SSRF 防护:上游目标仅取 settings.canvas_comfy_url(env TOIV_CANVAS_COMFY_URL,
  默认 http://192.168.71.127:8188),不接受任何请求传入的地址/参数。
- 鉴权复用 deps.get_current_user:iframe 无法带 Authorization 头,走其既有的
  ?token= 查询参数通道(与 <img>/EventSource 同一模式)。
- GET/POST 字节级流式透传;上游网络错误一律 502,响应不透出内网地址细节。
- 响应头覆写全局安全中间件默认值:X-Frame-Options/CSP frame-ancestors 放宽到
  同源,否则代理回来的页面仍无法被本站 iframe 嵌入(中间件用 setdefault,不覆盖)。
- 已知边界(本轮范围外,按需后补):ComfyUI 前端的 WebSocket /ws 不透传(队列
  实时推送不可用,HTTP 页面与 API 可用);ComfyUI 前端以站点根绝对路径引用的
  资源(/assets/* 等)不经过本子路径代理。

参考蓝本: routes/opentalking.py(httpx.AsyncClient + trust_env=False + 流式透传)。
"""
from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.deps import get_current_user
from app.models import User

router = APIRouter(tags=["canvas"])
logger = logging.getLogger(__name__)

# 画布页面含大体积 JS/CSS 静态资源,读超时给足;connect 收紧快速失败
_PROXY_TIMEOUT = httpx.Timeout(120.0, connect=8.0)

# 逐跳头(hop-by-hop)不透传;host/content-length 由 httpx 依新请求重建
_DROP_REQ_HEADERS = frozenset({
    "host", "connection", "content-length", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade",
})
# 响应侧:逐跳头 + 长度/编码头(流式转发,长度以最终输出为准;
# 请求已强制 Accept-Encoding: identity,上游不应回压缩体,content-encoding 一并丢弃)
_DROP_RESP_HEADERS = frozenset({
    "connection", "content-length", "content-encoding", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade",
})


def _target_base() -> str:
    """反代目标基址(已去尾斜杠)。仅取配置值;配置非法 → 500(部署问题,不是用户输入)。"""
    base = get_settings().canvas_comfy_url.strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(status_code=500, detail="画布代理目标未正确配置")
    return base


async def _stream_passthrough(request: Request, url: str) -> StreamingResponse:
    """GET/POST 字节级流式透传;上游网络错误 → 502(detail 不带内网地址)。"""
    fwd_headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _DROP_REQ_HEADERS
    }
    # 强制 identity:流式透传压缩字节必须同步透传 content-encoding,不做解压协商最稳
    fwd_headers["accept-encoding"] = "identity"

    client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT, trust_env=False)
    upstream_req = client.build_request(
        request.method,
        url,
        headers=fwd_headers,
        content=await request.body() if request.method == "POST" else None,
    )
    try:
        upstream = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        logger.warning("画布代理上游不可达: %s", type(e).__name__)
        raise HTTPException(status_code=502, detail="画布服务不可达") from e

    async def _aiter():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError:
            # 上游中途断流:日志记录,连接已断无法改状态码,截断结束
            logger.warning("画布代理上游连接中断: %s", request.url.path)
        finally:
            await upstream.aclose()
            await client.aclose()

    resp_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() not in _DROP_RESP_HEADERS
    }
    # 覆写全局安全中间件默认(middleware 用 setdefault,这里先占值即生效):
    # 画布 iframe 与页面同源,允许本站嵌入;其余安全头(nosniff 等)维持默认
    resp_headers["X-Frame-Options"] = "SAMEORIGIN"
    resp_headers["Content-Security-Policy"] = "frame-ancestors 'self'"

    return StreamingResponse(
        _aiter(),
        status_code=upstream.status_code,
        headers=resp_headers,
    )


@router.get("/canvas/proxy", response_model=None)
@router.get("/canvas/proxy/{rest:path}", response_model=None)
@router.post("/canvas/proxy", response_model=None)
@router.post("/canvas/proxy/{rest:path}", response_model=None)
async def canvas_proxy(
    request: Request,
    rest: str = "",
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """ComfyUI 画布 GET/POST 透传。rest 为空 = 画布首页(/)。"""
    base = _target_base()
    url = f"{base}/{rest}" if rest else f"{base}/"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    return await _stream_passthrough(request, url)


# ── 原生画布(2026-09-16):object_info 服务端缓存 ─────────────────────────────
# 全量 object_info 20MB+,浏览器直拉既慢又给 ComfyUI loop 加压(同实例 6+ 并发
# object_info 会饿死 loop,见引擎工作台两级探测教训);这里服务端拉一次缓存,
# 单飞防并发风暴,?classes= 逗号分隔只回请求的类,响应缩到 KB 级。

_OBJECT_INFO_TTL_S = 600.0
_OBJECT_INFO_CACHE: dict = {"data": None, "at": 0.0}
_OBJECT_INFO_LOCK = asyncio.Lock()
_OBJECT_INFO_TIMEOUT = httpx.Timeout(60.0, connect=8.0)


@router.get("/canvas/object_info")
async def canvas_object_info(
    classes: str = "",
    user: User = Depends(get_current_user),
) -> dict:
    """ComfyUI /object_info 服务端缓存代理。classes 为空回全量(慎用),否则按类过滤。"""
    want = {c.strip() for c in classes.split(",") if c.strip()}
    cached = _OBJECT_INFO_CACHE["data"]
    fresh = cached is not None and time.monotonic() - _OBJECT_INFO_CACHE["at"] <= _OBJECT_INFO_TTL_S
    if not fresh:
        async with _OBJECT_INFO_LOCK:
            cached = _OBJECT_INFO_CACHE["data"]
            fresh = cached is not None and time.monotonic() - _OBJECT_INFO_CACHE["at"] <= _OBJECT_INFO_TTL_S
            if not fresh:
                base = _target_base()
                try:
                    async with httpx.AsyncClient(timeout=_OBJECT_INFO_TIMEOUT, trust_env=False) as client:
                        resp = await client.get(f"{base}/object_info")
                        resp.raise_for_status()
                        cached = resp.json()
                except httpx.HTTPError as e:
                    logger.warning("画布 object_info 上游不可达: %s", type(e).__name__)
                    raise HTTPException(status_code=502, detail="画布服务不可达") from e
                _OBJECT_INFO_CACHE["data"] = cached
                _OBJECT_INFO_CACHE["at"] = time.monotonic()
    if want and isinstance(cached, dict):
        return {k: v for k, v in cached.items() if k in want}
    return cached if isinstance(cached, dict) else {}


_WORKFLOW_TIMEOUT = httpx.Timeout(30.0, connect=8.0)


@router.get("/canvas/workflow")
async def canvas_workflow(
    path: str,
    user: User = Depends(get_current_user),
) -> dict:
    """读 ComfyUI userdata 工作流(UI 格式 JSON)。path 相对 workflows/ 目录。

    不走 /canvas/proxy 透传的原因:框架路由会把 %2F 解码,而 ComfyUI(aiohttp)
    的 /userdata/{file} 要求 raw path 保留 %2F,解码后必 404 —— 这里服务端
    自己按整段 quote 构造上游 URL。
    """
    clean = path.strip().lstrip("/")
    if not clean.lower().endswith(".json") or ".." in clean or "\\" in clean or not clean:
        raise HTTPException(status_code=422, detail="非法工作流路径")
    base = _target_base()
    url = f"{base}/api/userdata/{quote('workflows/' + clean, safe='')}"
    try:
        async with httpx.AsyncClient(timeout=_WORKFLOW_TIMEOUT, trust_env=False) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        logger.warning("画布工作流读取失败: %s", type(e).__name__)
        raise HTTPException(status_code=502, detail="画布服务不可达") from e
    except ValueError as e:
        raise HTTPException(status_code=502, detail="工作流内容不是合法 JSON") from e
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="工作流内容格式异常")
    return data
