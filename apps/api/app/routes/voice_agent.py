"""POST /api/agent/voice —— 语音 Agent 端点(M1.2)。

接收浏览器 webm/wav 录音 → ASR 转文字 → Agent 主循环(runner.run)→ SSE 流式回事件。
Agent 每产出一段 text 事件,自动异步调 TTS 服务合成语音,推 {type:"voice", url} 事件。
TTS 合成不阻塞 Agent 主循环(asyncio.create_task + 队列回灌)。

ASR 实现:复用 dub_text.py 的逻辑——优先调 settings.whisper_url(外部 GPU 服务),
否则用容器内置 faster-whisper(CPU)。TTS 复用 voice.py 的契约(IndexTTS2 /tts)。

流程:
  1. 接收 audio(UploadFile)+ 可选 canvas_id + 可选 messages(JSON 串历史对话)
  2. ASR → 转录文本
  3. 把转录文本作为 user message 追加到 messages,调 runner.run(canvas_id 透传)
  4. SSE 流式返回 Agent 事件:text/tool/image/video/audio/model3d/error/voice
  5. text 事件触发 TTS 异步合成,合成完成后追加 voice 事件
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlmodel import Session
from sse_starlette.sse import EventSourceResponse

from app.agent import runner
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.storage import content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

# 语音 Agent 上传/ASR/TTS 相关常量
_MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 单条录音上限 25MB(webm/wav)
_ASR_TIMEOUT = 60.0  # 外部 Whisper 听写短语音超时(秒)
_TTS_TIMEOUT = 180.0  # TTS 首调懒加载模型(~20s),给足余量
_ACCEPTED_AUDIO_CT = {
    "audio/webm", "audio/wav", "audio/x-wav", "audio/wave",
    "audio/ogg", "audio/mpeg", "audio/mp3", "audio/mp4",
    "application/octet-stream",  # 浏览器有时给通用类型,后缀兜底
}


# ── ASR:复用 dub_text.py 的基础设施 ──────────────────────────────────────

async def _transcribe_external(base: str, path: Path, name: str) -> str:
    """调外部 whisper_url(契约:POST {base}/asr multipart(file)→ {segments:[{start,end,text}]})。
    404 时回退 OpenAI 兼容 /v1/audio/transcriptions(AI-Omni ASR @ workstation:9210)。"""
    async with httpx.AsyncClient(timeout=_ASR_TIMEOUT) as client:
        with path.open("rb") as f:
            resp = await client.post(
                f"{base}/asr", files={"file": (name, f, "audio/webm")}
            )
        if resp.status_code == 404:
            with path.open("rb") as f:
                resp = await client.post(
                    f"{base}/v1/audio/transcriptions",
                    files={"file": (name, f, "audio/webm")},
                    data={"response_format": "verbose_json"},
                )
    resp.raise_for_status()
    segs = (resp.json() or {}).get("segments") or []
    return " ".join(str(s.get("text", "")).strip() for s in segs).strip()


async def _transcribe_local(path: Path) -> str:
    """用容器内置 faster-whisper(CPU)转录 → 拼接文本。复用 dub_text 的模型缓存/线程模式。"""
    from app.routes.dub_text import _get_whisper_model, _whisper_transcribe_sync

    model = await _get_whisper_model()
    job: dict[str, Any] = {"progress": 0, "started": time.monotonic(), "elapsed": 0.0}
    raw = await asyncio.to_thread(_whisper_transcribe_sync, model, str(path), job)
    return " ".join(str(s.get("text", "")).strip() for s in raw).strip()


async def _transcribe_audio(path: Path, name: str) -> str:
    """ASR:优先调 settings.whisper_url,否则容器内置 faster-whisper。返回转录文本。"""
    settings = get_settings()
    if settings.whisper_url.strip():
        return await _transcribe_external(settings.whisper_url.strip().rstrip("/"), path, name)
    return await _transcribe_local(path)


# ── TTS:复用 voice.py 的契约(IndexTTS2 /tts)──────────────────────────────

async def _tts_synth(text: str) -> str:
    """调 TTS 服务合成语音,落本地 manju 目录,返回 URL。

    复用 routes/voice.py 的契约 form {text}(voice_agent 不带 ref_audio/emo,
    简化首版;后续可扩展支持画布 default_ref_audio)。
    """
    settings = get_settings()
    tts_target = settings.tts_url.rstrip("/")
    voice_dir = content_subdir("manju")
    voice_dir.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False) as client:
        resp = await client.post(tts_target + "/tts", data={"text": text})

    if resp.status_code != 200 or not resp.content or resp.content[:4] != b"RIFF":
        raise RuntimeError(f"TTS 合成失败(status={resp.status_code})")

    name = f"voice-{uuid.uuid4().hex}.wav"
    (voice_dir / name).write_bytes(resp.content)
    return f"/api/manju/voice/{name}"


# ── 端点 ────────────────────────────────────────────────────────────────

async def _save_upload(audio: UploadFile) -> tuple[Path, str]:
    """把 UploadFile 落临时文件,返回 (path, 原始文件名)。ASR 需要可 seek 的本地文件。"""
    content = await audio.read()
    if not content:
        raise HTTPException(status_code=400, detail="空音频文件")
    if len(content) > _MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="音频过大(上限 25MB)")

    # 后缀兜底:浏览器 webm 录音 content-type 经常是 audio/webm;octet-stream 时用文件名
    ct = (audio.content_type or "").lower()
    name = audio.filename or "voice.webm"
    suffix = Path(name).suffix.lower() or ".webm"
    if ct in {"audio/wav", "audio/x-wav", "audio/wave"} and suffix not in {".wav", ".wave"}:
        suffix = ".wav"

    tf = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tf.write(content)
        tf.close()
    except OSError as e:
        try:
            Path(tf.name).unlink()
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"音频落盘失败:{e}") from e
    return Path(tf.name), name


def _parse_messages(messages_json: str | None) -> list[dict]:
    """解析可选的 messages JSON 串(历史对话),格式 [{role,content}]。"""
    if not messages_json:
        return []
    try:
        items = json.loads(messages_json)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"messages JSON 解析失败:{e}") from e
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="messages 必须是数组")
    out: list[dict] = []
    for m in items:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip()
        content = str(m.get("content") or "").strip()
        if role in ("user", "assistant", "system") and content:
            out.append({"role": role, "content": content[:8000]})
    return out


@router.post("/agent/voice")
async def voice_agent(
    audio: UploadFile = File(...),
    canvas_id: str | None = Form(default=None),
    messages: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
):
    """语音 Agent:audio → ASR → runner.run(canvas_id)→ SSE 流式(text 自动 TTS → voice 事件)。"""
    enforce_generation_rate_limit(user)

    # 1) 落盘 + ASR
    path, name = await _save_upload(audio)
    try:
        try:
            transcript = await _transcribe_audio(path, name)
        except ImportError as e:
            raise HTTPException(
                status_code=500,
                detail=f"ASR 依赖缺失(api 镜像需重建,装 faster-whisper 或配 whisper_url):{e}",
            ) from e
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"外部 ASR 服务不可达:{e}") from e
        except Exception as e:  # noqa: BLE001 — ASR 内部异常转 502
            raise HTTPException(status_code=502, detail=f"ASR 失败:{e}") from e
    finally:
        try:
            path.unlink()
        except OSError:
            pass

    transcript = (transcript or "").strip()
    if not transcript:
        raise HTTPException(status_code=422, detail="ASR 未识别到任何语音内容")

    # 2) 拼装 messages:历史 + 本轮转录文本
    history = _parse_messages(messages)
    history.append({"role": "user", "content": transcript})

    # 3) SSE 流式:Agent 事件 + 异步 TTS 合成 voice 事件
    async def stream():
        # TTS 异步任务列表(防止 GC 中断任务);合成完成后通过 queue 回灌 voice 事件
        voice_queue: asyncio.Queue[dict | None] = asyncio.Queue()
        pending_tts: set[asyncio.Task] = set()

        async def _tts_then_enqueue(text_chunk: str) -> None:
            try:
                url = await _tts_synth(text_chunk)
                await voice_queue.put({"type": "voice", "url": url, "text": text_chunk})
            except Exception as e:  # noqa: BLE001 — TTS 失败不应阻断 Agent 主循环
                logger.warning("voice_agent TTS 失败:%s", e)
                await voice_queue.put({
                    "type": "error", "content": f"语音合成失败:{e}",
                    "source": "tts", "text": text_chunk,
                })

        try:
            async for ev in runner.run(history, pool, user, session, canvas_id=canvas_id):
                # Agent text 事件 → 触发异步 TTS,同时把 text 事件也推给前端
                if ev.get("type") == "text" and ev.get("content"):
                    content = ev["content"]
                    task = asyncio.create_task(_tts_then_enqueue(content))
                    pending_tts.add(task)
                    task.add_done_callback(pending_tts.discard)
                yield {"event": "msg", "data": json.dumps(ev, ensure_ascii=False)}
                # 在每个 Agent 事件后,把已就绪的 voice 事件也排空回灌
                while not voice_queue.empty():
                    vev = await voice_queue.get()
                    if vev is None:
                        continue
                    yield {"event": "msg", "data": json.dumps(vev, ensure_ascii=False)}

            # Agent 主循环结束:等所有未完成的 TTS 任务收尾,把 voice 事件全推出去
            if pending_tts:
                await asyncio.gather(*pending_tts, return_exceptions=True)
            while not voice_queue.empty():
                vev = await voice_queue.get()
                if vev is None:
                    continue
                yield {"event": "msg", "data": json.dumps(vev, ensure_ascii=False)}
        finally:
            # 兜底取消未完成的 TTS(防泄漏)
            for t in list(pending_tts):
                if not t.done():
                    t.cancel()

        yield {"event": "done", "data": json.dumps({"transcript": transcript}, ensure_ascii=False)}

    return EventSourceResponse(stream())
