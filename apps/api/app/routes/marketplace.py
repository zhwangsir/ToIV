"""模型市场代理 —— 服务端转发 Civitai / HuggingFace 搜索(避免 CORS,密钥留服务端)。

下载落地(写入 worker 文件系统 / 经 ComfyUI-Manager)留待后续接入。
"""
from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.deps import get_current_user
from app.models import User

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
    # R18 软门槛:nsfw 参数仅当用户已开 R18 时才生效,否则服务端强制 "false"。
    effective_nsfw = nsfw if user.nsfw_enabled else "false"
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
