"""LoRA 训练路由(D 期)—— 上传数据集 → Florence2 打标 → AI-Toolkit 训练 → 注册进模型库。

架构:API(CPU 编排)通过 HTTP 调 GPU 机上的 trainer agent(:9100)，同 ComfyUI/TTS/LLM
的访问模式。训练时 pool.mark_busy 摘流该卡出图(ComfyUI 进程不停),训完 mark_free 回归。

数据集 & LoRA 产物均落 NAS(API 走 cifs 挂载写入,trainer 走 SMB 读取,同一物理目录)。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import engine, get_session
from app.deps import get_current_user, get_pool
from app.models import TrainJob, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import detect_model_family

logger = logging.getLogger(__name__)
router = APIRouter()

_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20MB/张


def _trainer_base() -> str:
    url = get_settings().trainer_url.strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=503, detail="训练服务未部署(TOIV_TRAINER_URL 未配置)")
    return url


def _trainjob_dict(j: TrainJob) -> dict:
    return {
        "id": j.id,
        "name": j.name,
        "base_ckpt": j.base_ckpt,
        "trigger_words": j.trigger_words,
        "status": j.status,
        "progress": json.loads(j.progress) if j.progress else None,
        "lora_path": j.lora_path,
        "sample_urls": json.loads(j.sample_urls) if j.sample_urls else [],
        "error": j.error,
        "created_at": j.created_at.isoformat(),
        # 训练超参(回显给前端)
        "lr": j.lr,
        "steps": j.steps,
        "network_dim": j.network_dim,
        "cuda_device": j.cuda_device,
    }


# ---------------------------------------------------------------------------
# 数据集上传
# ---------------------------------------------------------------------------


class DatasetUploadResponse(BaseModel):
    job_id: str
    count: int
    dataset_dir: str  # NAS 相对路径(供 trainer 用)


@router.post("/train/dataset")
async def upload_dataset(
    files: list[UploadFile],
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> DatasetUploadResponse:
    """上传训练数据集图片(10-30 张)。通过 HTTP 转发给 trainer agent 存本地。"""
    # 训练链写操作统一限流(generation 档):数据集上传是训练链入口
    enforce_generation_rate_limit(user)
    if not files:
        raise HTTPException(status_code=400, detail="请至少上传一张图片")
    if len(files) > 50:
        raise HTTPException(status_code=400, detail="单次上限 50 张")

    # 先建档拿 job_id
    job = TrainJob(
        tenant_id=user.tenant_id,
        user_id=user.id,
        status="queued",
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    # 通过 HTTP multipart 转发给 trainer agent
    base = _trainer_base()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            mp_files = []
            for i, f in enumerate(files):
                content = await f.read()
                if not content:
                    continue
                if len(content) > _MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail=f"{f.filename} 超过 20MB 上限")
                ext = Path(f.filename or "img.png").suffix.lower() or ".png"
                mp_files.append(("files", (f"img-{i:03d}{ext}", content, f.content_type or "image/png")))
            resp = await client.post(
                f"{base}/upload",
                files=mp_files,
                data={"job_id": job.id},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        job.status = "error"
        job.error = f"上传到训练服务失败: {e}"
        session.add(job)
        session.commit()
        raise HTTPException(status_code=502, detail=str(e)) from e

    job.dataset_dir = data.get("dataset_dir", job.id)
    session.add(job)
    session.commit()
    return DatasetUploadResponse(
        job_id=job.id,
        count=data.get("count", 0),
        dataset_dir=job.dataset_dir,
    )


# ---------------------------------------------------------------------------
# Florence2 自动打标
# ---------------------------------------------------------------------------


class CaptionRequest(BaseModel):
    job_id: str
    cuda_device: int = 0


class CaptionResponse(BaseModel):
    job_id: str
    count: int
    captions: list[dict]  # [{filename, caption}]


@router.post("/train/caption")
async def caption_dataset(
    body: CaptionRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CaptionResponse:
    """调 trainer agent 用 Florence2 给数据集自动打标(生成 .txt 标签文件)。"""
    # 打标占 trainer GPU(Florence2 推理):generation 档限流
    enforce_generation_rate_limit(user)
    job = session.exec(
        select(TrainJob).where(TrainJob.id == body.job_id, TrainJob.user_id == user.id)
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="训练作业不存在")

    job.status = "captioning"
    session.add(job)
    session.commit()

    base = _trainer_base()
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{base}/caption",
                json={
                    "dataset_dir": job.dataset_dir,
                    "cuda_device": body.cuda_device,
                    "trigger_words": job.trigger_words,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        job.status = "error"
        job.error = f"打标失败: {e}"
        session.add(job)
        session.commit()
        raise HTTPException(status_code=502, detail=str(e)) from e

    job.status = "queued"  # 打标完,回到 queued 等训练
    session.add(job)
    session.commit()
    return CaptionResponse(
        job_id=job.id,
        count=data.get("count", 0),
        captions=data.get("captions", []),
    )


# ---------------------------------------------------------------------------
# 启动训练
# ---------------------------------------------------------------------------


class TrainStartRequest(BaseModel):
    job_id: str
    name: str = Field(default="", description="训练名(也作 LoRA 文件名)")
    base_ckpt: str = Field(description="底模文件名")
    trigger_words: str = Field(default="", description="触发词")
    lr: float = 1e-4
    steps: int = 1000
    network_dim: int = 16
    network_alpha: int = 16
    resolution: int = 1024
    batch_size: int = 1
    cuda_device: int = Field(default=0, description="用哪张 GPU(0-3)")


class TrainStartResponse(BaseModel):
    job_id: str
    trainer_job_id: str
    worker: str


@router.post("/train/start")
async def start_training(
    body: TrainStartRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
) -> TrainStartResponse:
    """启动 LoRA 训练:调 trainer agent + 摘流该卡出图。"""
    # LoRA 训练是平台最贵 GPU 操作(独占一卡数小时):按 3 倍生成配额计数,
    # 60s 窗口内最多 6 次启动,防批量提交打爆 trainer(与 drama 角色三视图同档)
    enforce_generation_rate_limit(user, count=3)
    job = session.exec(
        select(TrainJob).where(TrainJob.id == body.job_id, TrainJob.user_id == user.id)
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="训练作业不存在")

    # 确定训练用 worker URL(cuda_device → ComfyUI 端口映射)
    settings = get_settings()
    worker_urls = settings.worker_urls
    if body.cuda_device >= len(worker_urls):
        raise HTTPException(status_code=400, detail=f"cuda_device {body.cuda_device} 超出范围(共 {len(worker_urls)} 张卡)")
    worker_url = worker_urls[body.cuda_device]

    # 更新作业参数
    job.name = body.name or f"lora_{job.id[:8]}"
    job.base_ckpt = body.base_ckpt
    job.trigger_words = body.trigger_words
    job.lr = body.lr
    job.steps = body.steps
    job.network_dim = body.network_dim
    job.network_alpha = body.network_alpha
    job.resolution = body.resolution
    job.batch_size = body.batch_size
    job.cuda_device = body.cuda_device
    job.worker = worker_url
    job.status = "training"
    session.add(job)
    session.commit()

    # 摘流该卡出图(ComfyUI 进程不停,只是不派新出图任务)
    pool.mark_busy(worker_url)

    # 调 trainer agent 启动训练
    base = _trainer_base()
    family = detect_model_family(body.base_ckpt)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{base}/train",
                json={
                    "job_id": job.id,
                    "base_ckpt": body.base_ckpt,
                    "family": family,
                    "dataset_dir": job.dataset_dir,
                    "trigger_words": body.trigger_words,
                    "lr": body.lr,
                    "steps": body.steps,
                    "network_dim": body.network_dim,
                    "network_alpha": body.network_alpha,
                    "resolution": body.resolution,
                    "batch_size": body.batch_size,
                    "cuda_device": body.cuda_device,
                    "lora_name": job.name,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        job.status = "error"
        job.error = f"启动训练失败: {e}"
        session.add(job)
        session.commit()
        pool.mark_free(worker_url)  # 失败了,回归出图池
        raise HTTPException(status_code=502, detail=str(e)) from e

    job.trainer_job_id = data.get("trainer_job_id", "")
    session.add(job)
    session.commit()
    return TrainStartResponse(
        job_id=job.id,
        trainer_job_id=job.trainer_job_id,
        worker=worker_url,
    )


# ---------------------------------------------------------------------------
# SSE 训练进度转发
# ---------------------------------------------------------------------------


@router.get("/train/{job_id}/events")
async def train_events(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """SSE 转发 trainer agent 的训练进度(step/loss)给前端。"""
    job = session.exec(
        select(TrainJob).where(TrainJob.id == job_id, TrainJob.user_id == user.id)
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="训练作业不存在")
    if not job.trainer_job_id:
        raise HTTPException(status_code=400, detail="训练尚未启动")

    base = _trainer_base()
    trainer_url = f"{base}/train/{job.trainer_job_id}/events"

    async def stream():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", trainer_url) as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            payload = line[6:]
                            # 透传 trainer 的 SSE 数据,同时更新 DB
                            try:
                                data = json.loads(payload)
                                evt = data.get("event", "progress")
                                if evt == "progress":
                                    _update_progress(job_id, data)
                                elif evt == "done":
                                    _update_done(job_id, data)
                                elif evt == "error":
                                    _update_error(job_id, data)
                                    # 训练结束(无论成败),回归出图池
                                    _free_worker(job_id)
                            except (json.JSONDecodeError, ValueError):
                                pass
                            yield {"event": "message", "data": payload}
                        elif line.startswith("event: "):
                            # 透传 event 名(SSE 协议双层)
                            continue
        except Exception as e:
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(stream())


def _update_progress(job_id: str, data: dict) -> None:
    with Session(engine) as s:
        j = s.exec(select(TrainJob).where(TrainJob.id == job_id)).first()
        if j:
            j.progress = json.dumps({
                "step": data.get("step", 0),
                "total": data.get("total", 0),
                "loss": data.get("loss", 0),
                "recent_losses": data.get("recent_losses", []),
            })
            s.add(j)
            s.commit()


def _update_done(job_id: str, data: dict) -> None:
    with Session(engine) as s:
        j = s.exec(select(TrainJob).where(TrainJob.id == job_id)).first()
        if j:
            j.status = "done"
            j.lora_path = data.get("lora_path", "")
            j.sample_urls = json.dumps(data.get("samples", []))
            s.add(j)
            s.commit()


def _update_error(job_id: str, data: dict) -> None:
    with Session(engine) as s:
        j = s.exec(select(TrainJob).where(TrainJob.id == job_id)).first()
        if j:
            j.status = "error"
            j.error = data.get("message", "训练失败")
            s.add(j)
            s.commit()


def _free_worker(job_id: str) -> None:
    """训练结束 → worker 回归出图池。"""
    from app.deps import get_pool

    with Session(engine) as s:
        j = s.exec(select(TrainJob).where(TrainJob.id == job_id)).first()
        if j and j.worker:
            get_pool().mark_free(j.worker)


# ---------------------------------------------------------------------------
# 注册 LoRA 到模型库
# ---------------------------------------------------------------------------


class RegisterRequest(BaseModel):
    job_id: str


@router.post("/train/{job_id}/register")
def register_lora(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """训练完后注册 LoRA:文件已在 NAS loras/,此处只登记元数据(前端模型库据此展示)。

    实际注册逻辑:LoRA 文件落 NAS loras/ 后 ComfyUI 自动发现(已有 LoraLoader 节点)。
    此端点仅更新 TrainJob 状态 + 返回 LoRA 文件名供前端使用。
    """
    enforce_generation_rate_limit(user)
    job = session.exec(
        select(TrainJob).where(TrainJob.id == job_id, TrainJob.user_id == user.id)
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="训练作业不存在")
    if job.status != "done":
        raise HTTPException(status_code=400, detail=f"训练未完成(当前状态: {job.status})")
    if not job.lora_path:
        raise HTTPException(status_code=400, detail="LoRA 文件路径为空")

    # LoRA 文件名(NAS loras/ 下的文件名,ComfyUI LoraLoader 据此加载)
    lora_filename = Path(job.lora_path).name
    return {
        "ok": True,
        "lora_name": lora_filename,
        "trigger_words": job.trigger_words,
        "base_ckpt": job.base_ckpt,
        "family": detect_model_family(job.base_ckpt),
    }


# ---------------------------------------------------------------------------
# 列训练作业
# ---------------------------------------------------------------------------


@router.get("/train/jobs")
def list_train_jobs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的训练作业历史(最新在前)。"""
    rows = session.exec(
        select(TrainJob)
        .where(TrainJob.user_id == user.id)
        .order_by(TrainJob.created_at.desc())
        .limit(50)
    ).all()
    return [_trainjob_dict(j) for j in rows]


@router.get("/train/{job_id}")
def get_train_job(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """查单个训练作业详情。"""
    job = session.exec(
        select(TrainJob).where(TrainJob.id == job_id, TrainJob.user_id == user.id)
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="训练作业不存在")
    return _trainjob_dict(job)


# ---------------------------------------------------------------------------
# i2L 风格 LoRA(DiffSynth ZImage-i2L-v2,图 → LoRA 单次前向)
# ---------------------------------------------------------------------------

_I2L_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _i2l_base() -> str:
    url = get_settings().i2l_url.strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=503, detail="i2L 风格 LoRA 服务未部署(TOIV_I2L_URL 未配置)")
    return url


def _i2l_agent_detail(resp: httpx.Response, fallback: str) -> str:
    """从 agent 错误响应提取 detail 字段透传,提取失败用兜底文案。"""
    try:
        return str(resp.json().get("detail") or fallback)
    except (ValueError, AttributeError):
        return fallback


@router.post("/train/i2l")
async def i2l_style_lora(
    files: list[UploadFile] = File(...),
    lora_name: str = Form(...),
    demo_prompt: str = Form(""),
    user: User = Depends(get_current_user),
) -> dict:
    """i2L 风格 LoRA:1-8 张风格参考图 → 单次前向导出 Z-Image 族 LoRA。

    设计理由(不写 TrainJob):i2L 是单次前向推理而非迭代训练——无步数/loss/进度
    概念,同步等待即得产物,TrainJob 的 queued/training/done 状态机与 SSE 进度
    转发对它不适用。LoRA 产物由 agent 直落 NAS loras/(ComfyUI
    LoraLoaderModelOnly 自动发现),返回字段与 register_lora 端点风格对齐。
    """
    # i2L 单次前向即出 LoRA(独占 GPU3 ~26G 常驻服务):与 /train/start 同档,
    # 按 3 倍生成配额计数,防批量提交打爆 i2l agent
    enforce_generation_rate_limit(user, count=3)
    base = _i2l_base()

    name = lora_name.strip()
    if not name or not _I2L_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="lora_name 仅允许字母/数字/下划线/连字符")
    if len(files) > 8:
        raise HTTPException(status_code=400, detail="单次上限 8 张")

    mp_files = []
    for i, f in enumerate(files):
        ctype = (f.content_type or "").lower()
        if not ctype.startswith("image/"):
            raise HTTPException(status_code=400, detail=f"{f.filename} 不是图片(content-type: {ctype or '未知'})")
        content = await f.read()
        if not content:
            raise HTTPException(status_code=400, detail=f"图片为空: {f.filename}")
        if len(content) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail=f"{f.filename} 超过 20MB 上限")
        ext = Path(f.filename or "img.png").suffix.lower() or ".png"
        mp_files.append(("files", (f"img-{i:03d}{ext}", content, ctype)))

    data = {"lora_name": name}
    if demo_prompt.strip():
        data["demo_prompt"] = demo_prompt.strip()

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(f"{base}/i2l", files=mp_files, data=data)
    except httpx.TimeoutException as e:
        raise HTTPException(status_code=504, detail=f"i2L 服务超时: {e}") from e
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"i2L 服务不可达: {e}") from e

    if resp.status_code == 200:
        payload = resp.json()
        return {
            "ok": True,
            "lora_name": payload.get("lora_name", f"{name}.safetensors"),
            "size_mb": payload.get("size_mb", 0.0),
            "family": "z_image",  # i2L 元模型基于 Z-Image(DiffSynth ZImage-i2L-v2)
            "demo_png": payload.get("demo_png"),
        }
    if resp.status_code == 409:
        raise HTTPException(status_code=409, detail=_i2l_agent_detail(resp, "i2L 服务忙(已有任务在跑),请稍后重试"))
    if resp.status_code == 400:
        raise HTTPException(status_code=400, detail=_i2l_agent_detail(resp, "i2L 输入错误"))
    raise HTTPException(status_code=502, detail=_i2l_agent_detail(resp, f"i2L 导出失败(HTTP {resp.status_code})"))
