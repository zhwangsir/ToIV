"""GET /api/images —— 代理 ComfyUI /view。

取图韧性:产物由"生成它的那个 worker"写在本机输出目录,而同机(同 host)的其它
worker 共享同一目录。因此主 worker 掉线时,自动回退到同机存活的 worker 代取,
避免"worker 一死、已生成的图/视频就取不回"(此前的 502)。
"""
from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import User

router = APIRouter()


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


@router.get("/images")
async def get_image(
    filename: str,
    subfolder: str = "",
    type_: str = Query(default="output", alias="type"),
    worker: str = Query(...),
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
    primary = resolve_worker(worker)  # SSRF 白名单校验
    host = _host(primary.base_url)
    # 同机其它 worker 共享同一输出目录,可作为主 worker 掉线时的回退
    siblings = [
        c for c in pool.clients
        if _host(c.base_url) == host and c.base_url != primary.base_url
    ]
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, content_type = await client.get_image_bytes(filename, subfolder, type_)
            return Response(
                content=content,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
        except ComfyUIError as e:
            last_err = e
    raise HTTPException(status_code=502, detail=f"产物暂不可取(同机 worker 均不可达): {last_err}")
