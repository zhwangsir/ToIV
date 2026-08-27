"""视频超分服务(4K)—— probe → 抽帧 → M6 fleet 并行帧超分 → ffmpeg 合并 → Job 回写。

设计要点:
- 纯后台管线(端点建档秒回,spawn 协程执行);产物落 core 本地
  (content_subdir("video-upscale")),由 routes/video_upscale.py 直接服务,
  不经 /api/images worker 代理 → deps.resolve_worker 无需改动。
- fleet = 超分专用 ComfyUI 实例(生产 :8261/:8262/:8263,GPU1/2/3,仅 4x-UltraSharp,
  不入 WorkerPool);经标准 HTTP API(upload/prompt/history/view)访问,无共享文件系统依赖。
  round-robin 分片 + 每实例 ≤2 并发(真实吞吐 ~75-148 帧/min/3 卡,AGENTS.md 易错点 28)。
- 断点续跑:帧目录(产物盘 frames/<job_id>/)保留到成功;失败/重启后已超分帧跳过。
  api 重启由 reconcile_interrupted()(main.py lifespan 调用)重挂未终态作业。
- 目标分辨率服务端推导(横 3840×2160 / 竖 2160×3840),画幅方向护栏,禁止用户手填。
- 帧级进度:内存注册表(job_id → stage/done/total/pct),经路由轮询端点透出;
  api 重启后注册表丢失 → 进度 null(前端 indeterminate),作业照常续跑。
- 整体预算 = settings.job_track_timeout(默认 7200s);超预算标 error 收口,帧保留。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import hmac

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import image_sig
from app.config import get_settings
from app.models import Job, User
from app.storage import content_subdir, drama_output_root
from app.workflows.video_upscale import (
    DEFAULT_UPSCALE_MODEL,
    FrameUpscaleParams,
    assert_orientation_compatible,
    build_frame_upscale_graph,
    derive_target_resolution,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
# 单帧超分等待上限(实测 4K PNG 帧 1-2s;600s 兜住 fleet 排队/冷载模型)
_FRAME_TIMEOUT = 600.0
# 每实例同时在跑的帧数上限(任务书:控制并发每实例 ≤2)
_PER_WORKER_CONCURRENCY = 2
# fleet 健康探测短超时(死实例快速剔除,不拖慢提交)
_HEALTH_TIMEOUT = 4.0
# 帧轮询 history 间隔
_POLL_INTERVAL = 1.0
# ffmpeg/ffprobe 单次调用上限(抽帧/抽音轨/合并);4K 合并长片给足余量
_FF_TIMEOUT = 1800.0
# 产物文件名约束(routes 服务端点同款 regex;两处保持一致)
OUTPUT_NAME_RE = re.compile(r"^upscale-[0-9a-f]{32}\.mp4$")

# 后台任务强引用集合(asyncio 仅持弱引用,防 GC 提前回收;同 drama_studio._spawn)
_BG_TASKS: set[asyncio.Task] = set()
# 帧级进度注册表:job_id → {stage, done, total, pct, detail}(进程内存,重启即丢)
_PROGRESS: dict[str, dict[str, Any]] = {}


class VideoUpscaleError(RuntimeError):
    """视频超分管线失败(源解析/probe/fleet/合并任一环);消息直接落 Job error 语义。"""


# ---------------------------------------------------------------------------
# 存储路径(产物盘;/tmp 禁大文件 —— AGENTS.md 易错点 2)
# ---------------------------------------------------------------------------
def product_root() -> Path:
    """超分产物根目录(content_dir/video-upscale;prod 可指 NAS 挂载点)。"""
    return content_subdir("video-upscale")


def _work_root(job_id: str) -> Path:
    """单作业工作目录(源视频/源帧/超分帧/音轨),成功后才清理。"""
    return product_root() / "frames" / job_id


# ---------------------------------------------------------------------------
# 进度注册表
# ---------------------------------------------------------------------------
def _set_progress(
    job_id: str, stage: str, done: int = 0, total: int = 0, detail: str = ""
) -> None:
    pct = round(done / total * 100) if total > 0 else None
    _PROGRESS[job_id] = {
        "stage": stage,
        "done": done,
        "total": total,
        "pct": pct,
        "detail": detail,
    }


def progress_snapshot(job_id: str) -> dict[str, Any] | None:
    """进度快照(无记录返回 None;api 重启后进行中作业即此情形,前端按 indeterminate)。"""
    snap = _PROGRESS.get(job_id)
    return dict(snap) if snap is not None else None


# ---------------------------------------------------------------------------
# DB 写回(晚绑定 engine:测试可 patch app.db.engine 指向内存库,同 drama 后台任务)
# ---------------------------------------------------------------------------
def _set_job_status(prompt_id: str, status: str) -> None:
    from sqlmodel import Session, select

    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job and job.status != "done":
            job.status = status
            s.add(job)
            s.commit()


def _set_job_done(prompt_id: str, urls: list[str]) -> None:
    from sqlmodel import Session, select

    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job and job.status != "done":
            job.status = "done"
            job.result = json.dumps(urls)
            s.add(job)
            s.commit()


def _set_job_prompt(prompt_id: str, prompt: str) -> None:
    from sqlmodel import Session, select

    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job:
            job.prompt = prompt
            s.add(job)
            s.commit()


# ---------------------------------------------------------------------------
# ffprobe / ffmpeg 封装(全异步子进程;无 ffprobe 即报错,不静默降级)
# ---------------------------------------------------------------------------
async def _run(cmd: list[str], timeout: float = _FF_TIMEOUT) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise VideoUpscaleError(f"命令超时({timeout:.0f}s): {cmd[0]}") from None
    return proc.returncode or 0, out, err


def _require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise VideoUpscaleError(f"服务端缺少 {name},无法执行视频超分")


async def probe_video(path: Path) -> dict[str, Any]:
    """ffprobe 探测源视频:width/height/fps/帧数(可空)/是否含音轨。无 ffprobe 报错。"""
    _require_tool("ffprobe")
    rc, out, err = await _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-of", "json", str(path),
    ])
    if rc != 0:
        raise VideoUpscaleError(f"ffprobe 探测失败: {err.decode(errors='replace')[:200]}")
    try:
        stream = (json.loads(out).get("streams") or [])[0]
        w, h = int(stream["width"]), int(stream["height"])
        num, den = stream.get("r_frame_rate", "25/1").split("/")
        fps = int(num) / max(1, int(den))
    except (IndexError, KeyError, ValueError) as e:
        raise VideoUpscaleError(f"ffprobe 输出解析失败: {e}") from e
    frames_raw = stream.get("nb_frames")
    try:
        frames = int(frames_raw) if frames_raw and frames_raw != "N/A" else 0
    except (TypeError, ValueError):
        frames = 0
    # 音轨探测(无音轨 → 合并时补静音轨)
    rc_a, out_a, _ = await _run([
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path),
    ])
    has_audio = rc_a == 0 and bool(out_a.decode().strip())
    return {"width": w, "height": h, "fps": fps, "frames": frames, "has_audio": has_audio}


async def extract_frames(video: Path, out_dir: Path) -> int:
    """ffmpeg 抽帧为 frame_%06d.png;返回帧数(0 = 失败)。"""
    _require_tool("ffmpeg")
    out_dir.mkdir(parents=True, exist_ok=True)
    rc, _, err = await _run([
        "ffmpeg", "-y", "-i", str(video),
        "-pix_fmt", "rgb24", "-start_number", "1",
        str(out_dir / "frame_%06d.png"),
    ])
    if rc != 0:
        raise VideoUpscaleError(f"抽帧失败: {err.decode(errors='replace')[:200]}")
    return len(list(out_dir.glob("frame_*.png")))


async def extract_audio(video: Path, audio_path: Path) -> bool:
    """抽音轨(统一转 aac,源音轨编码不可拷贝容器时也能成功);无音轨/失败返回 False。"""
    _require_tool("ffmpeg")
    try:
        rc, _, _ = await _run([
            "ffmpeg", "-y", "-i", str(video),
            "-vn", "-c:a", "aac", "-b:a", "192k", str(audio_path),
        ])
    except VideoUpscaleError:
        return False
    return rc == 0 and audio_path.exists() and audio_path.stat().st_size > 0


async def encode_video(
    frames_dir: Path, output: Path, fps: float, audio_path: Path | None
) -> None:
    """超分帧序列 → MP4(libx264 crf18);音轨回接,无音轨补静音轨(anullsrc)。"""
    _require_tool("ffmpeg")
    cmd = [
        "ffmpeg", "-y",
        "-framerate", f"{fps:g}", "-start_number", "1",
        "-i", str(frames_dir / "upscaled_%06d.png"),
    ]
    if audio_path is not None:
        cmd += ["-i", str(audio_path)]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    cmd += [
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-shortest",
        "-movflags", "+faststart",
        str(output),
    ]
    rc, _, err = await _run(cmd)
    if rc != 0:
        raise VideoUpscaleError(f"视频合并失败: {err.decode(errors='replace')[:200]}")


# ---------------------------------------------------------------------------
# fleet 访问(超分专用 ComfyUI 实例;标准 HTTP API,无共享文件系统)
# ---------------------------------------------------------------------------
def upscale_worker_urls() -> list[str]:
    """配置的 fleet 实例列表(TOIV_UPSCALE_WORKERS,逗号分隔)。"""
    raw = get_settings().upscale_workers
    return [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]


async def healthy_upscale_workers(workers: list[str] | None = None) -> list[str]:
    """fleet 健康探测(/system_stats 短超时,并发);返回可达实例列表(保持入参序)。"""
    urls = workers if workers is not None else upscale_worker_urls()
    if not urls:
        return []

    async def _ok(url: str) -> bool:
        try:
            await ComfyUIClient(url, timeout=_HEALTH_TIMEOUT).get_system_stats()
            return True
        except ComfyUIError:
            return False

    results = await asyncio.gather(*(_ok(u) for u in urls))
    return [u for u, ok in zip(urls, results) if ok]


async def upscale_frame_remote(
    client: ComfyUIClient,
    frame_path: Path,
    upload_name: str,
    model_name: str,
    target_w: int,
    target_h: int,
    timeout: float = _FRAME_TIMEOUT,
) -> bytes:
    """单帧在 fleet 实例上超分:上传 → 提交 → 轮询 history → /view 取回 PNG 字节。"""
    content = await asyncio.to_thread(frame_path.read_bytes)
    image_name = await client.upload_image(content, upload_name)
    graph = build_frame_upscale_graph(
        FrameUpscaleParams(
            image=image_name,
            model_name=model_name,
            target_w=target_w,
            target_h=target_h,
        )
    )
    prompt_id = await client.queue_prompt(graph, uuid.uuid4().hex)

    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            history = await client.get_history(prompt_id)
        except ComfyUIError:
            history = {}
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status") or {}
            if status.get("status_str") == "error":
                raise VideoUpscaleError(f"fleet 执行错误: {str(status)[:200]}")
            for node_out in (entry.get("outputs") or {}).values():
                for img in node_out.get("images", []):
                    data, _ = await client.get_image_bytes(
                        img["filename"], img.get("subfolder", ""), img.get("type", "output")
                    )
                    return data
        await asyncio.sleep(_POLL_INTERVAL)
    raise VideoUpscaleError(f"单帧超分超时({timeout:.0f}s)")


# ---------------------------------------------------------------------------
# 源视频解析(产物 URL → 本地文件;/api/images 需归属校验防 IDOR)
# ---------------------------------------------------------------------------
def _verify_images_ownership(session, user: User, qs: dict[str, list[str]]) -> bool:
    """/api/images 源 URL 归属校验(与 routes/images.py 同一口径),返回源 Job 的 nsfw 标记。

    - 有 sig 且 HMAC 匹配 → 签名即能力,放行;nsfw 从归属 Job 尽力继承(查不到=False)
    - 无 sig → DB 归属回退(本人/同租户 Job 产物才放行;admin 直通)
    - 源 Job nsfw=True 而请求无 R18 上下文 → 403(不把 R18 产物降级成主站可见)
    校验不过抛 404(不泄露存在性)。
    """
    from fastapi import HTTPException

    from app.nsfw_ctx import nsfw_allowed

    filename = (qs.get("filename") or [""])[0]
    subfolder = (qs.get("subfolder") or [""])[0]
    type_ = (qs.get("type") or ["output"])[0]
    worker = (qs.get("worker") or [""])[0]
    sig = (qs.get("sig") or [""])[0]
    if not filename or not worker:
        raise HTTPException(status_code=422, detail="无效的产物 URL(缺 filename/worker)")

    from sqlmodel import select

    src_job = session.exec(
        select(Job)
        .where(Job.result.like(f"%filename={filename}%"))
        .where((Job.user_id == user.id) | (Job.tenant_id == user.tenant_id))
        .order_by(Job.created_at.desc())  # type: ignore[attr-defined]
    ).first()

    if sig:
        expected = image_sig(filename, subfolder, type_, worker)
        if not hmac.compare_digest(sig.encode(), expected.encode()):
            raise HTTPException(status_code=404, detail="产物不存在")
    elif user.role != "admin" and src_job is None:
        raise HTTPException(status_code=404, detail="产物不存在")

    src_nsfw = bool(src_job.nsfw) if src_job else False
    if src_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="R18 产物需在专区内操作")
    return src_nsfw


def _inherit_nsfw_by_filename(session, user: User, name: str) -> bool:
    """按产物文件名反查源 Job 继承其 nsfw 标记(二次加工链 R18 打标继承)。

    查询口径与 /api/images 分支一致(result LIKE 文件名、本人/同租户、最新优先);
    查不到源 Job 时保守置 True——宁严勿宽:R18 源片经超分/抠像/对口型后以
    SFW 标记进主站作品库是内容红线,反向误伤(查不到归属的旧产物标 R18)可接受。
    """
    from sqlmodel import select

    src_job = session.exec(
        select(Job)
        .where(Job.result.like(f"%{name}%"))
        .where((Job.user_id == user.id) | (Job.tenant_id == user.tenant_id))
        .order_by(Job.created_at.desc())  # type: ignore[attr-defined]
    ).first()
    return bool(src_job.nsfw) if src_job else True


def resolve_source_ownership(session, user: User, video_url: str) -> bool:
    """入站校验:URL 形态白名单 + 归属;返回新作业应继承的 nsfw 标记。"""
    from fastapi import HTTPException

    url = video_url.strip()
    if url.startswith("/api/images?"):
        return _verify_images_ownership(session, user, parse_qs(urlsplit(url).query))
    if url.startswith("/api/drama/output/"):
        name = url.rsplit("/", 1)[-1]
        if not re.fullmatch(r"drama-[0-9a-f]{32}\.mp4", name):
            raise HTTPException(status_code=422, detail="非法的成片文件名")
        if not (drama_output_root() / name).is_file():
            raise HTTPException(status_code=404, detail="源视频文件不存在")
        return _inherit_nsfw_by_filename(session, user, name)
    if url.startswith("/api/studio/files/"):
        name = url.rsplit("/", 1)[-1]
        if not re.fullmatch(r"[\w.-]{1,128}", name) or ".." in name:
            raise HTTPException(status_code=422, detail="非法的工作室文件名")
        if not (drama_output_root() / "studio" / name).is_file():
            raise HTTPException(status_code=404, detail="源视频文件不存在")
        return _inherit_nsfw_by_filename(session, user, name)
    if url.startswith("/api/video/upscale/output/"):
        name = url.rsplit("/", 1)[-1]
        if not OUTPUT_NAME_RE.fullmatch(name):
            raise HTTPException(status_code=422, detail="非法的超分产物文件名")
        if not (product_root() / name).is_file():
            raise HTTPException(status_code=404, detail="源视频文件不存在")
        return _inherit_nsfw_by_filename(session, user, name)
    if url.startswith("/api/video/chromakey/output/"):
        # 抠像产物(M6)可再入链(二次抠像/超分);regex 与 routes/chromakey 保持一致
        name = url.rsplit("/", 1)[-1]
        if not re.fullmatch(r"chromakey-[0-9a-f]{32}\.mp4", name):
            raise HTTPException(status_code=422, detail="非法的抠像产物文件名")
        if not (content_subdir("chromakey") / name).is_file():
            raise HTTPException(status_code=404, detail="源视频文件不存在")
        return _inherit_nsfw_by_filename(session, user, name)
    if url.startswith("/api/video/lipsync/output/"):
        # 对口型产物可再入链(超分/二次对口型);regex 与 routes/video_lipsync 保持一致
        name = url.rsplit("/", 1)[-1]
        if not re.fullmatch(r"lipsync-[0-9a-f]{32}\.mp4", name):
            raise HTTPException(status_code=422, detail="非法的对口型产物文件名")
        if not (content_subdir("lipsync") / name).is_file():
            raise HTTPException(status_code=404, detail="源视频文件不存在")
        return _inherit_nsfw_by_filename(session, user, name)
    raise HTTPException(
        status_code=422,
        detail="不支持的视频来源(需作品库产物 /api/images、短剧成片或工作室文件 URL)",
    )


async def _fetch_source_local(video_url: str, dest: Path) -> None:
    """把已过归属校验的源视频 URL 落成本地文件(供 probe/抽帧)。"""
    from fastapi import HTTPException

    if video_url.startswith("/api/images?"):
        qs = parse_qs(urlsplit(video_url).query)
        filename = (qs.get("filename") or [""])[0]
        subfolder = (qs.get("subfolder") or [""])[0]
        type_ = (qs.get("type") or ["output"])[0]
        worker = (qs.get("worker") or [""])[0]
        from app.deps import get_pool, resolve_worker

        primary = resolve_worker(worker)  # SSRF 白名单校验(deps 既有)
        host = urlsplit(primary.base_url).hostname or primary.base_url
        siblings = [
            c
            for c in get_pool().clients
            if (urlsplit(c.base_url).hostname or c.base_url) == host
            and c.base_url != primary.base_url
        ]
        last_err: Exception | None = None
        for client in [primary, *siblings]:
            try:
                content, _ = await client.get_image_bytes(filename, subfolder, type_)
                await asyncio.to_thread(dest.write_bytes, content)
                return
            except ComfyUIError as e:
                last_err = e
        raise VideoUpscaleError(f"源视频下载失败(同机 worker 均不可达): {last_err}")
    if video_url.startswith("/api/drama/output/"):
        src = drama_output_root() / video_url.rsplit("/", 1)[-1]
    elif video_url.startswith("/api/studio/files/"):
        src = drama_output_root() / "studio" / video_url.rsplit("/", 1)[-1]
    elif video_url.startswith("/api/video/upscale/output/"):
        src = product_root() / video_url.rsplit("/", 1)[-1]
    elif video_url.startswith("/api/video/chromakey/output/"):
        src = content_subdir("chromakey") / video_url.rsplit("/", 1)[-1]
    elif video_url.startswith("/api/video/lipsync/output/"):
        src = content_subdir("lipsync") / video_url.rsplit("/", 1)[-1]
    else:
        raise HTTPException(status_code=422, detail="不支持的视频来源")
    if not src.is_file():
        raise VideoUpscaleError("源视频文件不存在(可能已被清理)")
    await asyncio.to_thread(shutil.copyfile, src, dest)


# ---------------------------------------------------------------------------
# 后台管线
# ---------------------------------------------------------------------------
def spawn_upscale(
    job_id: str,
    prompt_id: str,
    video_url: str,
    target: str,
    workers: list[str] | None = None,
) -> asyncio.Task:
    """fire-and-forget 启动超分管线(持强引用防 GC;同 prompt_id 幂等)。"""
    key = f"video-upscale:{job_id}"
    for t in _BG_TASKS:
        if t.get_name() == key and not t.done():
            return t
    task = asyncio.create_task(
        run_pipeline(job_id, prompt_id, video_url, target, workers), name=key
    )
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


async def _upscale_shard(
    client: ComfyUIClient,
    fallbacks: list[ComfyUIClient],
    shard: list[tuple[int, Path]],
    out_dir: Path,
    model_name: str,
    target_w: int,
    target_h: int,
    deadline: float,
    counters: dict[str, Any],
) -> None:
    """单实例分片处理:最多 _PER_WORKER_CONCURRENCY 帧在飞;失败帧换实例重试 1 次。"""

    async def _one(frame_idx: int, frame_path: Path) -> None:
        out_path = out_dir / f"upscaled_{frame_idx:06d}.png"
        upload_name = f"vup-{uuid.uuid4().hex[:8]}-{frame_idx:06d}.png"
        # 首试 + 1 次重试(重试优先落到其他实例扛单实例掉线;仅 1 实例时同实例重试)
        retry_client = fallbacks[0] if fallbacks else client
        last_err: Exception | None = None
        for attempt, cli in enumerate((client, retry_client)):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VideoUpscaleError("整体超时预算耗尽")
            try:
                data = await upscale_frame_remote(
                    cli, frame_path, upload_name, model_name, target_w, target_h,
                    timeout=min(_FRAME_TIMEOUT, remaining),
                )
                await asyncio.to_thread(out_path.write_bytes, data)
                counters["done"] += 1
                return
            except Exception as e:  # noqa: BLE001 — 收集后由缺失帧检测兜底
                last_err = e
                if attempt == 0:
                    logger.warning("帧 %d @ %s 首试失败,换实例重试: %s", frame_idx, cli.base_url, e)
        raise VideoUpscaleError(f"帧 {frame_idx} 超分失败: {last_err}")

    pending: set[asyncio.Task] = set()
    for frame_idx, frame_path in shard:
        if time.monotonic() >= deadline:
            raise VideoUpscaleError("整体超时预算耗尽")
        task = asyncio.create_task(_one(frame_idx, frame_path))
        pending.add(task)
        task.add_done_callback(pending.discard)
        if len(pending) >= _PER_WORKER_CONCURRENCY:
            done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for d in done:
                if (exc := d.exception()) is not None:
                    counters["errors"].append(str(exc))
    if pending:
        done, _ = await asyncio.wait(pending)
        for d in done:
            if (exc := d.exception()) is not None:
                counters["errors"].append(str(exc))


async def run_pipeline(
    job_id: str,
    prompt_id: str,
    video_url: str,
    target: str,
    workers: list[str] | None = None,
    *,
    fused: bool = False,
) -> None:
    """超分管线主体(后台):probe → 推导 → 抽帧 → fleet 并行 → 合并 → 回写。

    可恢复:源帧/超分帧/音轨落工作目录,已存在即跳过(续跑语义);
    成功后才清工作目录,失败/超时保留供重试。

    fused=True(RES-2026-08-18 生成链融合模式):挂在生成 Job 上而非独立
    video_upscale Job——不覆盖生成提示词、不改 done 状态,终产物经
    _fused_finish 原子回写(result+post_status 清零);失败仅清 post_status
    保留原生成原片(超分是增强,失败不能毁掉已成功的生成)。
    """
    settings = get_settings()
    work = _work_root(job_id)
    src_dir = work / "src"
    out_dir = work / "upscaled"
    source_video = work / "source.mp4"
    audio_path = work / "audio.m4a"
    deadline = time.monotonic() + settings.job_track_timeout
    try:
        if not fused:
            _set_job_status(prompt_id, "running")
        _set_progress(job_id, "preparing")

        # 1. 源视频落本地 + probe(无 ffprobe 直接报错)
        work.mkdir(parents=True, exist_ok=True)
        if not source_video.exists():
            await _fetch_source_local(video_url, source_video)
        meta = await probe_video(source_video)
        target_w, target_h = derive_target_resolution(meta["width"], meta["height"], target)
        # 画幅方向护栏(易错点 28;derive 天然满足,此为最终防御)
        assert_orientation_compatible(meta["width"], meta["height"], target_w, target_h)

        # 2. 抽帧(续跑:已有源帧则跳过)+ 帧数以实际抽取为准(nb_frames 容器字段不可信)
        existing_src = sorted(src_dir.glob("frame_*.png")) if src_dir.is_dir() else []
        if existing_src:
            total = len(existing_src)
        else:
            total = await extract_frames(source_video, src_dir)
        if total <= 0:
            raise VideoUpscaleError("抽帧结果为空(源视频可能损坏)")
        if not fused:
            _set_job_prompt(
                prompt_id,
                f"视频超分 {target.upper()} · {meta['width']}×{meta['height']} → "
                f"{target_w}×{target_h} · {total}帧@{meta['fps']:g}fps",
            )
        if meta["has_audio"] and not audio_path.exists():
            await extract_audio(source_video, audio_path)

        # 3. fleet 健康探测(至少 1 实例;端点已预检,后台再核一次扛中途掉线)
        urls = workers or upscale_worker_urls()
        healthy = await healthy_upscale_workers(urls)
        if not healthy:
            raise VideoUpscaleError("超分引擎全部离线(fleet 无可用实例)")

        # 4. round-robin 分片逐帧超分(已超分帧跳过 → 续跑;每实例 ≤2 并发)
        pending_frames = [
            (i, src_dir / f"frame_{i:06d}.png")
            for i in range(1, total + 1)
            if not (out_dir / f"upscaled_{i:06d}.png").exists()
        ]
        out_dir.mkdir(parents=True, exist_ok=True)
        skipped = total - len(pending_frames)
        counters: dict[str, Any] = {"done": skipped, "errors": []}
        _set_progress(job_id, "upscaling", skipped, total)
        clients = [ComfyUIClient(u, timeout=settings.request_timeout) for u in healthy]
        shards: list[list[tuple[int, Path]]] = [[] for _ in clients]
        for i, item in enumerate(pending_frames):
            shards[i % len(clients)].append(item)

        async def _progress_watch() -> None:
            while counters["done"] < total:
                _set_progress(
                    job_id, "upscaling", counters["done"], total,
                    detail=f"{len(counters['errors'])} 帧失败待检测" if counters["errors"] else "",
                )
                await asyncio.sleep(2.0)

        watch = asyncio.create_task(_progress_watch())
        try:
            results = await asyncio.gather(
                *(
                    _upscale_shard(
                        client, [c for c in clients if c is not client], shard,
                        out_dir, DEFAULT_UPSCALE_MODEL, target_w, target_h,
                        deadline, counters,
                    )
                    for client, shard in zip(clients, shards) if shard
                ),
                return_exceptions=True,  # 单 shard 超时/异常不打断其余 shard 收尾,统一进缺失检测
            )
            for r in results:
                if isinstance(r, Exception):
                    counters["errors"].append(str(r))
        finally:
            watch.cancel()

        # 5. 缺失帧检测(失败帧兜底;有缺失即 error,帧保留可续跑)
        missing = [
            i for i in range(1, total + 1)
            if not (out_dir / f"upscaled_{i:06d}.png").exists()
        ]
        if missing:
            preview = ",".join(str(i) for i in missing[:10])
            raise VideoUpscaleError(
                f"{len(missing)} 帧超分失败(帧号 {preview}{'…' if len(missing) > 10 else ''});"
                f"已保留帧目录,可重新发起续跑"
            )

        # 6. 合并(libx264;音轨回接,无音轨补静音)
        _set_progress(job_id, "encoding", total, total)
        name = f"upscale-{job_id}.mp4"
        product = product_root() / name
        await encode_video(
            out_dir, product, meta["fps"], audio_path if audio_path.exists() else None
        )
        # 出片校验:分辨率必须等于目标(防 fleet 图被篡改/错配)
        out_meta = await probe_video(product)
        if (out_meta["width"], out_meta["height"]) != (target_w, target_h):
            product.unlink(missing_ok=True)
            raise VideoUpscaleError(
                f"出片分辨率 {out_meta['width']}×{out_meta['height']} 与目标 "
                f"{target_w}×{target_h} 不符"
            )

        if fused:
            _fused_finish(prompt_id, [f"/api/video/upscale/output/{name}"])
        else:
            _set_job_done(prompt_id, [f"/api/video/upscale/output/{name}"])
        _set_progress(job_id, "done", total, total)
        # 成功后才清工作目录(keep-frames 语义:失败保留,成功清理)
        await asyncio.to_thread(shutil.rmtree, work, True)
        logger.info(
            "视频超分完成 job=%s: %d 帧 → %s(%d×%d)",
            job_id, total, name, target_w, target_h,
        )
    except Exception as e:  # noqa: BLE001 — 后台管线任何意外都必须落终态
        logger.exception("视频超分失败 job=%s: %s", job_id, e)
        _set_progress(job_id, "error", detail=str(e)[:200])
        if fused:
            # 生成原片是成功的:只清后处理标记回落原片,不标 error
            _mark_post_status(prompt_id, "")
        else:
            _set_job_status(prompt_id, "error")


def _mark_post_status(prompt_id: str, flag: str) -> None:
    from sqlmodel import Session, select

    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job:
            job.post_status = flag
            s.add(job)
            s.commit()


def _fused_finish(prompt_id: str, urls: list[str]) -> None:
    """融合模式终态:同一 commit 原子写 result + 清 post_status(status 已是 done)。

    与 duration 链的 rewrite_job_result 同语义;本地实现避免与
    services.video_generators 互相 import(该模块族较重,防环)。
    """
    from sqlmodel import Session, select

    from app.db import engine

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job:
            job.status = "done"
            job.result = json.dumps(urls)
            job.post_status = ""
            s.add(job)
            s.commit()


# ---------------------------------------------------------------------------
# 生成链融合超分(RES-2026-08-18):请求目标超引擎原生上限时自动挂链
# ---------------------------------------------------------------------------

def maybe_chain_upscale(prompt_id: str, target: str, workers: list[str] | None = None) -> bool:
    """生成提交成功后挂融合超分链;返回是否实际挂链。

    流程(后台 task):
    1. 等待生成 Job 终态(done 且 post_status 清零 = 生成与时长链均完成;error 则放弃);
    2. 置 post_status=processing(前端转「超分中」并轮询终产物);
    3. run_pipeline(fused) → 原子回写超分产物;失败清标记回落原片。
    幂等:同 prompt_id 已有在跑链则跳过。
    """
    key = f"gen-upscale:{prompt_id}"
    for t in _BG_TASKS:
        if t.get_name() == key and not t.done():
            return False

    async def _wait_and_run() -> None:
        settings = get_settings()
        deadline = time.monotonic() + settings.job_track_timeout
        from sqlmodel import Session, select

        from app.db import engine

        # 资源预算二期:held 作业放行后 prompt_id 从占位符(hold-*)换真实值,
        # 首次见到即记 job.id,后续按 id 跟踪,不受换名影响(见 services/hold_queue)
        job_id: str | None = None
        while time.monotonic() < deadline:
            await asyncio.sleep(5.0)
            with Session(engine) as s:
                job = (
                    s.get(Job, job_id)
                    if job_id
                    else s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                )
                if not job:
                    return
                job_id = job.id
                if job.status == "error":
                    logger.info("生成失败,放弃超分链 %s", prompt_id)
                    return
                if job.status == "done" and not job.post_status:
                    video_url = (json.loads(job.result) or [""])[0] if job.result else ""
                    if not video_url:
                        return
                    _mark_post_status(prompt_id, "processing")
                    gen_job_id = job.id
                    break
        else:
            logger.warning("超分链等待生成超时 %s", prompt_id)
            return
        await run_pipeline(gen_job_id, prompt_id, video_url, target, workers, fused=True)

    task = asyncio.create_task(_wait_and_run(), name=key)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return True


def reconcile_interrupted() -> int:
    """api 启动时收口:未终态 video_upscale 作业重挂续跑(帧目录在则断点续传)。

    参照 tracker.reconcile_pending / drama_studio.reconcile_interrupted;
    需在已有事件循环的上下文调用(spawn 内 create_task)。返回重挂数量。
    """
    from sqlmodel import Session, select

    from app.db import engine

    rehang = 0
    with Session(engine) as s:
        rows = s.exec(
            select(Job).where(
                Job.kind == "video_upscale", Job.status.in_(("queued", "running"))  # type: ignore[attr-defined]
            )
        ).all()
        for job in rows:
            video_url, target = "", "4k"
            try:
                params = json.loads(job.params) if job.params else {}
                video_url = str(params.get("video_url") or "")
                target = str(params.get("target") or "4k")
            except ValueError:
                pass
            if not video_url:
                job.status = "error"
                s.add(job)
                s.commit()
                continue
            spawn_upscale(job.id, job.prompt_id, video_url, target)
            rehang += 1
    if rehang:
        logger.info("reconcile: 重挂 %d 个未终态视频超分作业(断点续跑)", rehang)
    return rehang
