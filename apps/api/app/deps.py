"""FastAPI 依赖注入。"""
from __future__ import annotations

from functools import lru_cache

from fastapi import Depends, Header, HTTPException
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


def resolve_worker(worker: str) -> ComfyUIClient:
    """校验 worker 在白名单内并返回客户端（防 SSRF：只允许配置过的后端）。"""
    settings = get_settings()
    normalized = worker.rstrip("/")
    if normalized not in settings.worker_urls:
        raise HTTPException(status_code=400, detail="未知的 worker")
    return ComfyUIClient(normalized, timeout=settings.request_timeout)


def get_current_user(
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> User:
    """从 Bearer JWT 解析当前用户;失败抛 401。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="未认证")
    user_id = decode_token(authorization.split(" ", 1)[1])
    if not user_id:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user
