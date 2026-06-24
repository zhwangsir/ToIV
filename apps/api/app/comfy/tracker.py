"""服务端作业追踪 —— 提交后即在后台把结果回写库,独立于客户端 SSE。

修复的真实 bug:历史上结果只在客户端连 `/api/jobs/{id}/events` 时由 SSE 流写库;
前端不连 / 中途断开 → 结果永不落库,任务永远停在 "queued"(用户丢图)。

这里在提交时 fire-and-forget 启动一个**轮询 /history** 的后台任务,完成即落库,
幂等。客户端 SSE 仍可连(实时进度),与本追踪共用同一套落库函数,双写无害。

ComfyUIClient 无状态(每调用现开现关 httpx),故可安全用于请求生命周期之外。
"""
from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlencode

from sqlmodel import Session, select

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.db import engine
from app.models import Job

logger = logging.getLogger(__name__)

# 持有后台任务强引用(asyncio 仅持弱引用,否则可能被 GC 提前回收)
_tasks: set[asyncio.Task] = set()

# 单作业追踪上限(视频可能跑数分钟)
_TRACK_TIMEOUT = 1200.0  # 20 分钟
_POLL_START = 2.0
_POLL_MAX = 8.0


def image_url(worker: str, image: dict) -> str:
    return f"/api/images?{urlencode({**image, 'worker': worker})}"


def mark_status(prompt_id: str, status: str) -> None:
    """更新状态(独立短会话);已完成的作业不回退。"""
    with Session(engine) as session:
        job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job and job.status != "done":
            job.status = status
            session.add(job)
            session.commit()


def mark_done(prompt_id: str, urls: list[str]) -> None:
    """完成时持久化状态与产物 URL;幂等(已 done 则跳过,避免重复写)。"""
    with Session(engine) as session:
        job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job and job.status != "done":
            job.status = "done"
            job.result = json.dumps(urls)
            session.add(job)
            session.commit()


async def record_result(client: ComfyUIClient, prompt_id: str) -> list[str]:
    """从 ComfyUI history 取产物 → 代理 URL → 落库。幂等。供 SSE 与追踪共用。"""
    files = await client.get_result_files(prompt_id)
    urls = [image_url(client.base_url, f) for f in files]
    mark_done(prompt_id, urls)
    return urls


async def _poll_once(client: ComfyUIClient, prompt_id: str) -> str | None:
    """查一次 history。完成→落库返回 'done';执行出错→标 error;未完成→None。"""
    try:
        history = await client.get_history(prompt_id)
    except ComfyUIError:
        return None  # worker 暂不可达/历史未就绪,下次再试
    entry = history.get(prompt_id)
    if not entry:
        return None  # 还没进 history(排队 / 执行中)
    status = entry.get("status") or {}
    files: list[dict] = []
    for node_out in (entry.get("outputs") or {}).values():
        for value in node_out.values():
            if not isinstance(value, list):
                continue
            for item in value:
                if isinstance(item, dict) and "filename" in item:
                    files.append(
                        {
                            "filename": item["filename"],
                            "subfolder": item.get("subfolder", ""),
                            "type": item.get("type", "output"),
                        }
                    )
    if files:
        mark_done(prompt_id, [image_url(client.base_url, f) for f in files])
        return "done"
    if status.get("status_str") == "error":
        mark_status(prompt_id, "error")
        return "error"
    if status.get("completed"):
        mark_done(prompt_id, [])  # 完成但无产物(罕见)
        return "done"
    return None


async def _track(client: ComfyUIClient, prompt_id: str) -> None:
    """轮询 history 直到完成/出错/超时,把结果落库(独立于任何客户端连接)。"""
    delay, waited = _POLL_START, 0.0
    while waited < _TRACK_TIMEOUT:
        try:
            outcome = await _poll_once(client, prompt_id)
            if outcome is not None:
                return
        except Exception as e:  # noqa: BLE001 — 后台任务绝不能因意外冒泡而静默死掉
            logger.warning("job tracker %s poll error: %s", prompt_id, e)
        await asyncio.sleep(delay)
        waited += delay
        delay = min(delay * 1.4, _POLL_MAX)
    logger.warning("job tracker %s timed out after %.0fs", prompt_id, _TRACK_TIMEOUT)


def spawn(client: ComfyUIClient, prompt_id: str) -> None:
    """提交后即启动后台追踪(fire-and-forget,保留强引用防 GC)。"""
    task = asyncio.create_task(_track(client, prompt_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
