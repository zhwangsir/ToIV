"""POST /api/reverse —— 反推提示词:上传图/视频/音频,反推出可复用的生成提示词。

链路(2026-08-08 调研结论,见 docs 反推调研):
- 图像/视频 → workstation Qwen3-VL-8B vLLM 服务(toiv-vlm, GPU3, reverse_vlm_base_url),
  OpenAI 兼容 chat/completions,图像走 image_url、视频走 video_url(base64 data URL 内联)。
  系统提示要求输出「能直接复用于生成模型」的自然语言描述——H3/MiniMax 类视频模型偏好
  叙事长描述(要剧本不要清单),视频反推按六段式(镜头运动/主体/动作/场景/光线/风格)。
- 音频 → SenseVoice 服务(toiv-sensevoice, GPU2, sensevoice_url):转写 + 情绪 +
  音频事件 + 语种,组合成配音场景可直接复用的描述(文本 + 一句话风格)。
R18 上下文(X-NSFW)在系统提示中要求如实描述不回避;Qwen3-VL 官方对齐仍可能拒答,
NSFW 专线(JoyCaption)为二期规划。
"""
from __future__ import annotations

import base64
import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel

from app.config import get_settings
from app.deps import get_current_user
from app.jsonutil import parse_json_obj
from app.models import User
from app.nsfw_ctx import nsfw_allowed

router = APIRouter()
logger = logging.getLogger(__name__)

# 视觉反推一次给足时长:视频 base64 内联较大,vLLM 首 token 也慢
_VLM_TIMEOUT = httpx.Timeout(300.0, connect=10.0)
_SENSEVOICE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

# vLLM served-model-name 是模型目录绝对路径(随部署变化),不写死:
# 首次请求时从 /models 自动探测并缓存;探测失败 → 502 而不是 404。
_model_id_cache: str | None = None


async def _resolve_model_id() -> str:
    global _model_id_cache
    if _model_id_cache:
        return _model_id_cache
    s = get_settings()
    endpoint = f"{s.reverse_vlm_base_url.rstrip('/')}/models"
    try:
        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
            resp = await client.get(endpoint)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"VLM 反推服务不可达:{e}") from e
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"VLM 反推服务返回 {resp.status_code},请重试")
    try:
        model_id = resp.json()["data"][0]["id"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise HTTPException(status_code=502, detail="VLM 服务模型列表为空") from e
    _model_id_cache = model_id
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


async def _chat_completion(system: str, part: dict) -> str:
    """调 Qwen3-VL vLLM chat/completions(单图/单视频 + 取文本),网络/非 200/空 → 502。"""
    s = get_settings()
    endpoint = f"{s.reverse_vlm_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": await _resolve_model_id(),
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


@router.post("/reverse", response_model=ReverseResponse)
async def reverse_prompt(
    file: UploadFile,
    user: User = Depends(get_current_user),
):
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
        prompt = f"{text}{style}" if text else style or "未识别到语音内容"
        return ReverseResponse(
            kind=kind,
            prompt=prompt,
            meta={"text": text, "emotion": emotion, "events": events, "language": language},
        )

    if kind == "image":
        system = _IMAGE_SYSTEM + (_NSFW_CLAUSE if nsfw else "")
        part = {"type": "image_url", "image_url": {"url": _data_url(content, kind, file.content_type or "")}}
    else:
        system = _VIDEO_SYSTEM + (_NSFW_CLAUSE if nsfw else "")
        part = {"type": "video_url", "video_url": {"url": _data_url(content, kind, file.content_type or "")}}

    raw = await _chat_completion(system, part)
    obj = parse_json_obj(raw)
    if not obj or not (obj.get("prompt") or "").strip():
        # 模型没按 JSON 输出时,原文本通常就是可用描述,宽松降级不 502
        logger.info("反推结果非 JSON,按纯文本降级: %s", raw[:200])
        return ReverseResponse(kind=kind, prompt=raw)
    return ReverseResponse(
        kind=kind,
        prompt=obj["prompt"].strip(),
        negative=(obj.get("negative") or "").strip() or None,
    )
