"""特效预设体系 —— Pikaffects 式一键物理特效(确定性注入层,2026-08-26 P0)。

设计目标:对标 Pika 2.5 Pikaffects,把「融化/爆炸/压碎…」等物理特效做成静态预设,
选中后由后端把特效描述**确定性地拼接到用户提示词前部**,不经过 LLM、不改
H3/Wan 核心生成逻辑(预设注入层只做字符串拼接 + 请求模型校验)。

纪律(与 workflows/style_presets.py 同源):
  1. 纯数据驱动,无副作用;API 层经 validate_effect_key()/apply_effect_preset() 使用
  2. positive_prompt 一律英文自然语言(H3 提示词风格:物理过程 + 电影感 + 声音暗示;
     H3 正文全正向,负向只走引擎 negative 通道,见 skills/h3-prompt-writer)
  3. 适配引擎 H3 优先(原生音画直出),Wan2.2 兜底(R18 链路);cfg/steps 为推荐参数
     (纯数据,不自动覆盖用户显式参数——改采样参数属引擎核心逻辑,不在注入层做)
  4. 全部预设均为场景/主体级物理形变,与 R18 链路(H3 NSFW 默认 10Eros-Max 嫁接版
     UNET,TOIV_H3_NSFW_UNET)兼容,description 中逐一注明
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class EffectPreset:
    """单个物理特效预设。

    key: 稳定标识(API 传参值,kebab-case)
    label_zh: 中文名(下拉 label)
    description: 中文一句话描述(前端选中后展示;含 R18 兼容性注明)
    positive_prompt: 英文特效描述(注入用户 prompt 前部;H3 自然语言风格)
    negative_prompt: 附加负向(并入用户 negative;H3 节点无负向输入时仅快照保留)
    engines: 适配引擎族(h3=MiniMax H3 优先,wan=Wan2.2 兜底)
    cfg / steps: 推荐采样参数(纯建议数据,不自动覆盖用户显式参数;None=引擎默认)
    """

    key: str
    label_zh: str
    description: str
    positive_prompt: str
    negative_prompt: str = ""
    engines: tuple[str, ...] = ("h3", "wan")
    cfg: float | None = None
    steps: int | None = None


# R18 兼容注明(全部预设均为主体/场景级物理形变,与 10Eros-Max H3 嫁接版及
# Wan2.2 NSFW 配方链路无冲突;description 统一尾缀,前端选中即可见)
_R18_NOTE = "R18 兼容(10Eros-Max)"

_EFFECT_PRESETS: dict[str, EffectPreset] = {
    "melt": EffectPreset(
        key="melt",
        label_zh="融化",
        description=f"主体如蜡般软化下垂,淌成光亮液泊;{_R18_NOTE}",
        positive_prompt=(
            "The subject melts like warm wax: its surface softens and loses tension, "
            "edges sag and stretch downward under gravity, thick glossy drips slide off "
            "and pool on the ground, the whole form slowly collapsing into a shining puddle "
            "while the background stays perfectly still. Macro cinematic detail, soft volumetric "
            "light, realistic viscous fluid physics, faint wet dripping sound."
        ),
        engines=("h3", "wan"),
    ),
    "explode": EffectPreset(
        key="explode",
        label_zh="爆炸",
        description=f"主体从核心炸开,碎片与尘雾四散飞溅;{_R18_NOTE}",
        positive_prompt=(
            "The subject suddenly bursts apart from its core: a shockwave of fragments and dust "
            "blasts outward in all directions, debris tumbling through the air with trailing smoke, "
            "then the pieces rain down and settle, leaving an empty space where the subject stood. "
            "High-speed photography look, dramatic rim light, dust particles glowing in the air, "
            "a deep cinematic boom."
        ),
        negative_prompt="intact subject, duplicate subject",
        engines=("h3", "wan"),
        steps=20,
        cfg=3.5,
    ),
    "crush": EffectPreset(
        key="crush",
        label_zh="压碎",
        description=f"无形压机缓缓落下,主体被压扁成皱片;{_R18_NOTE}",
        positive_prompt=(
            "An invisible giant press slowly descends onto the subject: the top surface dents and "
            "flattens, cracks spread across its body, the structure buckles and is pressed into a "
            "thin crumpled sheet against the ground, dust puffing out from the edges. Industrial "
            "cinematic lighting, rigid-body crush physics, a low grinding rumble."
        ),
        engines=("h3", "wan"),
        steps=20,
        cfg=3.5,
    ),
    "inflate": EffectPreset(
        key="inflate",
        label_zh="膨胀",
        description=f"主体如气球般鼓胀变圆,轻轻浮晃;{_R18_NOTE}",
        positive_prompt=(
            "The subject inflates like a balloon: its body swells up round and tight, the surface "
            "stretching smooth and glossy, limbs sinking into the expanding volume as it grows "
            "larger and lighter, gently bobbing in place. Playful cinematic close-up, soft studio "
            "light, elastic rubber physics, faint stretching creaks."
        ),
        engines=("h3", "wan"),
    ),
    "squish": EffectPreset(
        key="squish",
        label_zh="捏扁",
        description=f"巨手捏压,主体如果冻般压扁回弹;{_R18_NOTE}",
        positive_prompt=(
            "A giant invisible hand squishes the subject: it compresses with soft cartoon elasticity, "
            "bulging outward at the sides, wobbling like jelly as the pressure pulses, then slowly "
            "springs back toward its original shape. Playful macro shot, squash-and-stretch "
            "animation physics, soft cartoon boings."
        ),
        engines=("h3", "wan"),
    ),
    "levitate": EffectPreset(
        key="levitate",
        label_zh="悬浮",
        description=f"主体失重升空,碎石尘埃一同漂浮;{_R18_NOTE}",
        positive_prompt=(
            "The subject gently lifts off the ground and levitates: it rises slowly into the air, "
            "rotating weightlessly as dust and small pebbles float up around it, hair and loose "
            "fabric drifting upward, a soft glow shimmering beneath it. Cinematic low-angle shot, "
            "anti-gravity physics, a shimmering magical hum."
        ),
        engines=("h3", "wan"),
    ),
    "dissolve": EffectPreset(
        key="dissolve",
        label_zh="消散",
        description=f"主体化作发光微粒,随风散去直至空无;{_R18_NOTE}",
        positive_prompt=(
            "The subject dissolves into countless glowing particles: its edges break apart into "
            "fine dust and embers that drift away on the wind, the form thinning into a shimmering "
            "cloud until nothing remains, the scene left quiet and empty. Cinematic backlit "
            "particles, slow ethereal fade, whispering wind."
        ),
        negative_prompt="subject remains, duplicate subject",
        engines=("h3", "wan"),
    ),
    "deflate": EffectPreset(
        key="deflate",
        label_zh="泄气",
        description=f"主体如漏气气球般皱缩瘫软;{_R18_NOTE}",
        positive_prompt=(
            "The subject deflates like a punctured balloon: it wrinkles and sags as the air rushes "
            "out, shrinking and collapsing into a soft crumpled shell that flops gently onto the "
            "ground. Playful cinematic timing, elastic rubber physics, a comical descending whoosh."
        ),
        engines=("h3", "wan"),
    ),
    "eye-pop": EffectPreset(
        key="eye-pop",
        label_zh="瞪眼",
        description=f"卡通式震惊:双眼弹射凸出再收回;{_R18_NOTE}",
        positive_prompt=(
            "The character's eyes suddenly pop out in cartoon shock: pupils dilate and the eyeballs "
            "spring forward on elastic stalks, the jaw dropping, the whole face frozen in "
            "exaggerated surprise before the eyes snap back into place. Classic cartoon comedy "
            "physics, snappy timing, a playful boing."
        ),
        engines=("h3", "wan"),
    ),
    "shatter": EffectPreset(
        key="shatter",
        label_zh="碎裂",
        description=f"主体如玻璃般布满裂纹,崩碎成晶亮碎片;{_R18_NOTE}",
        positive_prompt=(
            "The subject shatters like glass: a spiderweb of cracks races across its surface, then "
            "it bursts into thousands of sharp shards that scatter and tumble to the ground, "
            "glittering as they settle into a sparkling pile. High-speed cinematic detail, brittle "
            "fracture physics, a crisp crystalline crash."
        ),
        negative_prompt="intact subject, duplicate subject",
        engines=("h3", "wan"),
        steps=20,
        cfg=3.5,
    ),
    "freeze": EffectPreset(
        key="freeze",
        label_zh="冰冻",
        description=f"寒霜蔓延,主体被冰封进晶莹冰壳;{_R18_NOTE}",
        positive_prompt=(
            "A wave of frost races over the subject: ice crystals bloom and crawl across its "
            "surface, breath turning to mist, the whole body locking solid mid-motion inside a "
            "clear glassy shell of ice, snowflakes drifting around it. Cold blue cinematic light, "
            "freezing physics, delicate crackling ice."
        ),
        engines=("h3", "wan"),
    ),
    "burn": EffectPreset(
        key="burn",
        label_zh="燃烧",
        description=f"火焰吞噬主体,化作余烬与飞灰;{_R18_NOTE}",
        positive_prompt=(
            "The subject ignites and burns away: flames lick up from its edges, embers and ash "
            "curling off into the air, the surface glowing orange and crumbling into charred "
            "fragments that scatter on the wind until only drifting ash remains. Warm fire-lit "
            "cinematic grade, realistic fire and ember physics, a deep crackling roar."
        ),
        negative_prompt="intact subject",
        engines=("h3", "wan"),
        steps=20,
        cfg=3.5,
    ),
    "vanish": EffectPreset(
        key="vanish",
        label_zh="消失",
        description=f"主体闪烁折叠,瞬间凭空消失;{_R18_NOTE}",
        positive_prompt=(
            "The subject vanishes in a blink: it flickers once with a ripple of distortion, folds "
            "inward on itself and disappears completely, leaving the background untouched as if it "
            "was never there, a faint shimmer hanging in the air for a moment. Clean cinematic VFX, "
            "sudden silence."
        ),
        negative_prompt="subject remains, duplicate subject",
        engines=("h3", "wan"),
    ),
    "transform": EffectPreset(
        key="transform",
        label_zh="变形",
        description=f"轮廓如液体光般重塑,主体变成全新形态;{_R18_NOTE}",
        positive_prompt=(
            "The subject morphs through a magical transformation: its silhouette ripples and "
            "reshapes, colors flowing across its surface like liquid light as it turns into a "
            "completely new form, sparkling particles swirling around during the change, ending "
            "stable and whole. Fantasy cinematic lighting, fluid morphing physics, a rising "
            "magical chime."
        ),
        engines=("h3", "wan"),
    ),
    "camera-shake": EffectPreset(
        key="camera-shake",
        label_zh="震屏",
        description=f"如遭地震般剧烈手持晃动,尘埃震落;{_R18_NOTE}",
        positive_prompt=(
            "The camera shakes violently as if struck by an earthquake: the frame rattles with "
            "fast jittery movement, dust falls from above, the subject stumbles to keep balance, "
            "debris trembling on every surface, then the shaking slowly subsides. Handheld action "
            "cinematography, a rumbling low-frequency impact."
        ),
        engines=("h3", "wan"),
    ),
    "petrify": EffectPreset(
        key="petrify",
        label_zh="石化",
        description=f"石质纹理自下而上蔓延,主体凝成雕像;{_R18_NOTE}",
        positive_prompt=(
            "The subject slowly turns to stone: a grey stony texture creeps upward from its base, "
            "the surface hardening and losing color, fine cracks and a mossy grain appearing as "
            "motion freezes, ending as a perfectly still statue. Museum cinematic lighting, slow "
            "petrification physics, a low rumbling grind."
        ),
        engines=("h3", "wan"),
    ),
    "crystallize": EffectPreset(
        key="crystallize",
        label_zh="结晶",
        description=f"晶莹宝石簇在主体表面生长,折射彩虹光;{_R18_NOTE}",
        positive_prompt=(
            "Brilliant crystals grow all over the subject: translucent gemstone clusters sprout "
            "and branch across its surface, refracting rainbows as they spread, the subject "
            "becoming a glittering crystal sculpture that catches every beam of light. Macro "
            "cinematic sparkle, crystalline growth physics, delicate glassy chimes."
        ),
        engines=("h3", "wan"),
    ),
}


def list_effect_presets() -> list[EffectPreset]:
    """全部特效预设(注册表声明顺序,供引擎注册表/前端下拉枚举)。"""
    return list(_EFFECT_PRESETS.values())


def get_effect_preset(key: str | None) -> EffectPreset | None:
    """按 key 取预设;None/空串/未知 key → None(注入层防御:绝不阻断生成)。"""
    if not key:
        return None
    return _EFFECT_PRESETS.get(key.strip())


def validate_effect_key(key: str | None) -> str | None:
    """请求模型校验用:None/空白 → None;未知 key 抛 ValueError(pydantic → 422)。

    与 get_effect_preset 的静默容错分工:HTTP 入口必须显式拒绝未知 key
    (防静默拼错导致特效不生效还扣额度),注入函数本身保持防御式 no-op。
    """
    if not key or not key.strip():
        return None
    k = key.strip()
    if k not in _EFFECT_PRESETS:
        raise ValueError(f"未知特效预设: {k}")
    return k


def apply_effect_preset(
    positive: str,
    negative: str = "",
    key: str | None = None,
) -> tuple[str, str]:
    """确定性注入:预设特效描述拼到用户 prompt 前部,预设负向并入用户负向。

    - key 为 None/未知 → 原样返回(防御式 no-op,生成永不被注入层阻断)
    - 注入位置在**前部**:H3/Wan 对句首主体事件权重最高,特效是全片主事件,
      用户 prompt 作为主体/场景补充紧随其后
    - negative 仅当预设自带负向时合并(逗号连接,A1111 风格;H3 无负向输入时
      仅随请求快照保留,不进图)
    """
    preset = get_effect_preset(key)
    if preset is None:
        return positive, negative
    user_pos = positive.strip()
    pos = f"{preset.positive_prompt} {user_pos}" if user_pos else preset.positive_prompt
    neg = negative
    if preset.negative_prompt:
        user_neg = negative.strip()
        neg = f"{user_neg}, {preset.negative_prompt}" if user_neg else preset.negative_prompt
    return pos, neg
