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
from pathlib import Path
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

# 复用 marketplace 的源(Civitai 走 civitai.red 镜像;HF 走 hf-mirror 镜像;key 走 env)
_CIVITAI = os.environ.get("TOIV_CIVITAI_API_BASE", "https://civitai.red/api/v1/models")
_CIVITAI_KEY = os.environ.get("TOIV_CIVITAI_API_KEY", "")
_HF_BASE = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
_HF_API = f"{_HF_BASE}/api/models"
_WEIGHT_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf")


# mirror(civitai.red)host:下载链须走 mirror 才能用 mirror key 鉴权。
# API 有时返回指向 civitai.com 的 downloadUrl(如 LUSTIFY),对 mirror key 会 401 —— 统一改写。
_CIVITAI_HOST = urlsplit(_CIVITAI).netloc


def _to_mirror(url: str) -> str:
    """把下载直链的 host 改写成 mirror host,使 mirror key 生效(避免落到 civitai.com 401)。"""
    parts = urlsplit(url)
    if _CIVITAI_HOST and parts.netloc and parts.netloc != _CIVITAI_HOST:
        return parts._replace(netloc=_CIVITAI_HOST).geturl()
    return url


def _resolve_civitai(model_id: str) -> tuple[str, str]:
    """Civitai 模型 id → 最新版本主文件的下载直链 + 文件名。"""
    h = {"Authorization": f"Bearer {_CIVITAI_KEY}"} if _CIVITAI_KEY else {}
    r = requests.get(f"{_CIVITAI}/{model_id}", headers=h, timeout=30)
    r.raise_for_status()
    versions = r.json().get("modelVersions") or []
    if not versions:
        raise RuntimeError("Civitai 模型无可用版本")
    files = versions[0].get("files") or []
    f = next((x for x in files if x.get("primary")), files[0] if files else None)
    if not f or not f.get("downloadUrl"):
        raise RuntimeError("Civitai 版本无可下载文件")
    url = _to_mirror(f["downloadUrl"])
    if _CIVITAI_KEY and "token=" not in url:
        url += ("&" if "?" in url else "?") + f"token={_CIVITAI_KEY}"
    return url, (f.get("name") or unquote(os.path.basename(urlsplit(url).path)))


def _pick_hf_file(repo: str, want: str = "") -> str:
    """HuggingFace 仓库 → 主权重文件仓内路径(优先 .safetensors、体积最小的顶层文件)。"""
    if want.strip():
        return want.strip()
    r = requests.get(f"{_HF_API}/{repo.strip().strip('/')}", timeout=30)
    r.raise_for_status()
    sibs = [s.get("rfilename", "") for s in (r.json().get("siblings") or [])]
    cand = [s for s in sibs if s.lower().endswith(_WEIGHT_EXT)]
    if not cand:
        raise RuntimeError("HuggingFace 仓库内无可下载权重文件")
    # 优先 .safetensors,再按路径浅、名短
    cand.sort(key=lambda s: (0 if s.lower().endswith(".safetensors") else 1, s.count("/"), len(s)))
    return cand[0]

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
    # url=直链 | hf=显式 repo+file | civitai/huggingface=模型库卡片(服务端解析下载链)
    source: str = Field(default="url", pattern="^(url|hf|civitai|huggingface)$")
    url: str = Field(default="", max_length=1000)  # source=url
    id: str = Field(default="", max_length=200)  # source=civitai/huggingface:模型 id / 仓库
    hf_repo: str = Field(default="", max_length=200)  # source=hf 显式仓库
    hf_file: str = Field(default="", max_length=300)  # repo 内文件路径(huggingface 可空=自动挑主文件)
    type: str = Field(default="checkpoint", max_length=40)  # checkpoint/lora/vae/...
    filename: str = Field(default="", max_length=200)  # 空则解析/推断


def _resolve(req: NasDownloadRequest) -> tuple[str, str]:
    """把请求解析成 (下载直链 url, 文件名)。civitai/huggingface 走 API 解析。"""
    if req.source == "civitai":
        if not req.id:
            raise RuntimeError("缺少 Civitai 模型 id")
        return _resolve_civitai(req.id)
    if req.source == "huggingface":
        repo = req.id.strip().strip("/")
        if not repo:
            raise RuntimeError("缺少 HuggingFace 仓库")
        file = _pick_hf_file(repo, req.hf_file)
        return f"{_HF_BASE}/{repo}/resolve/main/{file}", os.path.basename(file)
    if req.source == "hf":
        repo = req.hf_repo.strip().strip("/")
        return (
            f"{_HF_BASE}/{repo}/resolve/main/{req.hf_file}",
            os.path.basename(req.hf_file),
        )
    # url
    return req.url, (unquote(os.path.basename(urlsplit(req.url).path)) or "model.safetensors")


def _download_url(url: str, dest: str, job: dict) -> None:
    """流式下载 URL 到 dest(可为 cifs 挂载路径,直落 NAS),按 content-length 报进度 0-100。"""
    with requests.get(url, stream=True, timeout=(30, 600)) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        got = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=4 << 20):  # 4MB 块,大文件更省 syscall
                if not chunk:
                    continue
                f.write(chunk)
                got += len(chunk)
                if total:
                    job["progress"] = int(got / total * 100)
                job["downloaded_mb"] = round(got / 1024 / 1024, 1)


def _run_blocking(req: NasDownloadRequest, job: dict) -> str:
    """阻塞:解析下载链 → 直接流式下载到 cifs 挂载的 NAS models 目录(免临时/免 SFTP)。
    cifs 不可用时回退到"下临时→SFTP 上传"。返回落盘路径。"""
    job["stage"] = "解析下载地址"
    url, filename = _resolve(req)
    if req.filename.strip():
        filename = os.path.basename(req.filename.strip())
    job["filename"] = filename

    s = get_settings()
    mount = Path(s.nas_models_mount)
    if mount.is_dir():
        # 直落 NAS(内核 cifs 走 LAN 满速);先写 .part 再改名,避免 ComfyUI 读半成品
        dest_dir = mount / nas.subdir_for(req.type)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename
        part = dest.with_name(dest.name + ".part")
        job["stage"] = "下载到 NAS"
        _download_url(url, str(part), job)
        if dest.exists():
            dest.unlink()
        part.rename(dest)
        job["downloaded_mb"] = round(dest.stat().st_size / 1024 / 1024, 1)
        return str(dest)

    # 回退:cifs 未挂 → 下临时再 SFTP 传
    with tempfile.TemporaryDirectory(prefix="nasdl-") as tmp:
        job["stage"] = "下载中"
        local = os.path.join(tmp, filename)
        _download_url(url, local, job)
        job["downloaded_mb"] = round(os.path.getsize(local) / 1024 / 1024, 1)
        job["stage"] = "上传到 NAS"
        return nas.upload_model(local, req.type, filename)


async def _run_download(req: NasDownloadRequest, job: dict) -> None:
    try:
        remote = await asyncio.to_thread(_run_blocking, req, job)
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
    if body.source in ("civitai", "huggingface") and not body.id:
        raise HTTPException(status_code=400, detail="缺少模型 id / 仓库")
    # 文件名在后台线程里解析(civitai/huggingface 需查 API);先占位。
    filename = os.path.basename(body.filename.strip()) if body.filename.strip() else "…解析中"

    job_id = uuid.uuid4().hex
    job = {"id": job_id, "status": "running", "stage": "排队", "progress": 0,
           "downloaded_mb": 0.0, "remote": None, "error": None,
           "filename": filename, "type": body.type,
           "started": time.monotonic(), "elapsed": 0.0}
    _jobs[job_id] = job
    _prune()
    task = asyncio.create_task(_run_download(body, job))
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
