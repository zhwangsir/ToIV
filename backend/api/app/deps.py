"""FastAPI 依赖注入。"""
from __future__ import annotations

from functools import lru_cache
from urllib.parse import urlsplit

from fastapi import Depends, Header, HTTPException, Query, Request
from sqlmodel import Session

from app.comfy.client import ComfyUIClient
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.models import User
from app.security import decode_token_claims, token_sha256
from app.token_policy import is_revoked, scope_allows


@lru_cache
def get_pool() -> WorkerPool:
    settings = get_settings()
    return WorkerPool.from_urls(
        settings.worker_urls,
        timeout=settings.request_timeout,
        # 注册表动态跟随(ComfyUI-LB /admin/backends);空串 = 不启用,原行为
        registry_url=settings.comfy_workers_registry_url.strip() or None,
    )


# 受信算力机直连时允许的 ComfyUI 端口段(防把白名单机器当任意端口代理)
_COMFY_PORT_MIN = 8188
_COMFY_PORT_MAX = 8299


def _host(url: str) -> str:
    parts = urlsplit(url)
    return parts.hostname or url


def _same_instance_other_network(
    normalized: str, candidates: list[str], groups: list[set[str]]
) -> str | None:
    """同一实例的双网络地址(LAN ↔ Tailscale):按 (同机地址组, 端口) 归一匹配。

    专用实例/池成员通常只配一个网络地址,而旧产物 URL 可能记另一个;必须还原到
    配置实例,否则会落 hostname 回退 → 同机 LB,其 output 目录没有该产物。
    """
    target = urlsplit(normalized)
    host, port = target.hostname, target.port
    if not host or not port:
        return None
    group = next((g for g in groups if host in g), None)
    if not group:
        return None
    for base in candidates:
        parts = urlsplit(base)
        if parts.hostname in group and parts.hostname != host and parts.port == port:
            return base.rstrip("/")
    return None


def resolve_worker(worker: str) -> ComfyUIClient:
    """校验 worker 在白名单内并返回客户端(防 SSRF:只允许配置过的后端)。

    匹配规则:先精确匹配完整 URL(pool 白名单或 H3/LongCat 专用实例);失败则按 hostname
    匹配(同机多 worker 共享输出目录,旧产物 URL 里的 worker 端口可能已不在当前
    白名单,但同机仍有存活 worker 能代取)。hostname 匹配命中时返回白名单中
    第一个同机 worker(主取),siblings 回退由调用方处理。
    """
    settings = get_settings()
    normalized = worker.rstrip("/")
    if normalized in settings.worker_urls:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # 池内动态成员(LB 注册表跟随):调度会按注册表派到静态白名单之外的实例
    # (如 gpu3 :8263)。取产物必须回到生成它的实例——回退到同机 LB 时,其
    # /view 在学到 filename→backend 前按序盲试,会返回他端同名陈旧文件。
    try:
        for member in get_pool().clients:
            if member.base_url.rstrip("/") == normalized:
                return ComfyUIClient(normalized, timeout=settings.request_timeout)
    except Exception:  # noqa: BLE001 — 池不可构建时沿用既有回退链
        pass
    # H3 专用实例(不在 pool 白名单;2026-09-13 双 worker 池):必须在 hostname 回退之前
    # 精确匹配任一配置实例,否则落第二实例的作业(worker=:8198)产物取回被判「未知的 worker」,
    # 同机(127)还会被 hostname 回退错配到 pool worker(其 output 目录没有 H3 产物)
    from app.services.h3 import h3_instances  # 函数内导入:避免 deps↔services 循环
    for h3_url in h3_instances():
        if normalized == h3_url:
            return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # LongCat 专用实例(不在 pool 白名单):同 H3,hostname 回退会错配到
    # 同机 pool worker(其 output 目录没有 LongCat 产物),必须先行精确匹配
    longcat_base = getattr(settings, "longcat_base", "")
    if longcat_base and normalized == longcat_base:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # Qwen-Image-Edit 专用实例(pc02 :8194,不在 pool 白名单):同 H3/LongCat,
    # hostname 回退会错配到同机池实例 :8193(其 output 目录没有编辑产物),必须先行精确匹配
    qwen_edit_base = getattr(settings, "qwen_edit_base", "")
    if qwen_edit_base and normalized == qwen_edit_base:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # Wan-Animate-2 专用实例(workstation :8199,不在 pool 白名单):同上,
    # hostname 回退会错配到同机 pool worker(其 output 目录没有 Animate-2 产物)
    wan_animate2_base = getattr(settings, "wan_animate2_base", "")
    if wan_animate2_base and normalized == wan_animate2_base:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # InfiniteTalk 专用实例(workstation :8201,不在 pool 白名单):同上,
    # hostname 回退会错配到同机 pool worker(其 output 目录没有 InfiniteTalk 产物)
    infinitetalk_base = getattr(settings, "infinitetalk_base", "")
    if infinitetalk_base and normalized == infinitetalk_base:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # 双网络地址归一:旧产物可能记的是同一实例的另一个网络地址(如 H3 记 TS
    # 100.68.100.90:8264,现网配 LAN :8264)。必须在 hostname 回退之前还原到配置
    # 实例,否则 :8264 会被错配到同机 LB(:8188),其 output 目录没有 H3 产物(404)。
    candidates = [
        b for b in (
            *h3_instances(), longcat_base, qwen_edit_base,
            wan_animate2_base, infinitetalk_base,
        ) if b
    ]
    candidates.extend(settings.worker_urls)
    try:
        candidates.extend(c.base_url for c in get_pool().clients)
    except Exception:  # noqa: BLE001 — 池不可构建时只用静态候选
        pass
    alias_url = _same_instance_other_network(
        normalized, candidates, getattr(settings, "worker_host_groups", [])
    )
    if alias_url:
        return ComfyUIClient(alias_url, timeout=settings.request_timeout)
    # hostname 级回退:兼容旧产物 URL(worker 端口已退役但同机仍存活)
    target_host = _host(normalized)
    for url in settings.worker_urls:
        if _host(url) == target_host:
            return ComfyUIClient(url, timeout=settings.request_timeout)
    # 同机双地址回退(内网 ↔ Tailscale):旧产物记内网地址,白名单只有 TS 地址
    same_machine = next((g for g in getattr(settings, "worker_host_groups", []) if target_host in g), None)
    if same_machine:
        for url in settings.worker_urls:
            if _host(url) in same_machine:
                return ComfyUIClient(url, timeout=settings.request_timeout)
        # 池里没有这台机(如 pc01 已出池但产物仍在本机):受信机器直连原地址,限 ComfyUI 端口段
        port = urlsplit(normalized).port
        if urlsplit(normalized).scheme in ("http", "https") and port and _COMFY_PORT_MIN <= port <= _COMFY_PORT_MAX:
            return ComfyUIClient(normalized, timeout=settings.request_timeout)
    raise HTTPException(status_code=400, detail="未知的 worker")


def get_current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> User:
    """从 Bearer JWT 解析当前用户。

    令牌优先取请求头 `Authorization: Bearer`,其次取 `?token=` 查询参数
    （<img>/原生 EventSource 无法附带请求头，只能走查询参数）。失败抛 401。
    受限服务令牌(claims.scope)只能访问 token_policy.SCOPES 白名单接口,其余 403;
    命中吊销清单(token_policy)的令牌按无效处理(401)。
    """
    raw: str | None = None
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization.split(" ", 1)[1]
    elif token:
        raw = token
    if not raw:
        raise HTTPException(status_code=401, detail="未认证")
    claims = decode_token_claims(raw)
    if not claims:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    if is_revoked(token_sha256(raw), claims):
        raise HTTPException(status_code=401, detail="令牌已吊销")
    scope = claims.get("scope")
    if scope is not None:
        query = {k: v for k, v in request.query_params.items() if k != "token"}
        if not isinstance(scope, str) or not scope_allows(scope, request.method, request.url.path, query):
            raise HTTPException(status_code=403, detail="服务令牌无权访问该接口")
    user = session.get(User, claims["sub"])
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    if scope is not None and user.role == "admin":
        # 服务令牌不得代表管理员账号(签发端已拒绝;此处兜底)
        raise HTTPException(status_code=403, detail="服务令牌不能属于管理员账号")
    return user


def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
