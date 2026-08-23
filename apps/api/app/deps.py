"""FastAPI 依赖注入。"""
from __future__ import annotations

from functools import lru_cache
from urllib.parse import urlsplit

from fastapi import Depends, Header, HTTPException, Query
from sqlmodel import Session

from app.comfy.client import ComfyUIClient
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.models import User
from app.security import decode_token


@lru_cache
def get_pool() -> WorkerPool:
    settings = get_settings()
    return WorkerPool.from_urls(settings.worker_urls, timeout=settings.request_timeout)


def _host(url: str) -> str:
    parts = urlsplit(url)
    return parts.hostname or url


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
    # H3 专用实例(不在 pool 白名单):必须在 hostname 回退之前精确匹配,
    # 否则同机(127)会被错配到 pool worker,而其 output 目录没有 H3 产物
    h3_base = getattr(settings, "h3_base", "")
    if h3_base and normalized == h3_base:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # LongCat 专用实例(不在 pool 白名单):同 H3,hostname 回退会错配到
    # 同机 pool worker(其 output 目录没有 LongCat 产物),必须先行精确匹配
    longcat_base = getattr(settings, "longcat_base", "")
    if longcat_base and normalized == longcat_base:
        return ComfyUIClient(normalized, timeout=settings.request_timeout)
    # hostname 级回退:兼容旧产物 URL(worker 端口已退役但同机仍存活)
    target_host = _host(normalized)
    for url in settings.worker_urls:
        if _host(url) == target_host:
            return ComfyUIClient(url, timeout=settings.request_timeout)
    raise HTTPException(status_code=400, detail="未知的 worker")


def get_current_user(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> User:
    """从 Bearer JWT 解析当前用户。

    令牌优先取请求头 `Authorization: Bearer`,其次取 `?token=` 查询参数
    （<img>/原生 EventSource 无法附带请求头，只能走查询参数）。失败抛 401。
    """
    raw: str | None = None
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization.split(" ", 1)[1]
    elif token:
        raw = token
    if not raw:
        raise HTTPException(status_code=401, detail="未认证")
    user_id = decode_token(raw)
    if not user_id:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
