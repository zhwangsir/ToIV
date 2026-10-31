"""客户端断开时取消出站请求(httpx / 后台 task)。

同步长请求(TTS / Demucs / VLM / ffmpeg)没有 Job 可 cancelJob:前端 abort fetch
只会让浏览器停等,出站连接仍占 IndexTTS/Whisper/Demucs/GPU。本模块把
request.is_disconnected 与 in-flight asyncio.Task 绑在一起,断开即 cancel。
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable
from typing import TypeVar

from fastapi import Request
from sqlmodel import Session, select

from app.db import engine
from app.models import Job

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ClientAborted(Exception):
    """客户端已断开,出站请求已取消。调用方不要再写产物。"""


async def _watch_disconnect(request: Request, task: asyncio.Task) -> None:
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                return
            await asyncio.sleep(0.25)
    except asyncio.CancelledError:
        return


async def await_or_disconnect(request: Request | None, coro: Awaitable[T]) -> T:
    """等 coro;若 request 断开则 cancel 并抛 ClientAborted。request=None 时原样 await(单测)。"""
    task = asyncio.ensure_future(coro)
    if request is None:
        return await task
    watcher = asyncio.create_task(_watch_disconnect(request, task))
    try:
        return await task
    except asyncio.CancelledError:
        raise ClientAborted() from None
    finally:
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watcher


def mark_prompt_canceled(prompt_id: str) -> None:
    """把 tracker 已建档的 Job 标 canceled(ComfyUI 清场由调用方 cancel_prompt)。"""
    if not prompt_id:
        return
    try:
        with Session(engine) as s:
            job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
            if job and job.status not in ("done", "error", "canceled"):
                job.status = "canceled"
                s.add(job)
                s.commit()
    except Exception as e:  # noqa: BLE001 — 标取消失败不阻断断开路径
        logger.warning("mark_prompt_canceled %s 失败:%s", prompt_id, e)


def abort_http_exception():
    """给已断开的客户端一个正式错误(对方通常已收不到)。"""
    from fastapi import HTTPException

    return HTTPException(status_code=400, detail="已中止")
