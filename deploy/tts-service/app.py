"""ToIV TTS 服务 —— FastAPI 封装 edge-tts，接口兼容 IndexTTS2 /tts 契约。

兼容契约（ToIV voice.py / dub_voice.py 调用方期望）：
  POST /tts
    Form: text, emo_text(可选), emo_alpha(可选), language(可选)
    Files: ref_audio(可选, multipart) —— 本服务不支持音色克隆，ref_audio 忽略
    Response: 200 + wav 二进制(RIFF)；失败返回 JSON {"detail": "..."}

语言路由（ToIV 约定）：
  zh  -> 中文(普通话)  en -> 英语    ja -> 日语
  ko  -> 韩语          yue -> 粤语

音色情感近似：
  happy/excited → 高声调 + 稍快
  sad/tired     → 低声调 + 稍慢
  angry         → 稍快 + 中等语调
  calm          → 慢速 + 平稳语调
(edge-tts 无原生情感轴，用 pitch/rate 近似)
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import wave
from typing import Optional

import edge_tts
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

logger = logging.getLogger("toiv-tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="ToIV TTS Service (edge-tts)")

VOICE_MAP = {
    "zh":  "zh-CN-XiaoxiaoNeural",
    "en":  "en-US-AriaNeural",
    "ja":  "ja-JP-NanamiNeural",
    "ko":  "ko-KR-SunHiNeural",
    "yue": "zh-HK-HiuMaanNeural",
}

DEFAULT_VOICE = VOICE_MAP["zh"]
MAX_TEXT_LEN = 2000


def _select_voice(language: str | None) -> str:
    if not language:
        return DEFAULT_VOICE
    lang = language.lower().strip()
    return VOICE_MAP.get(lang, DEFAULT_VOICE)


_EMO_PARAMS = {
    "happy":   {"pitch": "+12Hz", "rate": "+8%"},
    "excited": {"pitch": "+15Hz", "rate": "+12%"},
    "angry":   {"pitch": "+5Hz",  "rate": "+10%"},
    "sad":     {"pitch": "-8Hz",  "rate": "-10%"},
    "tired":   {"pitch": "-5Hz",  "rate": "-8%"},
    "calm":    {"pitch": "0Hz",   "rate": "-5%"},
    "soft":    {"pitch": "0Hz",   "rate": "-3%"},
}


def _emo_to_pr(emo_text: str | None, emo_alpha: float) -> tuple[str, str]:
    """返回 (pitch, rate) 字符串。无情感时返回空字符串 = 不传参。"""
    if not emo_text or emo_alpha <= 0:
        return ("", "")
    key = emo_text.strip().lower()
    for k, params in _EMO_PARAMS.items():
        if k in key:
            base_pitch = params["pitch"]
            base_rate = params["rate"]
            pitch_hz = int(base_pitch.replace("Hz", ""))
            rate_pct = int(base_rate.replace("%", "").replace("+", ""))
            return (
                f"{int(pitch_hz * emo_alpha):+d}Hz",
                f"{int(rate_pct * emo_alpha):+d}%",
            )
    return ("", "")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "engine": "edge-tts", "voices": list(VOICE_MAP.keys())}


@app.post("/tts")
async def tts(
    text: str = Form(...),
    emo_text: Optional[str] = Form(None),
    emo_alpha: Optional[str] = Form("0.6"),
    language: Optional[str] = Form(None),
    ref_audio: Optional[UploadFile] = File(None),
):
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail=f"text 过长,上限 {MAX_TEXT_LEN} 字符")

    voice = _select_voice(language)
    try:
        alpha = float(emo_alpha) if emo_alpha else 0.6
    except (ValueError, TypeError):
        alpha = 0.6
    pitch, rate = _emo_to_pr(emo_text, alpha)

    try:
        kwargs: dict = {"text": text, "voice": voice}
        if pitch:
            kwargs["pitch"] = pitch
        if rate:
            kwargs["rate"] = rate
        communicate = edge_tts.Communicate(**kwargs)
        mp3_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                mp3_chunks.append(chunk["data"])
        mp3_data = b"".join(mp3_chunks)
    except Exception as e:
        logger.exception("edge-tts 合成失败")
        raise HTTPException(status_code=502, detail=f"TTS 合成失败: {e}")

    if not mp3_data:
        raise HTTPException(status_code=500, detail="TTS 合成为空")

    wav_data = _mp3_to_wav(mp3_data)
    return Response(content=wav_data, media_type="audio/wav")


def _mp3_to_wav(mp3_data: bytes) -> bytes:
    """mp3 -> wav (16-bit PCM, 24kHz mono) 便于 ffmpeg 后处理与时长探测。"""
    import tempfile
    import subprocess

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f_mp3:
        f_mp3.write(mp3_data)
        mp3_path = f_mp3.name
    wav_path = mp3_path + ".wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", mp3_path, "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", wav_path],
            check=True, capture_output=True,
        )
        with open(wav_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(mp3_path)
            os.unlink(wav_path)
        except OSError:
            pass
