"""视频译制·听写翻译 —— 得到带时间轴的双语片段(配音/对口型的台本骨架)。

  POST /api/dub/import-srt        multipart(file) 解析 SRT/VTT → [{index,start,end,text}]
  POST /api/dub/transcribe        起后台听写作业(内置 faster-whisper / 外部 whisper_url)
  GET  /api/dub/transcribe/{job}  听写进度 + 完成片段
  POST /api/dub/translate         复用 LLM 把片段批量翻成目标语(口语自然、贴近朗读时长)

转录来源二选一:已有字幕 → import-srt(零部署);无字幕 → transcribe。听写默认用 api 容器
内置 faster-whisper(CPU,首调下载模型到 /data/whisper),配 whisper_url 则改调外部 GPU
服务。后台作业避免长视频阻塞/代理超时。译文长度尽量贴近原文朗读时长,便于配音对齐。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.agent import llm
from app.config import get_settings
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.dub import _DUB_DIR, _NAME_RE

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_SRT_BYTES = 2 * 1024 * 1024  # 字幕文件上限 2MB
_MAX_SEGMENTS = 400  # 译制片段上限(控 LLM/TTS 量)
_TRANSCRIBE_TIMEOUT = 1200.0  # 外部 Whisper 听写长视频上限(本地无网络超时)

# SRT/VTT 时间戳:HH:MM:SS,mmm 或 HH:MM:SS.mmm
_TS_RE = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})")
_ARROW_RE = re.compile(
    r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})"
)


def _ts_to_sec(ts: str) -> float:
    m = _TS_RE.match(ts.strip())
    if not m:
        return 0.0
    h, mi, s, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def _parse_srt(text: str) -> list[dict]:
    """解析 SRT/VTT 文本 → [{index,start,end,text}](按 start 排序,合并多行文案)。"""
    # 去 BOM / WEBVTT 头;按空行分块
    text = text.lstrip("﻿")
    blocks = re.split(r"\r?\n\r?\n+", text.strip())
    segs: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        arrow_i = next((i for i, ln in enumerate(lines) if _ARROW_RE.search(ln)), None)
        if arrow_i is None:
            continue  # 无时间轴(WEBVTT 头/纯序号块)→ 跳过
        am = _ARROW_RE.search(lines[arrow_i])
        start, end = _ts_to_sec(am.group(1)), _ts_to_sec(am.group(2))
        body = " ".join(lines[arrow_i + 1:]).strip()
        if not body or end <= start:
            continue
        segs.append({"start": round(start, 3), "end": round(end, 3), "text": body})
    segs.sort(key=lambda s: s["start"])
    return [{"index": i, **s} for i, s in enumerate(segs[:_MAX_SEGMENTS])]


@router.post("/dub/import-srt")
async def dub_import_srt(
    file: UploadFile,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if len(content) > _MAX_SRT_BYTES:
        raise HTTPException(status_code=413, detail="字幕文件过大(上限 2MB)")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("gbk")  # 中文字幕常见 GBK
        except UnicodeDecodeError as e:
            raise HTTPException(status_code=400, detail="字幕编码无法识别(请存 UTF-8)") from e
    segments = _parse_srt(text)
    if not segments:
        raise HTTPException(status_code=422, detail="未解析到有效字幕(检查 SRT/VTT 格式)")
    return {"segments": segments, "count": len(segments)}


class TranscribeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # /dub/upload 的源视频 name


# ── 听写后台作业 ──────────────────────────────────────────────────────
# 内置 faster-whisper(CPU)默认;配 whisper_url 则改调外部 GPU 服务。后台跑避免
# 长视频阻塞事件循环 / 公网代理超时(同 lipsync-long 内存 Job 模式;api 重启会丢)。
_transcribe_jobs: dict[str, dict] = {}
_t_tasks: set[asyncio.Task] = set()
_JOBS_KEEP = 40

# faster-whisper 模型按 (size,compute) 缓存,首调在线程加载(避免重复加载/阻塞循环)
_model_cache: dict[tuple, object] = {}
_model_lock = asyncio.Lock()


def _prune_transcribe_jobs() -> None:
    if len(_transcribe_jobs) <= _JOBS_KEEP:
        return
    term = sorted(
        (j for j in _transcribe_jobs.values() if j["status"] in ("done", "error")),
        key=lambda j: j["started"],
    )
    for j in term[: len(_transcribe_jobs) - _JOBS_KEEP]:
        _transcribe_jobs.pop(j["id"], None)


def _normalize_segments(raw: list) -> list[dict]:
    """规整为 [{index,start,end,text}](过滤空/逆序,封顶 _MAX_SEGMENTS)。"""
    segs: list[dict] = []
    for s in raw:
        try:
            start, end = float(s["start"]), float(s["end"])
            txt = str(s.get("text", "")).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if txt and end > start:
            segs.append({"start": round(start, 3), "end": round(end, 3), "text": txt})
    return [{"index": i, **s} for i, s in enumerate(segs[:_MAX_SEGMENTS])]


def _load_whisper(size: str, compute: str):
    """加载 faster-whisper(CPU);首次会下载模型到 HF_HOME(/data/whisper)。阻塞,放线程跑。"""
    from faster_whisper import WhisperModel  # 惰性导入:未装则只影响听写,不拖累启动

    return WhisperModel(size, device="cpu", compute_type=compute)


async def _get_whisper_model():
    s = get_settings()
    key = (s.whisper_model, s.whisper_compute)
    async with _model_lock:
        model = _model_cache.get(key)
        if model is None:
            model = await asyncio.to_thread(_load_whisper, s.whisper_model, s.whisper_compute)
            _model_cache[key] = model
        return model


def _whisper_transcribe_sync(model, path: str) -> list[dict]:
    """阻塞转录(迭代生成器才真正计算)→ raw 片段。必须在线程里跑。"""
    segments, _info = model.transcribe(path, vad_filter=True, beam_size=5)
    out: list[dict] = []
    for seg in segments:
        txt = (seg.text or "").strip()
        if txt:
            out.append({"start": float(seg.start), "end": float(seg.end), "text": txt})
    return out


async def _transcribe_external(base: str, src_path, name: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=_TRANSCRIBE_TIMEOUT) as client:
        with src_path.open("rb") as f:
            resp = await client.post(f"{base}/asr", files={"file": (name, f, "video/mp4")})
    resp.raise_for_status()
    return _normalize_segments(resp.json().get("segments") or [])


async def _run_transcribe(job: dict, src_path, name: str) -> None:
    """后台听写:外部 whisper_url 优先,否则内置 faster-whisper(线程跑)。异常落 job.error。"""
    try:
        s = get_settings()
        if s.whisper_url.strip():
            job["stage"] = "外部听写中"
            segs = await _transcribe_external(s.whisper_url.strip().rstrip("/"), src_path, name)
        else:
            job["stage"] = "加载模型"
            model = await _get_whisper_model()
            job["stage"] = "听写中"
            raw = await asyncio.to_thread(_whisper_transcribe_sync, model, str(src_path))
            segs = _normalize_segments(raw)
    except ImportError as e:
        job["status"], job["error"] = "error", f"听写依赖缺失(api 镜像需重建):{e}"
        return
    except Exception as e:  # noqa: BLE001 — 后台任务异常一律落 job,不冒泡
        logger.warning("transcribe %s 失败:%s", job["id"], e)
        job["status"], job["error"] = "error", f"听写失败:{e}"
        return
    if not segs:
        job["status"], job["error"] = "error", "听写未得到有效片段(可能无语音/无音轨)"
        return
    job["segments"] = segs
    job["count"] = len(segs)
    job["stage"] = "完成"
    job["elapsed"] = round(time.monotonic() - job["started"], 1)
    job["status"] = "done"


@router.post("/dub/transcribe")
async def dub_transcribe(
    body: TranscribeRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """起后台听写作业。内置 faster-whisper(CPU)/ 外部 whisper_url。轮询 GET 取结果。"""
    enforce_generation_rate_limit(user)
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = _DUB_DIR / body.name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "status": "running", "stage": "排队",
        "count": 0, "segments": [], "error": None,
        "started": time.monotonic(), "elapsed": 0.0,
    }
    _transcribe_jobs[job_id] = job
    _prune_transcribe_jobs()
    task = asyncio.create_task(_run_transcribe(job, src, body.name))
    _t_tasks.add(task)
    task.add_done_callback(_t_tasks.discard)
    return {"job_id": job_id}


@router.get("/dub/transcribe/{job_id}")
async def dub_transcribe_status(
    job_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    job = _transcribe_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="听写任务不存在(可能已过期或 api 重启)")
    return {k: job[k] for k in ("id", "status", "stage", "count", "segments", "error", "elapsed")}


_LANG_NAME = {"zh": "简体中文", "en": "英语", "ja": "日语", "ko": "韩语"}


class TranslateSeg(BaseModel):
    index: int
    text: str = Field(min_length=1, max_length=2000)


class TranslateRequest(BaseModel):
    segments: list[TranslateSeg] = Field(min_length=1, max_length=_MAX_SEGMENTS)
    target_lang: str = Field(default="zh")  # zh/en/ja/ko


def _extract_json_array(s: str) -> list:
    """从 LLM 回复里抽 JSON 数组(容错代码围栏/前后缀文字)。"""
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", s).strip()
    a, b = s.find("["), s.rfind("]")
    if a == -1 or b == -1 or b <= a:
        raise ValueError("回复中无 JSON 数组")
    return json.loads(s[a:b + 1])


@router.post("/dub/translate")
async def dub_translate(
    body: TranslateRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """批量翻译:口语自然、长度贴近原文朗读时长(便于配音对齐)。返回 [{index,translated}]。"""
    enforce_generation_rate_limit(user)
    lang = _LANG_NAME.get(body.target_lang, "简体中文")
    items = [{"i": s.index, "text": s.text} for s in body.segments]
    system = (
        f"你是专业影视译制翻译。把每条字幕翻成{lang},要求:口语化、自然顺畅,"
        "保留原句语气与信息;长度尽量贴近原文的朗读时长(便于配音对口型对齐),不加注释。"
        '只返回 JSON 数组,每项形如 {"i": 原序号, "t": "译文"},不要任何额外文字。'
    )
    user_msg = json.dumps(items, ensure_ascii=False)

    try:
        msg = await llm.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user_msg}]
        )
        arr = _extract_json_array(msg.get("content") or "")
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=502, detail=f"翻译结果解析失败:{e}") from e

    by_index = {s.index: s.text for s in body.segments}
    translated: list[dict] = []
    for item in arr:
        try:
            idx = int(item["i"])
            t = str(item["t"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if idx in by_index and t:
            translated.append({"index": idx, "translated": t})
    if not translated:
        raise HTTPException(status_code=502, detail="翻译未返回有效结果")
    return {"translated": translated, "count": len(translated), "target_lang": body.target_lang}
