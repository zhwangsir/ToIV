"""模型市场代理 —— 服务端转发 Civitai / HuggingFace 搜索(避免 CORS,密钥留服务端)。

安装落地(2026-08-09 重构):弃用 worker 上的 ComfyUI-Manager 链路(策展白名单只收
目录模型、worker 选择漂移、无进度反馈),复用 /nas/download 作业管线——解析下载直链
→ 直落 NAS 模型库(worker 从 NAS 读,下完刷新即可用),进度走 GET /api/nas/download/{job_id}。
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.routes.nas_models import (
    NasDownloadRequest,
    require_admin,
    require_nas_ready,
    start_download_job,
)

router = APIRouter()

# Civitai 走可达镜像 civitai.red(civitai.com 在 CN 被墙);可用 env 覆盖。
# NSFW/成人模型需 API key 鉴权才能搜到/下载;key 走 env(TOIV_CIVITAI_API_KEY),不入仓库。
_CIVITAI = os.environ.get("TOIV_CIVITAI_API_BASE", "https://civitai.red/api/v1/models")
_CIVITAI_WEB = os.environ.get("TOIV_CIVITAI_WEB_BASE", "https://civitai.red")
_CIVITAI_KEY = os.environ.get("TOIV_CIVITAI_API_KEY", "")
_HF = "https://huggingface.co/api/models"
_HEADERS = {"User-Agent": "ToIV/0.1 (+https://github.com/zhwangsir/ToIV)"}


async def _get_json(url: str, params: dict, headers: dict | None = None):
    h = {**_HEADERS, **(headers or {})}
    async with httpx.AsyncClient(timeout=20.0, headers=h) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


def _civitai_item(it: dict) -> dict:
    thumb = None
    for version in it.get("modelVersions") or []:
        for img in version.get("images") or []:
            if img.get("url") and img.get("type", "image") == "image":
                thumb = img["url"]
                break
        if thumb:
            break
    return {
        "id": str(it.get("id")),
        "name": it.get("name"),
        "type": it.get("type"),
        "creator": (it.get("creator") or {}).get("username"),
        "thumbnail": thumb,
        "downloads": (it.get("stats") or {}).get("downloadCount"),
        "url": f"{_CIVITAI_WEB}/models/{it.get('id')}",
        "source": "civitai",
    }


def _hf_item(it: dict) -> dict:
    repo = it.get("id") or it.get("modelId") or ""
    return {
        "id": repo,
        "name": repo,
        "type": it.get("pipeline_tag") or "model",
        "creator": it.get("author") or (repo.split("/")[0] if "/" in repo else None),
        "thumbnail": None,
        "downloads": it.get("downloads"),
        "url": f"https://huggingface.co/{repo}",
        "source": "huggingface",
    }


@router.get("/marketplace/search")
async def search(
    source: str = Query(default="civitai"),
    query: str = "",
    type: str | None = None,
    nsfw: str = Query(default="false"),
    user: User = Depends(get_current_user),
) -> dict:
    # R18 门槛:与全站 jobs/presets 一致,读 X-NSFW 请求上下文(/nsfw 专页标记),
    # 不再看 User.nsfw_enabled(账户软开关已废弃,仅作历史记录保留,见 models.User)。
    effective_nsfw = nsfw if nsfw_allowed(user) else "false"
    try:
        if source == "civitai":
            params: dict = {"limit": 24, "sort": "Most Downloaded", "nsfw": effective_nsfw}
            if query:
                params["query"] = query
            if type:
                params["types"] = type
            headers = {"Authorization": f"Bearer {_CIVITAI_KEY}"} if _CIVITAI_KEY else None
            data = await _get_json(_CIVITAI, params, headers)
            items = [_civitai_item(i) for i in data.get("items", [])]
        elif source == "huggingface":
            params = {"limit": 24, "sort": "downloads", "direction": -1}
            if query:
                params["search"] = query
            data = await _get_json(_HF, params)
            rows = data if isinstance(data, list) else []
            items = [_hf_item(i) for i in rows]
        else:
            raise HTTPException(status_code=400, detail="未知模型来源")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"模型市场请求失败: {e}") from e
    return {"items": items, "source": source}


# --------------------------------------------------------------------------- #
# 模型安装落地 —— 复用 /nas/download 作业管线(直落 NAS 模型库)
# --------------------------------------------------------------------------- #

# 允许的下载来源主机白名单(防 SSRF / 任意写):仅这些域名的直链可下载。
# civitai.red 是 civitai.com 的可达镜像;hf-mirror 是 huggingface 的国内镜像。
_ALLOWED_DOWNLOAD_HOSTS: frozenset[str] = frozenset(
    {
        "civitai.com",
        "civitai.red",
        "huggingface.co",
        "hf-mirror.com",
    }
)

# 市场类型名(Civitai 原始大小写无关)→ NAS 下载类型词表(app.nas.subdir_for 落子目录)。
# 覆盖 Civitai 全部分类名:Checkpoint/LORA/LoCon/Controlnet/Upscaler/VAE/
# TextualInversion/Hypernetwork 等;旧链路只认小写枚举,Upscaler 等会被 400 误杀。
_MARKET_TYPE_MAP: dict[str, str] = {
    "checkpoint": "checkpoint",
    "checkpoints": "checkpoint",
    "lora": "lora",
    "loras": "lora",
    "locon": "lora",            # LyCORIS 经 LoRA 加载器使用,落 loras/
    "lycoris": "lora",
    "vae": "vae",
    "controlnet": "controlnet",
    "upscaler": "upscale",
    "upscale": "upscale",
    "upscale_models": "upscale",
    "textualinversion": "embeddings",
    "embedding": "embeddings",
    "embeddings": "embeddings",
    "hypernetwork": "hypernetworks",
    "hypernetworks": "hypernetworks",
    "clip": "clip",
    "clip_vision": "clip_vision",
    "unet": "unet",
    "diffusion_model": "diffusion_models",
    "diffusion_models": "diffusion_models",
    "ipadapter": "ipadapter",
}

# Civitai 模型页链接(/models/{id})不是下载直链;识别后转 source=civitai 经 API 解析。
_CIVITAI_WEB_PATH = re.compile(r"^/models/(\d+)/?$")
_CIVITAI_HOSTS = ("civitai.com", "civitai.red")


class InstallRequest(BaseModel):
    """模型安装入参。url 与 (source,id) 二选一;type 必填(Civitai 分类名大小写均可)。"""

    type: str
    url: str | None = None
    source: str | None = None
    id: str | None = None
    name: str | None = None
    filename: str | None = None
    base: str | None = None


def _validate_download_url(url: str) -> str:
    """校验直链:必须是 http(s) 且主机在白名单内(防 SSRF / 任意写)。返回规整后的 url。"""
    parsed = urlsplit(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="模型下载链接必须是 http(s)")
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(status_code=400, detail="模型下载链接缺少主机名")
    # 命中白名单主机或其子域(如 cdn.civitai.com)才放行。
    allowed = any(
        host == h or host.endswith(f".{h}") for h in _ALLOWED_DOWNLOAD_HOSTS
    )
    if not allowed:
        raise HTTPException(
            status_code=400,
            detail=f"下载来源 {host} 不在白名单内(仅允许 Civitai / HuggingFace 及其镜像)",
        )
    return parsed.geturl()


def _to_nas_request(req: InstallRequest) -> NasDownloadRequest:
    """把市场安装入参组装成 NAS 下载请求;同时完成 type 归一化与 url 白名单校验。

    source+id 优先(civitai/huggingface 经其 API 解析真实下载直链,自动带 token);
    裸 url 兜底(须白名单主机)。Civitai 模型页链接(/models/{id})自动转 civitai 解析。
    """
    model_type = req.type.strip().lower()
    nas_type = _MARKET_TYPE_MAP.get(model_type)
    if nas_type is None:
        allowed = ", ".join(sorted(set(_MARKET_TYPE_MAP)))
        raise HTTPException(
            status_code=400, detail=f"未知模型类型 {req.type!r};允许:{allowed}"
        )

    if req.source is not None and req.source not in ("civitai", "huggingface"):
        raise HTTPException(status_code=400, detail="未知模型来源")

    filename = os.path.basename(req.filename.strip()) if req.filename else ""
    name = (req.name or "").strip()

    # source+id:经 Civitai/HuggingFace API 解析下载直链(NSFW 自动带 token)
    if req.source == "civitai" and req.id:
        return NasDownloadRequest(
            source="civitai", id=req.id.strip(), name=name,
            type=nas_type, filename=filename,
        )
    if req.source == "huggingface" and req.id:
        # hf_file 可空 → nas_models._pick_hf_file 自动挑主权重文件
        return NasDownloadRequest(
            source="huggingface", id=req.id.strip(), hf_file=filename,
            type=nas_type, filename=filename,
        )

    if req.url:
        url = _validate_download_url(req.url)
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        m = _CIVITAI_WEB_PATH.match(parsed.path)
        if m and any(host == h or host.endswith(f".{h}") for h in _CIVITAI_HOSTS):
            # Civitai 模型页链接(非 /api/download/ 直链)→ 转 civitai id 解析
            return NasDownloadRequest(
                source="civitai", id=m.group(1), name=name,
                type=nas_type, filename=filename,
            )
        return NasDownloadRequest(
            source="url", url=url, type=nas_type, filename=filename,
        )

    raise HTTPException(
        status_code=400, detail="缺少安装目标:需提供 url,或 (source=civitai|huggingface, id)"
    )


@router.post("/marketplace/install")
async def install(
    req: InstallRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """把搜到的模型下载到 NAS 模型库(全集群 worker 共享,下完刷新即可用)。

    返回 job_id;进度轮询 GET /api/nas/download/{job_id}。仅管理员(写共享模型库)。
    """
    require_admin(user)
    nas_req = _to_nas_request(req)  # 校验入参(type 归一化 / url 白名单)
    require_nas_ready()
    result = start_download_job(nas_req, user, session)
    return {
        "accepted": True,
        **result,
        "message": f"已开始下载到 NAS 模型库({nas_req.type}),完成后各 worker 自动可用",
    }
