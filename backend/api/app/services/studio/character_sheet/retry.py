"""设定卡出图等待/队列/worker 选择(重试基础设施)."""
from __future__ import annotations

import asyncio
import colorsys
import contextvars
import hashlib
import json
import logging
import math
import os
import re
import uuid
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from PIL import Image, ImageDraw, ImageFont

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

import app.services.studio.character_sheet.constants as _constants
globals().update({k: v for k, v in vars(_constants).items() if not k.startswith('__')})

import app.services.studio.character_sheet.templates as _templates
globals().update({k: v for k, v in vars(_templates).items() if not k.startswith('__')})





class CharacterSheetQueueWait(CharacterSheetError):
    """04:30：作业在 Comfy 队列里排队超过上限（未开始执行）。

    不是出图失败：调用方记 queue_wait、不消耗重试次数；本作业已从 pending 撤下。
    """

    def __init__(self, message: str, *, queue_wait: float, prompt_id: str=''):
        super().__init__(message, status_code=503)
        self.queue_wait = float(queue_wait)
        self.prompt_id = prompt_id

async def _comfy_prompt_state(client: Any, prompt_id: str) -> str:
    """pending / running / gone / unknown（/queue 查不到时 unknown，按执行计时更保守）。"""
    try:
        running, pending = await client.get_queue_detail()
    except Exception:
        return 'unknown'
    if prompt_id in pending:
        return 'pending'
    if prompt_id in running:
        return 'running'
    return 'gone'

async def _wait_images(client: Any, prompt_id: str, *, exec_timeout: float | None=None, queue_wait_max: float | None=None) -> list[dict]:
    """04:30：超时只从 Comfy 开始执行计时；排队时间不计入。

    排队超过 ``queue_wait_max``(默认 20min) → 撤下本作业并抛 CharacterSheetQueueWait。
    """
    exec_to = float(_POLL_TIMEOUT if exec_timeout is None else exec_timeout)
    q_max = float(_QUEUE_WAIT_MAX if queue_wait_max is None else queue_wait_max)
    waited = 0.0
    queue_wait = 0.0
    from app.comfy.client import ComfyUIError
    while waited < exec_to:
        try:
            images = await client.get_images(prompt_id)
        except ComfyUIError:
            images = []
        if images:
            return images
        try:
            hist = await client.get_history(prompt_id)
            rec = (hist or {}).get(prompt_id) or {}
            st = rec.get('status') or {}
            if st.get('status_str') == 'error' or (st.get('completed') is False and any((isinstance(m, list) and m and (m[0] == 'execution_error') for m in st.get('messages') or []))):
                msg = 'execution_error'
                for m in st.get('messages') or []:
                    if isinstance(m, list) and m and (m[0] == 'execution_error'):
                        detail = m[1] if len(m) > 1 else {}
                        msg = str((detail or {}).get('exception_message') or (detail or {}).get('exception_type') or msg)
                        break
                raise CharacterSheetError(f'出图失败:{msg}', status_code=502)
        except CharacterSheetError:
            raise
        except Exception:
            pass
        state = await _comfy_prompt_state(client, prompt_id)
        await asyncio.sleep(_POLL_INTERVAL)
        if state == 'pending':
            queue_wait += _POLL_INTERVAL
            if queue_wait >= q_max:
                try:
                    await client.delete_from_queue([prompt_id])
                except Exception:
                    pass
                raise CharacterSheetQueueWait(f'排队超时 queue_wait={queue_wait:.0f}s(>{q_max:.0f}s 未开始执行，不计失败)', queue_wait=queue_wait, prompt_id=prompt_id)
            continue
        waited += _POLL_INTERVAL
    raise CharacterSheetError(f'出图超时({exec_to:.0f}s 执行计时, queue_wait={queue_wait:.0f}s)', status_code=504)

def _assert_sheet_worker_allowed(url: str) -> None:
    port = urlsplit(url).port
    if port in _FORBIDDEN_WORKER_PORTS or port not in _SHEET_ALLOWED_PORTS:
        raise CharacterSheetError(f'禁止使用端口 :{port},设定卡仅允许 :8262/:8264', status_code=400)

async def _pick_sheet_client(worker: str | None=None) -> Any:
    """仅从 :8262/:8264 取客户端;禁止 pool/:8195/:8196/:8197/:8205/:8261/:8263。"""
    from app.comfy.client import ComfyUIClient, ComfyUIError
    from app.config import get_settings
    from app.services.video_upscale import healthy_upscale_workers, upscale_worker_urls
    settings = get_settings()
    timeout = settings.request_timeout
    if worker:
        u = worker.rstrip('/')
        _assert_sheet_worker_allowed(u)
        allowed = set(upscale_worker_urls())
        if u not in allowed:
            port = urlsplit(u).port
            if port not in _SHEET_ALLOWED_PORTS:
                raise CharacterSheetError(f'worker 不在设定卡允许列表(:8262/:8264):{u}', status_code=400)
        return ComfyUIClient(u, timeout=timeout)
    urls = await healthy_upscale_workers()
    safe = []
    for u in urls:
        try:
            _assert_sheet_worker_allowed(u)
            safe.append(u)
        except CharacterSheetError:
            continue
    if not safe:
        remapped = []
        for u in upscale_worker_urls():
            p = urlsplit(u)
            if p.port not in _SHEET_ALLOWED_PORTS:
                continue
            for host in ('100.68.100.90', '192.168.71.127'):
                cand = f'{p.scheme}://{host}:{p.port}'
                remapped.append(cand)
        seen: set[str] = set()
        uniq = []
        for c in remapped:
            if c not in seen:
                seen.add(c)
                uniq.append(c)
        safe = await healthy_upscale_workers(uniq)
    if not safe:
        raise CharacterSheetError('出图 fleet :8262/:8264 不可用', status_code=503)

    def _rank(u: str) -> int:
        port = urlsplit(u).port or 0
        return {8262: 0, 8264: 1}.get(port, 9)
    safe.sort(key=_rank)
    try:
        client = ComfyUIClient(safe[0], timeout=timeout)
        await client.get_system_stats()
        return client
    except ComfyUIError as e:
        raise CharacterSheetError(f'出图后端不可用:{e}', status_code=503) from e
