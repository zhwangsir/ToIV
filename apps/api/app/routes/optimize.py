"""POST /api/optimize —— 用 LLM 把用户的简单输入扩写成各功能的专业提示词。

各生成功能(图像/视频/音频/3D)各有一套系统提示,产出该功能最合适的提示词。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agent import llm
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

# 每个功能一套"提示词优化"系统提示
_SYSTEMS: dict[str, str] = {
    "image": (
        "你是文生图(Stable Diffusion)提示词工程师。把用户的想法改写成一句"
        "结构化、画面感强的英文提示词,涵盖:主体、风格、光影、构图、画质词"
        "(如 highly detailed, 4k)。只输出提示词本身,不要解释、不要引号、不要换行。"
    ),
    "image_edit": (
        "你是图生图(重绘)提示词工程师。用户上传了一张图并想改它。把需求改写成一句"
        "英文提示词,描述目标风格/修改方向 + 画质词。只输出提示词本身,不要解释、不要引号。"
    ),
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


class OptimizeRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    kind: str = Field(default="image")


class OptimizeResponse(BaseModel):
    optimized: str


@router.post("/optimize", response_model=OptimizeResponse)
async def optimize_prompt(
    body: OptimizeRequest,
    user: User = Depends(get_current_user),
) -> OptimizeResponse:
    enforce_generation_rate_limit(user)
    system = _SYSTEMS.get(body.kind, _SYSTEMS["image"])
    try:
        msg = await llm.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": body.prompt}]
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    text = (msg.get("content") or "").strip().strip('"').strip()
    if not text:
        raise HTTPException(status_code=502, detail="优化失败,请重试")
    return OptimizeResponse(optimized=text)
