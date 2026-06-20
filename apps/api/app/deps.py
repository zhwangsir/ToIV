"""FastAPI 依赖注入。"""
from __future__ import annotations

from functools import lru_cache

from fastapi import HTTPException

from app.comfy.client import ComfyUIClient
from app.comfy.pool import WorkerPool
from app.config import get_settings


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
