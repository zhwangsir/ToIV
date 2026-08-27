"""POST /api/manju/shot/lipsync —— 对口型:让分镜视频角色嘴型对上配音(LatentSync 1.6)。

源视频(分镜 i2v 产物)+ 配音(TTS)→ 下载到选中 worker 的 input → LatentSync 工作流 →
口型同步成片。异步 Job + tracker 落库(同出图/转视频)。成片不含独立对白轨,
故前端把产物作 videoUrl(配音仍由成片对白轨提供,口型与语音对齐)。

注:LatentSync 自带人脸检测;写实层效果好,动漫脸可能不稳(模型局限)。
worker 侧需:已下 ByteDance/LatentSync-1.6 模型 + 写视频走 av 兜底(见 deploy/lipsync-setup.md)。
"""
from __future__ import annotations

import uuid
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.versioning import params_snapshot
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph

router = APIRouter()

_DOWNLOAD_TIMEOUT = 120.0


class LipsyncRequest(BaseModel):
    video_url: str = Field(min_length=1, max_length=2000)  # 源分镜视频
    voice_url: str = Field(min_length=1, max_length=2000)  # 该镜配音
    lips_expression: float = Field(default=1.5, ge=1.0, le=3.0)
    inference_steps: int = Field(default=20, ge=1, le=50)
    # 采样种子:缺省随机;rerun keep 锁 seed 时精确复现口型采样
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


def _allowed(url: str) -> bool:
    """来源白名单:相对路径 / 白名单 worker / 本机 API 端口,防 SSRF。

    回环(127.0.0.1/localhost)不再全端口通配——否则本端点即成内网打点通道
    (如 http://127.0.0.1:6379 打 Redis);仅放行本 API 自身端口
    (相对路径已由 _resolve 覆盖,此处兜同源绝对 URL 回链)。"""
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    s = get_settings()
    allowed = {urlsplit(w).hostname for w in s.worker_urls if urlsplit(w).hostname}
    if host in allowed:
        return True
    if host in {"127.0.0.1", "localhost"}:
        api = urlsplit(s.api_base_url)
        api_port = api.port or (443 if api.scheme == "https" else 80)
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:  # 非法端口
            return False
        return port == api_port
    return False


def _check_redirect(resp: httpx.Response, initial_url: str) -> None:
    """重定向复验(follow_redirects 下载):最终落点须仍过白名单或与初始
    (已验)URL 同源,否则 400——防白名单内地址开放重定向绕过 SSRF 检查。"""
    final = str(resp.url)
    if final == initial_url:
        return
    f, i = urlsplit(final), urlsplit(initial_url)
    if f.scheme == i.scheme and f.netloc.lower() == i.netloc.lower():
        return
    if not _allowed(final):
        raise HTTPException(status_code=400, detail="重定向目标不在白名单内")


def _resolve(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


@router.post("/manju/shot/lipsync")
async def lipsync_shot(
    req: LipsyncRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    for u in (req.video_url, req.voice_url):
        if not _allowed(u):
            raise HTTPException(status_code=400, detail="来源不在白名单内")

    # 选 worker(4 进程共享 LatentSync 安装,任一可)
    try:
        client = await pool.pick(required=set())
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    # 下载源视频 + 配音(跟随重定向后逐回复验最终落点)
    v_url, a_url = _resolve(req.video_url), _resolve(req.voice_url)
    async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as http:
        try:
            v = await http.get(v_url)
            _check_redirect(v, v_url)
            v.raise_for_status()
            a = await http.get(a_url)
            _check_redirect(a, a_url)
            a.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"源下载失败:{e}") from e
    if not v.content or not a.content:
        raise HTTPException(status_code=502, detail="源视频或配音为空")

    # 上传到 worker input
    try:
        vfn = await client.upload_image(v.content, f"lipsync_src_{uuid.uuid4().hex}.mp4")
        afn = await client.upload_image(a.content, f"lipsync_voice_{uuid.uuid4().hex}.wav")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"上传 worker 失败:{e}") from e

    # 建图 + 入队 + Job + tracker
    params = LatentSyncParams(
        video=vfn, audio=afn,
        lips_expression=req.lips_expression, inference_steps=req.inference_steps,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_latentsync_graph(params)
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind="manju_lipsync",
            status="queued",
            prompt="对口型",
            seed=params.seed,
            # 快照存 URL 源(重生时重新下载,不依赖 worker 临时文件)+ 实际 seed(锁 seed 复现)
            params=params_snapshot(req, seed=params.seed),
        )
    )
    session.commit()
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
        "mode": "manju_lipsync",
    }
