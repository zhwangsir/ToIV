"""OpenTalking 数字人引擎反向代理。

把前端对 /api/opentalking/* 的调用透传到 OpenTalking unified 进程
(本地 dev: 127.0.0.1:4403; Docker: http://opentalking:8000),统一鉴权 + 同源。

- 简单 GET (/health /models /avatars /voices /personas /runtime-config /queue/status
  /sessions/webrtc/ice-config) 走通配 GET 代理。
- SSE (GET /sessions/{id}/events) 用 httpx.stream() 字节级透传,复用 ?token= 鉴权。
- POST (/sessions /sessions/{id}/start|speak|interrupt|webrtc/offer) 显式声明,body 透传。
- WebRTC 媒体流不经过本代理(SRTP P2P 直连 OpenTalking UDP 端口),仅信令(POST /webrtc/offer)走代理。

参考蓝本: routes/voice.py(httpx.AsyncClient + trust_env=False 防 SSRF)。
"""
from __future__ import annotations

import json
import re
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app.config import get_settings
from app.deps import get_current_user
from app.models import User

router = APIRouter(tags=["opentalking"])

# SSE 事件流路径特判: /sessions/{id}/events
_SSE_RE = re.compile(r"^/sessions/[^/]+/events$")
# 简单 GET 代理白名单(rest 路径, 以 / 开头)。通配兜底也会匹配, 白名单仅用于文档化。
_SIMPLE_GET_PATHS = {
    "/health",
    "/healthz",
    "/models",
    "/avatars",
    "/voices",
    "/personas",
    "/runtime-config",
    "/runtime/status",
    "/queue/status",
    "/sessions/webrtc/ice-config",
    "/agent/knowledge-bases",
    "/memory/libraries",
    "/scene-assets/backgrounds",
    "/scene-assets/compositions",
}
# 代理超时: REST 30s; SSE 无读超时(长连接); POST 创建会话可能涉及 STT prewarm, 给 60s。
_REST_TIMEOUT = 30.0
_POST_TIMEOUT = 60.0
_SSE_CONNECT_TIMEOUT = 8.0


def _ot_base() -> str:
    """OpenTalking 基址(已去尾斜杠)。"""
    return get_settings().opentalking_base_url.strip().rstrip("/")


def _check_enabled() -> None:
    """未启用时直接 503, 避免每个端点重复判断。"""
    if not get_settings().opentalking_enabled:
        raise HTTPException(status_code=503, detail="数字人引擎未启用")


def _unreachable(detail: str = "数字人引擎暂时不可用") -> HTTPException:
    return HTTPException(status_code=503, detail=detail)


# ---------- 响应形状转换(对齐前端契约) ----------


def _is_json(r: httpx.Response) -> bool:
    ct = (r.headers.get("content-type") or "").lower()
    return ct.startswith("application/json") or ct.startswith("text/json")


def _shape_avatars(r: httpx.Response) -> Response:
    """上游 /avatars 返回 list[AvatarSummary] 裸数组;前端期望 {"avatars": [...]}。

    透传所有字段(id/name/model_type/width/height/person_mode/is_custom/has_preview_video/
    matting_status/duo_dialog/client_renderer),前端可按需消费,无需再改代理。
    """
    try:
        data = r.json()
    except (ValueError, json.JSONDecodeError):
        # 上游返回非 JSON(异常情况),原样透传避免吞错
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type"),
        )

    # 防御:某些版本可能已经包了一层 {"avatars": [...]}
    if isinstance(data, dict) and isinstance(data.get("avatars"), list):
        payload = data
    elif isinstance(data, list):
        payload = {"avatars": data}
    else:
        payload = {"avatars": []}

    return Response(
        content=json.dumps(payload, ensure_ascii=False),
        status_code=r.status_code,
        media_type="application/json",
    )


def _shape_models(r: httpx.Response) -> Response:
    """上游 /models 返回 {"models": ["id1","id2"], "statuses": [...], "default_model": str|None}。

    前端 ModelsResponse 期望 {"models": ModelInfo[], "default_model": str},其中
    ModelInfo = {id, backend, status, reason}。把 statuses 映射为 ModelInfo 列表,
    connected → status="available" / 否则 "unavailable"。default_model 缺失时回退 "mock"。
    """
    try:
        data = r.json()
    except (ValueError, json.JSONDecodeError):
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type"),
        )

    if not isinstance(data, dict):
        # 异常形状,兜底返回空列表 + mock 默认
        payload: dict[str, Any] = {"models": [], "default_model": "mock"}
        return Response(
            content=json.dumps(payload, ensure_ascii=False),
            status_code=r.status_code,
            media_type="application/json",
        )

    statuses = data.get("statuses")
    if not isinstance(statuses, list):
        statuses = []

    models: list[dict[str, Any]] = []
    for s in statuses:
        if not isinstance(s, dict):
            continue
        models.append(
            {
                "id": str(s.get("id") or ""),
                "backend": str(s.get("backend") or ""),
                "status": "available" if s.get("connected") else "unavailable",
                "reason": s.get("reason"),
            }
        )

    # 上游 default_model 可能是 None;前端 TS 类型是 string,回退 "mock" 保持契约
    default_model = data.get("default_model") or "mock"

    payload = {"models": models, "default_model": default_model}
    return Response(
        content=json.dumps(payload, ensure_ascii=False),
        status_code=r.status_code,
        media_type="application/json",
    )


def _shape_response(rest: str, r: httpx.Response) -> Response | None:
    """按 rest 路径分发到具体 shape 转换器;无匹配返回 None(原样透传)。"""
    # rest 形如 "/avatars" 或 "/avatars?xxx"(已去 query);此处只判等路径部分
    path = rest.split("?", 1)[0].rstrip("/")
    if path == "/avatars":
        return _shape_avatars(r)
    if path == "/models":
        return _shape_models(r)
    return None


# ---------- 状态探活(无需鉴权, 供前端首屏判断是否降级) ----------


@router.get("/opentalking/status")
async def ot_status() -> dict[str, Any]:
    settings = get_settings()
    if not settings.opentalking_enabled:
        return {"enabled": False, "reachable": False}
    base = _ot_base()
    if not base:
        return {"enabled": True, "reachable": False}
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            r = await client.get(f"{base}/health")
        reachable = r.status_code == 200
        info: dict[str, Any] = {"enabled": True, "reachable": reachable}
        if reachable:
            try:
                payload = r.json()
                info["model"] = payload.get("llm_model")
                info["tts_provider"] = payload.get("tts_provider")
            except (ValueError, KeyError):
                pass
        return info
    except httpx.HTTPError:
        return {"enabled": True, "reachable": False}


# ---------- 简单 GET 代理(通配兜底, SSE 特判) ----------


@router.get("/opentalking{rest:path}", response_model=None)
async def proxy_get(
    rest: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response | StreamingResponse:
    """通配 GET 代理。rest 以 / 开头, 如 /health /avatars。

    SSE 特判: rest 匹配 ^/sessions/[^/]+/events$ 时走流式透传。
    """
    _check_enabled()
    base = _ot_base()
    if not rest.startswith("/"):
        rest = "/" + rest
    url = f"{base}{rest}"
    # 透传查询参数(?token= 由前端 EventSource 注入, 但后端鉴权已用 header 完成, 此参数传给 OpenTalking 无害)
    if request.url.query:
        url = f"{url}?{request.url.query}"

    # SSE 流式透传
    if _SSE_RE.match(rest):
        return await _proxy_sse(url)

    # 普通 GET
    try:
        async with httpx.AsyncClient(
            timeout=_REST_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            r = await client.get(url)
    except httpx.HTTPError as e:
        raise _unreachable(f"数字人引擎不可达: {e}") from e

    # 形状转换:仅对 2xx JSON 响应做 shape;错误响应原样透传便于前端看到真实 detail
    if r.status_code < 300 and _is_json(r):
        shaped = _shape_response(rest, r)
        if shaped is not None:
            return shaped

    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type"),
    )


# ---------- SSE 流式透传 ----------


async def _proxy_sse(url: str) -> StreamingResponse:
    """httpx.stream() 字节级透传 SSE, 不解析帧。OpenTalking 自带 30s ping 心跳。"""
    client = httpx.AsyncClient(timeout=None, trust_env=False)

    async def gen():
        try:
            async with client.stream("GET", url) as upstream:
                async for chunk in upstream.aiter_raw():
                    if chunk:
                        yield chunk
        except httpx.HTTPError:
            # 上游断开: 发一个 error 事件让前端 onerror 触发重连
            yield (
                'event: error\ndata: {"code":"upstream_disconnected",'
                '"message":"数字人引擎连接中断"}\n\n'
            ).encode("utf-8")
        finally:
            await client.aclose()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 防 nginx/openresty 缓冲 SSE
        },
    )


# ---------- POST 代理(显式声明, body 透传) ----------


async def _proxy_post(url: str, body: dict | None) -> Response:
    """POST + JSON body 透传。上游非 2xx 响应原样转发(保留 detail 便于前端展示)。"""
    try:
        async with httpx.AsyncClient(
            timeout=_POST_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            r = await client.post(url, json=body)
    except httpx.TimeoutException as e:
        # 区分超时(上游 worker 未就绪,常见于会话创建)与连接失败,便于前端给出准确提示
        raise _unreachable(
            f"数字人引擎响应超时(>{_POST_TIMEOUT:.0f}s),worker 可能未就绪: {e}"
        ) from e
    except httpx.HTTPError as e:
        raise _unreachable(f"数字人引擎不可达: {e}") from e
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type"),
    )


@router.post("/opentalking/sessions")
async def create_session(
    body: dict | None = Body(default=None),
    user: User = Depends(get_current_user),
) -> Response:
    """创建数字人会话。POST /sessions → OpenTalking。"""
    _check_enabled()
    return await _proxy_post(f"{_ot_base()}/sessions", body)


@router.post("/opentalking/sessions/{session_id}/start")
async def start_session(
    session_id: str,
    body: dict | None = Body(default=None),
    user: User = Depends(get_current_user),
) -> Response:
    _check_enabled()
    return await _proxy_post(f"{_ot_base()}/sessions/{session_id}/start", body)


@router.post("/opentalking/sessions/{session_id}/speak")
async def speak(
    session_id: str,
    body: dict | None = Body(default=None),
    user: User = Depends(get_current_user),
) -> Response:
    """文本驱动数字人说话。"""
    _check_enabled()
    return await _proxy_post(f"{_ot_base()}/sessions/{session_id}/speak", body)


@router.post("/opentalking/sessions/{session_id}/interrupt")
async def interrupt(
    session_id: str,
    body: dict | None = Body(default=None),
    user: User = Depends(get_current_user),
) -> Response:
    _check_enabled()
    return await _proxy_post(f"{_ot_base()}/sessions/{session_id}/interrupt", body)


@router.post("/opentalking/sessions/{session_id}/webrtc/offer")
async def webrtc_offer(
    session_id: str,
    body: dict | None = Body(default=None),
    user: User = Depends(get_current_user),
) -> Response:
    """WebRTC SDP 信令代理(媒体流 P2P 直连, 不经过本代理)。"""
    _check_enabled()
    return await _proxy_post(
        f"{_ot_base()}/sessions/{session_id}/webrtc/offer", body
    )
