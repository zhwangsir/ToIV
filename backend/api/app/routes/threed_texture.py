"""POST /api/3d/texture —— Hunyuan3D 2.1 纹理生成(委托 workstation toiv-hy3dtex :9404)。

输入是已生成的白模 GLB 产物:job_id(作品库作业)或 {filename, worker} 句柄
(取件逻辑复用 routes/threed_ops 的 resolve_worker 白名单 + get_image_bytes 同源纪律),
multipart 上传到 toiv-hy3dtex 执行 hy3dpaint 多视图扩散 + PBR 烘焙,产出带贴图的新 GLB。

参考图(可选,三优先级):
1. 显式 image={filename, worker}(worker input 目录的上传图);
2. job_id 对应作业的 params.image + job.worker(图生3D 作业的原始参考图,自动回填);
3. 都没有 → 服务端渲染白模正视图作为条件图兜底(风格完全由 prompt 文本引导)。

prompt(可选):风格/材质文本,覆盖管线默认 caption("high quality"),如
"青铜锈蚀质感"、"卡通皮肤"。

纹理生成是分钟级(多视图扩散 + 4K 烘焙 + RealESRGAN 增强),同步长超时
(hy3d_tex_timeout_sec 默认 900s),前端须用 timeoutMs 覆盖默认 30s/180s。

产物落 content_subdir("threed") 并建档 Job(kind=threed_texture,status=done),
URL /api/3d/texture/files/{name} 带 Range(同 threed_ops 纪律);.glb 扩展名
与前端 mediaKindOf 识别兼容,自动进作品库 3D 桶(libraryQuery 已收录该 kind)。

失败纪律:来源不合法 422/403/404,worker 取产物失败 502,纹理服务未配置 503、
不可达/超时/返回非预期产物 502。
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.images import _ranged_response
from app.routes.threed_ops import (
    _MAX_GLB_BYTES,
    OpsSource,
    _fetch_glb_bytes,
    _glb_locator_from_job,
    _read_local_glb,
)
from app.services import service_orchestrator as orch_svc
from app.storage import content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

_OUT_NAME_RE = re.compile(r"^threedtex-[0-9a-f]{32}\.glb$")
_IMG_EXT_RE = re.compile(r"\.(png|jpe?g|webp|bmp)$", re.IGNORECASE)

_IMG_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}


class ThreeDTextureRequest(BaseModel):
    # 来源二选一:作品库作业 id(归属校验后取 .glb 产物)或直接句柄
    job_id: str | None = Field(default=None, max_length=64)
    source: OpsSource | None = None
    # 可选参考图句柄(worker input 目录);缺省时自动回填图生3D 作业的原始参考图
    image: OpsSource | None = None
    # 风格/材质文本(覆盖管线默认 caption;无参考图时为主要风格引导)
    prompt: str | None = Field(default=None, max_length=500)
    # 贴图边长(像素),服务侧钳制 1024-4096
    texture_size: int = Field(default=2048, ge=1024, le=4096)


def _ref_image_from_job_params(job: Job) -> OpsSource | None:
    """图生3D 作业的 params 里有上传图句柄(image + 作业 worker),自动回填参考图。"""
    try:
        params = json.loads(job.params) if job.params else {}
    except json.JSONDecodeError:
        return None
    image = params.get("image")
    worker = job.worker or params.get("worker") or ""
    if isinstance(image, str) and image and worker and _IMG_EXT_RE.search(image):
        return OpsSource(filename=image, worker=worker)
    return None


async def _fetch_ref_image_bytes(source: OpsSource) -> tuple[bytes, str]:
    """取参考图字节(worker input 目录),返回 (bytes, 扩展名)。"""
    m = _IMG_EXT_RE.search(source.filename)
    if not m:
        raise HTTPException(status_code=422, detail="参考图仅支持 png/jpg/webp/bmp")
    ext = m.group(1).lower().replace("jpeg", "jpg")
    client = resolve_worker(source.worker)  # 白名单校验,非白名单 4xx
    try:
        content, _ = await client.get_image_bytes(source.filename, "", "input")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"参考图暂不可取:{e}") from e
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="参考图过大(上限 50MB)")
    return content, ext


@router.post("/3d/texture")
async def threed_texture(
    body: ThreeDTextureRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)

    settings = get_settings()
    base = settings.hy3d_tex_url.strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="3D 纹理服务未配置(TOIV_HY3D_TEX_URL 为空)")

    # ---- 定位来源 GLB(与 threed_ops 同一纪律) ----
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
    else:  # 本服务自有产物(材质/纹理结果的链式再处理)
        glb = _read_local_glb(source)
        source_snapshot = {"local": source}

    # ---- 参考图:显式 > 原作业 params 回填 > 无(服务端正视图兜底) ----
    ref: OpsSource | None = body.image
    if ref is None and body.job_id:
        ref = _ref_image_from_job_params(job)
    files: dict[str, tuple] = {"file": ("model.glb", glb, "model/gltf-binary")}
    ref_snapshot: dict[str, str] | None = None
    if ref is not None:
        ref_bytes, ref_ext = await _fetch_ref_image_bytes(ref)
        files["image"] = (
            f"reference.{ref_ext}", ref_bytes, _IMG_CONTENT_TYPES[f".{ref_ext}"],
        )
        ref_snapshot = ref.model_dump()

    data: dict[str, str] = {"texture_size": str(body.texture_size)}
    if body.prompt and body.prompt.strip():
        data["prompt"] = body.prompt.strip()[:500]

    # ---- R2 冷层接线:全部 4xx 校验过后,委托前先唤醒 hy3dtex ----
    # 同步等健康(端点保持 pending,与分钟级生成同一同步契约);唤醒失败 503
    # 不触达纹理服务、不落盘不建档(不造假产物)。开关关/条目禁用时直通。
    await orch_svc.ensure_awake(
        "hy3dtex",
        enabled=bool(getattr(settings, "orch_wake_on_call", False)),
    )

    # ---- 委托 toiv-hy3dtex(分钟级长超时) ----
    try:
        async with httpx.AsyncClient(
            timeout=settings.hy3d_tex_timeout_sec, follow_redirects=True, trust_env=False
        ) as client:
            resp = await client.post(base + "/texture", data=data, files=files)
    except httpx.TimeoutException as e:
        raise HTTPException(status_code=502, detail=f"3D 纹理服务超时:{e}") from e
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"3D 纹理服务不可达:{e}") from e
    if resp.status_code != 200:
        detail = f"3D 纹理生成失败(HTTP {resp.status_code})"
        try:
            detail = resp.json().get("detail", detail)
        except (ValueError, KeyError, AttributeError):
            pass
        raise HTTPException(status_code=502, detail=detail)
    content = resp.content
    if content[:4] != b"glTF":
        raise HTTPException(status_code=502, detail="3D 纹理服务返回非预期产物(magic 校验失败)")
    if len(content) > _MAX_GLB_BYTES * 2:
        raise HTTPException(status_code=502, detail="3D 纹理产物过大(上限 400MB)")

    # ---- 产物落盘 + 建档 ----
    name = f"threedtex-{uuid.uuid4().hex}.glb"
    out_dir = content_subdir("threed")
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / name).write_bytes(content)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"产物落盘失败:{e}") from e
    url = f"/api/3d/texture/files/{name}"

    if body.prompt and body.prompt.strip():
        prompt = f"3D 纹理({body.prompt.strip()[:80]})"
    else:
        prompt = "3D 纹理模型"

    job_id: str | None = None
    try:
        new_job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=f"3dtex-{uuid.uuid4().hex}",
            worker="local",
            kind="threed_texture",
            status="done",
            prompt=prompt[:500],
            seed=0,
            result=json.dumps([url], ensure_ascii=False),
            params=json.dumps(
                {
                    "op": "texture",
                    "source": source_snapshot,
                    "ref_image": ref_snapshot,
                    "prompt": body.prompt,
                    "texture_size": body.texture_size,
                },
                ensure_ascii=False,
            ),
        )
        session.add(new_job)
        session.commit()
        session.refresh(new_job)
        job_id = new_job.id
    except Exception:
        session.rollback()
        logger.warning("3D 纹理产物建档失败(产物已落盘)", exc_info=True)

    return {"kind": "threed_texture", "url": url, "job_id": job_id, "op": "texture", "format": "glb"}


@router.get("/3d/texture/files/{name}")
async def get_threed_texture_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    """回读 3D 纹理产物(glb),手动 Range 支持(同 threed_ops)。"""
    if not _OUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = content_subdir("threed") / name
    try:
        if path.is_file():
            return _ranged_response(
                path.read_bytes(),
                "model/gltf-binary",
                request.headers.get("range"),
            )
    except OSError as e:
        logger.warning("3D 产物目录不可达:%s", e)
    raise HTTPException(status_code=404, detail="3D 产物不存在")
