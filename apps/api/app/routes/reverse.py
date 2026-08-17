"""POST /api/reverse —— 反推提示词:上传图/视频/音频,反推出可复用的生成提示词。

链路(2026-08-08 集群重排后,见 docs/2026-08-08-cluster-reallocation-plan.md):
- SFW 图像 + 全部视频 → studio04 MLX Qwen2.5-VL-72B-Instruct-4bit 自定义 /v1/reverse
  服务(reverse_vlm_base_url;GPU3 toiv-vlm 停而不删作热回退)。图像走 image_url、视频走
  video_url(base64 data URL;reverse_video_mac_prefix 非空时走 NAS 中转本地路径)。
  系统提示作为 prompt 传入,模型返回自然语言描述,core 侧按 JSON/纯文本兜底解析。
  视频反推按六段式(镜头运动/主体/动作/场景/光线/风格)组织叙事长描述。
- NSFW 图像(X-NSFW)→ JoyCaption 专线(joycaption_base_url,空串回退 Qwen3-VL)。
- 音频 → SenseVoice(sensevoice_url):转写 + 情绪 + 音频事件 + 语种,组合成人声描述;
  配了 omni_captioner_base_url 时再走增强链:demucs 分离伴奏 → Omni-Captioner 生成
  音乐描述,合并进 prompt(增强链失败只降级不 502)。
R18 上下文(X-NSFW)在系统提示中要求如实描述不回避;Qwen3-VL 官方对齐仍可能拒答,
R18 图像走 JoyCaption 专线解决。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import posixpath
import re
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel

from app import nas
from app.config import get_settings
from app.deps import get_current_user
from app.jsonutil import parse_json_obj
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_rate_limit
from app.services.audio_sep import separate_accompaniment

router = APIRouter()
logger = logging.getLogger(__name__)

# 视觉反推一次给足时长:视频 base64 内联较大,vLLM 首 token 也慢
_VLM_TIMEOUT = httpx.Timeout(300.0, connect=10.0)
_SENSEVOICE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

# vLLM served-model-name 是模型目录绝对路径(随部署变化),不写死:
# 首次请求时从 /models 自动探测并按 base_url 缓存;探测失败 → 502 而不是 404。
# None 表示该 base_url 为非 OpenAI 兼容服务(如 studio04 mlx-vlm)。
_model_id_cache: dict[str, str | None] = {}


async def _resolve_model_id(base_url: str) -> str | None:
    """探测 OpenAI 兼容服务的 /models;若端点不存在(如 studio04 MLX 自定义服务),返回 None。"""
    if base_url in _model_id_cache:
        return _model_id_cache[base_url]
    endpoint = f"{base_url.rstrip('/')}/models"
    try:
        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
            resp = await client.get(endpoint)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"VLM 反推服务不可达:{e}") from e
    if resp.status_code == 404:
        # 非 OpenAI 兼容服务(如 studio04 mlx-vlm),交由 _mlx_vlm_reverse 处理
        _model_id_cache[base_url] = None
        return None
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"VLM 反推服务返回 {resp.status_code},请重试")
    try:
        model_id = resp.json()["data"][0]["id"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise HTTPException(status_code=502, detail="VLM 服务模型列表为空") from e
    _model_id_cache[base_url] = model_id
    return model_id

_EXT_KIND = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image",
    ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".flac": "audio",
    ".ogg": "audio", ".aac": "audio",
}

_MIME_FALLBACK = {
    "image": "image/png",
    "video": "video/mp4",
    "audio": "audio/wav",
}

_NSFW_CLAUSE = "画面若含成人/裸露内容,如实描述,不要回避、淡化或拒绝。"

# 图像反推:自然语言长描述(Flux/H3 i2v 偏好)+ 题材匹配的负面词
_IMAGE_SYSTEM = (
    "你是顶尖的生成模型提示词工程师。用户上传一张图,你要**逆向工程**出能重新生成"
    "类似画面的提示词。\n"
    "要求:\n"
    "1) prompt:一段流畅的英文自然语言长描述(主体、外貌、动作、场景、光线、构图、"
    "镜头、风格/质感),忠实画面实际内容,不脑补不存在的东西;\n"
    "2) negative:一段与画面题材匹配的英文负向提示词(5~15 个具体可视词,如 "
    "deformed hands, blurry, watermark;写实题材排除 cartoon/anime,动漫题材排除 "
    "photorealistic/3d render),避免 ugly/bad 这类抽象评价词。\n"
    '只输出 JSON:{"prompt": "...", "negative": "..."},不要解释,不要代码块标记。'
)

# 视频反推:六段式叙事(镜头运动/主体/动作/场景/光线/风格),H3/LongCat 偏好的形态
_VIDEO_SYSTEM = (
    "你是顶尖的视频生成模型(MiniMax H3 / LongCat)提示词工程师。用户上传一段视频,"
    "你要**逆向工程**出能重新生成类似视频的英文提示词。\n"
    "按六段式组织成一段连贯叙事(不要分点罗列):\n"
    "①镜头运动(运镜方式,如 push in / pan left / tracking shot)→ ②主体(外观特征)"
    "→ ③主体动作(按时序)→ ④场景环境 → ⑤光线氛围 → ⑥风格质感(cinematic/35mm 等)。\n"
    "忠实视频实际内容,动作描述要时序化,镜头运动准确,不脑补。\n"
    '只输出 JSON:{"prompt": "..."},不要解释,不要代码块标记。'
)


# 音乐反推(Omni-Captioner):描述伴奏的可复用生成提示词(曲风/乐器/节奏/情绪/用途)
_MUSIC_SYSTEM = (
    "你是顶尖的音乐生成模型(Suno/ElevenLabs Music 类)提示词工程师。用户上传一段音频"
    "(已分离出的伴奏/背景音乐),你要**逆向工程**出能重新生成类似音乐的英文提示词。\n"
    "一段流畅自然语言描述,覆盖:曲风/流派、情绪氛围、主要乐器与音色、节奏/BPM 特征、"
    "结构动态(起伏/高潮)、适用场景。忠实实际听感,不脑补。\n"
    '只输出 JSON:{"prompt": "..."},不要解释,不要代码块标记。'
)


class ReverseResponse(BaseModel):
    kind: str  # image / video / audio
    prompt: str
    negative: str | None = None
    meta: dict = {}


def _detect_kind(content_type: str, filename: str) -> str | None:
    """按 content-type 前缀判定,判定不了退回扩展名。"""
    for kind in ("image", "video", "audio"):
        if content_type.startswith(f"{kind}/"):
            return kind
    ext = os.path.splitext(filename or "")[1].lower()
    return _EXT_KIND.get(ext)


def _limit_for(kind: str) -> int:
    s = get_settings()
    return {
        "image": s.reverse_max_image_mb,
        "video": s.reverse_max_video_mb,
        "audio": s.reverse_max_audio_mb,
    }[kind] * 1024 * 1024


async def _mlx_vlm_reverse(system: str, part: dict, base_url: str) -> str:
    """调 studio04 mlx-vlm 自定义 /v1/reverse 端点(单图/单视频)。"""
    endpoint = f"{base_url.rstrip('/')}/reverse"
    payload: dict = {
        "prompt": system,
        "max_tokens": 2048,
        "temperature": 0.3,
    }
    if part.get("type") == "image_url":
        payload["image_url"] = part["image_url"]["url"]
    elif part.get("type") == "video_url":
        payload["video_path"] = part["video_url"]["url"]
    else:
        raise HTTPException(status_code=502, detail="VLM 不支持的媒体类型")

    try:
        async with httpx.AsyncClient(timeout=_VLM_TIMEOUT, trust_env=False) as client:
            resp = await client.post(endpoint, json=payload)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"VLM 反推服务不可达:{e}") from e
    if resp.status_code != 200:
        logger.warning("反推 VLM 非 200: status=%d body=%s", resp.status_code, resp.text[:500])
        raise HTTPException(status_code=502, detail=f"VLM 反推服务返回 {resp.status_code},请重试")
    try:
        raw = (resp.json().get("prompt") or "").strip()
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(status_code=502, detail="VLM 返回格式异常") from e
    if not raw:
        raise HTTPException(status_code=502, detail="VLM 返回为空,请重试")
    return raw


async def _chat_completion(system: str, part: dict, base_url: str) -> str:
    """调 VLM vLLM chat/completions(单图/单视频 + 取文本),网络/非 200/空 → 502。
    若 base_url 不是 OpenAI 兼容服务(探测 /models 返回 404),回退到 mlx-vlm 自定义端点。"""
    model_id = await _resolve_model_id(base_url)
    if model_id is None:
        return await _mlx_vlm_reverse(system, part, base_url)

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [part]},
        ],
        "max_tokens": 2048,
        "temperature": 0.3,
        # Qwen3 系思考模式抑制(传了不生效也不报错)
        "chat_template_kwargs": {"enable_thinking": False},
    }
    try:
        async with httpx.AsyncClient(timeout=_VLM_TIMEOUT, trust_env=False) as client:
            resp = await client.post(endpoint, json=payload)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"VLM 反推服务不可达:{e}") from e
    if resp.status_code != 200:
        logger.warning("反推 VLM 非 200: status=%d body=%s", resp.status_code, resp.text[:500])
        raise HTTPException(status_code=502, detail=f"VLM 反推服务返回 {resp.status_code},请重试")
    try:
        raw = (resp.json()["choices"][0]["message"].get("content") or "").strip()
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise HTTPException(status_code=502, detail="VLM 返回格式异常") from e
    if not raw:
        raise HTTPException(status_code=502, detail="VLM 返回为空,请重试")
    return raw


async def _stage_video_to_nas(content: bytes, ext: str) -> tuple[str, str]:
    """视频 SFTP 中转 NAS(studio04 MLX 的 video_url 只认本地路径,不认 base64)。
    返回 (studio04 挂载路径, SFTP 远端路径);用后必须 _remove_staged 清理。"""
    s = get_settings()
    name = f"rev-{uuid.uuid4().hex}{ext}"
    remote = posixpath.join("/NAS", s.reverse_video_nas_subdir, name)

    def _put() -> None:
        sftp, transport = nas._connect()
        try:
            nas._ensure_dir(sftp, posixpath.dirname(remote))
            with sftp.open(remote, "wb") as f:
                f.write(content)
        finally:
            sftp.close()
            transport.close()

    try:
        await asyncio.to_thread(_put)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"视频中转 NAS 失败:{e}") from e
    mac_path = f"{s.reverse_video_mac_prefix.rstrip('/')}/{s.reverse_video_nas_subdir}/{name}"
    return mac_path, remote


async def _remove_staged(remote: str) -> None:
    """清理 NAS 中转文件(尽力而为,失败只记日志)。"""

    def _rm() -> None:
        sftp, transport = nas._connect()
        try:
            sftp.remove(remote)
        finally:
            sftp.close()
            transport.close()

    try:
        await asyncio.to_thread(_rm)
    except Exception:
        logger.warning("中转视频清理失败: %s", remote)


async def _sensevoice_analyze(content: bytes, filename: str, mime: str) -> dict:
    """转发音频到 SenseVoice /analyze,网络/非 200/格式异常 → 502。"""
    s = get_settings()
    endpoint = f"{s.sensevoice_url.rstrip('/')}/analyze"
    try:
        async with httpx.AsyncClient(timeout=_SENSEVOICE_TIMEOUT, trust_env=False) as client:
            resp = await client.post(
                endpoint,
                files={"file": (filename or "audio.wav", content, mime)},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"音频反推服务不可达:{e}") from e
    if resp.status_code != 200:
        logger.warning("SenseVoice 非 200: status=%d body=%s", resp.status_code, resp.text[:500])
        raise HTTPException(status_code=502, detail=f"音频反推服务返回 {resp.status_code},请重试")
    try:
        return resp.json()
    except ValueError as e:
        raise HTTPException(status_code=502, detail="音频反推服务返回格式异常") from e


def _data_url(content: bytes, kind: str, content_type: str) -> str:
    mime = content_type if content_type.startswith(f"{kind}/") else _MIME_FALLBACK[kind]
    return f"data:{mime};base64,{base64.b64encode(content).decode()}"


def _salvage_prompt(raw: str) -> str:
    """模型输出被 max_tokens 截断或带 JSON 包装但无法整体解析时的兜底提取:
    捞出 "prompt" 字符串值,去掉尾随的 negative 片段/引号,避免把 JSON 骨架塞进提示词框。"""
    m = re.search(r'"prompt"\s*:\s*"(.*)', raw, re.S)
    if not m:
        return raw
    text = re.split(r'",\s*"negative', m.group(1))[0]
    return text.rstrip('"}').strip() or raw


async def _music_caption(content: bytes, filename: str, mime: str) -> str | None:
    """音乐反推:demucs 分离伴奏 → Omni-Captioner 生成音乐描述。

    增强链路,失败不拖垮主链路:未配置 omni_captioner_base_url / 分离失败 /
    Omni 异常 → 记日志返回 None(调用方只出人声部分)。
    """
    s = get_settings()
    base_url = s.omni_captioner_base_url.strip()
    if not base_url:
        return None
    try:
        accompaniment = await separate_accompaniment(content, filename or "audio.wav")
        part = {
            "type": "audio_url",
            "audio_url": {"url": _data_url(accompaniment, "audio", "audio/wav")},
        }
        raw = await _chat_completion(_MUSIC_SYSTEM, part, base_url)
        obj = parse_json_obj(raw)
        caption = (obj.get("prompt") or "").strip() if obj else _salvage_prompt(raw).strip()
        if caption.startswith("{"):  # 兜底也没捞出 prompt 值,放弃音乐描述
            return None
        return caption or None
    except HTTPException as e:
        logger.warning("音乐反推降级(HTTP %s): %s", e.status_code, e.detail)
        return None
    except Exception:
        logger.exception("音乐反推异常,按无人声音乐描述降级")
        return None


async def reverse_visual(
    content: bytes,
    filename: str,
    content_type: str,
    kind: str,
    nsfw: bool,
) -> ReverseResponse:
    """图像/视频字节流 → 反推提示词(/reverse 端点与 Agent Team reprompt 共用链)。

    kind 仅收 image/video(音频走 SenseVoice 专线,不在此列);NSFW 图像走
    JoyCaption 专线,视频一律 Qwen3-VL;reverse_video_mac_prefix 非空时视频
    经 NAS 中转本地路径(studio04 MLX 只认路径),用后清理。
    """
    s = get_settings()
    staged_remote: str | None = None
    if kind == "image":
        system = _IMAGE_SYSTEM + (_NSFW_CLAUSE if nsfw else "")
        part = {"type": "image_url", "image_url": {"url": _data_url(content, kind, content_type)}}
        # NSFW 图像 → JoyCaption 专线(无审查设计);未配置时回退 Qwen3-VL
        base_url = (
            s.joycaption_base_url.strip()
            if nsfw and s.joycaption_base_url.strip()
            else s.reverse_vlm_base_url
        )
    else:
        system = _VIDEO_SYSTEM + (_NSFW_CLAUSE if nsfw else "")
        base_url = s.reverse_vlm_base_url  # JoyCaption 是纯图像模型,视频一律走 Qwen3-VL
        if s.reverse_video_mac_prefix.strip():
            # studio04 MLX 模式:video_url 只认本地路径 → SFTP 中转 NAS 传挂载路径
            ext = os.path.splitext(filename or "")[1].lower() or ".mp4"
            mac_path, staged_remote = await _stage_video_to_nas(content, ext)
            part = {"type": "video_url", "video_url": {"url": mac_path}}
        else:
            part = {"type": "video_url", "video_url": {"url": _data_url(content, kind, content_type)}}

    try:
        raw = await _chat_completion(system, part, base_url)
    finally:
        if staged_remote:
            await _remove_staged(staged_remote)
    obj = parse_json_obj(raw)
    if not obj or not (obj.get("prompt") or "").strip():
        # 模型没按 JSON 输出时,原文本通常就是可用描述,宽松降级不 502
        logger.info("反推结果非 JSON,按纯文本降级: %s", raw[:200])
        return ReverseResponse(kind=kind, prompt=_salvage_prompt(raw))
    return ReverseResponse(
        kind=kind,
        prompt=obj["prompt"].strip(),
        negative=(obj.get("negative") or "").strip() or None,
    )


@router.post("/reverse", response_model=ReverseResponse)
async def reverse_prompt(
    file: UploadFile,
    user: User = Depends(get_current_user),
):
    # 反推限流:视频可达 50MB base64 + VLM 长推理,必须在读文件前拦截。
    # scope="reverse" 未在 ratelimit._DEFAULT_SCOPES 定义 → 回退 default(60s/20 次)。
    enforce_rate_limit(user, count=1, scope="reverse")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    kind = _detect_kind(file.content_type or "", file.filename or "")
    if kind is None:
        raise HTTPException(status_code=400, detail="不支持的文件类型(仅图片/视频/音频)")
    limit = _limit_for(kind)
    if len(content) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"文件过大({kind} 上限 {limit // 1024 // 1024}MB)",
        )

    nsfw = nsfw_allowed(user)

    if kind == "audio":
        data = await _sensevoice_analyze(content, file.filename or "", file.content_type or "")
        text = (data.get("text") or "").strip()
        emotion = (data.get("emotion") or "").strip()
        events = data.get("events") or []
        language = (data.get("language") or "").strip()
        style_bits = [b for b in (emotion and f"情绪 {emotion}", language and f"语种 {language}") if b]
        if events:
            style_bits.append("事件 " + ", ".join(str(e) for e in events))
        style = f"({'; '.join(style_bits)})" if style_bits else ""
        prompt = f"{text}{style}" if text else style or ""
        music = await _music_caption(content, file.filename or "", file.content_type or "")
        if music:
            prompt = f"{prompt}；背景音乐: {music}" if prompt else music
        if not prompt:
            prompt = "未识别到语音内容"
        return ReverseResponse(
            kind=kind,
            prompt=prompt,
            meta={
                "text": text, "emotion": emotion, "events": events,
                "language": language, "music": music,
            },
        )

    return await reverse_visual(content, file.filename or "", file.content_type or "", kind, nsfw)
