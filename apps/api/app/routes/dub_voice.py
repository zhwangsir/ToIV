"""视频译制·配音轨 —— 逐片段合成译文语音,按时间轴铺成整轨(喂对口型 audio_name)。

  POST /api/dub/voice-track   译文片段 [{start,end,text}] → 整条配音轨 dubvoice-*.wav
  GET  /api/dub/voice-track/{name}  回配音轨(供前端试听)

复用 IndexTTS2(config.tts_url,见 voice.py)。默认从**源视频自带音轨**就地抽几秒做
参考音 → 克隆原说话人音色(译制后仍是原角色的声线),且全程本地文件、无内部鉴权下载坑。
逐段 atempo 贴合原时槽长度(便于对口型逐段对齐),adelay 铺到各自起点,amix 成整轨。
产物落 _DUB_DIR,经 /dub/lipsync-long 的 audio_name 直读做对口型音源。
"""
from __future__ import annotations

import re
import tempfile
import uuid
import wave
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.assembly import _run_ffmpeg
from app.routes.dub import _DUB_DIR, _NAME_RE, _probe_duration

router = APIRouter()

_TTS_TIMEOUT = 180.0  # IndexTTS2 首调懒加载模型 ~20s,留足
_MAX_SEGMENTS = 200
_VOICE_TRACK_RE = re.compile(r"^dubvoice-[0-9a-f]{32}\.wav$")
_TEMPO_MAX = 2.0  # atempo 单段上限(超出则略溢出时槽,可接受)


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


class VoiceTrackResponse(BaseModel):
    name: str
    url: str
    duration: float
    segment_count: int


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


@router.post("/dub/voice-track", response_model=VoiceTrackResponse)
async def dub_voice_track(
    body: VoiceTrackRequest,
    user: User = Depends(get_current_user),
) -> VoiceTrackResponse:
    enforce_generation_rate_limit(user)
    settings = get_settings()
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = _DUB_DIR / body.name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")

    src_dur = await _probe_duration(src)
    segs = sorted(body.segments, key=lambda s: s.start)
    total = max((s.end for s in segs), default=0.0)
    if src_dur > 0:
        total = max(total, src_dur)
    if total <= 0:
        raise HTTPException(status_code=422, detail="片段时间轴无效")

    _DUB_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dub-voice-") as tmp:
        tmp_dir = Path(tmp)

        # 从源视频自带音轨抽参考音 → 克隆原说话人(取首个片段处,确保有人声)
        ref_bytes: bytes | None = None
        if body.ref_seconds > 0:
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
                try:
                    audio = await _tts(
                        client, settings.tts_url, s.text,
                        body.emo_text, body.emo_alpha, ref_bytes,
                    )
                except (httpx.HTTPError, RuntimeError):
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

        if not wavs:
            raise HTTPException(status_code=502, detail="配音全部失败(检查 TTS 服务)")

        out_name = f"dubvoice-{uuid.uuid4().hex}.wav"
        out_path = _DUB_DIR / out_name
        cmd = _build_track_cmd(wavs, starts, tempos, total, out_path)
        await _run_ffmpeg(cmd)

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="配音轨合成为空")

    return VoiceTrackResponse(
        name=out_name,
        url=f"/api/dub/voice-track/{out_name}",
        duration=_wav_duration(out_path),
        segment_count=len(wavs),
    )


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
