"""视频译制·智能剪辑工坊 —— 已有长视频的处理入口。

  POST /api/dub/upload              multipart(video) → 大文件流式落盘 → {name, url, size}
  GET  /api/dub/source/{name}       回服务上传的源视频(供前端预览 / 后端管线下载)
  POST /api/dub/autocut             场景/静音切分 → 带时间轴的片段
  POST /api/dub/lipsync-long        真人长视频分段对口型(起 DB Job + 内存 Job + 后台管线)
  GET  /api/dub/lipsync-long/{job}  对口型进度(含 gpu_seconds 成本;DB 优先,内存兜底)
  GET  /api/dub/output/{name}       回对口型成片

译制/剪辑全链路(自动剪辑 → 多语言配音 → 对口型 → 成片)都以这里上传的源视频为起点。
落盘到 /data/dub(与 /data/manju 同卷),后续 ffmpeg / ASR / 对口型直接读本地文件。
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

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.jobs_persist import persist_job_to_db
from app.storage import content_subdir
from app.deps import get_current_user, get_pool
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.versioning import params_snapshot
# 复用:LatentSync 建图(纯函数)+ assembly 的拼接/来源校验(单一真相,不重复造)
from app.routes.assembly import _concat_parts, _check_redirect, _is_allowed_clip, _resolve_clip_url
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph

logger = logging.getLogger(__name__)

router = APIRouter()

_DUB_DIR = content_subdir("dub")  # 生成内容根(默认 /data;可切 NAS 挂载点)
# 视频上传不设大小上限(用户要求):流式 1MB 分块写盘,不整片进内存,大文件安全。
# 上传速度受网络带宽限制(与本服务无关);实际约束仅剩磁盘空间。
_CHUNK = 1024 * 1024  # 1MB 流式分块,避免整片进内存
# 音频板块 ASR 工具卡共用此上传通道:视频之外放行常见音频格式(whisper 经 ffmpeg 直接吃音频)。
_EXT_OK = {".mp4", ".mov", ".webm", ".mkv", ".mp3", ".wav", ".flac", ".ogg", ".m4a"}
_NAME_RE = re.compile(r"^dub-[0-9a-f]{32}\.(mp4|mov|webm|mkv|mp3|wav|flac|ogg|m4a)$")


@router.post("/dub/upload")
async def dub_upload(
    video: UploadFile,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    ext = Path(video.filename or "").suffix.lower()
    if ext not in _EXT_OK:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的媒体格式(仅 {', '.join(sorted(_EXT_OK))})",
        )

    _DUB_DIR.mkdir(parents=True, exist_ok=True)
    name = f"dub-{uuid.uuid4().hex}{ext}"
    dest = _DUB_DIR / name
    size = 0
    try:
        with dest.open("wb") as f:
            while chunk := await video.read(_CHUNK):
                size += len(chunk)  # 仅统计,返回给前端;不设上限
                f.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception as e:  # noqa: BLE001 — 落盘失败兜底清理
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"保存失败:{e}") from e

    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="空文件")

    return {"name": name, "url": f"/api/dub/source/{name}", "size": size}


@router.get("/dub/source/{name}")
async def dub_source(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")
    return FileResponse(path, media_type="video/mp4", filename=name)


# ── 自动化剪辑:把长视频按场景切 / 静音切句,得到带时间轴的片段 ────────────
# 纯 ffmpeg(场景检测 scene / 静音检测 silencedetect),无模型依赖。
# 产出的片段时间轴是后续逐句配音对齐、对口型分段、精剪重排的骨架。


async def _ffmpeg_stderr(args: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    return err.decode("utf-8", "ignore")


async def _probe_duration(path: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    try:
        return float(out.decode().strip())
    except (ValueError, AttributeError):
        return 0.0


_PTS_RE = re.compile(r"pts_time:([0-9.]+)")
_SIL_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")


async def _scene_cuts(path: Path, thr: float) -> list[float]:
    """场景切点:select 出场景跳变帧,showinfo 打 pts_time。"""
    err = await _ffmpeg_stderr([
        "-i", str(path), "-filter:v", f"select='gt(scene,{thr})',showinfo",
        "-f", "null", "-",
    ])
    return [float(m) for m in _PTS_RE.findall(err)]


async def _silence_cuts(path: Path, noise_db: float, min_sil: float) -> list[float]:
    """静音结束点 = 下一句开始,作为切句点。"""
    err = await _ffmpeg_stderr([
        "-i", str(path), "-af", f"silencedetect=noise={noise_db}dB:d={min_sil}",
        "-f", "null", "-",
    ])
    return [float(m) for m in _SIL_END_RE.findall(err)]


def _build_segments(cuts: list[float], duration: float, min_seg: float) -> list[dict]:
    """切点 → 片段;过短的并入下一段,保证每段 ≥ min_seg。"""
    points = [0.0] + sorted(c for c in cuts if 0.0 < c < duration) + [duration]
    segs: list[dict] = []
    i = 0
    while i < len(points) - 1:
        start = points[i]
        j = i + 1
        end = points[j]
        while end - start < min_seg and j < len(points) - 1:
            j += 1
            end = points[j]
        segs.append({
            "index": len(segs),
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
        })
        i = j
    return segs


class AutoCutRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # /dub/upload 返回的 name
    mode: str = Field(default="scene")  # scene(场景切) / silence(静音切句)
    threshold: float = Field(default=0.4)  # scene:0~1 灵敏度 / silence:噪声(传正数,内部取负 dB)
    min_seg: float = Field(default=1.5, ge=0.2, le=60.0)


@router.post("/dub/autocut")
async def dub_autocut(
    body: AutoCutRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / body.name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")

    duration = await _probe_duration(path)
    if duration <= 0:
        raise HTTPException(status_code=422, detail="无法读取视频时长")

    if body.mode == "silence":
        cuts = await _silence_cuts(path, -abs(body.threshold or 30.0), 0.5)
    else:
        thr = min(max(body.threshold, 0.05), 0.95)
        cuts = await _scene_cuts(path, thr)

    segments = _build_segments(cuts, duration, body.min_seg)
    return {
        "segments": segments,
        "count": len(segments),
        "source_duration": round(duration, 3),
        "mode": body.mode,
    }


# ── 真人长视频对口型:分段 LatentSync → 拼接成片 ────────────────────────
# 源视频按片段切 → 逐段上传 worker 跑 LatentSync(复用 workflows/lipsync 建图)→
# 下载同步片段 → 复用 assembly._concat_parts 拼成成片。
#
# 异步:POST 起一个 DB Job + 内存 Job(后台任务跑整条管线),前端轮询 GET 进度;成片走
# /dub/output。Phase 1 验证目标 = 真人单语言一条,量「对口型质量 + GPU 成本」:
# job.gpu_seconds 累计每段 LatentSync 的入队→产出墙钟,作单卡顺序处理的成本代理。
#
# 鲁棒:单段 LatentSync 失败/超时(如该段无人脸)→ 回退用原片段+音轨补位,不让
# 一段失败毁掉整条 12 分钟作业;回退计数 fallbacks 暴露给前端。
# 持久化:DB Job 存终态(done/error + 全量 job dict),api 重启后前端仍可查到结果;
# 内存 Job 保留实时进度(running 中 completed/stage 等动态字段),DB 写失败不毁内存。

_LATENT_FPS = 25  # LatentSync 原生 25fps(切片与拼接都对齐,减少 worker 重采样)
_SEG_TIMEOUT = 600.0  # 单段 LatentSync 上限(8~12s 片约数分钟,留足余量)
_MAX_SEGMENTS = 90  # 段数硬上限(12min / 8s ≈ 90)
_JOBS_KEEP = 60  # 内存 Job 最多保留数(超出删最旧的终态作业)
_VIDEO_EXT = (".mp4", ".webm", ".mov", ".mkv")
_LIPSYNC_OUT_RE = re.compile(r"^dubsync-[0-9a-f]{32}\.mp4$")
_DUBVOICE_RE = re.compile(r"^dubvoice-[0-9a-f]{32}\.wav$")  # 译制配音轨(dub_voice 产)

# 内存 Job 存储(实时进度)+ 后台任务强引用(asyncio 仅持弱引用,防 GC 提前回收)
# 持久化层见 DB Job(kind="dub_lipsync_long"),内存仅保运行中动态字段,终态双写
_lipsync_jobs: dict[str, dict] = {}
_ls_tasks: set[asyncio.Task] = set()


def _prune_jobs() -> None:
    """内存 Job 超额时删最旧的终态(done/error)作业,避免无限增长。"""
    if len(_lipsync_jobs) <= _JOBS_KEEP:
        return
    terminal = sorted(
        (j for j in _lipsync_jobs.values() if j["status"] in ("done", "error")),
        key=lambda j: j["started"],
    )
    for j in terminal[: len(_lipsync_jobs) - _JOBS_KEEP]:
        _lipsync_jobs.pop(j["id"], None)


class LipsyncLongRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # /dub/upload 返回的源视频 name
    # 片段时间轴 [{start,end}](来自 autocut);空 = 按 seg_seconds 等分整片
    segments: list[dict] = Field(default_factory=list, max_length=_MAX_SEGMENTS)
    # 配音轨本地名(dub_voice 产的 dubvoice-*.wav,本地直读做对口型音源,免下载/鉴权)
    audio_name: str | None = Field(default=None, max_length=200)
    # 配音轨 URL(外部来源);三者优先级 audio_name > audio_url > 源视频自带音轨
    audio_url: str | None = Field(default=None, max_length=2000)
    seg_seconds: float = Field(default=12.0, ge=2.0, le=60.0)  # 无 segments 时的等分长度
    max_segments: int = Field(default=8, ge=1, le=_MAX_SEGMENTS)  # 单次跑多少段(控本)
    lips_expression: float = Field(default=1.5, ge=1.0, le=3.0)
    inference_steps: int = Field(default=10, ge=1, le=50)  # LatentSync DPM-Solver++ 10 步(P1.1)


def _segments_from(body: LipsyncLongRequest, duration: float) -> list[tuple[float, float]]:
    """得到 [(start,end)] 片段列表:优先用传入 segments,否则按 seg_seconds 等分。"""
    segs: list[tuple[float, float]] = []
    if body.segments:
        for s in body.segments:
            try:
                a = max(0.0, min(float(s.get("start", 0.0)), duration))
                b = max(0.0, min(float(s.get("end", 0.0)), duration))
            except (TypeError, ValueError):
                continue
            if b - a >= 0.5:  # 太短的段对口型无意义,跳过
                segs.append((round(a, 3), round(b, 3)))
    else:
        t = 0.0
        while t < duration:
            segs.append((round(t, 3), round(min(t + body.seg_seconds, duration), 3)))
            t += body.seg_seconds
    return segs[: body.max_segments]


async def _ffmpeg_run(cmd: list[str]) -> None:
    """跑 ffmpeg,非零退出抛 RuntimeError(后台任务用,异于 assembly 抛 HTTPException)。"""
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        tail = (err or b"").decode("utf-8", "replace")[-500:]
        raise RuntimeError(f"ffmpeg 失败:{tail}")


async def _slice_video(src: Path, start: float, dur: float, out: Path) -> None:
    """切一段无声视频(force 25fps)喂给 LatentSync;音轨另切,避免 A/V 同源耦合。"""
    await _ffmpeg_run([
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{dur:.3f}",
        "-an", "-c:v", "libx264", "-preset", "veryfast",
        "-pix_fmt", "yuv420p", "-r", str(_LATENT_FPS), str(out),
    ])


async def _slice_audio(src: Path, start: float, dur: float, out: Path) -> None:
    """切对应时间段音频(mono 16k wav),LoadAudio 喂 LatentSync。"""
    await _ffmpeg_run([
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{dur:.3f}",
        "-vn", "-ac", "1", "-ar", "16000", str(out),
    ])


def _pick_video(files: list[dict]) -> dict | None:
    """从 history 产物里挑视频文件(VHS_VideoCombine 产 mp4)。"""
    for f in files:
        if str(f.get("filename", "")).lower().endswith(_VIDEO_EXT):
            return f
    return None


async def _wait_prompt(
    client: ComfyUIClient, prompt_id: str, timeout: float
) -> list[dict]:
    """轮询 history 直到该 prompt 产出文件(返回产物)/出错/超时。"""
    delay, waited = 2.0, 0.0
    while waited < timeout:
        try:
            history = await client.get_history(prompt_id)
        except ComfyUIError:
            history = {}  # worker 暂不可达,下次再试
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status") or {}
            files: list[dict] = []
            for node_out in (entry.get("outputs") or {}).values():
                for value in node_out.values():
                    if isinstance(value, list):
                        files += [
                            it for it in value
                            if isinstance(it, dict) and "filename" in it
                        ]
            if files:
                return files
            if status.get("status_str") == "error":
                raise RuntimeError("LatentSync worker 执行出错(可能该段无人脸)")
            if status.get("completed"):
                return files  # 完成但无产物(罕见)
        await asyncio.sleep(delay)
        waited += delay
        delay = min(delay * 1.4, 8.0)
    raise RuntimeError(f"对口型超时(>{timeout:.0f}s)")


async def _lipsync_segment(
    client: ComfyUIClient,
    body: LipsyncLongRequest,
    seg_v: Path,
    seg_a: Path,
    seg_out: Path,
) -> float:
    """单段:上传切片 → LatentSync → 下载同步成片落 seg_out。返回该段 GPU 墙钟秒。"""
    vfn = await client.upload_image(seg_v.read_bytes(), f"dubls_v_{uuid.uuid4().hex}.mp4")
    afn = await client.upload_image(seg_a.read_bytes(), f"dubls_a_{uuid.uuid4().hex}.wav")
    graph = build_latentsync_graph(
        LatentSyncParams(
            video=vfn, audio=afn,
            lips_expression=body.lips_expression, inference_steps=body.inference_steps,
        )
    )
    t0 = time.monotonic()
    prompt_id = await client.queue_prompt(graph, uuid.uuid4().hex)
    files = await _wait_prompt(client, prompt_id, _SEG_TIMEOUT)
    elapsed = time.monotonic() - t0
    vf = _pick_video(files)
    if not vf:
        raise RuntimeError("未取到同步视频产物")
    content, _ = await client.get_image_bytes(
        vf["filename"], vf.get("subfolder", ""), vf.get("type", "output")
    )
    if not content:
        raise RuntimeError("同步视频为空")
    seg_out.write_bytes(content)
    return elapsed


async def _run_lipsync_long(
    job: dict, src_path: Path, body: LipsyncLongRequest,
    segments: list[tuple[float, float]], pool: WorkerPool,
    audio_path: Path | None,
) -> None:
    """后台管线:逐段切片→LatentSync→拼接。任何阶段异常都落到 job.error,不冒泡。

    audio_path:本地配音轨(audio_name 解析所得)。优先级 audio_path > audio_url > 源音轨。
    """
    try:
        client = await pool.pick(required=set())
    except Exception as e:  # noqa: BLE001 — 选 worker 失败(不可达/无模型)即整作业失败
        job["status"], job["error"] = "error", f"无可用 worker:{e}"
        return

    with tempfile.TemporaryDirectory(prefix="dub-ls-") as tmp:
        tmp_dir = Path(tmp)
        # 音源:本地配音轨直读 / 外部配音轨下载一次 / 源视频自带音轨(单语言验证)
        if audio_path is not None:
            audio_src = audio_path
        elif body.audio_url:
            try:
                audio_src = tmp_dir / "dub.audio"
                audio_resolved = _resolve_clip_url(body.audio_url)
                async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as http:
                    r = await http.get(audio_resolved)
                    _check_redirect(r, audio_resolved)
                    r.raise_for_status()
                audio_src.write_bytes(r.content)
            except Exception as e:  # noqa: BLE001
                job["status"], job["error"] = "error", f"配音下载失败:{e}"
                return
        else:
            audio_src = src_path

        synced: list[Path] = []
        for i, (a, b) in enumerate(segments):
            dur = max(0.1, b - a)
            job["stage"] = f"对口型 {i + 1}/{len(segments)}"
            seg_v = tmp_dir / f"v{i:03d}.mp4"
            seg_a = tmp_dir / f"a{i:03d}.wav"
            seg_out = tmp_dir / f"o{i:03d}.mp4"
            try:
                await _slice_video(src_path, a, dur, seg_v)
                await _slice_audio(audio_src, a, dur, seg_a)
            except Exception as e:  # noqa: BLE001 — 切分失败 = 源不可读,致命
                job["status"], job["error"] = "error", f"第{i + 1}段切分失败:{e}"
                return
            try:
                job["gpu_seconds"] = round(
                    job["gpu_seconds"]
                    + await _lipsync_segment(client, body, seg_v, seg_a, seg_out),
                    1,
                )
                synced.append(seg_out)
            except Exception as e:  # noqa: BLE001 — 单段对口型失败 → 回退原片段补位
                logger.warning("dub lipsync 第%d段失败,回退原片段:%s", i + 1, e)
                try:
                    await _ffmpeg_run([
                        "ffmpeg", "-y", "-i", str(seg_v), "-i", str(seg_a),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(_LATENT_FPS),
                        "-c:a", "aac", "-shortest", str(seg_out),
                    ])
                    synced.append(seg_out)
                    job["fallbacks"] += 1
                except Exception as e2:  # noqa: BLE001
                    job["status"], job["error"] = "error", f"第{i + 1}段回退也失败:{e2}"
                    return
            job["completed"] = i + 1

        if not synced:
            job["status"], job["error"] = "error", "无可拼接片段"
            return

        job["stage"] = "拼接成片"
        _DUB_DIR.mkdir(parents=True, exist_ok=True)
        out_name = f"dubsync-{uuid.uuid4().hex}.mp4"
        out_path = _DUB_DIR / out_name
        try:
            await _concat_parts(synced, _LATENT_FPS, True, out_path)
        except Exception as e:  # noqa: BLE001
            job["status"], job["error"] = "error", f"拼接失败:{e}"
            return
        if not out_path.exists() or out_path.stat().st_size == 0:
            job["status"], job["error"] = "error", "成片为空"
            return
        job["url"] = f"/api/dub/output/{out_name}"

    job["stage"] = "完成"
    job["elapsed"] = round(time.monotonic() - job["started"], 1)
    job["status"] = "done"


async def _run_lipsync_long_tracked(
    job: dict, src_path: Path, body: LipsyncLongRequest,
    segments: list[tuple[float, float]], pool: WorkerPool,
    audio_path: Path | None,
) -> None:
    """_run_lipsync_long 的 DB 持久化包装:管线结束后把终态写回 DB Job。

    why:用 try/finally 包一层,无需改动 _run_lipsync_long 内部多处 return。
    无论 done / error,都把最终 job dict 写回 DB——api 重启后前端仍可查到终态。
    """
    try:
        await _run_lipsync_long(job, src_path, body, segments, pool, audio_path)
    finally:
        if job["status"] in ("done", "error"):
            persist_job_to_db(job["id"], "dub_lipsync_long", job["status"], job)


@router.post("/dub/lipsync-long")
async def dub_lipsync_long(
    body: LipsyncLongRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = _DUB_DIR / body.name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")
    if body.audio_url and not _is_allowed_clip(body.audio_url):
        raise HTTPException(status_code=400, detail="配音来源不在白名单内")
    # 本地配音轨(dubvoice-*.wav):校验文件名 + 存在,作对口型音源(优先于 audio_url/源音轨)
    audio_path: Path | None = None
    if body.audio_name:
        if not _DUBVOICE_RE.match(body.audio_name):
            raise HTTPException(status_code=400, detail="非法配音轨文件名")
        audio_path = _DUB_DIR / body.audio_name
        if not audio_path.is_file():
            raise HTTPException(status_code=404, detail="配音轨不存在")

    duration = await _probe_duration(src)
    if duration <= 0:
        raise HTTPException(status_code=422, detail="无法读取视频时长")
    segments = _segments_from(body, duration)
    if not segments:
        raise HTTPException(status_code=422, detail="无有效片段(检查 segments/seg_seconds)")

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "status": "running", "stage": "准备",
        "total": len(segments), "completed": 0, "fallbacks": 0,
        "gpu_seconds": 0.0, "url": None, "error": None,
        "source": body.name, "source_duration": round(duration, 3),
        "started": time.monotonic(), "elapsed": 0.0,
    }
    _lipsync_jobs[job_id] = job
    _prune_jobs()

    # 持久化到 DB Job:api 重启后内存 _lipsync_jobs 丢失,DB 保终态供前端恢复查询。
    # prompt_id 复用 job_id(本管线无 ComfyUI prompt_id);worker 在后台动态 pick,空串占位。
    # result 存全量 job dict 快照,状态查询端点回放用(运行中由内存提供实时进度)。
    session.add(Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=job_id,
        worker="",
        kind="dub_lipsync_long",
        status="running",
        prompt="长视频对口型",
        params=params_snapshot(body),
        result=json.dumps(job, ensure_ascii=False),
    ))
    session.commit()

    task = asyncio.create_task(
        _run_lipsync_long_tracked(job, src, body, segments, pool, audio_path)
    )
    _ls_tasks.add(task)
    task.add_done_callback(_ls_tasks.discard)

    return {
        "job_id": job_id,
        "segment_count": len(segments),
        "source_duration": round(duration, 3),
        "segments": [
            {"index": i, "start": a, "end": b} for i, (a, b) in enumerate(segments)
        ],
    }


_JOB_PUBLIC = (
    "id", "status", "stage", "total", "completed", "fallbacks",
    "gpu_seconds", "url", "error", "source_duration", "elapsed",
)


@router.get("/dub/lipsync-long/{job_id}")
async def dub_lipsync_status(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    # 优先查 DB Job(api 重启后内存丢,DB 保终态);运行中且内存还在则用内存(实时进度)
    db_job = session.exec(select(Job).where(Job.prompt_id == job_id)).first()
    if db_job:
        # 运行中 + 内存还在:回内存的实时进度(completed/stage/gpu_seconds 等动态字段)
        # 否则回放 DB result 快照(终态或重启后恢复)
        mem = _lipsync_jobs.get(job_id)
        if db_job.status == "running" and mem:
            return {k: mem[k] for k in _JOB_PUBLIC}
        try:
            data = json.loads(db_job.result) if db_job.result else {}
        except ValueError:
            data = {}
        return {k: data.get(k) for k in _JOB_PUBLIC}
    # 内存兜底:迁移前老作业或 DB 未命中(向后兼容)
    job = _lipsync_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在(可能已过期或 api 重启)")
    return {k: job[k] for k in _JOB_PUBLIC}


@router.get("/dub/output/{name}")
async def dub_output(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _LIPSYNC_OUT_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )
