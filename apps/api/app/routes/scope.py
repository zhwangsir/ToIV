"""POST /api/scope/generate —— SCoPE 相机运镜视频(腾讯 ARC,Wan2.2-A14B + 视线坐标编码)。

链路:首帧图(image_url 相对路径/白名单 URL,或 image_base64 内联)+ prompt +
轨迹预设 → core 后台任务调 workstation SCoPE 服务(:9401,模型常驻 + 串行队列)
→ mp4 落 content_subdir("scope") → Job(kind=scope_camera) 建档,前端经 /api/jobs 回读。

服务契约见 deploy/scope-service/toiv_scope_server.py:POST /generate 同步返回
mp4 二进制(40 步实测 ~11min,超时经 scope_timeout_sec 配置),非 200 透传 detail。

后台任务是进程内的:api 重启后 queued/running 的 scope 作业由
reconcile_interrupted()(挂 main lifespan)标 error,不静默假 done。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import uuid
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.images import _ranged_response
from app.storage import content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

_PROBE_TIMEOUT = 5.0
_DOWNLOAD_TIMEOUT = 120.0
_OUT_NAME_RE = re.compile(r"^scope-[0-9a-f]{32}\.mp4$")
_MAX_IMAGE_BYTES = 30 * 1024 * 1024  # 与服务端上限一致
_BG_TASKS: set[asyncio.Task] = set()


class ScopeGenerateRequest(BaseModel):
    image_url: str | None = Field(default=None, max_length=2000)  # 相对路径或白名单 URL
    image_base64: str | None = Field(default=None, max_length=45_000_000)  # 可带 data URL 头
    prompt: str = Field(min_length=1, max_length=4000)
    trajectory: str = Field(min_length=1, max_length=200)  # GET /api/scope/trajectories 枚举
    seed: int = Field(default=42, ge=0, le=2**63 - 1)
    steps: int = Field(default=40, ge=1, le=40)  # e2e/调试用小步数
    x_fov: float = Field(default=1.11847, gt=0.0, lt=3.2)


def _base() -> str:
    return get_settings().scope_base_url.strip().rstrip("/")


def _check_enabled() -> None:
    if not _base():
        raise HTTPException(status_code=503, detail="SCoPE 运镜引擎未配置")


def _allowed(url: str) -> bool:
    """来源白名单:相对路径 / 白名单 worker / 本机,防 SSRF(同 lipsync.py)。"""
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    s = get_settings()
    allowed = {urlsplit(w).hostname for w in s.worker_urls if urlsplit(w).hostname}
    return host in allowed or host in {"127.0.0.1", "localhost"}


def _resolve(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


async def _fetch_image_b64(req: ScopeGenerateRequest) -> str:
    """首帧图 → base64(image_url 下载或 image_base64 透传,统一尺寸上限)。"""
    if req.image_url and req.image_base64:
        raise HTTPException(status_code=400, detail="image_url 与 image_base64 只能传一个")
    if req.image_base64:
        b64 = req.image_base64
        if "," in b64 and b64.split(",", 1)[0].startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64, validate=True)
        except ValueError as e:  # binascii.Error 是 ValueError 子类
            raise HTTPException(status_code=400, detail=f"image_base64 解码失败:{e}") from e
        if not raw or len(raw) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="首帧图为空或超过 30MB 上限")
        return b64
    if req.image_url:
        if not _allowed(req.image_url):
            raise HTTPException(status_code=400, detail="首帧图来源不在白名单内")
        try:
            async with httpx.AsyncClient(
                timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, trust_env=False
            ) as client:
                resp = await client.get(_resolve(req.image_url))
                resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"首帧图下载失败:{e}") from e
        if not resp.content or len(resp.content) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="首帧图为空或超过 30MB 上限")
        return base64.b64encode(resp.content).decode("ascii")
    raise HTTPException(status_code=400, detail="必须提供 image_url 或 image_base64")


def _write_output(content: bytes) -> tuple[str, str]:
    """产物落 content_subdir('scope'),返回 (文件名, URL)。"""
    name = f"scope-{uuid.uuid4().hex}.mp4"
    root = content_subdir("scope")
    root.mkdir(parents=True, exist_ok=True)
    (root / name).write_bytes(content)
    return name, f"/api/scope/files/{name}"


def _set_job(prompt_id: str, status: str, urls: list[str] | None = None) -> None:
    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None:
            return
        job.status = status
        if urls is not None:
            job.result = json.dumps(urls, ensure_ascii=False)
        s.add(job)
        s.commit()


async def _run_job(prompt_id: str, payload: dict[str, object]) -> None:
    """后台任务:调 SCoPE 服务 → 产物落盘 → Job 收口(同 video_upscale 模式)。"""
    timeout = get_settings().scope_timeout_sec
    _set_job(prompt_id, "running")
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.post(f"{_base()}/generate", json=payload)
    except httpx.TimeoutException:
        logger.warning("SCoPE 生成超时(>%.0fs): %s", timeout, prompt_id)
        _set_job(prompt_id, "error")
        return
    except httpx.HTTPError as e:
        logger.warning("SCoPE 服务不可达: %s", e)
        _set_job(prompt_id, "error")
        return
    if resp.status_code != 200:
        detail = ""
        try:
            detail = resp.json().get("detail", "")
        except (ValueError, KeyError, AttributeError):
            detail = (resp.text or "")[:200]
        logger.warning("SCoPE 生成失败 status=%d: %s", resp.status_code, detail)
        _set_job(prompt_id, "error")
        return
    if not resp.content or len(resp.content) < 100:
        logger.warning("SCoPE 返回空产物: %s", prompt_id)
        _set_job(prompt_id, "error")
        return
    try:
        _, url = await asyncio.to_thread(_write_output, resp.content)
    except OSError as e:
        logger.warning("SCoPE 产物落盘失败: %s", e)
        _set_job(prompt_id, "error")
        return
    _set_job(prompt_id, "done", [url])


def spawn_scope_job(prompt_id: str, payload: dict[str, object]) -> asyncio.Task:
    """fire-and-forget(持强引用防 GC;同 prompt_id 幂等,同 video_upscale.spawn_upscale)。"""
    key = f"scope-camera:{prompt_id}"
    for t in _BG_TASKS:
        if t.get_name() == key and not t.done():
            return t
    task = asyncio.create_task(_run_job(prompt_id, payload), name=key)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


def reconcile_interrupted() -> int:
    """api 重启后,进程内后台任务已丢:queued/running 的 scope 作业标 error(不造假)。"""
    from app.db import engine

    with Session(engine) as s:
        jobs = s.exec(
            select(Job).where(
                Job.kind == "scope_camera", Job.status.in_(("queued", "running"))
            )
        ).all()
        for job in jobs:
            job.status = "error"
            s.add(job)
        s.commit()
    if jobs:
        logger.info("SCoPE 中断作业收口: %d 个标 error", len(jobs))
    return len(jobs)


# ---------- 端点 ----------


@router.get("/scope/status")
async def scope_status(user: User = Depends(get_current_user)) -> dict[str, object]:
    """探活:enabled + reachable + 服务侧 busy/预设数(5s 超时快速降级)。"""
    base = _base()
    if not base:
        return {"enabled": False, "reachable": False}
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT, trust_env=False) as client:
            r = await client.get(f"{base}/health")
        info: dict[str, object] = {"enabled": True, "reachable": r.status_code == 200}
        if r.status_code == 200:
            payload = r.json()
            info["busy"] = payload.get("busy")
            info["trajectories"] = payload.get("trajectories")
        return info
    except httpx.HTTPError:
        return {"enabled": True, "reachable": False}


@router.get("/scope/trajectories")
async def scope_trajectories(user: User = Depends(get_current_user)) -> dict[str, object]:
    """轨迹预设枚举(代理 SCoPE 服务,失败 502)。"""
    _check_enabled()
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT, trust_env=False) as client:
            r = await client.get(f"{_base()}/trajectories")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"SCoPE 服务不可达:{e}") from e
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"SCoPE 服务返回 {r.status_code}")
    return r.json()


@router.post("/scope/generate")
async def scope_generate(
    req: ScopeGenerateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """提交运镜生成:建档 Job(kind=scope_camera, queued)后后台执行,前端轮询 /api/jobs。"""
    _check_enabled()
    enforce_generation_rate_limit(user)
    image_b64 = await _fetch_image_b64(req)

    prompt_id = f"scope-{uuid.uuid4().hex}"
    payload: dict[str, object] = {
        "image_base64": image_b64,
        "prompt": req.prompt,
        "trajectory": req.trajectory,
        "seed": req.seed,
        "steps": req.steps,
        "x_fov": req.x_fov,
    }
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=_base(),
            kind="scope_camera",
            status="queued",
            prompt=req.prompt[:500],
            seed=req.seed,
            params=json.dumps(
                {
                    "trajectory": req.trajectory,
                    "steps": req.steps,
                    "x_fov": req.x_fov,
                    "image_url": req.image_url,  # 快照存 URL 源(同 lipsync 纪律)
                },
                ensure_ascii=False,
            ),
        )
    )
    session.commit()
    spawn_scope_job(prompt_id, payload)
    return {"prompt_id": prompt_id, "kind": "scope_camera", "status": "queued"}


@router.get("/scope/files/{name}")
async def get_scope_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    """回读运镜产物(手动 Range,同 audio_orchestrate 文件服务)。"""
    if not _OUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = content_subdir("scope") / name
    try:
        if path.is_file():
            return _ranged_response(
                path.read_bytes(), "video/mp4", request.headers.get("range")
            )
    except OSError as e:
        logger.warning("SCoPE 产物目录不可达:%s", e)
    raise HTTPException(status_code=404, detail="运镜产物不存在")
