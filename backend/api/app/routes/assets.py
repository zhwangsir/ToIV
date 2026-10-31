"""POST /api/assets/from-job —— 作品库产物 → 参考输入 转运(资产互通,2026-08-18)。

场景:图片生成的产物直接作为图生视频/图生图的参考图、视频产物作参考视频、
音频作参考音——省去「下载到本地再上传」的往返。

流程:归属校验(Job 属本人/同租户,且 filename 在 result 中)→ 从产物 worker
(output 目录)取字节(同机回退,复用 images.py 韧性思路)→ 上传到目标 worker
(input 目录,支持按任务 kind 选型或钉定 worker)→ 返回 RefImageHandle 同构句柄。

安全:与 /api/images 归属回退同款校验(LIKE filename 匹配 + 属主/租户),统一
404 不泄露存在性;文件名过 pathsafe 白名单;体积上限沿用 upload(图/音 20MB、视频 200MB)。
"""
from __future__ import annotations

import uuid
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.capabilities import required_models, required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.pathsafe import PathTraversalError, validate_path_component
from app.routes.upload import _EXT_TO_KIND, _MAX_BYTES, _MAX_VIDEO_BYTES, _VIDEO_KINDS

router = APIRouter()


class FromJobRequest(BaseModel):
    """产物 → 参考输入转运请求。

    kind:决定目标 worker 选型(与 /api/upload 同款 capabilities 门控,下划线风格)。
    worker:钉定目标(与后续生成同机);省略则按 kind 自动挑选。
    """

    job_id: str = Field(min_length=1, max_length=64)
    filename: str = Field(min_length=1, max_length=255)
    kind: str = Field(default="img2img", max_length=64)
    worker: str | None = Field(default=None, max_length=255)


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


@router.post("/assets/from-job")
async def asset_from_job(
    body: FromJobRequest,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """作品库产物搬运为参考输入,返回 {filename, worker}(与上传句柄同构,直接灌入引擎表单)。"""
    # 1) 路径白名单
    try:
        safe_filename = validate_path_component(body.filename, allow_subdirs=False)
    except PathTraversalError as e:
        raise HTTPException(status_code=400, detail=f"非法路径:{e}") from e
    if not safe_filename:
        raise HTTPException(status_code=400, detail="filename 不能为空")

    # 2) 归属校验:Job 属本人/同租户,且 filename 出现在其 result URL 列表中
    #    (LIKE 匹配与 images.py 归属回退同款;admin 同样要求 filename ∈ result,防任意文件拉取)
    job = session.get(Job, body.job_id)
    owns = (
        job is not None
        and (user.role == "admin" or job.user_id == user.id or job.tenant_id == user.tenant_id)
        and job.deleted_at is None
        and f"filename={safe_filename}" in (job.result or "")
    )
    if not owns:
        raise HTTPException(status_code=404, detail="产物不存在")

    # 3) 体积上限(按扩展名分流,与 upload 一致)
    ext = Path(safe_filename).suffix.lower()
    if ext not in _EXT_TO_KIND:
        raise HTTPException(status_code=415, detail=f"不支持的产物类型:{ext or '无扩展名'}")
    limit = _MAX_VIDEO_BYTES if _EXT_TO_KIND[ext] in _VIDEO_KINDS else _MAX_BYTES

    # 4) 从产物 worker 取字节(output 目录;主 worker 掉线回退同机存活 worker)
    primary = resolve_worker(job.worker)
    host = _host(primary.base_url)
    siblings = [c for c in pool.clients if _host(c.base_url) == host and c.base_url != primary.base_url]
    content: bytes | None = None
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, _ = await client.get_image_bytes(safe_filename, "", "output")
            break
        except ComfyUIError as e:
            last_err = e
    if content is None:
        raise HTTPException(status_code=502, detail=f"产物暂不可取(同机 worker 均不可达):{last_err}")
    if len(content) > limit:
        raise HTTPException(status_code=413, detail=f"产物过大(上限 {limit // 1024 // 1024}MB)")

    # 5) 目标 worker:钉定优先(与后续生成同机);否则按任务 kind 选型(caps 门控)
    if body.worker:
        target = resolve_worker(body.worker)
        req_models = required_models(body.kind)
        req_nodes = required_nodes(body.kind)
        if req_models and not req_models.issubset(await target.model_names()):
            raise HTTPException(status_code=503, detail="指定 worker 缺少该任务所需模型")
        if req_nodes and not req_nodes.issubset(await target.node_names()):
            raise HTTPException(status_code=503, detail="指定 worker 缺少该任务所需节点")
    else:
        try:
            target = await pool.pick(
                required=required_models(body.kind), required_nodes=required_nodes(body.kind)
            )
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e

    # 6) 唯一名落目标 input 目录(防各 worker 命名分歧,与 upload 分发模式同款前缀)
    dest = f"toivasset-{uuid.uuid4().hex}{ext}"
    try:
        name = await target.upload_image(content, dest)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"转运失败:{e}") from e
    return {"filename": name, "worker": target.base_url}
