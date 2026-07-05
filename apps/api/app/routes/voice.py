"""POST /api/manju/voice —— 漫剧逐镜配音:把中文台词送到自部署 TTS(IndexTTS2)合成语音。

漫剧 = 漫画 + 剧,语音是其灵魂。每镜有中文 dialogue,本端点调 .100:9000 的 TTS 独立服务
(隔离 venv,见 config.tts_url)把台词合成 wav,落到 /data/manju 下,GET /api/manju/voice/{name}
取回;成片时由 assembly 逐镜对齐混入(adelay + amix)。

- 默认用兜底音色;传 ref_audio_url(指向本 API 资产或白名单 worker)则克隆该角色音色。
- emo_text 给情感描述(喜怒哀乐),emo_alpha 控强度。
- ref_audio_url 仅允许相对路径 / 白名单来源,防 SSRF。
"""
from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
import uuid
import wave
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.deps import get_current_user
from app.models import User
from app.storage import content_subdir
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

# 与 assembly 同一输出目录(生成内容根,可切 NAS),成片混音可直接读到。
_VOICE_DIR = content_subdir("manju")
_VOICE_NAME_RE = re.compile(r"^voice(?:ref)?-[0-9a-f]{32}\.wav$")  # 合成配音 + 角色定妆音色
_TTS_TIMEOUT = 180.0  # 首次调用 TTS 服务要懒加载模型(~20s),给足余量
_LOCAL_API_BASE = "http://127.0.0.1:8080"
_MAX_REF_BYTES = 25 * 1024 * 1024  # 角色音色参考音上限 25MB
_REF_MAX_SEC = 30  # 参考音裁到 30s 足够克隆,防超长


class VoiceRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)  # 单镜台词
    emo_text: str | None = Field(default=None, max_length=200)  # 情感描述(可选)
    emo_alpha: float = Field(default=0.6, ge=0.0, le=1.0)
    ref_audio_url: str | None = Field(default=None, max_length=2000)  # 角色音色克隆参考音
    language: str = Field(default="zh", max_length=10)  # 合成语言


class VoiceResponse(BaseModel):
    url: str
    name: str
    duration_sec: float


def _allowed_ref(url: str) -> bool:
    """参考音来源白名单:相对路径(本 API)或白名单 worker host,防 SSRF。"""
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
    return _LOCAL_API_BASE + (url if url.startswith("/") else "/" + url)


def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 2)
    except (wave.Error, OSError):
        return 0.0


@router.post("/manju/voice", response_model=VoiceResponse)
async def synth_voice(
    body: VoiceRequest,
    user: User = Depends(get_current_user),
) -> VoiceResponse:
    enforce_generation_rate_limit(user)
    settings = get_settings()

    allowed_languages = {"zh", "en", "ja", "ko", "yue"}
    if body.language not in allowed_languages:
        raise HTTPException(status_code=422, detail="不支持的合成语言")

    # zh/en 走默认 tts_url；ja/ko/yue 走多语言 TTS，请求附加 language。
    is_multilingual = body.language in {"ja", "ko", "yue"}
    if is_multilingual:
        tts_target = settings.tts_multilingual_url.strip().rstrip("/")
        if not tts_target:
            raise HTTPException(status_code=503, detail="多语言 TTS 服务未配置")
    else:
        tts_target = settings.tts_url.rstrip("/")

    data: dict[str, str] = {"text": body.text}
    if body.emo_text and body.emo_text.strip():
        data["emo_text"] = body.emo_text.strip()
        data["emo_alpha"] = str(body.emo_alpha)
    if is_multilingual:
        data["language"] = body.language

    files = None
    async with httpx.AsyncClient(timeout=_TTS_TIMEOUT, follow_redirects=True) as client:
        # 角色音色:下载参考音再转发给 TTS 服务(multipart 文件)
        if body.ref_audio_url:
            if not _allowed_ref(body.ref_audio_url):
                raise HTTPException(status_code=400, detail="参考音来源不在白名单内")
            try:
                rr = await client.get(_resolve_url(body.ref_audio_url))
                rr.raise_for_status()
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"参考音下载失败:{e}") from e
            files = {"ref_audio": ("ref.wav", rr.content, "audio/wav")}

        try:
            resp = await client.post(
                tts_target + "/tts", data=data, files=files
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"TTS 服务不可达:{e}") from e

    if resp.status_code != 200:
        detail = "TTS 合成失败"
        try:
            detail = resp.json().get("detail", detail)
        except (ValueError, KeyError):
            detail = resp.text[:200] or detail
        raise HTTPException(status_code=502, detail=detail)
    if not resp.content or resp.content[:4] != b"RIFF":
        raise HTTPException(status_code=502, detail="TTS 返回非音频")

    _VOICE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"voice-{uuid.uuid4().hex}.wav"
    path = _VOICE_DIR / name
    path.write_bytes(resp.content)

    return VoiceResponse(url=f"/api/manju/voice/{name}", name=name, duration_sec=_wav_duration(path))


async def _convert_to_wav(src: Path, dst: Path) -> None:
    """ffmpeg 把上传音频归一为干净 wav(单声道 24k,裁 30s),供音色克隆。"""
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", str(src), "-ac", "1", "-ar", "24000",
        "-t", str(_REF_MAX_SEC), str(dst),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
        tail = (stderr or b"").decode("utf-8", "replace")[-300:]
        raise HTTPException(status_code=400, detail=f"音频转码失败(非有效音频?):{tail}")


@router.post("/manju/voice-ref", response_model=VoiceResponse)
async def upload_voice_ref(
    audio: UploadFile,
    user: User = Depends(get_current_user),
) -> VoiceResponse:
    """上传角色定妆音色参考音 → 归一为 wav 存档,返回 URL(逐镜配音时作克隆参考)。"""
    content = await audio.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if len(content) > _MAX_REF_BYTES:
        raise HTTPException(status_code=413, detail="音频过大(上限 25MB)")
    _VOICE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"voiceref-{uuid.uuid4().hex}.wav"
    out = _VOICE_DIR / name
    tf = tempfile.NamedTemporaryFile(suffix="_ref", delete=False)
    try:
        tf.write(content)
        tf.close()
        await _convert_to_wav(Path(tf.name), out)
    finally:
        try:
            Path(tf.name).unlink()
        except OSError:
            pass
    return VoiceResponse(url=f"/api/manju/voice/{name}", name=name, duration_sec=_wav_duration(out))


@router.get("/manju/voice/{name}")
async def get_voice(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _VOICE_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _VOICE_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="配音不存在")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )
