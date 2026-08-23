"""POST /api/audio/orchestrate —— 音频编排层:把已能独立运行的音频引擎(TTS/人声分离)
统一成一条顺序执行的编排 API。纯编排,不动引擎本身。

首批落地两条链(2026-08-23):
- 多角色 TTS 对白合成:steps 里多个 tts 步骤(可选 role → 请求级 voices 音色映射)
  顺序合成 → concat 步骤用 ffmpeg 拼接成一条对白 wav。
- 人声分离:separate 步骤包装 services.audio_sep(demucs @ workstation),
  source_url 指向本 API 资产或白名单来源(防 SSRF,同 voice.py 纪律)。

混音/音效/变体现无现成引擎,steps 里传 mix/sfx/variant 明确返回 501 占位,不造假。

执行语义:顺序执行;任一步失败即中断,HTTPException detail 带步骤序号;
ffmpeg 不可用时不硬拼——返回全部分段产物 + note 标注。
产物建档与 voice.py/audio_tools.py 同口径:Job(kind=audio_orchestrate, status=done),
result = 产物 URL 列表(拼接产物在前),前端作品库经 /api/jobs 回读。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
import uuid
import wave
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.images import _ranged_response
from app.services.audio_sep import separate_accompaniment, separate_vocals
from app.storage import audio_output_root, content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

_TTS_TIMEOUT = 180.0  # 同 voice.py:TTS 服务懒加载模型,给足余量
_OUT_NAME_RE = re.compile(r"^audioorch-[0-9a-f]{32}\.wav$")
_ALLOWED_LANGUAGES = {"zh", "en", "ja", "ko", "yue"}
_MAX_SOURCE_BYTES = 50 * 1024 * 1024  # 分离源音频上限 50MB,同 audio_tools


# ---------- 步骤 schema ----------

class VoiceSpec(BaseModel):
    """角色音色映射条目:tts 步骤带 role 时取这里的默认值(步骤级字段优先)。"""
    ref_audio_url: str | None = Field(default=None, max_length=2000)
    language: str = Field(default="zh", max_length=10)
    emo_text: str | None = Field(default=None, max_length=200)
    emo_alpha: float = Field(default=0.6, ge=0.0, le=1.0)


class TtsStep(BaseModel):
    type: Literal["tts"]
    text: str = Field(min_length=1, max_length=600)
    role: str | None = Field(default=None, max_length=50)  # 命中请求级 voices 映射
    ref_audio_url: str | None = Field(default=None, max_length=2000)
    language: str | None = Field(default=None, max_length=10)
    emo_text: str | None = Field(default=None, max_length=200)
    emo_alpha: float | None = Field(default=None, ge=0.0, le=1.0)


class SeparateStep(BaseModel):
    type: Literal["separate"]
    source_url: str = Field(min_length=1, max_length=2000)  # 相对路径或白名单 URL
    stem: Literal["vocals", "accompaniment"] = "vocals"


class ConcatStep(BaseModel):
    type: Literal["concat"]  # 拼接本轮此前所有 tts 分段(按步骤顺序)


class PlaceholderStep(BaseModel):
    """混音/音效/变体:现无引擎,明确 501 占位。"""
    type: Literal["mix", "sfx", "variant"]


Step = Annotated[
    TtsStep | SeparateStep | ConcatStep | PlaceholderStep,
    Field(discriminator="type"),
]


class OrchestrateRequest(BaseModel):
    steps: list[Step] = Field(min_length=1, max_length=20)
    title: str | None = Field(default=None, max_length=200)
    voices: dict[str, VoiceSpec] = Field(default_factory=dict, max_length=20)


# ---------- 内部工具 ----------

def _wav_duration(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 3)
    except (wave.Error, OSError):
        return None


def _allowed_source(url: str) -> bool:
    """来源白名单:相对路径(本 API)或白名单 worker host,防 SSRF(同 voice.py)。"""
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    settings = get_settings()
    allowed = {urlsplit(w).hostname for w in settings.worker_urls if urlsplit(w).hostname}
    return host in allowed or host in {"127.0.0.1", "localhost"}


def _resolve_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


def _write_output(audio: bytes) -> tuple[Path, str]:
    """产物写音频产物根目录(NAS 优先);不可写时降级本地回退目录(同 audio_tools)。"""
    name = f"audioorch-{uuid.uuid4().hex}.wav"
    root = audio_output_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        out = root / name
        out.write_bytes(audio)
        return out, name
    except OSError as e:
        logger.warning("音频产物根目录不可写(%s),降级本地回退目录:%s", root, e)
        fallback = content_subdir("audio")
        fallback.mkdir(parents=True, exist_ok=True)
        out = fallback / name
        out.write_bytes(audio)
        return out, name


async def _synth_tts(client: httpx.AsyncClient, step: TtsStep, spec: VoiceSpec) -> bytes:
    """单段 TTS 合成(多语言路由同 voice.py:zh/en 走 tts_url,ja/ko/yue 走多语言)。"""
    language = step.language or spec.language
    if language not in _ALLOWED_LANGUAGES:
        raise HTTPException(status_code=422, detail=f"不支持的合成语言:{language}")
    emo_text = step.emo_text if step.emo_text is not None else spec.emo_text
    emo_alpha = step.emo_alpha if step.emo_alpha is not None else spec.emo_alpha
    ref_audio_url = step.ref_audio_url or spec.ref_audio_url

    settings = get_settings()
    if language in {"ja", "ko", "yue"}:
        tts_target = settings.tts_multilingual_url.strip().rstrip("/")
        if not tts_target:
            raise HTTPException(status_code=503, detail="多语言 TTS 服务未配置")
    else:
        tts_target = settings.tts_url.strip().rstrip("/")

    data: dict[str, str] = {"text": step.text}
    if emo_text and emo_text.strip():
        data["emo_text"] = emo_text.strip()
        data["emo_alpha"] = str(emo_alpha)
    if language in {"ja", "ko", "yue"}:
        data["language"] = language

    files = None
    if ref_audio_url:
        if not _allowed_source(ref_audio_url):
            raise HTTPException(status_code=400, detail="参考音来源不在白名单内")
        try:
            rr = await client.get(_resolve_url(ref_audio_url))
            rr.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"参考音下载失败:{e}") from e
        files = {"ref_audio": ("ref.wav", rr.content, "audio/wav")}

    try:
        resp = await client.post(tts_target + "/tts", data=data, files=files)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"TTS 服务不可达:{e}") from e
    if resp.status_code != 200:
        detail = "TTS 合成失败"
        try:
            detail = resp.json().get("detail", detail)
        except (ValueError, KeyError, AttributeError):
            detail = (resp.text or "")[:200] or detail
        raise HTTPException(status_code=502, detail=detail)
    if not resp.content or resp.content[:4] != b"RIFF":
        raise HTTPException(status_code=502, detail="TTS 返回非音频")
    return resp.content


async def _concat_wav(segments: list[Path]) -> bytes:
    """ffmpeg concat 拼接分段(重编码归一 24k 单声道,容错各段参数差异)。"""
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    with tempfile.TemporaryDirectory() as td:
        lst = Path(td) / "concat.txt"
        lst.write_text(
            "".join(f"file '{p}'\n" for p in segments), encoding="utf-8"
        )
        out = Path(td) / "out.wav"
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
            "-ac", "1", "-ar", "24000", str(out),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            tail = (stderr or b"").decode("utf-8", "replace")[-300:]
            raise HTTPException(status_code=500, detail=f"音频拼接失败:{tail}")
        return out.read_bytes()


# ---------- 端点 ----------

@router.post("/audio/orchestrate")
async def audio_orchestrate(
    body: OrchestrateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """顺序执行编排步骤,产物落盘 + Job(kind=audio_orchestrate) 建档。

    失败纪律:任一步失败即中断,detail 前缀「步骤 N(类型)」;引擎不可达 502,
    服务未配置 503;mix/sfx/variant 占位 501;ffmpeg 缺失时 concat 不硬拼,
    返回分段 + note。
    """
    enforce_generation_rate_limit(user)

    segments: list[Path] = []  # tts 分段(concat 的输入)
    artifacts: list[dict[str, object]] = []  # 全部产物(分段/分离结果/拼接产物)
    final_url: str | None = None
    note: str | None = None

    async with httpx.AsyncClient(timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False) as client:
        for i, step in enumerate(body.steps):
            try:
                if isinstance(step, PlaceholderStep):
                    raise HTTPException(
                        status_code=501,
                        detail=f"步骤类型 {step.type} 暂未实现(无现成引擎,TODO 占位)",
                    )
                if isinstance(step, TtsStep):
                    spec = body.voices.get(step.role or "") or VoiceSpec()
                    wav = await _synth_tts(client, step, spec)
                    path, name = _write_output(wav)
                    segments.append(path)
                    artifacts.append({
                        "step": i, "type": "tts", "role": step.role,
                        "url": f"/api/audio/orch/files/{name}",
                        "duration_sec": _wav_duration(path),
                    })
                elif isinstance(step, SeparateStep):
                    if not _allowed_source(step.source_url):
                        raise HTTPException(status_code=400, detail="分离源不在白名单内")
                    try:
                        rr = await client.get(_resolve_url(step.source_url))
                        rr.raise_for_status()
                    except httpx.HTTPError as e:
                        raise HTTPException(status_code=502, detail=f"分离源下载失败:{e}") from e
                    if len(rr.content) > _MAX_SOURCE_BYTES:
                        raise HTTPException(status_code=413, detail="分离源音频过大(上限 50MB)")
                    fn = urlsplit(step.source_url).path.rsplit("/", 1)[-1] or "audio.wav"
                    if step.stem == "accompaniment":
                        wav = await separate_accompaniment(rr.content, filename=fn)
                    else:
                        wav = await separate_vocals(rr.content, filename=fn)
                    path, name = _write_output(wav)
                    artifacts.append({
                        "step": i, "type": "separate", "stem": step.stem,
                        "url": f"/api/audio/orch/files/{name}",
                        "duration_sec": _wav_duration(path),
                    })
                elif isinstance(step, ConcatStep):
                    if not segments:
                        raise HTTPException(status_code=422, detail="没有可拼接的 TTS 分段")
                    if shutil.which("ffmpeg") is None:
                        # 不硬拼:分段产物照常交付,note 标注(任务纪律)。
                        note = "服务端无 ffmpeg,跳过拼接,仅返回分段产物"
                        logger.warning("audio/orchestrate: ffmpeg 不可用,concat 步骤跳过")
                        continue
                    wav = await _concat_wav(segments)
                    path, name = _write_output(wav)
                    final_url = f"/api/audio/orch/files/{name}"
                    artifacts.append({
                        "step": i, "type": "concat",
                        "url": final_url,
                        "duration_sec": _wav_duration(path),
                    })
            except HTTPException as e:
                # 失败中断:标注步骤序号后原码上抛。
                e.detail = f"步骤 {i}({step.type}) 失败:{e.detail}"
                raise

    result_urls = ([final_url] if final_url else []) + [
        str(a["url"]) for a in artifacts if a["type"] != "concat"
    ]
    prompt = (body.title or "").strip() or next(
        (s.text for s in body.steps if isinstance(s, TtsStep)), "audio orchestration"
    )

    # 建档(同 voice.py 纪律:产物已落盘,建档失败不炸主流程)
    try:
        session.add(
            Job(
                tenant_id=user.tenant_id,
                user_id=user.id,
                prompt_id=f"orch-{uuid.uuid4().hex}",
                worker="local",
                kind="audio_orchestrate",
                status="done",
                prompt=prompt[:500],
                seed=0,
                result=json.dumps(result_urls, ensure_ascii=False),
                params=json.dumps(
                    {
                        "title": body.title,
                        "steps": [
                            s.model_dump(exclude_none=True) for s in body.steps
                        ],
                        "note": note,
                    },
                    ensure_ascii=False,
                ),
            )
        )
        session.commit()
    except Exception:
        session.rollback()
        logger.warning("编排产物建档失败(音频已落盘)", exc_info=True)

    return {
        "kind": "audio_orchestrate",
        "url": final_url,
        "artifacts": artifacts,
        "note": note,
    }


@router.get("/audio/orch/files/{name}")
async def get_orch_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    """回读编排产物。NAS 根目录与本地回退目录依次找;手动 Range 支持(同 audio_tools)。"""
    if not _OUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    for root in (audio_output_root(), content_subdir("audio")):
        try:
            path = root / name
            if path.is_file():
                return _ranged_response(
                    path.read_bytes(), "audio/wav", request.headers.get("range")
                )
        except OSError as e:
            logger.warning("音频产物目录不可达(%s):%s", root, e)
    raise HTTPException(status_code=404, detail="音频产物不存在")
