"""POST /api/video/lipsync —— 通用对口型(视频 + 音频 → lipsync,LatentSync agent)。

与 routes/lipsync.py(漫剧 manju 分镜专用,走 ComfyUI worker 工作流)不同,
本端点是通用能力:任意视频产物 + 任意音频产物 → workstation LatentSync 服务
(systemd toiv-lipsync,:9103)→ 口型同步成片落 core 产物存储。

链路:两源 URL(视频复用 video_upscale 的来源白名单 + 归属校验,音频同源纪律:
/api/images 归属校验 / 本地配音·音频产物 URL / SSRF 白名单外部 URL)→ 下载 →
multipart 上传 agent(/v1/video/upload)→ submit → Job(kind=lipsync,
status=processing, params 溯源)→ 后台任务轮询 status(5s 间隔,30min 预算,
同 scope 的进程内后台任务模式)→ succeeded 且 degraded=false → 结果视频落
content_subdir("lipsync") → Job done;degraded=true(未检出人脸/推理失败,
agent 返回原视频副本)→ Job error 不造假;failed/超时 → Job error。

agent 契约(单 worker 串行;内部自动 25fps/16kHz 归一):
- POST /v1/video/upload(multipart: media 文件 + type 字段)→ {"filename"}
- POST /v1/lipsync/submit(JSON {video, audio,
  inference_steps?, guidance_scale?})→ {"task_id"}
- GET /v1/lipsync/status/{task_id} → {status: pending|running|succeeded|failed,
  progress, degraded, ...}
- GET /v1/lipsync/result/{task_id} → {"video_url","duration_seconds"};
  video_url 为 agent 侧 /files/output/xxx.mp4(完整 URL = {agent} + 该路径)

后台任务是进程内的:api 重启后 processing 作业由 reconcile_interrupted()
(挂 main lifespan)按 params 快照(task_id + 产物名)重挂轮询(agent 侧任务
状态仍在,幂等);快照损坏标 error 不造假。产物由本路由
/video/lipsync/output/{name} 服务(Range),与 chromakey/upscale 同口径,
不经 /api/images worker 代理。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.audio_orchestrate import _allowed_source, _check_redirect
from app.routes.images import _ranged_response
from app.services import service_orchestrator as orch_svc
from app.services import video_upscale as upscale_svc
from app.storage import audio_output_root, content_subdir
from app.versioning import params_snapshot

logger = logging.getLogger(__name__)

router = APIRouter()

_OUT_NAME_RE = re.compile(r"^lipsync-[0-9a-f]{32}\.mp4$")
_DOWNLOAD_TIMEOUT = 120.0  # 两源下载(外部 URL)
_UPLOAD_TIMEOUT = 300.0  # 上传 agent(大视频给足余量)
_SUBMIT_TIMEOUT = 60.0
_POLL_INTERVAL = 5.0  # 状态轮询间隔(秒)
_POLL_TIMEOUT = 1800.0  # 总轮询预算 30min(单 worker 串行,排队也算在内)
_STATUS_TIMEOUT = 15.0  # 单次 status/result 查询
_RESULT_TIMEOUT = 300.0  # 结果视频下载
_MAX_VIDEO_BYTES = 500 * 1024 * 1024  # 外部 URL 视频上限 500MB
_MAX_AUDIO_BYTES = 100 * 1024 * 1024  # 外部 URL 音频上限 100MB

# 后台任务强引用集合(asyncio 仅持弱引用,防 GC 提前回收;同 scope._BG_TASKS)
_BG_TASKS: set[asyncio.Task] = set()


class VideoLipsyncRequest(BaseModel):
    """通用对口型请求:video_url 为源视频(作品库产物/本地产物/白名单外部 URL),
    audio_url 为驱动音频(同源纪律);inference_steps/guidance_scale 透传 agent。"""

    video_url: str = Field(min_length=1, max_length=2048)
    audio_url: str = Field(min_length=1, max_length=2048)
    inference_steps: int = Field(default=10, ge=1, le=200)  # 服务端已切 DPM-Solver++,10 步即达原 40 步质量(P1.1)
    guidance_scale: float = Field(default=1.5, ge=0.0, le=10.0)


def _base() -> str:
    """LatentSync agent 基址(已去尾斜杠);空串 = 未部署。"""
    return get_settings().lipsync_url.strip().rstrip("/")


def product_root() -> Path:
    """对口型产物根目录(content_dir/lipsync;prod 可指 NAS 挂载点)。"""
    return content_subdir("lipsync")


# ---------------------------------------------------------------------------
# 来源校验(视频复用 video_upscale 归属体系;音频同纪律)
# ---------------------------------------------------------------------------
def _audio_local_path(url: str) -> Path:
    """本地音频产物 URL → 磁盘路径;非法名 422、文件不存在 404。

    覆盖:TTS 配音(/api/manju/voice/)、音频编排(/api/audio/orch/files/)、
    人声分离(/api/audio/files/);regex 与各服务路由保持一致。
    """
    if url.startswith("/api/manju/voice/"):
        name = url.rsplit("/", 1)[-1]
        if not re.fullmatch(r"voice(?:ref)?-[0-9a-f]{32}\.wav", name):
            raise HTTPException(status_code=422, detail="非法的配音产物文件名")
        path = content_subdir("manju") / name
    elif url.startswith(("/api/audio/orch/files/", "/api/audio/files/")):
        name = url.rsplit("/", 1)[-1]
        if not re.fullmatch(r"audio(?:orch|sep)-[0-9a-f]{32}\.wav", name):
            raise HTTPException(status_code=422, detail="非法的音频产物文件名")
        # NAS 根目录与本地回退目录依次找(与各服务路由同一口径)
        path = next(
            (r / name for r in (audio_output_root(), content_subdir("audio")) if (r / name).is_file()),
            audio_output_root() / name,
        )
    else:
        raise HTTPException(
            status_code=422,
            detail="不支持的音频来源(需作品库产物 /api/images、配音/音频产物 URL 或白名单 URL)",
        )
    if not path.is_file():
        raise HTTPException(status_code=404, detail="源音频文件不存在")
    return path


def _resolve_video_source(session: Session, user: User, video_url: str) -> bool:
    """视频来源校验:本地相对 URL 走归属体系(422/404/403 由 helper 抛出),
    外部 URL 走 SSRF 白名单;返回新作业应继承的 nsfw 标记。"""
    if video_url.startswith("/"):
        return upscale_svc.resolve_source_ownership(session, user, video_url)
    if not _allowed_source(video_url):
        raise HTTPException(status_code=400, detail="视频来源不在白名单内")
    return False


def _resolve_audio_source(session: Session, user: User, audio_url: str) -> bool:
    """音频来源校验(语义同 _resolve_video_source)。"""
    if audio_url.startswith("/api/images?"):
        # worker 产物(音视通用):归属/签名/R18 门控全继承
        return upscale_svc.resolve_source_ownership(session, user, audio_url)
    if audio_url.startswith("/"):
        _audio_local_path(audio_url)  # 422/404 由 helper 抛出
        return False
    if not _allowed_source(audio_url):
        raise HTTPException(status_code=400, detail="音频来源不在白名单内")
    return False


# ---------------------------------------------------------------------------
# 下载(来源已过校验;失败 400,与 chromakey 前景纪律一致)
# ---------------------------------------------------------------------------
async def _download_external(url: str, dest: Path, max_bytes: int, label: str) -> None:
    """外部白名单 URL → 本地文件(体积上限防内存撑爆)。"""
    try:
        async with httpx.AsyncClient(
            timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            r = await client.get(url)
            _check_redirect(r, url)
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"{label}下载失败:{e}") from e
    if not r.content:
        raise HTTPException(status_code=400, detail=f"{label}下载为空")
    if len(r.content) > max_bytes:
        raise HTTPException(
            status_code=413, detail=f"{label}过大(上限 {max_bytes // 1024 // 1024}MB)"
        )
    await asyncio.to_thread(dest.write_bytes, r.content)


def _suffix(url: str, default: str) -> str:
    """从 URL 路径推导扩展名(ffmpeg 按内容探测,扩展名仅是提示)。"""
    ext = Path(urlsplit(url).path).suffix.lower()
    return ext if re.fullmatch(r"\.[a-z0-9]{2,5}", ext) else default


async def _fetch_video(video_url: str, dest: Path) -> None:
    if video_url.startswith("/"):
        await upscale_svc._fetch_source_local(video_url, dest)  # VideoUpscaleError 由调用方转 400
        return
    await _download_external(video_url, dest, _MAX_VIDEO_BYTES, "视频")


async def _fetch_audio(audio_url: str, dest: Path) -> None:
    if audio_url.startswith("/api/images?"):
        await upscale_svc._fetch_source_local(audio_url, dest)
        return
    if audio_url.startswith("/"):
        src = _audio_local_path(audio_url)
        await asyncio.to_thread(shutil.copyfile, src, dest)
        return
    await _download_external(audio_url, dest, _MAX_AUDIO_BYTES, "音频")


# ---------------------------------------------------------------------------
# agent 调用(上传 / 提交;不可达与非 2xx 一律 502,同 opentalking 代理纪律)
# ---------------------------------------------------------------------------
def _resp_detail(r: httpx.Response) -> str:
    try:
        return str(r.json().get("detail") or "")[:200]
    except (ValueError, AttributeError):
        return (r.text or "")[:200]


async def _upload_media(
    client: httpx.AsyncClient, base: str, path: Path, media_type: str
) -> str:
    """multipart 上传单个媒体文件 → agent 侧 filename。"""
    content = await asyncio.to_thread(path.read_bytes)
    files = {"media": (path.name, content, "application/octet-stream")}
    try:
        r = await client.post(
            f"{base}/v1/video/upload", files=files, data={"type": media_type}
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"对口型引擎不可达:{e}") from e
    if r.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"对口型引擎上传失败(status={r.status_code}):{_resp_detail(r)}",
        )
    try:
        filename = str(r.json().get("filename") or "")
    except ValueError:
        filename = ""
    if not filename:
        raise HTTPException(status_code=502, detail="对口型引擎上传响应缺 filename")
    return filename


async def _submit(
    client: httpx.AsyncClient,
    base: str,
    video_filename: str,
    audio_filename: str,
    inference_steps: int,
    guidance_scale: float,
) -> str:
    """提交对口型任务 → task_id。"""
    try:
        r = await client.post(
            f"{base}/v1/lipsync/submit",
            json={
                # 字段名是 video/audio(非 video_filename,2026-08-27 生产 400 实证)
                "video": video_filename,
                "audio": audio_filename,
                "inference_steps": inference_steps,
                "guidance_scale": guidance_scale,
            },
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"对口型引擎不可达:{e}") from e
    if r.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"对口型引擎提交失败(status={r.status_code}):{_resp_detail(r)}",
        )
    try:
        task_id = str(r.json().get("task_id") or "")
    except ValueError:
        task_id = ""
    if not task_id:
        raise HTTPException(status_code=502, detail="对口型引擎提交响应缺 task_id")
    return task_id


# ---------------------------------------------------------------------------
# Job 写回(晚绑定 engine:测试可 patch app.db.engine,同 video_upscale 纪律)
# ---------------------------------------------------------------------------
def _set_job(
    prompt_id: str, status: str, urls: list[str] | None = None, reason: str = ""
) -> None:
    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None:
            return
        job.status = status
        if urls is not None:
            job.result = json.dumps(urls, ensure_ascii=False)
        if reason:
            # 无独立 error 列:错误说明写 hold_reason(作品库列表/助手统一透出口径)
            job.hold_reason = reason
        s.add(job)
        s.commit()


# ---------------------------------------------------------------------------
# 后台轮询(进程内任务,同 scope 模式;瞬时网络故障容忍到总预算耗尽)
# ---------------------------------------------------------------------------
async def _finish_success(
    client: httpx.AsyncClient, base: str, prompt_id: str, task_id: str, name: str
) -> None:
    """succeeded 且非 degraded:取结果元信息 → 下载成片 → 落盘 → Job done。"""
    try:
        rr = await client.get(f"{base}/v1/lipsync/result/{task_id}")
    except httpx.HTTPError as e:
        _set_job(prompt_id, "error", reason=f"对口型结果查询失败:{e}")
        return
    if rr.status_code != 200:
        _set_job(prompt_id, "error", reason=f"对口型结果查询失败(status={rr.status_code})")
        return
    try:
        payload = rr.json()
    except ValueError:
        _set_job(prompt_id, "error", reason="对口型结果响应非 JSON")
        return
    video_url = str(payload.get("video_url") or "")
    if not video_url:
        _set_job(prompt_id, "error", reason="对口型结果缺 video_url")
        return
    if video_url.startswith(("http://", "https://")):
        download = video_url
    else:
        download = base + (video_url if video_url.startswith("/") else "/" + video_url)
    try:
        vr = await client.get(download, timeout=_RESULT_TIMEOUT)
    except httpx.HTTPError as e:
        _set_job(prompt_id, "error", reason=f"对口型产物下载失败:{e}")
        return
    if vr.status_code != 200 or not vr.content:
        _set_job(prompt_id, "error", reason=f"对口型产物下载失败(status={vr.status_code})")
        return
    try:
        root = product_root()
        root.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread((root / name).write_bytes, vr.content)
    except OSError as e:
        _set_job(prompt_id, "error", reason=f"对口型产物落盘失败:{e}")
        return
    _set_job(prompt_id, "done", [f"/api/video/lipsync/output/{name}"])
    logger.info("对口型完成 %s → %s(%.1fs)", prompt_id, name,
                float(payload.get("duration_seconds") or 0.0))


async def _run_job(prompt_id: str, task_id: str, name: str) -> None:
    """后台轮询主体:pending/running 续等;succeeded/failed/超时落终态。"""
    base = _base()
    if not base:
        _set_job(prompt_id, "error", reason="对口型引擎未配置")
        return
    deadline = time.monotonic() + _POLL_TIMEOUT
    try:
        async with httpx.AsyncClient(timeout=_STATUS_TIMEOUT, trust_env=False) as client:
            while True:
                if time.monotonic() >= deadline:
                    _set_job(
                        prompt_id, "error",
                        reason=f"对口型轮询超时({int(_POLL_TIMEOUT) // 60}min)",
                    )
                    return
                try:
                    r = await client.get(f"{base}/v1/lipsync/status/{task_id}")
                except httpx.HTTPError as e:
                    # 瞬时故障(重启/抖动)不判死,容忍到总预算耗尽
                    logger.warning("对口型状态轮询瞬时失败 %s: %s", task_id, e)
                    await asyncio.sleep(_POLL_INTERVAL)
                    continue
                if r.status_code != 200:
                    await asyncio.sleep(_POLL_INTERVAL)
                    continue
                try:
                    payload = r.json()
                except ValueError:
                    await asyncio.sleep(_POLL_INTERVAL)
                    continue
                status = str(payload.get("status") or "")
                if status == "failed":
                    detail = str(payload.get("error") or payload.get("message") or "")[:200]
                    _set_job(
                        prompt_id, "error",
                        reason=f"对口型引擎推理失败{(':' + detail) if detail else ''}",
                    )
                    return
                if status == "succeeded":
                    if payload.get("degraded"):
                        # agent 返回原视频副本:不建档不造假,明确降级原因
                        _set_job(
                            prompt_id, "error",
                            reason="推理降级(未检出人脸或推理失败),产物为原视频副本",
                        )
                        return
                    await _finish_success(client, base, prompt_id, task_id, name)
                    return
                await asyncio.sleep(_POLL_INTERVAL)  # pending/running
    except Exception as e:  # noqa: BLE001 — 后台任务任何意外都必须落终态
        logger.exception("对口型后台任务异常 %s: %s", prompt_id, e)
        _set_job(prompt_id, "error", reason=f"对口型后台任务异常:{str(e)[:200]}")


def spawn_lipsync_job(prompt_id: str, task_id: str, name: str) -> asyncio.Task:
    """fire-and-forget(持强引用防 GC;同 prompt_id 幂等,同 scope.spawn_scope_job)。"""
    key = f"video-lipsync:{prompt_id}"
    for t in _BG_TASKS:
        if t.get_name() == key and not t.done():
            return t
    task = asyncio.create_task(_run_job(prompt_id, task_id, name), name=key)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


def reconcile_interrupted() -> int:
    """api 重启后,进程内后台任务已丢:未终态 lipsync 作业按 params 快照重挂轮询
    (agent 侧任务状态仍在,幂等续等);快照损坏标 error 不造假。返回重挂数量。"""
    from app.db import engine

    rehang = 0
    with Session(engine) as s:
        jobs = s.exec(
            select(Job).where(
                Job.kind == "lipsync",
                Job.status.in_(("processing", "queued", "running")),  # type: ignore[attr-defined]
            )
        ).all()
        for job in jobs:
            task_id, name = "", ""
            try:
                params = json.loads(job.params) if job.params else {}
                task_id = str(params.get("task_id") or "")
                name = str(params.get("output") or "")
            except ValueError:
                pass
            if not task_id or not _OUT_NAME_RE.fullmatch(name):
                job.status = "error"
                job.hold_reason = "服务重启且任务快照损坏,无法续跑"
                s.add(job)
                s.commit()
                continue
            spawn_lipsync_job(job.prompt_id, task_id, name)
            rehang += 1
    if rehang:
        logger.info("reconcile: 重挂 %d 个未终态对口型作业(续轮询)", rehang)
    return rehang


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------
@router.post("/video/lipsync")
async def video_lipsync_submit(
    body: VideoLipsyncRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """提交通用对口型:下载两源 → 上传 agent → submit → 建档(processing)
    → 后台轮询;前端经 /api/jobs 回读终态与产物。

    错误纪律:lipsync_url 空 503;来源非法 422/404/403、非白名单 400;
    两源下载失败 400;agent 不可达/上传/提交失败 502。
    """
    base = _base()
    if not base:
        raise HTTPException(status_code=503, detail="对口型引擎未配置(TOIV_LIPSYNC_URL 为空)")
    enforce_generation_rate_limit(user)
    video_url = body.video_url.strip()
    audio_url = body.audio_url.strip()
    # 两源校验必须各自执行(or 短路会在 video 继承 nsfw=True 时跳过 audio 白名单校验)
    v_nsfw = _resolve_video_source(session, user, video_url)
    a_nsfw = _resolve_audio_source(session, user, audio_url)
    nsfw = v_nsfw or a_nsfw

    # R2 冷层接线:来源校验过后再唤醒 lipsync(校验失败不白唤醒 GPU;唤醒失败 503
    # 不下载不建档)。唤醒在建 Job 之前同步完成——Job 落库时服务已 running,无
    # 「作业在跑而服务被回收」窗口;且 lipsync 作业走自有 task_id 轮询(非 comfy
    # tracker 的 prompt_id 孤儿检测),唤醒期不会被误杀。开关关/条目禁用时直通。
    await orch_svc.ensure_awake(
        "lipsync",
        enabled=bool(getattr(get_settings(), "orch_wake_on_call", False)),
    )

    name = f"lipsync-{uuid.uuid4().hex}.mp4"
    with tempfile.TemporaryDirectory() as td:
        v_path = Path(td) / f"video{_suffix(video_url, '.mp4')}"
        a_path = Path(td) / f"audio{_suffix(audio_url, '.wav')}"
        try:
            await _fetch_video(video_url, v_path)
        except HTTPException:
            raise
        except Exception as e:  # VideoUpscaleError 等下载失败 → 400(客户端源问题)
            raise HTTPException(status_code=400, detail=f"视频下载失败:{e}") from e
        try:
            await _fetch_audio(audio_url, a_path)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"音频下载失败:{e}") from e

        async with httpx.AsyncClient(timeout=_UPLOAD_TIMEOUT, trust_env=False) as client:
            video_filename = await _upload_media(client, base, v_path, "video")
            audio_filename = await _upload_media(client, base, a_path, "audio")
            task_id = await _submit(
                client, base, video_filename, audio_filename,
                body.inference_steps, body.guidance_scale,
            )

    prompt_id = f"lipsync-{uuid.uuid4().hex}"
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        worker=base,
        kind="lipsync",
        status="processing",
        prompt="通用对口型(LatentSync)",
        seed=0,
        nsfw=nsfw,
        # 快照存 URL 源 + agent task_id + 产物名(重启重挂轮询用,见 reconcile_interrupted)
        params=params_snapshot(body, task_id=task_id, output=name),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    spawn_lipsync_job(prompt_id, task_id, name)
    return {
        "job_id": job.id,
        "prompt_id": prompt_id,
        "task_id": task_id,
        "kind": "lipsync",
        "status": "processing",
    }


@router.get("/video/lipsync/output/{name}")
async def lipsync_output(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),  # <video> 走 ?token= 查询参数(deps 内置回退)
) -> Response:
    """回读对口型产物(手动 Range,同 chromakey/scope 文件服务)。"""
    if not _OUT_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = product_root() / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="产物不存在")
    return _ranged_response(path.read_bytes(), "video/mp4", request.headers.get("range"))
