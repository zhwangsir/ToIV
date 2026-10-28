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


def _safe_ref_log(url: str) -> str:
    """日志用脱敏引用:去 query(签名/密钥)与 userinfo,绝不写完整 URL。"""
    u = (url or "").split("?", 1)[0]
    if "://" in u:
        try:
            from urllib.parse import urlsplit

            p = urlsplit(u)
            u = f"{p.scheme}://{p.hostname or ''}{p.path}"
        except ValueError:
            return "<非法URL>"
    return u[:80]


async def _fetch_voice_ref(url: str) -> bytes | None:
    """角色参考音字节(与参考图同一安全口径,见 app.services.ref_guard)。

    - /api/studio/files/… 站内直读受控磁盘根(不再回环 HTTP 自调,旧链无鉴权
      头必 401 且环回属私网目标);
    - 裸文件路径/非 http(s) scheme 一律拒绝;
    - 公网 http(s) 经 guard_public_http_url(私网/环回/链路本地默认拒绝,
      拒绝 URL userinfo,仅配置主机可放行)。
    任何失败返回 None(调用方降级默认音色,不阻塞合成)。
    """
    from pathlib import Path

    from app.services.ref_guard import (
        RefUrlError,
        guard_public_http_url,
        read_studio_ref_file,
    )

    u = (url or "").strip()
    marker = "/api/studio/files/"
    if marker in u:
        name = Path(u.split(marker, 1)[1].split("?", 1)[0]).name
        return read_studio_ref_file(name)
    if not (u.startswith("http://") or u.startswith("https://")):
        logger.warning("参考音地址非法(拒绝裸路径/非 http(s)): %s", _safe_ref_log(u))
        return None
    try:
        guarded = await guard_public_http_url(u)
    except RefUrlError as e:
        logger.warning("参考音地址被安全守卫拒绝: %s (%s)", _safe_ref_log(u), type(e).__name__)
        return None
    try:
        async with httpx.AsyncClient(timeout=_REF_TIMEOUT, trust_env=False) as client:
            r = await client.get(guarded)
            r.raise_for_status()
            return r.content
    except httpx.HTTPError:
        return None


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
    """按分镜说话人取角色参考音合成;状态机:rendered → voiced。

    C1a:合成成功登记 source=render 音频输入快照(台词/说话人/音色依据),
    voiced_revision_id 指向它;之后改 dialogue/speaker/换音色参考经音频指纹
    比对出 stale,改 prompt 等视觉字段不误伤。文本/音色来源在 synth 前捕获
    (F4:合成在途的用户编辑不得记入);参考音下载降级事实如实存
    render_params.voice_ref_degraded(指纹口径=配置来源,不谎报)。
    """
    ref: bytes | None = None
    if character and character.voice_ref_url:
        ref = await _fetch_voice_ref(character.voice_ref_url)
        if ref is None:
            # 日志只记角色与类别:完整 URL 可能带签名 query,不进日志
            logger.warning(
                "参考音获取失败,降级默认音色: character=%s ref=%s",
                str(getattr(character, "id", "") or "")[:12],
                _safe_ref_log(character.voice_ref_url),
            )
    # F4:发起时快照(合成可能耗时,在途用户编辑不得改变本次输入记录)
    captured_snapshot = {
        "dialogue": shot.dialogue,
        "speaker": shot.speaker or "",
    }
    captured_voice_ref = (character.voice_ref_url if character else "") or ""
    captured_char_id = (getattr(character, "id", "") if character else "") or ""
    degraded = bool(captured_voice_ref) and ref is None
    url = await synth(shot.dialogue, ref)
    from app.services.studio import revisions as rev_svc

    voice_rev = rev_svc.create_render_revision(
        session,
        shot,
        render_params={
            "kind": "voice",
            "dialogue": captured_snapshot["dialogue"],
            "speaker": captured_snapshot["speaker"],
            "voice_ref_url": captured_voice_ref,
            "character_id": captured_char_id,
            "voice_ref_degraded": degraded,
        },
        created_by="system",
        snapshot_override=captured_snapshot,
        inputs_override={
            "voice_ref_url": captured_voice_ref,
            "character_id": captured_char_id,
        },
    )
    shot.voice_url = url
    shot.voiced_revision_id = voice_rev.id
    shot.status = "voiced"
    shot.error = ""
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return url
