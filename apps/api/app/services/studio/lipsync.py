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


_FILES_PREFIX = "/api/studio/files/"


def _local_studio_bytes(url: str) -> bytes | None:
    """本服务 /api/studio/files/{name} 直读磁盘,避免内部自调缺 Bearer 401。"""
    from pathlib import Path as _Path

    from app.storage import drama_output_root

    path_url = url
    if path_url.startswith("http://") or path_url.startswith("https://"):
        # http://host/api/studio/files/x → /api/studio/files/x
        marker = "/api/studio/files/"
        i = path_url.find(marker)
        if i < 0:
            return None
        path_url = path_url[i:]
    if not path_url.startswith(_FILES_PREFIX):
        return None
    name = _Path(path_url[len(_FILES_PREFIX):]).name
    if not name or name != path_url[len(_FILES_PREFIX):]:
        raise LipsyncError("非法 studio 文件路径")
    path = drama_output_root() / "studio" / name
    if not path.is_file():
        raise LipsyncError(f"studio 文件不存在:{name}")
    data = path.read_bytes()
    if not data:
        raise LipsyncError("源视频或配音为空")
    return data


async def _download(http: httpx.AsyncClient, url: str) -> bytes:
    local = _local_studio_bytes(url)
    if local is not None:
        return local
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


async def lipsync_via_agent(shot: StudioShot) -> str:
    """走 workstation LatentSync HTTP agent(:9103),与 /api/video/lipsync 同契约。"""
    from app.config import get_settings

    base = get_settings().lipsync_url.strip().rstrip("/")
    if not base:
        raise LipsyncError("对口型引擎未配置(TOIV_LIPSYNC_URL)")

    async with httpx.AsyncClient(
        timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, trust_env=False
    ) as http:
        video_bytes = await _download(http, shot.video_url)
        voice_bytes = await _download(http, shot.voice_url)

    async with httpx.AsyncClient(timeout=300.0, trust_env=False) as client:
        try:
            rv = await client.post(
                f"{base}/v1/video/upload",
                files={"media": (f"studio_ls_{uuid.uuid4().hex}.mp4", video_bytes, "video/mp4")},
                data={"type": "video"},
            )
            ra = await client.post(
                f"{base}/v1/video/upload",
                files={"media": (f"studio_ls_{uuid.uuid4().hex}.wav", voice_bytes, "audio/wav")},
                data={"type": "audio"},
            )
        except httpx.HTTPError as e:
            raise LipsyncError(f"对口型引擎不可达:{e}") from e
        if rv.status_code >= 300 or ra.status_code >= 300:
            raise LipsyncError(
                f"对口型上传失败(video={rv.status_code},audio={ra.status_code})"
            )
        try:
            vfn = str(rv.json().get("filename") or "")
            afn = str(ra.json().get("filename") or "")
        except ValueError as e:
            raise LipsyncError("对口型上传响应非 JSON") from e
        if not vfn or not afn:
            raise LipsyncError("对口型上传响应缺 filename")

        try:
            rs = await client.post(
                f"{base}/v1/lipsync/submit",
                json={
                    "video": vfn,
                    "audio": afn,
                    "inference_steps": 10,
                    "guidance_scale": 1.5,
                },
            )
        except httpx.HTTPError as e:
            raise LipsyncError(f"对口型引擎不可达:{e}") from e
        if rs.status_code >= 300:
            raise LipsyncError(f"对口型提交失败(status={rs.status_code})")
        try:
            task_id = str(rs.json().get("task_id") or "")
        except ValueError as e:
            raise LipsyncError("对口型提交响应非 JSON") from e
        if not task_id:
            raise LipsyncError("对口型提交响应缺 task_id")

        waited = 0.0
        degraded = False
        while waited < _POLL_TIMEOUT:
            try:
                st = await client.get(f"{base}/v1/lipsync/status/{task_id}", timeout=15.0)
            except httpx.HTTPError:
                await asyncio.sleep(_POLL_INTERVAL)
                waited += _POLL_INTERVAL
                continue
            if st.status_code != 200:
                await asyncio.sleep(_POLL_INTERVAL)
                waited += _POLL_INTERVAL
                continue
            try:
                payload = st.json()
            except ValueError:
                await asyncio.sleep(_POLL_INTERVAL)
                waited += _POLL_INTERVAL
                continue
            status = str(payload.get("status") or "")
            if status == "succeeded":
                degraded = bool(payload.get("degraded"))
                break
            if status == "failed":
                raise LipsyncError(f"对口型失败:{payload.get('message') or payload}")
            await asyncio.sleep(_POLL_INTERVAL)
            waited += _POLL_INTERVAL
        else:
            raise LipsyncError(f"对口型超时({_POLL_TIMEOUT:.0f}s)")
        if degraded:
            raise LipsyncError("对口型降级(未检出人脸/推理失败),不落假成片")

        try:
            rr = await client.get(f"{base}/v1/lipsync/result/{task_id}", timeout=60.0)
        except httpx.HTTPError as e:
            raise LipsyncError(f"对口型结果查询失败:{e}") from e
        if rr.status_code != 200:
            raise LipsyncError(f"对口型结果查询失败(status={rr.status_code})")
        try:
            video_url = str(rr.json().get("video_url") or "")
        except ValueError as e:
            raise LipsyncError("对口型结果非 JSON") from e
        if not video_url:
            raise LipsyncError("对口型结果缺 video_url")
        download = (
            video_url
            if video_url.startswith(("http://", "https://"))
            else base + (video_url if video_url.startswith("/") else "/" + video_url)
        )
        try:
            vr = await client.get(download, timeout=300.0)
        except httpx.HTTPError as e:
            raise LipsyncError(f"对口型产物下载失败:{e}") from e
        if vr.status_code != 200 or not vr.content:
            raise LipsyncError(f"对口型产物下载失败(status={vr.status_code})")
        return _save_clip(vr.content)


async def lipsync_video(shot: StudioShot, pool: "WorkerPool") -> str:
    """视频镜对口型:优先 HTTP LatentSync agent;未配置时回退 Comfy 节点。"""
    if not shot.video_url or not shot.voice_url:
        raise LipsyncError("需要先出视频并配音")
    from app.config import get_settings

    if get_settings().lipsync_url.strip():
        return await lipsync_via_agent(shot)

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
