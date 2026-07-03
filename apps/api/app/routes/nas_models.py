"""模型下载到 NAS —— 绕过 ComfyUI-Manager 策展白名单,任意 URL / HuggingFace 直下到
NAS 的 ComfyUI models 目录(worker 从 NAS 读,下完刷新即可用)。

修复:此前"模型库下载"走 ComfyUI-Manager install_model,非策展模型被 400 拒。
现在下载→临时文件→SFTP 上传 NAS。仅管理员可用。
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
import uuid
from urllib.parse import unquote, urlsplit

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import nas
from app.config import get_settings
from app.deps import get_current_user
from app.models import User

logger = logging.getLogger(__name__)
router = APIRouter()

_jobs: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()
_JOBS_KEEP = 30


def _require_admin(user: User) -> None:
    if getattr(user, "role", "") != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可下载模型")


def _prune() -> None:
    if len(_jobs) <= _JOBS_KEEP:
        return
    done = sorted((j for j in _jobs.values() if j["status"] in ("done", "error")),
                  key=lambda j: j["started"])
    for j in done[: len(_jobs) - _JOBS_KEEP]:
        _jobs.pop(j["id"], None)


class NasDownloadRequest(BaseModel):
    source: str = Field(default="url", pattern="^(url|hf)$")
    url: str = Field(default="", max_length=1000)  # source=url
    hf_repo: str = Field(default="", max_length=200)  # source=hf,如 black-forest-labs/FLUX.1-dev
    hf_file: str = Field(default="", max_length=300)  # repo 内文件路径
    type: str = Field(default="checkpoint", max_length=40)  # checkpoint/lora/vae/...
    filename: str = Field(default="", max_length=200)  # 空则从 url/hf_file 推断


def _infer_filename(req: NasDownloadRequest) -> str:
    if req.filename.strip():
        return os.path.basename(req.filename.strip())
    if req.source == "hf" and req.hf_file:
        return os.path.basename(req.hf_file)
    if req.url:
        return unquote(os.path.basename(urlsplit(req.url).path)) or "model.safetensors"
    return "model.safetensors"


def _download_url(url: str, dest: str, job: dict) -> None:
    """流式下载 URL 到本地 dest,按 content-length 报进度。"""
    with requests.get(url, stream=True, timeout=(30, 300)) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        got = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if not chunk:
                    continue
                f.write(chunk)
                got += len(chunk)
                if total:
                    job["progress"] = int(got / total * 50)  # 下载占前 50%
                job["downloaded_mb"] = round(got / 1024 / 1024, 1)


def _download_hf(repo: str, file: str, tmp_dir: str) -> str:
    """HuggingFace 单文件下载(走 HF_ENDPOINT 镜像),返回本地路径。"""
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=repo, filename=file, local_dir=tmp_dir)


def _run_blocking(req: NasDownloadRequest, filename: str, job: dict) -> str:
    """阻塞:下载 → SFTP 上传 NAS。放线程跑。返回 NAS 远端路径。"""
    with tempfile.TemporaryDirectory(prefix="nasdl-") as tmp:
        if req.source == "hf":
            job["stage"] = "从 HuggingFace 下载"
            local = _download_hf(req.hf_repo, req.hf_file, tmp)
        else:
            job["stage"] = "下载中"
            local = os.path.join(tmp, filename)
            _download_url(req.url, local, job)
        size_mb = round(os.path.getsize(local) / 1024 / 1024, 1)
        job["downloaded_mb"] = size_mb
        job["stage"] = "上传到 NAS"
        job["progress"] = 50

        def _up(sent: int, total: int) -> None:
            if total:
                job["progress"] = 50 + int(sent / total * 50)  # 上传占后 50%

        return nas.upload_model(local, req.type, filename, on_progress=_up)


async def _run_download(req: NasDownloadRequest, filename: str, job: dict) -> None:
    try:
        remote = await asyncio.to_thread(_run_blocking, req, filename, job)
    except Exception as e:  # noqa: BLE001
        logger.warning("NAS 下载 %s 失败:%s", job["id"], e)
        job["status"], job["error"] = "error", f"下载失败:{e}"
        return
    job["remote"] = remote
    job["progress"] = 100
    job["stage"] = "完成"
    job["elapsed"] = round(time.monotonic() - job["started"], 1)
    job["status"] = "done"


@router.get("/nas/status")
async def nas_status(user: User = Depends(get_current_user)) -> dict[str, object]:
    """NAS 连通性 + 模型根目录信息(前端判断是否启用 NAS 下载)。"""
    s = get_settings()
    if not s.nas_enabled:
        return {"enabled": False}
    try:
        info = await asyncio.to_thread(nas.check_connection)
        return {"enabled": True, **info}
    except Exception as e:  # noqa: BLE001
        return {"enabled": True, "ok": False, "error": str(e)}


@router.post("/nas/download")
async def nas_download(
    body: NasDownloadRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """起模型下载→NAS 后台作业。轮询 GET /nas/download/{job}。"""
    _require_admin(user)
    if not get_settings().nas_enabled:
        raise HTTPException(status_code=503, detail="NAS 未配置")
    if body.source == "hf" and not (body.hf_repo and body.hf_file):
        raise HTTPException(status_code=400, detail="HuggingFace 下载需 hf_repo + hf_file")
    if body.source == "url" and not body.url:
        raise HTTPException(status_code=400, detail="缺少下载 URL")
    filename = _infer_filename(body)

    job_id = uuid.uuid4().hex
    job = {"id": job_id, "status": "running", "stage": "排队", "progress": 0,
           "downloaded_mb": 0.0, "remote": None, "error": None,
           "filename": filename, "type": body.type,
           "started": time.monotonic(), "elapsed": 0.0}
    _jobs[job_id] = job
    _prune()
    task = asyncio.create_task(_run_download(body, filename, job))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"job_id": job_id, "filename": filename}


@router.get("/nas/download/{job_id}")
async def nas_download_status(job_id: str, user: User = Depends(get_current_user)) -> dict[str, object]:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {k: job[k] for k in ("id", "status", "stage", "progress", "downloaded_mb",
                                "remote", "error", "filename", "type", "elapsed")}
