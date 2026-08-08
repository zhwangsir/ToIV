"""人声分离公共服务(Demucs htdemucs @ workstation,TOIV_AUDIO_SEP_URL)。

服务契约:POST {audio_sep_url}/separate multipart(file=音频) → vocals wav 二进制(audio/wav)。
2026-08-08 起另有 /separate_accompaniment → no_vocals wav(反推音乐链路用)。

失败纪律(不吞异常,调用方拿到清晰原因):
- 服务未配置(audio_sep_url 为空)→ HTTPException 503
- 不可达 / 超时 / 非 200 / 返回非 wav → HTTPException 502

消费方:译制参考音前置(routes/dub_voice,失败回退原始参考音)、
人声分离独立端点(routes/audio_tools,失败直接返回错误码)。
"""
from __future__ import annotations

import httpx
from fastapi import HTTPException

from app.config import get_settings

_AUDIO_SEP_TIMEOUT = 300.0  # 服务端串行排队 + Demucs 推理,留足


async def _separate(
    audio: bytes, filename: str, base_url: str | None, path: str
) -> bytes:
    raw = base_url if base_url is not None else get_settings().audio_sep_url
    base = raw.strip().rstrip("/")
    if not base:
        raise HTTPException(
            status_code=503, detail="人声分离服务未配置(TOIV_AUDIO_SEP_URL 为空)"
        )
    try:
        async with httpx.AsyncClient(
            timeout=_AUDIO_SEP_TIMEOUT, follow_redirects=True
        ) as client:
            resp = await client.post(
                base + path,
                files={"file": (filename, audio, "audio/wav")},
            )
    except httpx.TimeoutException as e:
        raise HTTPException(status_code=502, detail=f"人声分离服务超时:{e}") from e
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"人声分离服务不可达:{e}") from e
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"人声分离失败(HTTP {resp.status_code})"
        )
    if not resp.content or resp.content[:4] != b"RIFF":
        raise HTTPException(status_code=502, detail="人声分离服务返回非 wav 音频")
    return resp.content


async def separate_vocals(
    audio: bytes, filename: str = "audio", base_url: str | None = None
) -> bytes:
    """调人声分离服务提取干净人声,返回 vocals wav 字节。

    Args:
        audio:    原始音频字节(任意 Demucs 可解码格式)。
        filename: multipart 上传用的文件名(服务端按扩展名选解码器)。
        base_url: 服务地址覆盖;None = 读 config.audio_sep_url(常规路径)。

    Raises:
        HTTPException(503): 人声分离服务未配置(TOIV_AUDIO_SEP_URL 为空)。
        HTTPException(502): 服务不可达/超时/返回错误或非 wav 内容。
    """
    return await _separate(audio, filename, base_url, "/separate")


async def separate_accompaniment(
    audio: bytes, filename: str = "audio", base_url: str | None = None
) -> bytes:
    """调人声分离服务提取伴奏/背景音乐(no_vocals),返回 wav 字节。

    反推音乐链路专用(2026-08-08):伴奏送 Omni-Captioner 生成音乐描述。
    异常契约同 separate_vocals(503 未配置 / 502 不可达或失败)。
    """
    return await _separate(audio, filename, base_url, "/separate_accompaniment")
