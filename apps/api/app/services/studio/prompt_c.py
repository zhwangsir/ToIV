"""管线 C 画面提示词：台词不进画面；负向屏蔽字幕/店招/乱码文字/水印。"""
from __future__ import annotations

import re

# 默认 Avoid：烧录字幕 + 店招/招牌乱码英文（雨夜样片证据：Bit/Gems/NB Bit…）
C_AVOID_TEXT = (
    "subtitles, captions, on-screen text, watermark, logo, title card, "
    "storefront sign, shop sign, store signboard, neon sign text, "
    "garbled text, gibberish english, random letters, burned-in text, "
    "readable english words on signs, billboard text, "
    "digits on signs, number 7 on sign, red digit 7, 7-Eleven logo, "
    "chain-store fascia, orange green red stripes, FamilyMart bands, "
    "brand logo, clothing brand logo, chest logo, emblem on jacket, "
    # 10/05：H3 无独立负向口，Avoid 折进正向 prompt；写出具体品牌名（The North Face 等）
    # 反而把品牌词送进条件（雨夜 shot1 两个候选都出了乱码 NORTH FACE 胸标）→ 只写通用词
    "fashion brand mark, sportswear chest emblem, "
    "品牌标, 服装品牌logo, 胸口logo, 品牌文字, "
    "烧录字幕, 字幕, 台词文字, 水印, 台标, 花字, 标题文字, "
    "店招, 招牌, 乱码英文, 乱码文字, logo文字, "
    "店招数字, 红色数字7, 连锁品牌条纹, 橙绿红条纹"
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
_BRAND_BLOCK_MARKERS = ("brand logo", "clothing brand", "品牌标", "胸口logo", "The North Face")


def strip_dialogue(text: str) -> str:
    """去掉引号对白与「说/问/道：…」片段，避免台词写进画面提示词。"""
    s = text or ""
    for pat in _DIALOGUE_PATTERNS:
        s = pat.sub("", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip(" ,，;；")



# 设定卡风格服装锁：按 ref_style 注入配色/服装，抑制跨风格漂移（06:1x 藏青/兜帽）
# 10/03：无配色时禁止硬编码 jet-black/主色纯黑；必须从设定卡色块取色，取不到则不写颜色。
# 正向加素面无标（plain unbranded / no logo / no text / no print）。
_PLAIN_UNBRANDED = (
    "plain unbranded clothes, 素面无标无文字无印花, "
    "no logo, no text, no print on clothes, no brand mark, no chest emblem"
)
_ANCIENT_COSTUME_LOCK = (
    "wearing cross-collar jiaoling hanfu with layered silk and trim "
    "on collar and cuffs, traditional Chinese ancient costume, black hair, "
    f"{_PLAIN_UNBRANDED}, "
    "no hood, no hoodie, no raincoat, no windbreaker, no sweatshirt, no modern clothing, "
    "no purple robe, no violet robe, no blue robe, no indigo robe, no navy robe, no lavender, "
    "no brand logo, no clothing brand, no chest logo, no emblem, no text on clothes"
)
_ANIME_COSTUME_LOCK = (
    "wearing hooded raincoat, hood down off the head, wet black hair on forehead, "
    "same outfit as character sheet, cool white store light, "
    "mid-tone slate gray fabric readable under store light not pitch black, "
    "板岩灰中调可见勿纯黑, "
    f"{_PLAIN_UNBRANDED}, "
    "no hanfu, no white robe, no ancient costume, "
    "no purple raincoat, no blue raincoat, no indigo coat, "
    "no brand logo, no clothing brand, no chest logo, no emblem, no text on clothes"
)
_ANCIENT_STRIP = (
    "hoodie", "hood down", "hood up", "raincoat", "windbreaker", "sweatshirt",
    "convenience store", "zippered", "streetwear", "plastic umbrella",
)
_ANIME_STRIP = (
    "hanfu", "jiaoling", "ruqun", "ancient costume", "gold trim", "silk robe",
)

# 设定卡配色区几何（与 character_sheet.LAYOUT["palette"] 锁定一致）
_PALETTE_BOX = (1260, 2340, 520, 200)  # x, y, w, h on 2400x3200 sheet


def _normalize_hex(c: str) -> str | None:
    s = (c or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        return None
    try:
        int(s, 16)
    except ValueError:
        return None
    return f"#{s.upper()}"


def _hex_rgb(hx: str) -> tuple[int, int, int]:
    h = _normalize_hex(hx) or "#000000"
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def _is_skin_hex(hx: str) -> bool:
    r, g, b = _hex_rgb(hx)
    return 90 < r < 245 and 60 < g < 210 and 45 < b < 190 and r >= g - 5 and g >= b - 15


def _is_bg_or_light_hex(hx: str) -> bool:
    r, g, b = _hex_rgb(hx)
    if min(r, g, b) > 230:
        return True
    # 设定卡深灰底（非服装）
    if abs(r - 11) + abs(g - 14) + abs(b - 20) < 30:
        return True
    if abs(r - 248) + abs(g - 248) + abs(b - 252) < 40:
        return True
    return False


def _color_family(hx: str) -> str:
    r, g, b = _hex_rgb(hx)
    mx, mn = max(r, g, b), min(r, g, b)
    sat = mx - mn
    luma = r + g + b
    if luma < 120:
        # 近黑：偏棕 vs 纯黑
        if r > g + 8 and r > b + 8 and r > 28:
            return "deep_brown"
        return "black"
    # 金/琥珀：黄味足、蓝色通道低；排除粉肤（b 偏高）
    if r > 150 and g > 110 and b < 100 and (r - b) > 50 and (g - b) > 30:
        return "gold"
    # 服装棕（在肤色判定前，避免 #8B7355 类布色被当肤色丢掉）
    if (
        85 <= r <= 170
        and 60 <= g <= 140
        and b <= 110
        and (r - b) >= 30
        and sat >= 28
        and luma <= 420
        and r >= g
    ):
        return "deep_brown" if luma < 300 else "brown"
    if _is_skin_hex(hx):
        return "skin"
    # 低饱和先归灰/炭黑，避免冷灰 #5A6A7A 被判成蓝
    if sat < 45 and luma < 300:
        return "charcoal" if luma < 220 else "gray"
    if sat < 45:
        return "gray"
    # 紫/蓝族（漂移禁区）
    if b > r + 15 and b >= g:
        return "blue" if g > r + 5 else "purple"
    if b > g + 10 and r > g + 10 and b > 80:
        return "purple"
    if b > r + 10 and g > r and b > 90:
        return "blue"
    if r > 90 and g < 90 and b < 90 and r > g + 20:
        return "brown"
    return "other"


def hex_to_zh_en_color(hx: str) -> tuple[str, str]:
    """单色 → (中文名, 英文提示词片段)。"""
    fam = _color_family(hx)
    mapping = {
        "black": ("纯黑", "jet black"),
        "deep_brown": ("深棕", "deep brown"),
        "brown": ("棕色", "brown"),
        "gold": ("金色", "gold"),
        "charcoal": ("炭黑", "charcoal black"),
        "gray": ("板岩灰", "slate gray"),
        "skin": ("肤色", "skin tone"),
        "purple": ("紫色", "purple"),
        "blue": ("蓝色", "blue"),
        "other": ("主色", "dominant color"),
    }
    return mapping.get(fam, ("主色", "dominant color"))


def adjacent_wrong_color_terms(families: list[str]) -> str:
    """对黑/深棕主色，反向禁止相邻紫/蓝漂移。"""
    garment = {f for f in families if f in ("black", "deep_brown", "brown", "charcoal", "gray", "gold")}
    if not garment:
        return (
            "no purple clothing, no violet clothing, no blue clothing, "
            "no indigo clothing, no navy clothing"
        )
    # 黑/深棕：禁紫蓝靛藏青
    return (
        "no purple robe, no violet robe, no blue robe, no indigo robe, "
        "no navy robe, no lavender clothing, no bluish tint on costume, "
        "禁止紫色衣服, 禁止蓝色袍服, 禁止靛青色"
    )


def pick_garment_colors(colors: list[str] | None, n: int = 3) -> list[str]:
    """按面积序取服装色（调用方/抽色应已按像素面积降序）；不按「最深色」重排。

    07:3x 纠偏：面积最大的衣料色优先（如板岩灰雨衣），禁止把纯黑抬到灰前面。
    仅过滤底色/肤色/紫蓝漂移色；金色镶边若未进 top-n 则替换末位保留。
    """
    # 紫/蓝是漂移禁区，不当主衣料色；其余保持输入面积序
    skip_fams = {"skin", "blue", "purple"}
    cands: list[str] = []
    for raw in colors or []:
        hx = _normalize_hex(raw)
        if not hx:
            continue
        if _is_bg_or_light_hex(hx):
            continue
        fam = _color_family(hx)
        if fam in skip_fams:
            continue
        if hx not in cands:
            cands.append(hx)
    picked = cands[:n]
    # 色板有金则尽量保留镶边色（不改变首位主色）
    golds = [hx for hx in cands if _color_family(hx) == "gold"]
    if golds and not any(_color_family(hx) == "gold" for hx in picked):
        if len(picked) < n:
            picked.append(golds[0])
        elif len(picked) >= 2:
            picked[-1] = golds[0]
        # 若只有 1 格且主色非金，仍用主色，金不抢首位
    return picked


def costume_color_phrases_from_palette(colors: list[str] | None) -> tuple[str, str]:
    """配色色块 → (正向中英色名, 相邻偏色反向)。无可用色则双空串。"""
    picked = pick_garment_colors(colors, n=3)
    if not picked:
        return "", ""
    zh_parts: list[str] = []
    en_parts: list[str] = []
    fams: list[str] = []
    for hx in picked:
        zh, en = hex_to_zh_en_color(hx)
        fams.append(_color_family(hx))
        if zh not in zh_parts:
            zh_parts.append(zh)
        if en not in en_parts:
            en_parts.append(en)
    # 金色作镶边优先
    if "金色" in zh_parts and zh_parts[0] != "金色":
        zh_core = [z for z in zh_parts if z != "金色"]
        pos_zh = "主色" + "与".join(zh_core[:2]) + "、金色镶边"
    else:
        pos_zh = "主色" + "与".join(zh_parts[:3])
    pos_en = (
        "costume colors " + " and ".join(en_parts[:3])
        + ", exact palette match to character sheet swatches"
    )
    if "gold" in en_parts:
        pos_en += ", gold trim on collar and cuffs"
    pos = f"{pos_zh}, {pos_en}"
    neg = adjacent_wrong_color_terms(fams)
    return pos, neg


def extract_palette_swatches_from_sheet(
    png_bytes: bytes, *, max_n: int = 6
) -> list[str]:
    """从设定卡配色色块区按色块面积（像素计数）降序取色号。"""
    try:
        from io import BytesIO
        from PIL import Image
    except Exception:
        return []
    try:
        im = Image.open(BytesIO(png_bytes)).convert("RGB")
    except Exception:
        return []
    if im.size != (2400, 3200) and (im.size[0] < 800 or im.size[1] < 1000):
        # 非标准拼版：整图取色回退
        small = im.resize((64, 64), Image.Resampling.BOX)
        colors = small.getcolors(64 * 64) or []
        colors.sort(key=lambda c: c[0], reverse=True)
        out: list[str] = []
        for cnt, (r, g, b) in colors:
            hx = f"#{r:02X}{g:02X}{b:02X}"
            if _is_bg_or_light_hex(hx):
                continue
            if hx not in out:
                out.append(hx)
            if len(out) >= max_n:
                break
        return out
    # 标准拼版：读 palette 区；等比缩放到实际尺寸
    sx = im.size[0] / 2400.0
    sy = im.size[1] / 3200.0
    x, y, w, h = _PALETTE_BOX
    box = (int(x * sx), int(y * sy), int((x + w) * sx), int((y + h) * sy))
    pl = im.crop(box)
    # 量化后再按面积排序，合并近邻色
    small = pl.resize((max(24, pl.size[0] // 8), max(8, pl.size[1] // 8)), Image.Resampling.BOX)
    raw = small.getcolors(small.size[0] * small.size[1]) or []
    raw.sort(key=lambda c: c[0], reverse=True)
    out = []
    for cnt, (r, g, b) in raw:
        hx = f"#{r:02X}{g:02X}{b:02X}"
        if _is_bg_or_light_hex(hx):
            continue
        # 合并近邻
        merged = False
        for prev in out:
            pr, pg, pb = _hex_rgb(prev)
            if abs(pr - r) + abs(pg - g) + abs(pb - b) < 36:
                merged = True
                break
        if merged:
            continue
        out.append(hx)
        if len(out) >= max_n:
            break
    return out


def costume_lock_for_style(
    style: str | None,
    *,
    visual_prompt: str = "",
    name: str = "",
    colors: list[str] | None = None,
) -> str:
    """按设定卡风格返回服装配色锁；无风格则空串。

    古风：交领汉服 + 设定卡主色（有色块才写颜色；无色块不写 jet-black/主色纯黑），禁止兜帽/雨衣与紫蓝漂。
    二次元：连帽雨衣、帽兜放下；主色仅来自配色色块。
    colors: 设定卡配色 hex 列表（面积序）；有则注入中文色名并写相邻偏色反向；无则用无颜色版型锁。
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
    pos_c, neg_c = costume_color_phrases_from_palette(colors)
    if pos_c:
        # 用抽色段写主色；保留版型、素面正向与禁止项（禁止回落 jet-black 常量）
        if st in ("古风", "ancient", "ancient_realistic"):
            lock = (
                f"wearing cross-collar jiaoling hanfu with {pos_c}, "
                "traditional Chinese ancient costume, black hair, "
                f"{_PLAIN_UNBRANDED}, "
                "no hood, no hoodie, no raincoat, no windbreaker, no sweatshirt, no modern clothing, "
                "no brand logo, no clothing brand, no chest logo, no emblem, no text on clothes, "
                f"{neg_c}"
            )
        else:
            lock = (
                f"wearing hooded raincoat with {pos_c}, hood down off the head, "
                "wet black hair on forehead, same outfit as character sheet, cool white store light, "
                f"{_PLAIN_UNBRANDED}, "
                "no hanfu, no white robe, no ancient costume, "
                "no brand logo, no clothing brand, no chest logo, no emblem, no text on clothes, "
                f"{neg_c}"
            )
    # 无 pos_c：沿用无颜色常量锁（已无 jet-black/主色纯黑），禁止再回落含硬编码主色的旧常量
    base = (visual_prompt or "").strip()
    if base:
        low = base.lower()
        cleaned = base
        for bad in strip:
            if bad.lower() in low:
                cleaned = re.sub(re.escape(bad), "", cleaned, flags=re.I)
                cleaned = re.sub(r",\s*,", ", ", cleaned).strip(" ,")
                low = cleaned.lower()
        head = f"{name.strip()} " if name.strip() else ""
        if cleaned:
            return f"{head}{cleaned}, {lock}".strip(", ")
        return f"{head}{lock}".strip(", ")
    if name.strip():
        return f"{name.strip()}, {lock}"
    return lock


def _cast_colors(c) -> list[str] | None:
    raw = getattr(c, "colors", None)
    if raw is None and isinstance(c, dict):
        raw = c.get("colors")
    if not raw:
        return None
    if isinstance(raw, str):
        import json
        try:
            raw = json.loads(raw)
        except Exception:
            return None
    if not isinstance(raw, (list, tuple)):
        return None
    out = []
    for x in raw:
        hx = _normalize_hex(str(x))
        if hx:
            out.append(hx)
    return out or None


def build_cast_visual_for_style(
    cast,
    style: str | None = None,
    *,
    colors_by_name: dict[str, list[str]] | None = None,
) -> str:
    """组装管线 C 的 cast_visual：有风格时注入设定卡服装配色锁。

    colors_by_name: 可选 {角色名: hex列表}，来自设定卡配色色块抽色。
    """
    parts: list[str] = []
    cmap = colors_by_name or {}
    for c in cast or []:
        vp = (getattr(c, "visual_prompt", None) or "").strip()
        nm = (getattr(c, "name", None) or "").strip()
        cols = _cast_colors(c) or cmap.get(nm) or cmap.get(nm.lower() if nm else "")
        locked = costume_lock_for_style(style, visual_prompt=vp, name=nm, colors=cols)
        if locked:
            parts.append(locked)
        elif vp:
            parts.append(vp)
    return ", ".join(parts)


# 外套无标（中英正向，固定附加）
C_JACKET_PLAIN = "外套无 logo、无品牌字样, plain unbranded jacket with blank chest"
_HOOD_UP_RE = re.compile(r"(全程戴帽|戴帽|帽兜戴上|帽子戴上|hood\s+up|hood\s+on\b)", re.I)
_HOOD_DOWN_PHRASES = re.compile(
    r"(hoodie\s+hood\s+(?:completely\s+)?down(?:\s+off\s+the\s+head)?|"
    r"hood\s+(?:completely\s+)?down(?:\s+off\s+the\s+head|\s+resting\s+on\s+her\s+back)?|"
    r"帽兜放下|帽子放下)",
    re.I,
)


# 全程戴帽（2026-10-05 05:48 方案D）：明确「不放下」，防帽兜中途滑落
C_HOOD_STAYS_UP = "全程戴着帽兜、帽兜不滑落不放下, hood stays up over the head for the whole shot, never lower or remove the hood, the hood never falls off"
# 单一连续镜头（2026-10-05：931f/3c40 镜内多处硬切）
C_SINGLE_TAKE = "单一连续镜头、无切镜, one continuous take, no cuts, no scene change"

# 服装单一描述替换：cast_visual / 镜头描述里的外套名词短语 → outfit_desc（避免 风衣/雨衣/jacket 并存）
_GARMENT_EN = re.compile(
    r"(?:\b(?:jet\s+|pure\s+|plain\s+)?(?:black|dark)\s+)?(?:\bhooded\s+)?"
    r"\b(?:windbreaker|raincoat|rain\s+jacket|rain\s+coat|parka|anorak|jacket|coat)s?\b",
    re.I,
)
_GARMENT_ZH = re.compile(r"(?:纯黑|黑色|深色|黑)?(?:无\s*logo\s*无字的)?(?:连帽)?(?:风衣|雨衣|雨披|外套|夹克)")
_OUTFIT_SLOT = "\x00OUTFIT\x00"


def text_hood_state(*texts: str) -> str | None:
    """文字口径帽兜状态：up（全程戴帽/hood up）/ down（hood down/帽兜放下）/ None。"""
    if wants_hood_up(*texts):
        return "up"
    if any(_HOOD_DOWN_PHRASES.search(t or "") for t in texts):
        return "down"
    return None


def apply_outfit_desc(text: str, desc: str) -> str:
    """把外套名词短语统一成 desc，全文只保留第一次出现（其余删去）。desc 为空则原样返回。"""
    desc = (desc or "").strip()
    if not desc or not text:
        return text
    t = _GARMENT_ZH.sub(_OUTFIT_SLOT, _GARMENT_EN.sub(_OUTFIT_SLOT, text))
    if _OUTFIT_SLOT not in t:
        return text
    head, _, tail = t.partition(_OUTFIT_SLOT)
    tail = tail.replace(_OUTFIT_SLOT, "")
    out = head + desc + tail
    out = re.sub(r"(\s*[,，]\s*){2,}", ", ", out)
    out = re.sub(r"\s{2,}", " ", out)
    return out


def wants_hood_up(*texts: str) -> bool:
    """镜头描述要求戴帽（全程戴帽 / hood up）。"""
    return any(_HOOD_UP_RE.search(t or "") for t in texts)


def apply_hood_state(text: str, hood_up: bool) -> str:
    """hood_up 时把文中「帽兜放下」类短语改成戴帽，避免同一 prompt 自相矛盾。"""
    if not hood_up or not text:
        return text
    return _HOOD_DOWN_PHRASES.sub("hood up over the head", text)


def build_c_visual_prompt(
    *,
    shot_prompt: str,
    cast_visual: str = "",
    ref_prefix: str = "",
    dialogue: str = "",
    camera: str = "",
    scene: str = "",
    negative: str = "",
    style: str | None = None,
    outfit_desc: str = "",
) -> str:
    """组装管线 C 正向提示：参考行 + 场景/运镜/角色外观 + 画面描述（无台词）+ Avoid。

    Avoid 必须含 merge_negative 结果（店招/乱码/字幕），经 Comfy prompt 生效。
    outfit_desc：服装单一描述（如「纯黑无 logo 无字的连帽风衣」）；给出时外套名词短语统一替换、
    只保留一次，外套无 logo 固定句也改用该描述。
    正文固定含 C_SINGLE_TAKE（单一连续镜头、无切镜）。
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
    od = (outfit_desc or "").strip()
    if od:
        body = apply_outfit_desc(body, od)
    hood_up = wants_hood_up(shot_prompt or "", camera or "", cast_visual or "")
    body = apply_hood_state(body, hood_up)
    if hood_up and C_HOOD_STAYS_UP not in body:
        body += "，" + C_HOOD_STAYS_UP
    st = (style or "").strip().lower()
    if st in ("anime", "二次元"):
        body = (
            "anime style, 二次元 cel-shading, consistent anime character design, "
            "not photorealistic, not live-action, not realistic skin pores, "
        ) + body
    elif st in ("ancient_realistic", "ancient", "古风", "古风写实"):
        body = (
            "ancient Chinese realistic portrait style, 古风写实, "
            "not modern anime, not chibi, "
        ) + body
    body += (
        f"。{C_SINGLE_TAKE}。画面只有角色与场景，无任何文字、店招或乱码。"
        f"{(od + '，胸口空白无字, blank chest') if od else C_JACKET_PLAIN}。"
        " blank glowing lightboxes without letters, 无字发光灯箱,"
        " blank neon panels without text, empty glowing signs,"
        " 非连锁品牌配色, not chain-store fascia colors, not 7-Eleven stripes,"
        " not FamilyMart green-blue bands, not branded convenience store signage,"
        " 不出现任何数字字母与连锁品牌配色, no digits letters on signs,"
        " no red numeral 7, no orange-green-red stripe fascia."
    )
    # 室内货架镜：强制店内 + 可测正脸（雨夜镜1 v2 曾出门外侧写/手部无脸）
    blob = " ".join([shot_prompt or "", scene or "", camera or "", body]).lower()
    if any(k in blob for k in ("aisle", "货架", "冷柜", "fridge", "checkout", "收银", "店内")):
        # 19:30/v6：强制中景正脸，抑制手特写/帽兜挡脸
        hood_clause = (
            "hood up over the head the whole shot, same hood state in every frame, "
            if hood_up
            else ("hood down resting behind the neck, hair visible, " if od else "hoodie hood down, ")
        )
        body += (
            " Medium shot inside the convenience store interior between shelves, "
            f"{hood_clause}face fully visible facing camera, "
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
    """合并镜头原有 negative 与 C 默认文字/店招/品牌标屏蔽（缺项才追加，不丢弃）。"""
    base = (existing or "").strip()
    if not base:
        return C_AVOID_TEXT
    low = base.lower()
    need_text = not any(m in base or m in low for m in _TEXT_BLOCK_MARKERS)
    need_sign = not any(m in base or m in low for m in _SIGN_BLOCK_MARKERS)
    need_brand = not any(m in base or m in low for m in _BRAND_BLOCK_MARKERS)
    if not need_text and not need_sign and not need_brand:
        return base
    # 已有部分屏蔽时仍并入完整默认，保证店招/乱码/品牌条款到位
    return f"{base}, {C_AVOID_TEXT}"
