"""视频超分(4K)—— POST /api/video/upscale 提交 + 状态轮询 + 产物服务。

链路:作品库视频产物 URL → 归属校验 → 建档秒回 → 后台 probe/抽帧/目标推导
(横 3840×2160、竖 2160×3840,服务端自动,禁手填)→ M6 fleet 帧级超分 →
ffmpeg 合并(音轨回接,无音轨补静音)→ 产物落 core 本地回写 Job(进作品库)。

产物不经 worker output 目录取回,由本路由 /video/upscale/output/{name} 直接服务,
因此 deps.resolve_worker 无需为 fleet 加分支(与 H3/LongCat 的产物代理模式不同)。
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.services import video_upscale as svc
from app.versioning import params_snapshot
from app.workflows.video_upscale import TARGET_CHOICES

router = APIRouter()


class VideoUpscaleRequest(BaseModel):
    """video_url:作品库产物签名 URL(/api/images?…)或短剧成片/工作室文件相对路径;
    本地文件先经 /api/upload 上传再用产物 URL。target 预留档位(当前仅 4k)。"""

    video_url: str = Field(min_length=1, max_length=2048)
    target: str = Field(default="4k", max_length=8)


@router.post("/video/upscale")
async def upscale_video(
    req: VideoUpscaleRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """提交视频超分作业(秒回 Job);目标分辨率由服务端 probe 后按画幅方向推导。"""
    enforce_generation_rate_limit(user)
    if req.target not in TARGET_CHOICES:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的超分档位:{req.target!r};可选 {list(TARGET_CHOICES)}",
        )
    video_url = req.video_url.strip()
    # 源 URL 形态 + 归属校验(/api/images 防 IDOR;R18 产物须专区上下文),继承 nsfw 标记
    job_nsfw = svc.resolve_source_ownership(session, user, video_url)
    # fleet 预检:至少 1 个超分实例可达,否则 503(不建档,不空转)
    workers = await svc.healthy_upscale_workers()
    if not workers:
        raise HTTPException(status_code=503, detail="超分引擎暂不可用(fleet 无在线实例)")

    prompt_id = f"video-upscale-{uuid.uuid4().hex}"
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        # worker 置空:本作业不经 ComfyUI tracker 追踪(tracker.reconcile 会跳过),
        # 生命周期由 services.video_upscale 后台管线全权管理
        worker="",
        kind="video_upscale",
        status="queued",
        prompt=f"视频超分 {req.target.upper()}",
        seed=0,
        nsfw=job_nsfw,
        params=params_snapshot(req),
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    svc.spawn_upscale(job.id, prompt_id, video_url, req.target, workers)
    return {
        "job_id": job.id,
        "prompt_id": prompt_id,
        "kind": "video_upscale",
        "status": "queued",
        "target": req.target,
    }


# response_model=None:返回注解是 FileResponse | StreamingResponse Union,
# fastapi 0.137 会尝试按 Pydantic 字段解析响应注解而拒绝 Union 响应类型;
# 流式响应本就不走 response model 序列化,显式关闭(FastAPI 官方指引)。
@router.get("/video/upscale/output/{name}", response_model=None)
async def upscale_output(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),  # <video> 走 ?token= 查询参数(deps 内置回退)
) -> FileResponse | StreamingResponse:
    """超分产物 MP4(core 本地落盘);支持 Range(浏览器 <video> 拖动需 206)。"""
    if not svc.OUTPUT_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = svc.product_root() / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="产物不存在")

    range_header = request.headers.get("range")
    if range_header:
        file_size = path.stat().st_size
        try:
            start_s, end_s = range_header.replace("bytes=", "").split("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
        except ValueError:
            raise HTTPException(status_code=416, detail="invalid range") from None
        start = max(0, start)
        end = min(end, file_size - 1)
        if start > end:
            raise HTTPException(status_code=416, detail="invalid range") from None

        def file_iterator():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    data = f.read(min(1024 * 1024, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            file_iterator(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
            },
        )
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=name,
        headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400"},
    )


@router.get("/video/upscale/{job_id}")
async def upscale_status(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """作业状态 + 帧级进度(前端轮询;进度注册表进程内存,api 重启后 null → indeterminate)。"""
    job = session.exec(
        select(Job).where(Job.id == job_id, Job.kind == "video_upscale")
    ).first()
    if not job or (job.user_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="作业不存在")
    return {
        "job_id": job.id,
        "prompt_id": job.prompt_id,
        "status": job.status,
        "results": json.loads(job.result) if job.result else [],
        "progress": svc.progress_snapshot(job.id),
    }
