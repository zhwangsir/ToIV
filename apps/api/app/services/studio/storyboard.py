"""LLM 剧本拆解:premise → 角色草稿(实体注册表) + 分镜草稿(含 render_mode 建议)。

走 L3 精修层(chat_layered),失败抛 StoryboardError 由路由转 502。
拆后执行指代消解后处理(resolve_references):分镜 prompt 必须自包含
(角色名+外观 token 内联,禁止裸代词),先 LLM 受约束重写,失败兜底确定性注入。
"""
from __future__ import annotations

import json
import logging

from app.agent import llm
from app.quality import coreference
from app.services.studio.schemas import CharacterDraft, ShotDraft

logger = logging.getLogger(__name__)


class StoryboardError(RuntimeError):
    """剧本拆解失败(LLM 不可用 / 返回不可解析 / 内容为空)。"""


_SYSTEM = """你是短剧导演。把用户剧情拆解为角色与分镜表,只输出 JSON,禁止多余文本。
输出格式:
{
  "characters": [{"name": "角色名", "description": "中文描述", "visual_prompt": "英文视觉token"}],
  "shots": [{
    "scene": "场景中文描述", "prompt": "英文生成提示词", "negative": "反向词",
    "camera": "运镜", "dialogue": "台词", "speaker": "说话角色",
    "duration_sec": 6, "characters": ["出场角色名"],
    "render_mode": "video 或 image_motion"
  }]
}
render_mode 判定:画面有明显运动/表演/动作 → "video";静态画面/特写/空镜/回忆插图 → "image_motion"。
prompt 用英文,其余字段用中文。每个出场角色必须在 characters 中定义过。
prompt 必须自包含:出场角色必须写出角色名并内联其外观关键词(取自该角色 visual_prompt),
禁止使用 he/she/they/him/her/their 等英文代词,也禁止在 scene 中用「他/她/其」指代未命名角色。"""

# 指代消解重写:只许用注册表内实体名与外观 token,禁止新增实体、禁止代词
_RESOLVE_SYSTEM = """你是分镜提示词修复器。输入:实体注册表(角色名→英文外观token) + 待修复分镜(含未消解代词)。
任务:把每条 prompt 重写为自包含英文提示词——代词替换为对应角色名,并内联该角色外观关键词。
约束:只许使用注册表中的角色;不得新增实体;不得改变镜头意图、运镜与时长;不得输出任何代词(he/she/they/him/her/their)。
只输出 JSON:{"rewrites": [{"index": 分镜序号, "prompt": "重写后的英文提示词"}]}"""

_VALID_MODES = {"video", "image_motion"}


def _extract_json(text: str) -> dict | None:
    """从 LLM 输出提取首个 JSON 对象(容忍 ```json 围栏与前后噪文)。"""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def _coerce_character(raw: object) -> CharacterDraft | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    if not name:
        return None
    return CharacterDraft(
        name=name,
        description=str(raw.get("description") or "").strip(),
        visual_prompt=str(raw.get("visual_prompt") or "").strip(),
    )


def _coerce_shot(raw: object) -> ShotDraft | None:
    if not isinstance(raw, dict):
        return None
    mode = str(raw.get("render_mode") or "").strip()
    if mode not in _VALID_MODES:
        mode = "video"  # 非法/缺省回退视频链
    chars = raw.get("characters")
    try:
        duration = max(1, min(60, int(raw.get("duration_sec") or 6)))
    except (ValueError, TypeError):
        duration = 6
    return ShotDraft(
        scene=str(raw.get("scene") or "").strip(),
        prompt=str(raw.get("prompt") or "").strip(),
        negative=str(raw.get("negative") or "").strip(),
        camera=str(raw.get("camera") or "").strip(),
        dialogue=str(raw.get("dialogue") or "").strip(),
        speaker=str(raw.get("speaker") or "").strip(),
        duration_sec=duration,
        characters=[str(c) for c in chars] if isinstance(chars, list) else [],
        render_mode=mode,
    )


async def resolve_references(
    characters: list[CharacterDraft], shots: list[ShotDraft]
) -> None:
    """指代消解后处理(就地修改 shots)。

    检测 prompt 中未消解代词 → LLM 受约束重写(L2 层,只许用注册表实体) →
    重写无效/失败时兜底:确定性注入「角色名 (视觉token)」前缀,保证自包含。
    无问题的分镜不触碰;LLM 重写后仍含代词的条目拒收并走兜底。
    """
    names = [c.name for c in characters if c.name]
    flagged = [
        i for i, s in enumerate(shots) if coreference.unresolved_pronouns(s.prompt, names)
    ]
    if not flagged:
        return

    registry = {c.name: c.visual_prompt for c in characters if c.name}
    rewritten: set[int] = set()
    user_payload = {
        "registry": registry,
        "shots": [
            {"index": i, "prompt": shots[i].prompt, "characters": shots[i].characters}
            for i in flagged
        ],
    }
    try:
        msg = await llm.chat_layered(
            [
                {"role": "system", "content": _RESOLVE_SYSTEM},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            layer="L2",
            max_tokens=4000,
        )
        obj = _extract_json((msg.get("content") or "").strip())
        for item in (obj or {}).get("rewrites") or []:
            if not isinstance(item, dict):
                continue
            try:
                idx = int(item.get("index"))
            except (ValueError, TypeError):
                continue
            new_prompt = str(item.get("prompt") or "").strip()
            if idx not in flagged or not new_prompt:
                continue
            # 受约束校验:重写后仍含未消解代词 → 拒收(防幻觉式改写)
            if coreference.unresolved_pronouns(new_prompt, names):
                logger.warning("resolve_references: 分镜 %d 重写后仍含代词,拒收", idx)
                continue
            shots[idx].prompt = new_prompt
            rewritten.add(idx)
    except llm.LLMError as e:
        logger.warning("resolve_references: LLM 重写不可用,走确定性注入:%s", e)

    # 兜底:确定性注入「角色名 (视觉token)」前缀
    for i in flagged:
        if i in rewritten:
            continue
        tokens = []
        by_name = {c.name: c for c in characters}
        for cname in shots[i].characters:
            c = by_name.get(cname)
            if not c:
                continue
            tokens.append(f"{c.name} ({c.visual_prompt})" if c.visual_prompt else c.name)
        if tokens:
            shots[i].prompt = ", ".join(tokens) + ", " + shots[i].prompt


async def parse_script(
    premise: str, num_shots: int = 8, style: str = ""
) -> tuple[list[CharacterDraft], list[ShotDraft]]:
    """拆解剧本。返回 (角色草稿, 分镜草稿);失败抛 StoryboardError。"""
    user_prompt = f"剧情:{premise}\n风格:{style or '不限'}\n分镜数量:{num_shots}"
    try:
        msg = await llm.chat_layered(
            [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": user_prompt},
            ],
            layer="L3",
            max_tokens=8000,
        )
    except llm.LLMError as e:
        raise StoryboardError(f"LLM 不可用:{e}") from e

    obj = _extract_json((msg.get("content") or "").strip())
    if not obj:
        raise StoryboardError("LLM 返回不可解析")

    characters = [c for c in (_coerce_character(x) for x in obj.get("characters") or []) if c]
    shots = [s for s in (_coerce_shot(x) for x in obj.get("shots") or []) if s]
    shots = shots[:num_shots]
    if not shots or not any(s.prompt or s.scene for s in shots):
        raise StoryboardError("LLM 未产出有效分镜")
    await resolve_references(characters, shots)
    return characters, shots
