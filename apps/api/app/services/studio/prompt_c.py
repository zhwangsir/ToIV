"""管线 C 画面提示词：台词不进画面；负向屏蔽字幕/文字/水印。"""
from __future__ import annotations

import re

C_AVOID_TEXT = (
    "subtitles, captions, on-screen text, watermark, logo, title card, "
    "烧录字幕, 字幕, 台词文字, 水印, 台标, 花字, 标题文字"
)

_DIALOGUE_PATTERNS = (
    re.compile(r"「[^」]*」"),
    re.compile(r"『[^』]*』"),
    re.compile(r"“[^”]*”"),
    re.compile(r'"[^"]*"'),
    re.compile(r"说[：:][^\n。；;]*"),
    re.compile(r"问[：:][^\n。；;]*"),
    re.compile(r"道[：:][^\n。；;]*"),
)


def strip_dialogue(text: str) -> str:
    """去掉引号对白与「说/问/道：…」片段，避免台词写进画面提示词。"""
    s = text or ""
    for pat in _DIALOGUE_PATTERNS:
        s = pat.sub("", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip(" ,，;；")


def build_c_visual_prompt(
    *,
    shot_prompt: str,
    cast_visual: str = "",
    ref_prefix: str = "",
    dialogue: str = "",
    camera: str = "",
    scene: str = "",
) -> str:
    """组装管线 C 正向提示：参考行 + 场景/运镜/角色外观 + 画面描述（无台词）+ Avoid。"""
    body_parts: list[str] = []
    if scene.strip():
        body_parts.append(scene.strip())
    if camera.strip():
        body_parts.append("镜头：" + camera.strip())
    if cast_visual.strip():
        body_parts.append(cast_visual.strip())
    visual = strip_dialogue(shot_prompt or "")
    dlg = (dialogue or "").strip()
    if dlg:
        visual = strip_dialogue(visual.replace(dlg, ""))
    if visual:
        body_parts.append(visual)
    body = "，".join(body_parts) if body_parts else "竖屏短剧镜头，人物与场景清晰"
    body += "。画面只有角色与场景，无任何文字。"
    avoid = C_AVOID_TEXT
    if ref_prefix:
        head = ref_prefix if ref_prefix.endswith("\n") else ref_prefix + "\n"
        return f"{head}{body}\n\nAvoid: {avoid}"
    return f"{body}\n\nAvoid: {avoid}"


def merge_negative(existing: str = "") -> str:
    """合并镜头原有 negative 与 C 默认文字屏蔽。"""
    base = (existing or "").strip()
    if not base:
        return C_AVOID_TEXT
    if "字幕" in base or "subtitle" in base.lower():
        return base
    return f"{base}, {C_AVOID_TEXT}"

