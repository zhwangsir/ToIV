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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.agent import llm
from app.db import get_session
from app.deps import get_current_user
from app.jsonutil import parse_json_obj
from app.models import Agent, User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.model_profiles import detect_model_family
from app.workflows.style_presets import ALL_PRESETS

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
    "negative 务必精炼(5~15 个词):只用具体可视的词(如 extra fingers、blurry、"
    "watermark),避免 ugly、bad、poorly drawn 这类抽象评价词——模型理解不了,"
    "堆砌反而降质。\n"
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

# ── 模型族「方言」——让 positive 用目标模型真正听得懂的写法(关键质量杠杆)──────
# 同一意图喂不同底模须用不同写法:Pony 要质量分标签、SDXL 动漫要 danbooru 标签、
# Flux/Qwen 要自然语言长句且忌堆质量词。前端把所选 checkpoint 传来,据此切方言。
_FAMILY_GUIDANCE: dict[str, str] = {
    "pony": (
        "目标模型是 Pony Diffusion 系(SDXL)。positive **必须以质量分标签开头**:"
        "`score_9, score_8_up, score_7_up, score_6_up`,随后用 danbooru 风格逗号标签"
        "(主体如 1girl/1boy、外貌、服装、动作、场景、画风),可加 source_anime。"
        "**用标签不用整句**,标签间逗号分隔。"
    ),
    "sdxl_anime": (
        "目标模型是 SDXL 动漫底模(Illustrious / NoobAI / Animagine)。positive 用 "
        "**danbooru 风格逗号标签**:主体用 1girl/1boy/2girls,补外貌/服装/动作/场景/画风标签,"
        "并加画质标签 `masterpiece, best quality, amazing quality, very aesthetic, absurdres`。"
        "**用标签不用整句**。"
    ),
    "sdxl": (
        "目标模型是 SDXL(写实/通用)。positive 用逗号分隔的描述短语 + 摄影与画质词"
        "(detailed, sharp focus, cinematic lighting, professional photography, 8k)。"
    ),
    "flux": (
        "目标模型是 Flux。positive **必须是流畅的自然语言长句**,完整描述画面"
        "(主体、动作、环境、光线、镜头、氛围)。**禁止** danbooru 标签堆砌,"
        "**禁止** masterpiece/best quality 这类无效质量词——Flux 不吃这套,会变差。"
        "Flux 对 negative 几乎不响应,negative 可留简短或空。"
    ),
    "qwen": (
        "目标模型是 Qwen-Image。positive 用**自然语言**详细描述画面,语序清晰;"
        "它擅长画面内文字渲染,若用户要文字请用引号标出。不要 danbooru 标签堆砌。"
    ),
    # —— 次世代族(CFG≈1,负向失效):一律自然语言长句,不发质量词/负向 ——
    "qwen_image": (
        "目标模型是 Qwen-Image 底模(次世代,真 CFG 有效)。positive 用**流畅自然语言**详细"
        "描述画面(主体/动作/环境/光线/镜头/氛围),语序清晰;擅长画面内文字渲染,要文字用引号标出。"
        "**禁止** danbooru 标签堆砌与 masterpiece/best quality 无效质量词。"
        "该模型 negative **有效**,negative 给一段简洁英文负向(排除瑕疵/畸变/低质),不必冗长。"
    ),
    "flux2": (
        "目标模型是 FLUX.2(次世代画质天花板)。positive **必须是流畅自然语言长句**,"
        "完整描述主体/动作/环境/光线/镜头/氛围。**禁止** danbooru 标签与质量词堆砌。"
        "negative 失效,留空。"
    ),
    "z_image": (
        "目标模型是 Z-Image(次世代极速)。positive 用**简洁自然语言**清晰描述画面重点"
        "(主体/环境/光线/风格),不必冗长。**禁止**质量词/标签堆砌;negative 失效,留空。"
    ),
    "sd15": (
        "目标模型是 SD1.5。positive 用逗号标签 + 强质量词"
        "(masterpiece, best quality, highly detailed, sharp focus);"
        "SD1.5 解剖较弱,negative 要更强的解剖修正词。"
    ),
}


def _image_system_for(kind: str, model: str | None) -> str:
    """图像类系统提示:在内容感知基底上,按目标模型族追加「方言」指引。

    无 model → 退回通用基底(向后兼容);有 model → 检测族并拼接对应方言。
    """
    base = _IMAGE_SYSTEMS[kind]
    if not model:
        return base
    guide = _FAMILY_GUIDANCE.get(detect_model_family(model))
    return f"{base}\n\n【目标模型方言 · 务必遵守】{guide}" if guide else base


# ── 视频类:与图像类同构,JSON 输出 positive + negative ────────────────────
# 视频引擎(LTX2/H3)都吃 negative;负面词针对视频特有瑕疵(闪烁/形变/抖动)。
_VIDEO_SYSTEM = (
    "你是文/图生视频提示词工程师,擅长按题材定制提示词。\n"
    "把用户的想法改写成:\n"
    "1) positive:一句英文提示词,除画面外补充简单连续的运动描述"
    "(如 slow pan, gentle wind, drifting),避免剧烈复杂运动;\n"
    "2) negative:一段英文负向提示词,排除视频常见瑕疵——画质"
    "(blurry, lowres, jpeg artifacts, watermark)、闪烁与形变"
    "(flickering, morphing, distorted, deformed)、运动瑕疵"
    "(shaky camera, jittery motion, static frame);题材涉及人物时补解剖词"
    "(deformed hands, extra fingers, bad anatomy)。精炼 5~15 个具体可视的词,"
    "避免 ugly、bad 这类抽象评价词。\n"
    '只输出 JSON:{"positive": "...", "negative": "..."},不要解释,不要代码块标记。'
)

# 视频兜底负面:LLM 没给 / 解析失败时用
_VIDEO_GENERIC_NEGATIVE = (
    "blurry, lowres, jpeg artifacts, watermark, flickering, morphing, "
    "distorted, shaky camera, jittery motion"
)

# ── 其它类:单段提示词 ────────────────────────────────────────────────────
_TEXT_SYSTEMS: dict[str, str] = {
    "audio": (
        "你是文生音乐(ACE-Step)标签工程师。把用户的想法改写成一串逗号分隔的英文音乐标签,"
        "涵盖:流派、乐器、情绪、节奏(如 lofi, chill, piano, warm, 90bpm)。"
        "只输出标签本身,不要解释、不要引号、不要换行。"
    ),
    "threed": (
        "你是图生3D(Hunyuan3D)提示词工程师。把用户的想法改写成一句适合生成 3D 模型的英文提示词:"
        "单一居中主体、形体清晰、干净中性背景、无文字。只输出提示词本身,不要解释、不要引号。"
    ),
    "train": (
        "你是 LoRA 训练触发词工程师。把用户描述的训练主体(人物 / 角色 / 画风 / 物体)改写成"
        "一个规范的英文触发词:全小写、单词间用下划线连接、独特不易与普通词撞车、简短易记"
        "(如 zhenyu_girl, mocha_style)。若用户给了多个候选,原样保留逗号分隔。"
        "只输出触发词本身,不要解释、不要引号、不要换行。"
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
    # 目标模型(checkpoint 文件名);传入则按模型族切换改写方言,不传则用通用基底
    model: str | None = Field(default=None, max_length=300)
    # 风格预设 id;传入且预设写了 llm_layer 时,提示词优化走对应 LLM 层
    # (预设无该字段/层不可用时由 chat_layered 降级链自动回落 L1)
    style: str | None = Field(default=None, max_length=64)
    # 智能体 id;None=读 user.default_agent_id;仍 None=走 kind 默认 system prompt
    agent_id: str | None = Field(default=None, max_length=64)
    # 用户自由描述的风格方向(如"赛博朋克霓虹夜景""吉卜力手绘感");
    # 最高优先级:与智能体人格 / 默认规则冲突时以它为准。None=不注入,保持现有行为
    style_hint: str | None = Field(default=None, max_length=500)


class OptimizeResponse(BaseModel):
    optimized: str
    negative: str | None = None


def _parse_json_obj(text: str) -> dict | None:
    """从 LLM 文本里稳健地抽出 JSON 对象(共用实现 app.jsonutil.parse_json_obj)。"""
    return parse_json_obj(text)


def _style_llm_layer(style_id: str | None) -> str:
    """按风格预设解析提示词优化的 LLM 层;无预设/无该字段 → L1(现有行为)。

    层不可用时由 llm.chat_layered 的降级链(L3→L2→L1)自动兜底,这里不判可用性。
    """
    if not style_id:
        return "L1"
    preset = ALL_PRESETS.get(style_id)
    layer = (preset.llm_layer if preset else "") or ""
    layer = layer.upper()
    return layer if layer in ("L1", "L2", "L3", "L4") else "L1"


async def _llm_text(system: str, prompt: str, layer: str = "L1") -> str:
    try:
        msg = await llm.chat_layered(
            [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            layer=layer,
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return (msg.get("content") or "").strip()


def _resolve_agent_prefix(
    body: OptimizeRequest, user: User, session: Session
) -> str:
    """解析智能体并返回要拼在 kind 系统提示前的人格前缀(空串=不拼)。

    解析顺序:body.agent_id → user.default_agent_id → 空(走 kind 默认)。
    校验:agent 不存在→404;is_nsfw 且无 X-NSFW→403;applies_to 不含 kind 且
    不含 all→400。返回 agent.system_prompt(调用方负责拼 "\n\n" + kind 系统提示)。
    """
    aid = body.agent_id or getattr(user, "default_agent_id", None)
    if not aid:
        return ""
    agent = session.get(Agent, aid)
    if not agent:
        raise HTTPException(status_code=404, detail="智能体不存在")
    if agent.is_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="该智能体需要 R18 鉴权")
    applies = [s.strip() for s in (agent.applies_to or "").split(",") if s.strip()]
    if body.kind not in applies and "all" not in applies:
        raise HTTPException(status_code=400, detail="该智能体不适用于此 kind")
    return agent.system_prompt


@router.post("/optimize", response_model=OptimizeResponse)
async def optimize_prompt(
    body: OptimizeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> OptimizeResponse:
    enforce_generation_rate_limit(user)

    # 智能体人格前缀(空=走 kind 默认);解析顺序:body.agent_id → user.default_agent_id
    agent_prefix = _resolve_agent_prefix(body, user, session)

    # 风格预设决定提示词优化的 LLM 层(预设写了 llm_layer 才分层,否则保持 L1)
    llm_layer = _style_llm_layer(body.style)

    style_hint = (body.style_hint or "").strip()

    def _compose(base_system: str) -> str:
        """用户风格描述(最高优先级) + 智能体主人格 + kind 系统提示(含模型族方言)。"""
        parts: list[str] = []
        if style_hint:
            parts.append(
                f"【用户指定风格 · 最高优先级】用户要求整体风格为:{style_hint}。"
                "产出必须忠实体现该风格;当它与下方智能体人格或默认规则冲突时,"
                "一律以用户指定的风格为准。"
            )
        if agent_prefix:
            parts.append(agent_prefix)
        parts.append(base_system)
        return "\n\n".join(parts)

    # 图像类:内容感知 + 模型族方言 —— 先判题材,再用目标模型母语产出正向 + 负面
    if body.kind in _IMAGE_SYSTEMS:
        raw = await _llm_text(_compose(_image_system_for(body.kind, body.model)), body.prompt, layer=llm_layer)
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

    # 视频类:与图像类同构 —— JSON positive + negative(视频引擎吃 negative)
    if body.kind == "video":
        raw = await _llm_text(_compose(_VIDEO_SYSTEM), body.prompt, layer=llm_layer)
        obj = _parse_json_obj(raw)
        if obj and obj.get("positive"):
            positive = str(obj["positive"]).strip().strip('"')
            negative = str(obj.get("negative") or "").strip().strip('"') or _VIDEO_GENERIC_NEGATIVE
            return OptimizeResponse(optimized=positive, negative=negative)
        cleaned = raw.strip().strip('"').strip()
        if not cleaned:
            raise HTTPException(status_code=502, detail="优化失败,请重试")
        return OptimizeResponse(optimized=cleaned, negative=_VIDEO_GENERIC_NEGATIVE)

    # 其它类:单段(未知 kind 走通用兜底)
    system = _TEXT_SYSTEMS.get(body.kind) or (
        "你是提示词工程师。把用户的想法改写成一段精炼的英文提示词。"
        "只输出提示词本身,不要解释、不要引号、不要换行。"
    )
    text = (await _llm_text(_compose(system), body.prompt, layer=llm_layer)).strip('"').strip()
    if not text:
        raise HTTPException(status_code=502, detail="优化失败,请重试")
    return OptimizeResponse(optimized=text)
