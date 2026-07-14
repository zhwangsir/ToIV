"""视频译制·配音轨 —— 逐片段合成译文语音,按时间轴铺成整轨(喂对口型 audio_name)。

  POST /api/dub/voice-track   译文片段 [{start,end,text}] → 整条配音轨 dubvoice-*.wav
  GET  /api/dub/voice-track/{name}  回配音轨(供前端试听)

复用 IndexTTS2(config.tts_url,见 voice.py)。默认从**源视频自带音轨**就地抽几秒做
参考音 → 克隆原说话人音色(译制后仍是原角色的声线),且全程本地文件、无内部鉴权下载坑。
逐段 atempo 贴合原时槽长度(便于对口型逐段对齐),adelay 铺到各自起点,amix 成整轨。
产物落 _DUB_DIR,经 /dub/lipsync-long 的 audio_name 直读做对口型音源。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import tempfile
import time
import uuid
import wave
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.jobs_persist import persist_job_to_db
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.assembly import _run_ffmpeg
from app.routes.dub import _DUB_DIR, _NAME_RE, _probe_duration
from app.versioning import params_snapshot

logger = logging.getLogger(__name__)

router = APIRouter()

_TTS_TIMEOUT = 180.0  # IndexTTS2 首调懒加载模型 ~20s,留足
_MAX_SEGMENTS = 200
_VOICE_TRACK_RE = re.compile(r"^dubvoice-[0-9a-f]{32}\.wav$")
_TEMPO_MAX = 2.0  # atempo 单段上限(超出则略溢出时槽,可接受)

# 配音轨后台作业(逐段 TTS 可达数分钟 → 后台跑 + 前端轮询进度;同 lipsync 内存 Job)
_voice_jobs: dict[str, dict] = {}
_v_tasks: set[asyncio.Task] = set()
_JOBS_KEEP = 40


def _prune_voice_jobs() -> None:
    if len(_voice_jobs) <= _JOBS_KEEP:
        return
    term = sorted(
        (j for j in _voice_jobs.values() if j["status"] in ("done", "error")),
        key=lambda j: j["started"],
    )
    for j in term[: len(_voice_jobs) - _JOBS_KEEP]:
        _voice_jobs.pop(j["id"], None)


class VoiceSeg(BaseModel):
    start: float = Field(ge=0.0)
    end: float = Field(gt=0.0)
    text: str = Field(min_length=1, max_length=2000)  # 译文台词


class VoiceTrackRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # 源视频 name(抽参考音 + 定总长)
    segments: list[VoiceSeg] = Field(min_length=1, max_length=_MAX_SEGMENTS)
    ref_seconds: float = Field(default=8.0, ge=0.0, le=20.0)  # 0 = 用 TTS 默认音色
    emo_text: str | None = Field(default=None, max_length=200)
    emo_alpha: float = Field(default=0.6, ge=0.0, le=1.0)


def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 3)
    except (wave.Error, OSError):
        return 0.0


async def _tts(
    client: httpx.AsyncClient, base: str, text: str,
    emo_text: str | None, emo_alpha: float, ref: bytes | None,
) -> bytes:
    """调 IndexTTS2 合成单段;返回 wav 字节(校验 RIFF)。"""
    data: dict[str, str] = {"text": text}
    if emo_text and emo_text.strip():
        data["emo_text"] = emo_text.strip()
        data["emo_alpha"] = str(emo_alpha)
    files = {"ref_audio": ("ref.wav", ref, "audio/wav")} if ref else None
    resp = await client.post(base.rstrip("/") + "/tts", data=data, files=files)
    if resp.status_code != 200 or not resp.content or resp.content[:4] != b"RIFF":
        raise RuntimeError(f"TTS 合成失败(HTTP {resp.status_code})")
    return resp.content


def _build_track_cmd(
    wavs: list[Path], starts: list[float], tempos: list[float],
    total: float, out: Path,
) -> list[str]:
    """逐段 atempo 贴时槽 + adelay 铺到起点 + amix 成整轨,atrim 到总长。"""
    cmd: list[str] = ["ffmpeg", "-y"]
    for w in wavs:
        cmd += ["-i", str(w)]
    filters: list[str] = []
    labels: list[str] = []
    for i, (st, tempo) in enumerate(zip(starts, tempos)):
        ms = int(max(0.0, st) * 1000)
        lbl = f"a{i}"
        filters.append(
            f"[{i}:a]atempo={tempo:.3f},adelay={ms}|{ms},"
            f"aformat=channel_layouts=mono[{lbl}]"
        )
        labels.append(f"[{lbl}]")
    if len(labels) == 1:
        filters.append(f"{labels[0]}apad,atrim=0:{total:.3f}[out]")
    else:
        filters.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0[mix];"
            f"[mix]apad,atrim=0:{total:.3f}[out]"
        )
    cmd += [
        "-filter_complex", ";".join(filters), "-map", "[out]",
        "-ar", "24000", "-ac", "1", str(out),
    ]
    return cmd


async def _run_voice_track(job: dict, src: Path, body: VoiceTrackRequest, total: float) -> None:
    """后台:逐段 TTS(报 completed/total + elapsed)→ 铺整轨。异常落 job.error。"""
    settings = get_settings()
    segs = sorted(body.segments, key=lambda s: s.start)
    _DUB_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="dub-voice-") as tmp:
            tmp_dir = Path(tmp)
            # 从源视频自带音轨抽参考音 → 克隆原说话人(取首个片段处,确保有人声)
            ref_bytes: bytes | None = None
            if body.ref_seconds > 0:
                job["stage"] = "抽参考音"
                ref_path = tmp_dir / "ref.wav"
                ref_at = segs[0].start if segs else 0.0
                try:
                    await _run_ffmpeg([
                        "ffmpeg", "-y", "-ss", f"{ref_at:.3f}", "-i", str(src),
                        "-t", f"{body.ref_seconds:.3f}", "-vn", "-ac", "1", "-ar", "24000",
                        str(ref_path),
                    ])
                    if ref_path.is_file() and ref_path.stat().st_size > 0:
                        ref_bytes = ref_path.read_bytes()
                except HTTPException:
                    ref_bytes = None  # 源无音轨等 → 退回默认音色,不致命

            wavs: list[Path] = []
            starts: list[float] = []
            tempos: list[float] = []
            async with httpx.AsyncClient(timeout=_TTS_TIMEOUT, follow_redirects=True) as client:
                for i, s in enumerate(segs):
                    job["stage"] = f"合成配音 {i + 1}/{len(segs)}"
                    try:
                        audio = await _tts(
                            client, settings.tts_url, s.text,
                            body.emo_text, body.emo_alpha, ref_bytes,
                        )
                    except (httpx.HTTPError, RuntimeError):
                        job["failed"] += 1
                        job["completed"] = i + 1
                        job["progress"] = int((i + 1) / len(segs) * 100)
                        job["elapsed"] = round(time.monotonic() - job["started"], 1)
                        continue  # 单段失败 → 跳过(留空隙),不毁整轨
                    wp = tmp_dir / f"s{i:03d}.wav"
                    wp.write_bytes(audio)
                    dur = _wav_duration(wp)
                    slot = max(0.1, s.end - s.start)
                    # 译文偏长则加速贴回时槽(对口型逐段对齐);偏短则保自然语速
                    tempo = dur / slot if dur > slot else 1.0
                    tempos.append(min(max(tempo, 1.0), _TEMPO_MAX))
                    starts.append(s.start)
                    wavs.append(wp)
                    job["completed"] = i + 1
                    job["progress"] = int((i + 1) / len(segs) * 100)
                    job["elapsed"] = round(time.monotonic() - job["started"], 1)

            if not wavs:
                job["status"], job["error"] = "error", "配音全部失败(检查 TTS 服务)"
                return

            job["stage"] = "铺轨合成"
            out_name = f"dubvoice-{uuid.uuid4().hex}.wav"
            out_path = _DUB_DIR / out_name
            await _run_ffmpeg(_build_track_cmd(wavs, starts, tempos, total, out_path))
    except Exception as e:  # noqa: BLE001 — 后台任务异常一律落 job
        logger.warning("voice-track %s 失败:%s", job["id"], e)
        job["status"], job["error"] = "error", f"配音轨合成失败:{e}"
        return

    if not out_path.exists() or out_path.stat().st_size == 0:
        job["status"], job["error"] = "error", "配音轨合成为空"
        return
    job["result"] = {
        "name": out_name,
        "url": f"/api/dub/voice-track/{out_name}",
        "duration": _wav_duration(out_path),
        "segment_count": len(wavs),
    }
    job["stage"] = "完成"
    job["progress"] = 100
    job["elapsed"] = round(time.monotonic() - job["started"], 1)
    job["status"] = "done"


async def _run_voice_track_tracked(
    job: dict, src: Path, body: VoiceTrackRequest, total: float,
) -> None:
    """_run_voice_track 的 DB 持久化包装:管线结束后把终态写回 DB Job。

    why:用 try/finally 包一层,无需改动 _run_voice_track 内部多处 return。
    无论 done / error,都把最终 job dict 写回 DB——api 重启后前端仍可查到终态。
    """
    try:
        await _run_voice_track(job, src, body, total)
    finally:
        if job["status"] in ("done", "error"):
            persist_job_to_db(job["id"], "voice_track", job["status"], job)


@router.post("/dub/voice-track")
async def dub_voice_track(
    body: VoiceTrackRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """起后台配音轨作业(逐段 TTS)。轮询 GET /dub/voice-track-status/{job} 取进度/结果。"""
    enforce_generation_rate_limit(user)
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = _DUB_DIR / body.name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")

    src_dur = await _probe_duration(src)
    total = max((s.end for s in body.segments), default=0.0)
    if src_dur > 0:
        total = max(total, src_dur)
    if total <= 0:
        raise HTTPException(status_code=422, detail="片段时间轴无效")

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "status": "running", "stage": "排队",
        "total": len(body.segments), "completed": 0, "failed": 0,
        "progress": 0, "result": None, "error": None,
        "started": time.monotonic(), "elapsed": 0.0,
    }
    _voice_jobs[job_id] = job
    _prune_voice_jobs()

    # 持久化到 DB Job:api 重启后内存 _voice_jobs 丢失,DB 保终态供前端恢复查询。
    # prompt_id 复用 job_id;result 存全量 job dict 快照,状态查询端点回放用。
    session.add(Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=job_id,
        worker="",
        kind="voice_track",
        status="running",
        prompt="配音轨合成",
        params=params_snapshot(body),
        result=json.dumps(job, ensure_ascii=False),
    ))
    session.commit()

    task = asyncio.create_task(_run_voice_track_tracked(job, src, body, total))
    _v_tasks.add(task)
    task.add_done_callback(_v_tasks.discard)
    return {"job_id": job_id, "segment_count": len(body.segments)}


_VOICE_JOB_PUBLIC = (
    "id", "status", "stage", "total", "completed", "failed",
    "progress", "result", "error", "elapsed",
)


@router.get("/dub/voice-track-status/{job_id}")
async def dub_voice_track_status(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    # 优先查 DB Job(api 重启后内存丢,DB 保终态);运行中且内存还在则用内存(实时进度)
    db_job = session.exec(select(Job).where(Job.prompt_id == job_id)).first()
    if db_job:
        mem = _voice_jobs.get(job_id)
        if db_job.status == "running" and mem:
            return {k: mem[k] for k in _VOICE_JOB_PUBLIC}
        try:
            data = json.loads(db_job.result) if db_job.result else {}
        except ValueError:
            data = {}
        return {k: data.get(k) for k in _VOICE_JOB_PUBLIC}
    # 内存兜底:迁移前老作业或 DB 未命中(向后兼容)
    job = _voice_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="配音任务不存在(可能已过期或 api 重启)")
    return {k: job[k] for k in _VOICE_JOB_PUBLIC}


@router.get("/dub/voice-track/{name}")
async def get_voice_track(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _VOICE_TRACK_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DUB_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="配音轨不存在")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )
