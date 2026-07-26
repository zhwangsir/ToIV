"""GET /api/images —— 代理 ComfyUI /view。

取图韧性:产物由"生成它的那个 worker"写在本机输出目录,而同机(同 host)的其它
worker 共享同一目录。因此主 worker 掉线时,自动回退到同机存活的 worker 代取,
避免"worker 一死、已生成的图/视频就取不回"(此前的 502)。
"""
from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import User
from app.pathsafe import PathTraversalError, validate_path_component

router = APIRouter()


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


def _ranged_response(content: bytes, content_type: str, range_header: str | None) -> Response:
    """按 HTTP Range 返回。视频 <video> 必须拿 206 Partial + Accept-Ranges 才能播/拖动;
    裸 200 无 Accept-Ranges 会让浏览器媒体元素报 error 4(SRC_NOT_SUPPORTED)。
    产物已整段在内存,这里切片返回即可(体积不大);始终带 Accept-Ranges 声明支持 range。"""
    total = len(content)
    base = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"}
    if range_header and range_header.strip().startswith("bytes="):
        first = range_header.strip()[6:].split(",", 1)[0].strip()
        start_s, _, end_s = first.partition("-")
        try:
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else total - 1
        except ValueError:
            start, end = 0, total - 1
        start = max(0, start)
        end = min(end, total - 1)
        if start > end or start >= total:
            return Response(status_code=416, headers={**base, "Content-Range": f"bytes */{total}"})
        chunk = content[start : end + 1]
        return Response(
            content=chunk,
            status_code=206,
            media_type=content_type,
            headers={**base, "Content-Range": f"bytes {start}-{end}/{total}"},
        )
    return Response(content=content, media_type=content_type, headers=base)


@router.get("/images")
async def get_image(
    request: Request,
    filename: str,
    subfolder: str = "",
    type_: str = Query(default="output", alias="type"),
    worker: str = Query(...),
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
    try:
        safe_filename = validate_path_component(filename, allow_subdirs=False)
        safe_subfolder = validate_path_component(subfolder, allow_subdirs=True) if subfolder else ""
    except PathTraversalError as e:
        raise HTTPException(status_code=400, detail=f"非法路径: {e}") from e

    if not safe_filename:
        raise HTTPException(status_code=400, detail="filename 不能为空")

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
            content, content_type = await client.get_image_bytes(safe_filename, safe_subfolder, type_)
            # 视频/图片统一走 range 感知返回:视频靠 206+Accept-Ranges 才能播
            return _ranged_response(content, content_type, request.headers.get("range"))
        except ComfyUIError as e:
            last_err = e
    raise HTTPException(status_code=502, detail=f"产物暂不可取(同机 worker 均不可达): {last_err}")
