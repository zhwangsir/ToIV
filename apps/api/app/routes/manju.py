"""POST /api/manju/storyboard —— 漫剧工作室 M1:把剧情用 LLM 拆成结构化分镜。

入参剧情(premise)+ 镜数 + 风格 + 角色,产出 shots[]:每镜含英文出图提示词
(适合 SD/anime)、出场角色、运镜、中文台词、时长。前端据此渲染分镜板并逐镜出图。

复用 optimize.py 的健壮 JSON 解析(容忍 ```json 代码块/前后缀)。沿用现有鉴权与限流。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agent import llm
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

_STORYBOARD_SYSTEM = (
    "你是漫剧(动画短剧)导演 + 分镜师。把用户给的剧情拆解成连贯的分镜脚本。\n"
    "对每一个镜头(shot)给出:\n"
    "- scene:该镜的场景/地点简述(中文);\n"
    "- description:一句结构化、画面感强的【英文】出图提示词,适合 Stable Diffusion / "
    "anime 风格(含主体、动作、构图、光影、画质词如 highly detailed, anime style),"
    "若提供了 style 请融入其中,若该镜有角色出场请在提示词里体现其外貌特征;\n"
    "- characters:该镜出场角色名字数组(只用 characters 列表里给定的名字,没有则空数组);\n"
    "- camera:运镜方式(中文,如 缓慢推进 / 特写 / 全景 / 跟随 / 摇镜 / 仰拍);\n"
    "- dialogue:该镜的【中文】台词或旁白(没有则空字符串);\n"
    "- duration_sec:该镜建议时长(秒,整数,通常 2-6)。\n"
    "镜头数量严格等于用户要求的数量。\n"
    '只输出 JSON,形如 {"shots":[{"scene":"...","description":"...","characters":["..."],'
    '"camera":"...","dialogue":"...","duration_sec":3}, ...]},'
    "不要解释,不要代码块标记。"
)


class CharacterIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    desc: str = Field(default="", max_length=500)


class StoryboardRequest(BaseModel):
    premise: str = Field(min_length=1, max_length=4000)
    num_shots: int = Field(default=6, ge=1, le=24)
    style: str | None = Field(default=None, max_length=300)
    characters: list[CharacterIn] = Field(default_factory=list)


class Shot(BaseModel):
    id: str
    scene: str
    description: str
    characters: list[str] = Field(default_factory=list)
    camera: str = ""
    dialogue: str = ""
    duration_sec: int = 3


class StoryboardResponse(BaseModel):
    shots: list[Shot]


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


def _build_user_prompt(body: StoryboardRequest) -> str:
    lines = [f"剧情:{body.premise}", f"镜头数量:{body.num_shots}"]
    if body.style:
        lines.append(f"整体画风:{body.style}")
    if body.characters:
        roster = "; ".join(
            f"{c.name}({c.desc})" if c.desc else c.name for c in body.characters
        )
        lines.append(f"出场角色:{roster}")
    return "\n".join(lines)


def _coerce_shot(raw: object, index: int) -> Shot:
    """把 LLM 返回的单个镜头对象规整成 Shot(字段缺失/类型不符时回退到安全默认)。"""
    obj = raw if isinstance(raw, dict) else {}
    chars_raw = obj.get("characters")
    characters = (
        [str(c).strip() for c in chars_raw if str(c).strip()]
        if isinstance(chars_raw, list)
        else []
    )
    try:
        duration = int(obj.get("duration_sec") or 3)
    except (ValueError, TypeError):
        duration = 3
    duration = max(1, min(duration, 30))
    return Shot(
        id=f"shot-{index + 1}",
        scene=str(obj.get("scene") or "").strip(),
        description=str(obj.get("description") or "").strip(),
        characters=characters,
        camera=str(obj.get("camera") or "").strip(),
        dialogue=str(obj.get("dialogue") or "").strip(),
        duration_sec=duration,
    )


@router.post("/manju/storyboard", response_model=StoryboardResponse)
async def generate_storyboard(
    body: StoryboardRequest,
    user: User = Depends(get_current_user),
) -> StoryboardResponse:
    enforce_generation_rate_limit(user)

    try:
        msg = await llm.chat(
            [
                {"role": "system", "content": _STORYBOARD_SYSTEM},
                {"role": "user", "content": _build_user_prompt(body)},
            ]
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    raw = (msg.get("content") or "").strip()
    obj = _parse_json_obj(raw)
    shots_raw = obj.get("shots") if obj else None
    if not isinstance(shots_raw, list) or not shots_raw:
        raise HTTPException(status_code=502, detail="分镜生成失败,请重试")

    shots = [
        _coerce_shot(s, i)
        for i, s in enumerate(shots_raw[: body.num_shots])
    ]
    # 至少要有可出图的描述,否则视为失败
    if not any(s.description for s in shots):
        raise HTTPException(status_code=502, detail="分镜生成失败,请重试")
    return StoryboardResponse(shots=shots)
