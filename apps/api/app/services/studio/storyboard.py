"""LLM 剧本拆解:premise → 角色草稿 + 分镜草稿(含 render_mode 建议)。

走 L3 精修层(chat_layered),失败抛 StoryboardError 由路由转 502。
"""
from __future__ import annotations

import json
import logging

from app.agent import llm
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
prompt 用英文,其余字段用中文。每个出场角色必须在 characters 中定义过。"""

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
    return characters, shots
