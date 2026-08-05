"""对口型服务:LatentSync 1.6 让视频镜角色嘴型对上配音。

流程(与 routes/lipsync.py 同源,服务层自持、同步等待产物):
  下载分镜视频 + 配音 → 上传选中 worker 的 input → LatentSync 构图入队 →
  轮询 history 取产物 → 落盘 Studio 输出目录 → URL 回写 final_clip_url。

仅视频镜可用;image_motion 镜由路由层 422 拦截。状态机:voiced → lipsynced。
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING

import httpx
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.config import get_settings
from app.models import StudioShot
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

_DOWNLOAD_TIMEOUT = 120.0
_POLL_INTERVAL = 3.0  # 轮询间隔(秒);测试可 monkeypatch
_POLL_TIMEOUT = 600.0  # LatentSync 单镜通常分钟级


class LipsyncError(RuntimeError):
    pass


def _save_clip(data: bytes) -> str:
    """落盘到 Studio 输出目录,返回可访问 URL。"""
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.mp4"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def _resolve(url: str) -> str:
    """相对路径(本 API 资产)补全为绝对 URL。"""
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


async def _download(http: httpx.AsyncClient, url: str) -> bytes:
    try:
        r = await http.get(_resolve(url))
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise LipsyncError(f"源下载失败:{e}") from e
    if not r.content:
        raise LipsyncError("源视频或配音为空")
    return r.content


async def _wait_result_files(client, prompt_id: str) -> list[dict]:
    """轮询 worker history 取产物;超时抛 LipsyncError。"""
    waited = 0.0
    while waited < _POLL_TIMEOUT:
        try:
            files = await client.get_result_files(prompt_id)
        except ComfyUIError:
            files = []  # worker 暂不可达/历史未就绪,下轮再试
        if files:
            return files
        await asyncio.sleep(_POLL_INTERVAL)
        waited += _POLL_INTERVAL
    raise LipsyncError(f"对口型超时({_POLL_TIMEOUT:.0f}s)")


async def lipsync_video(shot: StudioShot, pool: "WorkerPool") -> str:
    """视频镜对口型:同步等待产物,返回落盘 URL。"""
    if not shot.video_url or not shot.voice_url:
        raise LipsyncError("需要先出视频并配音")
    try:
        client = await pool.pick(required=set())
    except ComfyUIError as e:
        raise LipsyncError(f"worker 不可用:{e}") from e

    async with httpx.AsyncClient(
        timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, trust_env=False
    ) as http:
        video_bytes = await _download(http, shot.video_url)
        voice_bytes = await _download(http, shot.voice_url)

    try:
        vfn = await client.upload_image(
            video_bytes, f"studio_ls_src_{uuid.uuid4().hex}.mp4"
        )
        afn = await client.upload_image(
            voice_bytes, f"studio_ls_voice_{uuid.uuid4().hex}.wav"
        )
    except ComfyUIError as e:
        raise LipsyncError(f"上传 worker 失败:{e}") from e

    graph = build_latentsync_graph(LatentSyncParams(video=vfn, audio=afn))
    try:
        prompt_id = await client.queue_prompt(graph, uuid.uuid4().hex)
    except ComfyUIError as e:
        raise LipsyncError(f"工作流提交失败:{e}") from e

    files = await _wait_result_files(client, prompt_id)
    out = files[0]
    try:
        data, _ = await client.get_image_bytes(
            out["filename"], out.get("subfolder", ""), out.get("type", "output")
        )
    except ComfyUIError as e:
        raise LipsyncError(f"取产物失败:{e}") from e
    return _save_clip(data)


async def lipsync_for_shot(
    session: Session, shot: StudioShot, pool: "WorkerPool | None" = None
) -> str:
    """对口型并回写分镜;状态机:voiced → lipsynced。"""
    if pool is None:
        from app.deps import get_pool

        pool = get_pool()
    url = await lipsync_video(shot, pool)
    shot.final_clip_url = url
    shot.status = "lipsynced"
    shot.error = ""
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return url
