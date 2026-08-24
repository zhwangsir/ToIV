"""POST /api/3d/ops —— 3D 产物材质/渲染调整(委托 workstation toiv-3dops :9402)。

输入是已生成的 GLB 产物:job_id(作品库作业)或 {filename, worker}(上传/作业句柄),
core 经 /api/images 同源逻辑(resolve_worker 白名单 + get_image_bytes)取回 GLB 字节,
multipart 上传到 toiv-3dops 执行:

- op=render:out=glb(默认)把材质预设(clay/matte/metal/glossy)烘焙为 GLB 的
  PBR 材质,产出新 3D 模型;out=png/mp4 为快照/360° turntable 视频(纯查看产物,
  灯光 environment/studio/rim × 背景 transparent/white/dark);wireframe/normal
  是纯查看模式,glb 输出下 422 拒绝。
- op=material:PBR 材质改写(base_color 染色/金属度/粗糙度)→ 新 GLB。

产物落 content_subdir("threed") 并建档 Job(kind=threed_render/threed_material,
status=done),URL /api/3d/ops/files/{name} 带 Range(同 audio_orchestrate 纪律);
扩展名 .png/.mp4/.glb 与前端 mediaKindOf 识别兼容,自动进作品库对应分支。

失败纪律:来源不合法 422/403/404,worker 取产物失败 502,3dops 未配置 503、
不可达/超时/返回非预期产物 502。
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.images import _ranged_response
from app.storage import content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

_OUT_NAME_RE = re.compile(r"^threedops-[0-9a-f]{32}\.(png|mp4|glb)$")
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_MAX_GLB_BYTES = 200 * 1024 * 1024

_CONTENT_TYPES = {
    ".png": "image/png",
    ".mp4": "video/mp4",
    ".glb": "model/gltf-binary",
}

_MATERIAL_LABELS = {
    "clay": "黏土",
    "matte": "哑光",
    "metal": "金属",
    "glossy": "陶瓷",
    "wireframe": "线框",
    "normal": "法线",
}


class OpsSource(BaseModel):
    """GLB 产物定位:ComfyUI /view 语义(filename + worker)。"""
    filename: str = Field(min_length=1, max_length=512)
    worker: str = Field(min_length=1, max_length=512)


class ThreeDOpsRequest(BaseModel):
    op: Literal["render", "material"]
    # 来源二选一:作品库作业 id(归属校验后取 .glb 产物)或直接句柄
    job_id: str | None = Field(default=None, max_length=64)
    source: OpsSource | None = None
    # render 参数;out=glb(默认):材质预设烘焙为 PBR 材质回写 GLB,产出新 3D 模型;
    # png/mp4 为快照/旋转视频(纯查看产物)。format 为旧参数,out 缺省时生效
    out: Literal["glb", "png", "mp4"] | None = None
    material: Literal["clay", "matte", "metal", "glossy", "wireframe", "normal"] = "clay"
    lighting: Literal["environment", "studio", "rim"] = "studio"
    background: Literal["transparent", "white", "dark"] = "dark"
    format: Literal["png", "mp4"] | None = None
    azimuth: float = Field(default=30.0, ge=-360.0, le=360.0)
    frames: Literal[24, 36] = 36
    size: int = Field(default=768, ge=256, le=1080)
    # material 参数(PBR 改写)
    base_color: str = Field(default="#b87333", max_length=7)  # 默认青铜色
    metallic: float = Field(default=0.85, ge=0.0, le=1.0)
    roughness: float = Field(default=0.35, ge=0.0, le=1.0)
    # 作品库展示标题(助手工具传自然语言意图)
    prompt: str | None = Field(default=None, max_length=500)


_LOCAL_GLB_RE = re.compile(r"^/api/3d/ops/files/(threedops-[0-9a-f]{32}\.glb)$")


def _glb_locator_from_job(job: Job) -> OpsSource | str:
    """从 Job.result(产物 URL 列表)解析第一个 .glb 产物的定位信息。

    两种形态:worker 签名 URL(/api/images?filename=…&worker=…)→ OpsSource;
    本服务自有产物(/api/3d/ops/files/threedops-*.glb,如材质改写的二次调整)→ 本地文件名(str)。
    """
    try:
        urls = json.loads(job.result) if job.result else []
    except json.JSONDecodeError:
        urls = []
    for url in urls:
        if not isinstance(url, str) or ".glb" not in url.lower():
            continue
        m = _LOCAL_GLB_RE.match(urlsplit(url).path)
        if m:
            return m.group(1)
        qs = parse_qs(urlsplit(url).query)
        filename = (qs.get("filename") or [""])[0]
        worker = (qs.get("worker") or [""])[0]
        if filename and worker:
            return OpsSource(filename=filename, worker=worker)
    raise HTTPException(status_code=422, detail="该作业没有 .glb 产物可调整")


def _read_local_glb(name: str) -> bytes:
    """读本服务自有 GLB 产物(材质改写结果的链式再调整)。"""
    try:
        path = content_subdir("threed") / name
        content = path.read_bytes()
    except OSError as e:
        raise HTTPException(status_code=404, detail=f"本地 GLB 产物不可读:{e}") from e
    if len(content) > _MAX_GLB_BYTES:
        raise HTTPException(status_code=413, detail="GLB 过大(上限 200MB)")
    if content[:4] != b"glTF":
        raise HTTPException(status_code=422, detail="产物不是有效 GLB(magic 校验失败)")
    return content


async def _fetch_glb_bytes(source: OpsSource, pool: WorkerPool | None) -> bytes:
    """按 /api/images 同源逻辑取 GLB:resolve_worker 白名单 + 同机 siblings 回退。"""
    if not source.filename.lower().endswith(".glb"):
        raise HTTPException(status_code=422, detail="仅支持 .glb 产物")
    primary = resolve_worker(source.worker)  # 白名单校验,非白名单 4xx
    host = urlsplit(primary.base_url).hostname or ""
    siblings = []
    if pool is not None:
        siblings = [
            c for c in pool.clients
            if (urlsplit(c.base_url).hostname or "") == host and c.base_url != primary.base_url
        ]
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, _ = await client.get_image_bytes(source.filename, "", "output")
            break
        except ComfyUIError as e:
            last_err = e
    else:
        raise HTTPException(
            status_code=502, detail=f"GLB 产物暂不可取(同机 worker 均不可达): {last_err}"
        )
    if len(content) > _MAX_GLB_BYTES:
        raise HTTPException(status_code=413, detail="GLB 过大(上限 200MB)")
    if content[:4] != b"glTF":
        raise HTTPException(status_code=422, detail="产物不是有效 GLB(magic 校验失败)")
    return content


def _verify_output(data: bytes, op: str, fmt: str) -> str:
    """产物 magic 校验,返回扩展名;造假/损坏一律 502。"""
    if op == "material" or fmt == "glb":
        if data[:4] == b"glTF":
            return "glb"
    elif fmt == "png":
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return "png"
    else:
        if len(data) > 12 and data[4:8] == b"ftyp":
            return "mp4"
    raise HTTPException(status_code=502, detail="3D 服务返回非预期产物(magic 校验失败)")


@router.post("/3d/ops")
async def threed_ops(
    body: ThreeDOpsRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)

    settings = get_settings()
    base = settings.threed_ops_url.strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="3D 调整服务未配置(TOIV_3D_OPS_URL 为空)")

    # ---- 定位来源 GLB ----
    if body.job_id and body.source:
        raise HTTPException(status_code=422, detail="job_id 与 source 二选一")
    if body.job_id:
        job = session.get(Job, body.job_id)
        if job is None or (
            user.role != "admin"
            and job.user_id != user.id
            and job.tenant_id != user.tenant_id
        ):
            raise HTTPException(status_code=404, detail="作业不存在")
        if job.status != "done":
            raise HTTPException(status_code=422, detail=f"作业尚未完成(status={job.status})")
    source = _glb_locator_from_job(job) if body.job_id else body.source
    if source is None:
        raise HTTPException(status_code=422, detail="缺少来源:job_id 或 source 二选一")

    if isinstance(source, OpsSource):
        glb = await _fetch_glb_bytes(source, pool)
        source_snapshot: dict[str, str] = source.model_dump()
    else:  # 本服务自有产物(材质改写结果的链式再调整)
        glb = _read_local_glb(source)
        source_snapshot = {"local": source}

    # ---- 委托 toiv-3dops ----
    if body.op == "render":
        out_mode = body.out or body.format or "glb"
        if out_mode == "glb" and body.material in ("wireframe", "normal"):
            raise HTTPException(
                status_code=422,
                detail=f"{body.material} 是纯查看模式,无法烘焙为 GLB;"
                       f"请改用 png/mp4 输出,或选 clay/matte/metal/glossy 材质预设",
            )
        path = "/render"
        data: dict[str, object] = {
            "material": body.material,
            "lighting": body.lighting,
            "background": body.background,
            "out": out_mode,
            "azimuth": str(body.azimuth),
            "frames": str(body.frames),
            "size": str(body.size),
        }
    else:
        out_mode = "glb"  # material 恒出 GLB
        if not _HEX_COLOR_RE.match(body.base_color):
            raise HTTPException(status_code=422, detail="base_color 须为 #RRGGBB")
        path = "/material"
        data = {
            "base_color": body.base_color,
            "metallic": str(body.metallic),
            "roughness": str(body.roughness),
        }

    try:
        async with httpx.AsyncClient(
            timeout=settings.threed_ops_timeout_sec, follow_redirects=True, trust_env=False
        ) as client:
            resp = await client.post(
                base + path,
                data=data,
                files={"file": ("model.glb", glb, "model/gltf-binary")},
            )
    except httpx.TimeoutException as e:
        raise HTTPException(status_code=502, detail=f"3D 调整服务超时:{e}") from e
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"3D 调整服务不可达:{e}") from e
    if resp.status_code != 200:
        detail = f"3D 调整失败(HTTP {resp.status_code})"
        try:
            detail = resp.json().get("detail", detail)
        except (ValueError, KeyError, AttributeError):
            pass
        raise HTTPException(status_code=502, detail=detail)
    ext = _verify_output(resp.content, body.op, out_mode)

    # ---- 产物落盘 + 建档 ----
    name = f"threedops-{uuid.uuid4().hex}.{ext}"
    out_dir = content_subdir("threed")
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / name).write_bytes(resp.content)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"产物落盘失败:{e}") from e
    url = f"/api/3d/ops/files/{name}"
    kind = "threed_render" if body.op == "render" else "threed_material"

    if body.prompt and body.prompt.strip():
        prompt = body.prompt.strip()[:500]
    elif body.op == "render":
        label = _MATERIAL_LABELS.get(body.material, body.material)
        prompt = (
            f"3D 材质模型({label})" if out_mode == "glb"
            else f"3D 旋转视频({label}材质)" if out_mode == "mp4"
            else f"3D 渲染快照({label}材质)"
        )
    else:
        prompt = f"3D 材质调整({body.base_color})"

    job_id: str | None = None
    try:
        job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=f"3dops-{uuid.uuid4().hex}",
            worker="local",
            kind=kind,
            status="done",
            prompt=prompt,
            seed=0,
            result=json.dumps([url], ensure_ascii=False),
            params=json.dumps(
                {
                    "op": body.op,
                    "source": source_snapshot,
                    "material": body.material,
                    "lighting": body.lighting,
                    "background": body.background,
                    "out": out_mode,
                    "base_color": body.base_color,
                    "metallic": body.metallic,
                    "roughness": body.roughness,
                },
                ensure_ascii=False,
            ),
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    except Exception:
        session.rollback()
        logger.warning("3D 调整产物建档失败(产物已落盘)", exc_info=True)

    return {"kind": kind, "url": url, "job_id": job_id, "op": body.op, "format": ext}


@router.get("/3d/ops/files/{name}")
async def get_threed_ops_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    """回读 3D 调整产物(png/mp4/glb),手动 Range 支持(同 audio_orchestrate)。"""
    if not _OUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = content_subdir("threed") / name
    try:
        if path.is_file():
            return _ranged_response(
                path.read_bytes(),
                _CONTENT_TYPES[path.suffix.lower()],
                request.headers.get("range"),
            )
    except OSError as e:
        logger.warning("3D 产物目录不可达:%s", e)
    raise HTTPException(status_code=404, detail="3D 产物不存在")
