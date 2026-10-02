"""管线 C 画面提示词：台词不进画面；负向屏蔽字幕/店招/乱码文字/水印。"""
from __future__ import annotations

import re

# 默认 Avoid：烧录字幕 + 店招/招牌乱码英文（雨夜样片证据：Bit/Gems/NB Bit…）
C_AVOID_TEXT = (
    "subtitles, captions, on-screen text, watermark, logo, title card, "
    "storefront sign, shop sign, store signboard, neon sign text, "
    "garbled text, gibberish english, random letters, burned-in text, "
    "readable english words on signs, billboard text, "
    "烧录字幕, 字幕, 台词文字, 水印, 台标, 花字, 标题文字, "
    "店招, 招牌, 乱码英文, 乱码文字, logo文字"
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

# 判定「已含文字屏蔽」的关键词；缺店招/乱码时仍追加
_TEXT_BLOCK_MARKERS = ("字幕", "subtitle", "caption", "watermark", "水印")
_SIGN_BLOCK_MARKERS = ("店招", "招牌", "storefront", "signboard", "garbled", "乱码")


def strip_dialogue(text: str) -> str:
    """去掉引号对白与「说/问/道：…」片段，避免台词写进画面提示词。"""
    s = text or ""
    for pat in _DIALOGUE_PATTERNS:
        s = pat.sub("", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip(" ,，;；")



# 设定卡风格服装锁：按 ref_style 注入配色/服装，抑制跨风格漂移（06:1x 藏青/兜帽）
_ANCIENT_COSTUME_LOCK = (
    "wearing deep indigo cross-collar jiaoling hanfu with gold trim on collar and cuffs, "
    "navy silk robe, traditional Chinese ancient costume, jet black hair, "
    "no hood, no hoodie, no raincoat, no windbreaker, no sweatshirt, no modern clothing"
)
_ANIME_COSTUME_LOCK = (
    "wearing jet-black hooded raincoat, hood down off the head, wet black hair on forehead, "
    "same black raincoat outfit as character sheet, cool white store light, "
    "no hanfu, no white robe, no ancient costume"
)
_ANCIENT_STRIP = (
    "hoodie", "hood down", "hood up", "raincoat", "windbreaker", "sweatshirt",
    "convenience store", "zippered", "streetwear", "plastic umbrella",
)
_ANIME_STRIP = (
    "hanfu", "jiaoling", "ruqun", "ancient costume", "gold trim", "silk robe",
)


def costume_lock_for_style(style: str | None, *, visual_prompt: str = "", name: str = "") -> str:
    """按设定卡风格返回服装配色锁；无风格则空串。

    古风：深蓝/藏青交领 + 金边，禁止兜帽/雨衣。
    二次元：黑连帽雨衣、帽兜放下。
    """
    st = (style or "").strip()
    if st in ("古风", "ancient", "ancient_realistic"):
        lock = _ANCIENT_COSTUME_LOCK
        strip = _ANCIENT_STRIP
    elif st in ("二次元", "anime"):
        lock = _ANIME_COSTUME_LOCK
        strip = _ANIME_STRIP
    else:
        return ""
    base = (visual_prompt or "").strip()
    if base:
        low = base.lower()
        cleaned = base
        for bad in strip:
            if bad.lower() in low:
                # 粗剔冲突词（大小写不敏感）
                import re as _re
                cleaned = _re.sub(_re.escape(bad), "", cleaned, flags=_re.I)
                cleaned = _re.sub(r",\s*,", ", ", cleaned).strip(" ,")
                low = cleaned.lower()
        head = f"{name.strip()} " if name.strip() else ""
        if cleaned:
            return f"{head}{cleaned}, {lock}".strip(", ")
        return f"{head}{lock}".strip(", ")
    if name.strip():
        return f"{name.strip()}, {lock}"
    return lock


def build_cast_visual_for_style(cast, style: str | None = None) -> str:
    """组装管线 C 的 cast_visual：有风格时注入设定卡服装配色锁。"""
    parts: list[str] = []
    for c in cast or []:
        vp = (getattr(c, "visual_prompt", None) or "").strip()
        nm = (getattr(c, "name", None) or "").strip()
        locked = costume_lock_for_style(style, visual_prompt=vp, name=nm)
        if locked:
            parts.append(locked)
        elif vp:
            parts.append(vp)
    return ", ".join(parts)


def build_c_visual_prompt(
    *,
    shot_prompt: str,
    cast_visual: str = "",
    ref_prefix: str = "",
    dialogue: str = "",
    camera: str = "",
    scene: str = "",
    negative: str = "",
) -> str:
    """组装管线 C 正向提示：参考行 + 场景/运镜/角色外观 + 画面描述（无台词）+ Avoid。

    Avoid 必须含 merge_negative 结果（店招/乱码/字幕），经 Comfy prompt 生效。
    """
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
    body += "。画面只有角色与场景，无任何文字、店招或乱码。"
    # 室内货架镜：强制店内 + 可测正脸（雨夜镜1 v2 曾出门外侧写/手部无脸）
    blob = " ".join([shot_prompt or "", scene or "", camera or "", body]).lower()
    if any(k in blob for k in ("aisle", "货架", "冷柜", "fridge", "checkout", "收银", "店内")):
        # 19:30/v6：强制中景正脸，抑制手特写/帽兜挡脸
        body += (
            " Medium shot inside the convenience store interior between shelves, "
            "hoodie hood down, face fully visible facing camera, "
            "eyes and nose clearly readable, upper body in frame, "
            "not outside on the wet sidewalk, "
            "not close-up of hands, not hands-only close-up, "
            "not hood covering face, not half face, not face cut off."
        )
    avoid = merge_negative(negative)
    if ref_prefix:
        head = ref_prefix if ref_prefix.endswith("\n") else ref_prefix + "\n"
        return f"{head}{body}\n\nAvoid: {avoid}"
    return f"{body}\n\nAvoid: {avoid}"


def merge_negative(existing: str = "") -> str:
    """合并镜头原有 negative 与 C 默认文字/店招屏蔽（缺项才追加，不丢弃）。"""
    base = (existing or "").strip()
    if not base:
        return C_AVOID_TEXT
    low = base.lower()
    need_text = not any(m in base or m in low for m in _TEXT_BLOCK_MARKERS)
    need_sign = not any(m in base or m in low for m in _SIGN_BLOCK_MARKERS)
    if not need_text and not need_sign:
        return base
    # 已有部分屏蔽时仍并入完整默认，保证店招/乱码条款到位
    return f"{base}, {C_AVOID_TEXT}"
