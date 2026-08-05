"""配音服务:分镜台词 → IndexTTS2 合成 wav,落盘并回写分镜。

复用集群 TTS 端点(config.tts_url;ja/ko/yue 走 tts_multilingual_url),
角色卡带 voice_ref_url 时下载参考音作 multipart 转发,实现音色克隆;
参考音下载失败降级默认音色,不阻塞合成。

产物落 Studio 输出目录(drama_output_root()/studio,NAS 优先降级本地),
URL 经 /api/studio/files/{name} 访问。
"""
from __future__ import annotations

import logging
import uuid

import httpx
from sqlmodel import Session

from app.config import get_settings
from app.models import StudioCharacter, StudioShot

logger = logging.getLogger(__name__)

_TTS_TIMEOUT = 180.0  # TTS 服务懒加载模型,给足余量
_REF_TIMEOUT = 30.0
_MULTILINGUAL = {"ja", "ko", "yue"}


class VoiceError(RuntimeError):
    pass


def _save_wav(data: bytes) -> str:
    """落盘到 Studio 输出目录,返回可访问 URL。"""
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.wav"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def _resolve_ref(url: str) -> str:
    """相对路径(本 API 资产)补全为绝对 URL。"""
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


async def synth(text: str, ref_audio_bytes: bytes | None, language: str = "zh") -> str:
    """合成台词 → wav URL。TTS 未配置/不可达/非音频返回抛 VoiceError。"""
    settings = get_settings()
    multilingual = language in _MULTILINGUAL
    target = (
        settings.tts_multilingual_url.strip().rstrip("/")
        if multilingual
        else settings.tts_url.strip().rstrip("/")
    )
    if not target:
        raise VoiceError("TTS 服务未配置")
    data: dict[str, str] = {"text": text}
    if multilingual:
        data["language"] = language
    files = (
        {"ref_audio": ("ref.wav", ref_audio_bytes, "audio/wav")}
        if ref_audio_bytes
        else None
    )
    try:
        async with httpx.AsyncClient(
            timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            resp = await client.post(target + "/tts", data=data, files=files)
    except httpx.HTTPError as e:
        raise VoiceError(f"TTS 服务不可达:{e}") from e
    if resp.status_code != 200 or not resp.content.startswith(b"RIFF"):
        raise VoiceError(f"TTS 合成失败(code={resp.status_code})")
    return _save_wav(resp.content)


async def synth_for_shot(
    session: Session, shot: StudioShot, character: StudioCharacter | None
) -> str:
    """按分镜说话人取角色参考音合成;状态机:rendered → voiced。"""
    ref: bytes | None = None
    if character and character.voice_ref_url:
        try:
            async with httpx.AsyncClient(timeout=_REF_TIMEOUT, trust_env=False) as client:
                r = await client.get(_resolve_ref(character.voice_ref_url))
                r.raise_for_status()
                ref = r.content
        except httpx.HTTPError:
            logger.warning("参考音下载失败,降级默认音色: %s", character.voice_ref_url)
    url = await synth(shot.dialogue, ref)
    shot.voice_url = url
    shot.status = "voiced"
    shot.error = ""
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return url
