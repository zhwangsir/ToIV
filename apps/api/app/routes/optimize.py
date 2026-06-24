"""POST /api/optimize —— 用 LLM 把用户的简单输入扩写成各功能的专业提示词。

内容感知(content-aware):图像/图生图类先让 LLM **判断要生成的内容类型与风格**
(人像 / 风景 / 动漫 / 写实 / 电影感 / 产品 / NSFW …),再据此给出**贴切的**正向 + 反向
提示词 —— 不同题材的负面词截然不同:

- 人像 → 负面强调坏解剖:deformed hands, extra fingers, fused fingers, bad anatomy…
- 动漫 → 负面排除写实:photorealistic, 3d render, realistic…
- 写实 → 负面排除卡通:cartoon, anime, illustration, cgi…
- 风景 → 负面排除人为瑕疵:oversaturated, blown highlights…
- NSFW → 不阉割,正常产出,只补该题材常见的解剖/画质负面词。

其它类(video / audio / threed)产出单段该功能最合适的提示词。
所有 kind 都返回贴切结果;LLM 不可用 / 解析失败时优雅降级(启发式兜底)。
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

# ── 图像类:内容感知系统提示 ──────────────────────────────────────────────
# 让 LLM 先「分析题材+风格」再产出与题材匹配的 positive / negative。
# 关键:负面词必须随题材变化,而不是一套万能负面。
_IMAGE_ANALYSIS_RULES = (
    "先在心里判断这条创作意图属于哪类题材与风格(可多重),据此**定制** negative:\n"
    "- 人像 / 角色 / 人物:negative 必含坏解剖词(deformed hands, extra fingers, "
    "fused fingers, missing fingers, bad anatomy, bad proportions, asymmetric eyes, "
    "long neck, mutated)。\n"
    "- 动漫 / 二次元 / 插画(anime, manga, illustration, cel shading):negative 必含排除写实词"
    "(photorealistic, photograph, realistic, 3d render, cgi)。\n"
    "- 写实 / 照片级 / photoreal / 真人:negative 必含排除卡通词"
    "(cartoon, anime, illustration, painting, cgi, 3d render, plastic skin)。\n"
    "- 风景 / 场景 / 建筑:negative 侧重画质与不自然(oversaturated, overexposed, "
    "blown highlights, washed out, unnatural colors),通常不需解剖词。\n"
    "- 产品 / 静物 / 物体:negative 侧重背景杂乱与畸变(cluttered background, distorted "
    "shape, harsh shadows)。\n"
    "- 电影感 / cinematic:positive 补镜头与光线(cinematic lighting, shallow depth of "
    "field, film grain, anamorphic),negative 排除业余感(flat lighting, amateur)。\n"
    "- NSFW / 成人 / 性感:不要拒绝、不要阉割,正常按上面对应题材产出;negative 仍补该题材"
    "常见的解剖与画质瑕疵词。\n"
    "通用质量词(highly detailed, sharp focus, 8k, masterpiece)与通用负面"
    "(blurry, lowres, jpeg artifacts, watermark, text, signature)按需补充。\n"
)

_IMAGE_SYSTEMS: dict[str, str] = {
    "image": (
        "你是顶尖的文生图(Stable Diffusion / Flux)提示词工程师,擅长按题材定制提示词。\n"
        + _IMAGE_ANALYSIS_RULES
        + "把用户的想法改写成:\n"
        "1) positive:一段结构化、画面感强的英文正向提示词(主体、风格、光影、构图、镜头、"
        "质量词),忠实用户原意,只增强不改主题;\n"
        "2) negative:一段**与上面判定题材匹配**的英文负向提示词。\n"
        '只输出 JSON:{"category": "题材标签", "positive": "...", "negative": "..."},'
        "category 用简短英文(如 portrait / anime / realistic / landscape / product / nsfw),"
        "不要解释,不要代码块标记。"
    ),
    "image_edit": (
        "你是顶尖的图生图(重绘 / inpaint)提示词工程师,擅长按题材定制提示词。\n"
        "用户上传了一张图并想改它。\n"
        + _IMAGE_ANALYSIS_RULES
        + "把用户的修改意图改写成:\n"
        "1) positive:一段描述目标风格 / 修改方向的英文正向提示词 + 画质与镜头词;\n"
        "2) negative:一段**与判定题材匹配**的英文负向提示词。\n"
        '只输出 JSON:{"category": "题材标签", "positive": "...", "negative": "..."},'
        "不要解释,不要代码块标记。"
    ),
}

# ── 其它类:单段提示词 ────────────────────────────────────────────────────
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

# ── 启发式兜底负面:按关键词判定题材,LLM 不可用 / 没给 negative 时用 ──────────
_GENERIC_NEGATIVE = "blurry, lowres, jpeg artifacts, watermark, text, signature, worst quality"
_ANATOMY_NEGATIVE = (
    "deformed hands, extra fingers, fused fingers, missing fingers, bad anatomy, "
    "bad proportions, asymmetric eyes, long neck, mutated, disfigured"
)

# (题材关键词, 该题材专属负面词)—— 命中即叠加到通用负面之前
_NEGATIVE_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
    # 动漫 / 二次元 → 排除写实
    (
        ("anime", "manga", "动漫", "二次元", "插画", "illustration", "cel shading", "chibi", "waifu"),
        "photorealistic, photograph, realistic, 3d render, cgi",
    ),
    # 写实 / 照片级 → 排除卡通
    (
        ("realistic", "photoreal", "photo", "写实", "真人", "照片", "raw photo", "dslr"),
        "cartoon, anime, illustration, painting, cgi, 3d render, plastic skin, " + _ANATOMY_NEGATIVE,
    ),
    # 风景 / 场景 / 建筑 → 画质与不自然
    (
        ("landscape", "scenery", "风景", "场景", "建筑", "architecture", "mountain", "city", "forest", "sunset"),
        "oversaturated, overexposed, blown highlights, washed out, unnatural colors",
    ),
    # 产品 / 静物
    (
        ("product", "产品", "静物", "still life", "object", "packaging", "bottle"),
        "cluttered background, distorted shape, harsh shadows",
    ),
    # 人像 / 人物 / 角色(放最后兜底,只要提到人就补解剖负面)
    (
        ("portrait", "人像", "人物", "角色", "girl", "boy", "woman", "man", "character", "face", "肖像", "nsfw", "性感", "裸"),
        _ANATOMY_NEGATIVE,
    ),
)


def _heuristic_negative(prompt: str) -> str:
    """LLM 没给 negative 时:按提示词关键词拼一条贴切的负面词。"""
    low = prompt.lower()
    parts: list[str] = []
    for keywords, extra in _NEGATIVE_RULES:
        if any(k in low for k in keywords):
            parts.append(extra)
            break  # 取首个命中的主题材,避免叠太多
    parts.append(_GENERIC_NEGATIVE)
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for chunk in ", ".join(parts).split(", "):
        c = chunk.strip()
        if c and c.lower() not in seen:
            seen.add(c.lower())
            out.append(c)
    return ", ".join(out)


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

    # 图像类:内容感知 —— 先判题材,再产出匹配的正向 + 负面
    if body.kind in _IMAGE_SYSTEMS:
        raw = await _llm_text(_IMAGE_SYSTEMS[body.kind], body.prompt)
        obj = _parse_json_obj(raw)
        if obj and obj.get("positive"):
            positive = str(obj["positive"]).strip().strip('"')
            negative_raw = str(obj.get("negative") or "").strip().strip('"')
            # LLM 给了 negative 就用它;没给则按 positive(更贴近最终画面)启发式补
            negative = negative_raw or _heuristic_negative(positive or body.prompt)
            return OptimizeResponse(optimized=positive, negative=negative)
        # 解析失败:把整段当正向,负面用启发式按内容补(而非一套万能负面)
        cleaned = raw.strip().strip('"').strip()
        if not cleaned:
            raise HTTPException(status_code=502, detail="优化失败,请重试")
        return OptimizeResponse(optimized=cleaned, negative=_heuristic_negative(cleaned))

    # 其它类:单段
    system = _TEXT_SYSTEMS.get(body.kind, _TEXT_SYSTEMS["video"])
    text = (await _llm_text(system, body.prompt)).strip('"').strip()
    if not text:
        raise HTTPException(status_code=502, detail="优化失败,请重试")
    return OptimizeResponse(optimized=text)
