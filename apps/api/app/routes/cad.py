"""CAD 工程图 → AI 设计:上传 DWG/DXF/图 → 转换线稿 + 几何 → ControlNet 出全套设计图。

- POST /cad/upload    multipart(file)→ 服务端转换 → {control_url, geometry, width, height}
- POST /cad/render    json(control_url, preset, space, style)→ ComfyUI 渲染(异步 Job + tracker)
- POST /cad/axon      json(geometry)→ 服务端渲轴测/3D 体量图 → {url}
- GET  /cad/file/{name}  取线稿 / 轴测图

对标暗壳AI:preset ∈ colored_plan / aerial_day|dusk|night / interior。
"""
from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.cad.convert import convert
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.cad_design import PRESETS, CadParams, build_cad_graph

router = APIRouter()

_CAD_DIR = (
    Path("/data") / "cad" if Path("/data").is_dir()
    else Path(tempfile.gettempdir()) / "toiv-cad"
)
_NAME_RE = __import__("re").compile(r"^cad-[0-9a-f]{32}\.png$")
_MAX_BYTES = 60 * 1024 * 1024  # 图纸上限 60MB
_DL_TIMEOUT = 120.0
_LOCAL_API = "http://127.0.0.1:8080"


class RenderRequest(BaseModel):
    control_url: str = Field(min_length=1, max_length=2000)
    preset: str = Field(default="aerial_day")
    space: str = Field(default="modern data center facility", max_length=200)
    style: str = Field(default="", max_length=120)
    width: int = Field(default=1344, ge=512, le=2048)
    height: int = Field(default=768, ge=512, le=2048)


class AxonRequest(BaseModel):
    geometry: dict


def _allowed(url: str) -> bool:
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
    return _LOCAL_API + (url if url.startswith("/") else "/" + url)


def _cad_local_name(url: str) -> str | None:
    """若 url 指向本服务的 CAD 文件端点,返回其文件名(供直接读盘,免鉴权 HTTP 回拉)。"""
    path = urlsplit(url).path if "://" in url else url
    prefix = "/api/cad/file/"
    if path.startswith(prefix):
        name = path[len(prefix):]
        if _NAME_RE.match(name):
            return name
    return None


async def _load_control_bytes(url: str) -> bytes:
    """取控制图字节。

    本服务上传产生的 CAD 线稿直接读盘 —— 回拉自身鉴权端点 /cad/file/{name} 会 401
    (内部请求无 token),且多一次网络往返。其余来源(worker 产物等)走白名单 HTTP 下载。
    """
    name = _cad_local_name(url)
    if name:
        path = _CAD_DIR / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="控制图不存在(可能已过期),请重新上传图纸")
        return path.read_bytes()
    async with httpx.AsyncClient(timeout=_DL_TIMEOUT, follow_redirects=True) as http:
        try:
            r = await http.get(_resolve(url))
            r.raise_for_status()
            return r.content
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"控制图下载失败:{e}") from e


@router.post("/cad/upload")
def cad_upload(file: UploadFile, user: User = Depends(get_current_user)) -> dict:
    """上传 DWG/DXF/图 → 服务端转换为干净线稿 + 几何(同步,跑在 threadpool)。"""
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if len(content) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="图纸过大(上限 60MB)")
    ext = Path(file.filename or "x.dwg").suffix.lower() or ".dwg"
    _CAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"cad-{uuid.uuid4().hex}.png"
    out = _CAD_DIR / name
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tf:
        tf.write(content)
        src = Path(tf.name)
    try:
        res = convert(src, out)
    except Exception as e:  # noqa: BLE001 — 转换失败给清晰提示
        raise HTTPException(status_code=422, detail=f"图纸转换失败:{e}") from e
    finally:
        try:
            src.unlink()
        except OSError:
            pass
    return {
        "control_url": f"/api/cad/file/{name}",
        "geometry": res.geometry,
        "width": res.width,
        "height": res.height,
        "n_segments": res.n_segments,
    }


@router.post("/cad/render")
async def cad_render(
    body: RenderRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """控制图 → ComfyUI ControlNet/​text2img 出设计图(异步 Job,前端轮询)。"""
    enforce_generation_rate_limit(user)
    if body.preset not in PRESETS:
        raise HTTPException(status_code=422, detail=f"未知 preset;可选 {tuple(PRESETS)}")
    needs_control = PRESETS[body.preset]["control"]
    if needs_control and not _allowed(body.control_url):
        raise HTTPException(status_code=400, detail="控制图来源不在白名单内")

    try:
        client = await pool.pick(required=set())
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    control_fn = ""
    if needs_control:
        content = await _load_control_bytes(body.control_url)
        try:
            control_fn = await client.upload_image(content, f"cad_ctrl_{uuid.uuid4().hex}.png")
        except ComfyUIError as e:
            raise HTTPException(status_code=502, detail=f"上传 worker 失败:{e}") from e

    params = CadParams(
        preset=body.preset, control_image=control_fn, space=body.space,
        style=body.style, width=body.width, height=body.height,
    )
    graph = build_cad_graph(params)
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    session.add(Job(
        tenant_id=user.tenant_id, user_id=user.id, prompt_id=prompt_id,
        worker=client.base_url, kind=f"cad_{body.preset}", status="queued",
        prompt=body.preset, seed=params.seed,
    ))
    session.commit()
    spawn_tracker(client, prompt_id)
    return {"prompt_id": prompt_id, "client_id": client_id, "worker": client.base_url, "mode": f"cad_{body.preset}"}


@router.post("/cad/axon")
def cad_axon(body: AxonRequest, user: User = Depends(get_current_user)) -> dict:
    """几何 → 服务端渲轴测/3D 体量图(matplotlib,同步 threadpool)。"""
    geo = body.geometry or {}
    if not geo.get("walls") and not geo.get("racks"):
        raise HTTPException(status_code=422, detail="无墙体/设备几何(图片输入无 3D)")
    from app.cad.axon import render_axon

    _CAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"cad-{uuid.uuid4().hex}.png"
    try:
        render_axon(geo, _CAD_DIR / name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"轴测渲染失败:{e}") from e
    return {"url": f"/api/cad/file/{name}"}


@router.get("/cad/file/{name}")
async def cad_file(name: str, user: User = Depends(get_current_user)) -> FileResponse:
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _CAD_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path, media_type="image/png", filename=name,
                        headers={"Cache-Control": "public, max-age=86400"})
