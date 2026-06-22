"""POST /api/optimize —— 用 LLM 把用户的简单输入扩写成各功能的专业提示词。

- 图像类(image / image_edit):一次产出"正向 + 负面"两段(JSON),两个框都回填。
- 其它类(video / audio / threed):产出单段该功能最合适的提示词。
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agent import llm
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

# 图像类:同时产出正向 + 负面(要求 LLM 返回 JSON)
_IMAGE_SYSTEMS: dict[str, str] = {
    "image": (
        "你是文生图(Stable Diffusion)提示词工程师。把用户的想法改写成:\n"
        "1) positive:一句结构化、画面感强的英文正向提示词(主体、风格、光影、构图、质量词如 highly detailed, 4k);\n"
        "2) negative:一句对应的英文负向提示词(排除瑕疵,如 blurry, lowres, deformed, bad anatomy, "
        "extra fingers, watermark, text, jpeg artifacts,并按画面内容补充)。\n"
        '只输出 JSON:{"positive": "...", "negative": "..."},不要解释,不要代码块标记。'
    ),
    "image_edit": (
        "你是图生图(重绘)提示词工程师。用户上传了一张图并想改它。给出:\n"
        "1) positive:一句描述目标风格/修改方向的英文正向提示词 + 画质词;\n"
        "2) negative:一句对应的英文负向提示词(排除常见瑕疵)。\n"
        '只输出 JSON:{"positive": "...", "negative": "..."},不要解释,不要代码块标记。'
    ),
}

# 其它类:单段提示词
_TEXT_SYSTEMS: dict[str, str] = {
    "video": (
        "你是文/图生视频提示词工程师。把用户的想法改写成一句英文提示词,除画面外"
        "补充简单连续的运动描述(如 slow pan, gentle wind, drifting),避免剧烈复杂运动。"
        "只输出提示词本身,不要解释、不要引号、不要换行。"
    ),
    "audio": (
        "你是文生音乐(ACE-Step)标签工程师。把用户的想法改写成一串逗号分隔的英文音乐标签,"
        "涵盖:流派、乐器、情绪、节奏(如 lofi, chill, piano, warm, 90bpm)。"
        "只输出标签本身,不要解释、不要引号、不要换行。"
    ),
    "threed": (
        "你是图生3D(Hunyuan3D)提示词工程师。把用户的想法改写成一句适合生成 3D 模型的英文提示词:"
        "单一居中主体、形体清晰、干净中性背景、无文字。只输出提示词本身,不要解释、不要引号。"
    ),
}

_DEFAULT_NEGATIVE = "blurry, lowres, deformed, bad anatomy, extra fingers, watermark, text, jpeg artifacts"


class OptimizeRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    kind: str = Field(default="image")


class OptimizeResponse(BaseModel):
    optimized: str
    negative: str | None = None


def _parse_json_obj(text: str) -> dict | None:
    """从 LLM 文本里稳健地抽出 JSON 对象(容忍代码块/前后缀)。"""
    t = text.strip()
    if "{" in t and "}" in t:
        t = t[t.index("{") : t.rindex("}") + 1]
    try:
        obj = json.loads(t)
        return obj if isinstance(obj, dict) else None
    except (ValueError, TypeError):
        return None


async def _llm_text(system: str, prompt: str) -> str:
    try:
        msg = await llm.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return (msg.get("content") or "").strip()


@router.post("/optimize", response_model=OptimizeResponse)
async def optimize_prompt(
    body: OptimizeRequest,
    user: User = Depends(get_current_user),
) -> OptimizeResponse:
    enforce_generation_rate_limit(user)

    # 图像类:一次产出正向 + 负面
    if body.kind in _IMAGE_SYSTEMS:
        raw = await _llm_text(_IMAGE_SYSTEMS[body.kind], body.prompt)
        obj = _parse_json_obj(raw)
        if obj and obj.get("positive"):
            positive = str(obj["positive"]).strip().strip('"')
            negative = str(obj.get("negative") or _DEFAULT_NEGATIVE).strip().strip('"')
            return OptimizeResponse(optimized=positive, negative=negative)
        # 解析失败:把整段当正向,负面用默认
        cleaned = raw.strip().strip('"').strip()
        if not cleaned:
            raise HTTPException(status_code=502, detail="优化失败,请重试")
        return OptimizeResponse(optimized=cleaned, negative=_DEFAULT_NEGATIVE)

    # 其它类:单段
    system = _TEXT_SYSTEMS.get(body.kind, _TEXT_SYSTEMS["video"])
    text = (await _llm_text(system, body.prompt)).strip('"').strip()
    if not text:
        raise HTTPException(status_code=502, detail="优化失败,请重试")
    return OptimizeResponse(optimized=text)
