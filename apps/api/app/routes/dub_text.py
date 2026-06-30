"""视频译制·听写翻译 —— 得到带时间轴的双语片段(配音/对口型的台本骨架)。

  POST /api/dub/import-srt   multipart(file) 解析 SRT/VTT → [{index,start,end,text}]
  POST /api/dub/transcribe   调 Whisper(ASR)服务听写源视频(需配 whisper_url)
  POST /api/dub/translate    复用 LLM 把片段批量翻成目标语(口语自然、贴近朗读时长)

转录来源二选一:已有字幕 → import-srt(零部署);无字幕 → transcribe(需 .100 部署
faster-whisper,见 config.whisper_url)。译文长度尽量贴近原文朗读时长,便于配音对齐。
"""
from __future__ import annotations

import json
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.agent import llm
from app.config import get_settings
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.dub import _DUB_DIR, _NAME_RE

router = APIRouter()

_MAX_SRT_BYTES = 2 * 1024 * 1024  # 字幕文件上限 2MB
_MAX_SEGMENTS = 400  # 译制片段上限(控 LLM/TTS 量)
_TRANSCRIBE_TIMEOUT = 600.0  # Whisper 听写长视频可能数分钟

# SRT/VTT 时间戳:HH:MM:SS,mmm 或 HH:MM:SS.mmm
_TS_RE = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})")
_ARROW_RE = re.compile(
    r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})"
)


def _ts_to_sec(ts: str) -> float:
    m = _TS_RE.match(ts.strip())
    if not m:
        return 0.0
    h, mi, s, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def _parse_srt(text: str) -> list[dict]:
    """解析 SRT/VTT 文本 → [{index,start,end,text}](按 start 排序,合并多行文案)。"""
    # 去 BOM / WEBVTT 头;按空行分块
    text = text.lstrip("﻿")
    blocks = re.split(r"\r?\n\r?\n+", text.strip())
    segs: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        arrow_i = next((i for i, ln in enumerate(lines) if _ARROW_RE.search(ln)), None)
        if arrow_i is None:
            continue  # 无时间轴(WEBVTT 头/纯序号块)→ 跳过
        am = _ARROW_RE.search(lines[arrow_i])
        start, end = _ts_to_sec(am.group(1)), _ts_to_sec(am.group(2))
        body = " ".join(lines[arrow_i + 1:]).strip()
        if not body or end <= start:
            continue
        segs.append({"start": round(start, 3), "end": round(end, 3), "text": body})
    segs.sort(key=lambda s: s["start"])
    return [{"index": i, **s} for i, s in enumerate(segs[:_MAX_SEGMENTS])]


@router.post("/dub/import-srt")
async def dub_import_srt(
    file: UploadFile,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    enforce_generation_rate_limit(user)
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if len(content) > _MAX_SRT_BYTES:
        raise HTTPException(status_code=413, detail="字幕文件过大(上限 2MB)")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("gbk")  # 中文字幕常见 GBK
        except UnicodeDecodeError as e:
            raise HTTPException(status_code=400, detail="字幕编码无法识别(请存 UTF-8)") from e
    segments = _parse_srt(text)
    if not segments:
        raise HTTPException(status_code=422, detail="未解析到有效字幕(检查 SRT/VTT 格式)")
    return {"segments": segments, "count": len(segments)}


class TranscribeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)  # /dub/upload 的源视频 name


@router.post("/dub/transcribe")
async def dub_transcribe(
    body: TranscribeRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """调 Whisper(ASR)服务听写源视频。未配置 whisper_url 则引导改用上传 SRT。"""
    enforce_generation_rate_limit(user)
    settings = get_settings()
    if not settings.whisper_url.strip():
        raise HTTPException(
            status_code=503,
            detail="未部署 Whisper 听写服务(设 TOIV_WHISPER_URL);可改用上传 SRT 字幕。",
        )
    if not _NAME_RE.match(body.name):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = _DUB_DIR / body.name
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源视频不存在")

    base = settings.whisper_url.strip().rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=_TRANSCRIBE_TIMEOUT) as client:
            with src.open("rb") as f:
                resp = await client.post(
                    f"{base}/asr", files={"file": (body.name, f, "video/mp4")}
                )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Whisper 服务不可达:{e}") from e
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=502, detail=f"Whisper 返回异常:{e}") from e

    raw = data.get("segments") or []
    segs: list[dict] = []
    for s in raw:
        try:
            start, end = float(s["start"]), float(s["end"])
            txt = str(s.get("text", "")).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if txt and end > start:
            segs.append({"start": round(start, 3), "end": round(end, 3), "text": txt})
    segs = [{"index": i, **s} for i, s in enumerate(segs[:_MAX_SEGMENTS])]
    if not segs:
        raise HTTPException(status_code=422, detail="听写未得到有效片段")
    return {"segments": segs, "count": len(segs)}


_LANG_NAME = {"zh": "简体中文", "en": "英语", "ja": "日语", "ko": "韩语"}


class TranslateSeg(BaseModel):
    index: int
    text: str = Field(min_length=1, max_length=2000)


class TranslateRequest(BaseModel):
    segments: list[TranslateSeg] = Field(min_length=1, max_length=_MAX_SEGMENTS)
    target_lang: str = Field(default="zh")  # zh/en/ja/ko


def _extract_json_array(s: str) -> list:
    """从 LLM 回复里抽 JSON 数组(容错代码围栏/前后缀文字)。"""
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", s).strip()
    a, b = s.find("["), s.rfind("]")
    if a == -1 or b == -1 or b <= a:
        raise ValueError("回复中无 JSON 数组")
    return json.loads(s[a:b + 1])


@router.post("/dub/translate")
async def dub_translate(
    body: TranslateRequest,
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """批量翻译:口语自然、长度贴近原文朗读时长(便于配音对齐)。返回 [{index,translated}]。"""
    enforce_generation_rate_limit(user)
    lang = _LANG_NAME.get(body.target_lang, "简体中文")
    items = [{"i": s.index, "text": s.text} for s in body.segments]
    system = (
        f"你是专业影视译制翻译。把每条字幕翻成{lang},要求:口语化、自然顺畅,"
        "保留原句语气与信息;长度尽量贴近原文的朗读时长(便于配音对口型对齐),不加注释。"
        '只返回 JSON 数组,每项形如 {"i": 原序号, "t": "译文"},不要任何额外文字。'
    )
    user_msg = json.dumps(items, ensure_ascii=False)

    try:
        msg = await llm.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user_msg}]
        )
        arr = _extract_json_array(msg.get("content") or "")
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=502, detail=f"翻译结果解析失败:{e}") from e

    by_index = {s.index: s.text for s in body.segments}
    translated: list[dict] = []
    for item in arr:
        try:
            idx = int(item["i"])
            t = str(item["t"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if idx in by_index and t:
            translated.append({"index": idx, "translated": t})
    if not translated:
        raise HTTPException(status_code=502, detail="翻译未返回有效结果")
    return {"translated": translated, "count": len(translated), "target_lang": body.target_lang}
