"""短剧《Dragon Ball × 遮天》生成管线配置。"""
from __future__ import annotations

import json
import os
from pathlib import Path

# 优先从 JSON 分镜加载；不存在则回退到下方硬编码示例
STORYBOARD_LATEST = Path(__file__).resolve().parent.parent / "output" / "storyboard_latest.json"


def load_storyboard(path: Path | str | None = None) -> dict:
    """从 JSON 分镜文件加载结构化分镜。

    返回 dict 含 title/characters/shots/narration；若文件不存在或解析失败，
    返回 None，由调用方回退到默认硬编码数据。
    """
    p = Path(path) if path else STORYBOARD_LATEST
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        # 基本字段校验
        if not isinstance(data.get("shots"), list) or not isinstance(data.get("narration"), list):
            return None
        return data
    except Exception:
        return None


# 基础设施:LB 代理当前/backend 为空,直接访问 comfyui-gpu0
COMFY_ENDPOINT = os.environ.get("TOIV_COMFY_ENDPOINT", "http://192.168.71.127:8189")
TTS_URL = os.environ.get("TOIV_TTS_URL", "http://192.168.71.127:9200")

# 模型
LTX_UNET = "ltx-2.3-distilled.safetensors"
LTX_VAE = "LTX23_video_vae_bf16.safetensors"
LTX_GEMMA = "gemma3_12b_it_bf16/model.safetensors"

# 角色固定视觉 token(英文),注入到每个镜头 prompt 中增强一致性
CHAR_GOKU = (
    "spiky black hair, golden eyes, muscular male saiyan warrior, "
    "orange gi with blue undershirt, orange belt and blue boots, "
    "warm golden aura with cyan highlights, confident heroic grin, "
    "Dragon Ball anime style"
)

CHAR_VEGETA = (
    "short spiky blue-silver hair, stern cold eyes, muscular male saiyan, "
    "dark blue bodysuit, white gloves and boots, saiyan armor shoulder pads, "
    "deep blue battle aura, arrogant posture, Dragon Ball anime style"
)

CHAR_SHIHAO = (
    "young black-haired Chinese cultivator, long dark hair with glowing tips, "
    "mysterious forehead rune, star-like eyes, black robe with dark gold trim, "
    "heavenly god ring behind back, billions of golden dao runes swirling, "
    "xianxia fantasy style, ethereal and powerful"
)

CHAR_SMALLTOWER = (
    "ancient six-layered stone pagoda floating in void, "
    "covered in primal dao patterns, chaotic mist glow, "
    "dignified timeless presence, Chinese fantasy style"
)

CHAR_MAP = {
    "goku": CHAR_GOKU,
    "vegeta": CHAR_VEGETA,
    "shihhao": CHAR_SHIHAO,
    "smalltower": CHAR_SMALLTOWER,
}

# 角色参考音(占位,后续可替换为真实参考音)
REF_AUDIO: dict[str, str] = {
    "narrator": "",
    "goku": "",
    "vegeta": "",
    "shihhao": "",
    "smalltower": "",
    "goku+vegeta": "",
}

# 16 镜分镜配置(总计约 88s)
# 全部用 LTX t2v 直接生成 6s 片段,再裁剪到目标时长
SHOTS = [
    {
        "id": "s1_1",
        "act": 1,
        "duration": 4,
        "prompt": "Slow push-in shot of shattered Universe 7 galaxy. Dark space cracks spread like black lightning across the starfield. Broken planets drift. Purple void tentacles writhe in the background. Epic apocalyptic atmosphere, cinematic wide angle, golden and blue energy afterglow.",
        "negative": "blurry, low quality, text, watermark, deformed, cartoon",
        "characters": [],
    },
    {
        "id": "s1_2",
        "act": 1,
        "duration": 5,
        "prompt": "Two saiyan warriors, one with spiky black hair golden aura and one with blue-silver hair deep blue aura, face each other across a starry canyon. They fire energy beams that collide in the center creating a ring shockwave. Wide angle, Dragon Ball anime style, dynamic action.",
        "negative": "blurry, low quality, text, watermark, deformed, extra limbs",
        "characters": ["goku", "vegeta"],
    },
    {
        "id": "s1_3",
        "act": 1,
        "duration": 4,
        "prompt": "A gigantic black space crack tears across the galaxy like a wound in reality. Spiral void suction pulls stars into it. Violent purple and black energy churns inside the rift. Cinematic disaster scene.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": [],
    },
    {
        "id": "s1_4",
        "act": 1,
        "duration": 4,
        "prompt": "Two warriors, one with golden aura and one with blue aura, are sucked into the black space rift. Their bodies trail long light tails as they spiral into the void. Cinematic follow shot, dramatic motion.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["goku", "vegeta"],
    },
    {
        "id": "s2_1",
        "act": 2,
        "duration": 5,
        "prompt": "Young black-haired Chinese cultivator stands atop a starry peak in ancient starfield. Billions of golden dao runes swirl around him, a heavenly god ring glows behind his back. He closes eyes to stabilize his cultivation breakthrough. Ethereal xianxia atmosphere, cyan-blue nebula background, slow orbiting camera.",
        "negative": "blurry, low quality, text, watermark, deformed, modern clothes, cartoon",
        "characters": ["shihhao"],
    },
    {
        "id": "s2_2",
        "act": 2,
        "duration": 5,
        "prompt": "Black space crack tears open in the starfield above the cultivator. Two warriors fall through: one spiky black hair with golden aura, one blue-silver hair with deep blue aura. They land heavily on floating nebula, looking around in shock. Cinematic top-down to eye-level shot.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["shihhao", "goku", "vegeta"],
    },
    {
        "id": "s2_3",
        "act": 2,
        "duration": 5,
        "prompt": "Three figures form a triangle in starfield. Young Chinese cultivator opens eyes with star-like glow, golden runes rising. Black-haired warrior scratches head curiously with golden aura. Blue-silver haired warrior crosses arms with cold stern expression. Tense standoff, xianxia meets anime style.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["shihhao", "goku", "vegeta"],
    },
    {
        "id": "s2_4",
        "act": 2,
        "duration": 5,
        "prompt": "Young Chinese cultivator dashes forward throwing a punch wrapped with billions of golden dao runes. Starfield trembles. Heavenly god ring behind him. Dynamic slow-motion punch, golden light trails, xianxia anime style.",
        "negative": "blurry, low quality, text, watermark, deformed, cartoon",
        "characters": ["shihhao"],
    },
    {
        "id": "s2_5",
        "act": 2,
        "duration": 6,
        "prompt": "Black-haired saiyan warrior with golden aura grins fiercely and throws a punch forward to meet the cultivator's fist. Blue energy and golden runes collide causing starfield explosion. Side angle, impact shockwave, Dragon Ball x xianxia crossover.",
        "negative": "blurry, low quality, text, watermark, deformed, extra limbs",
        "characters": ["goku", "shihhao"],
    },
    {
        "id": "s2_6",
        "act": 2,
        "duration": 6,
        "prompt": "Three-way battle in collapsing starfield. Blue-silver haired warrior fires blue energy blast from side. Young Chinese cultivator forms golden dao shield with hand seals. Black-haired warrior follows with golden punch. Fast orbiting camera, energy sparks, shattered space fragments.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["vegeta", "shihhao", "goku"],
    },
    {
        "id": "s3_1",
        "act": 3,
        "duration": 5,
        "prompt": "Ancient six-layered stone pagoda emerges from void above battlefield. Dao patterns glow with chaotic mist. A calm supreme pressure spreads freezing the three fighters mid-action. Cinematic reveal shot, majestic mystical atmosphere.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["smalltower", "goku", "vegeta", "shihhao"],
    },
    {
        "id": "s3_2",
        "act": 3,
        "duration": 6,
        "prompt": "Small ancient pagoda hovers center as golden dao light connects the young Chinese cultivator and the two saiyan warriors. Their hostile auras fade. The pagoda's primal patterns translate across dimensions. Slow rotating shot, peaceful mystical glow.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["smalltower", "shihhao", "goku", "vegeta"],
    },
    {
        "id": "s3_3",
        "act": 3,
        "duration": 7,
        "prompt": "The three figures now stand peacefully. Young Chinese cultivator's eyes soften. Black-haired saiyan grins warmly with golden aura dimmed. Blue-silver haired warrior nods slightly with arms no longer crossed. Understanding between dimensions, close-up faces.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["shihhao", "goku", "vegeta"],
    },
    {
        "id": "s4_1",
        "act": 4,
        "duration": 5,
        "prompt": "Young Chinese cultivator steps forward confidently. Ancient pagoda glows beside him. He raises both hands to begin tearing open space. Golden dao runes gather around his arms. Solemn and confident mood, medium shot.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["shihhao", "smalltower"],
    },
    {
        "id": "s4_2",
        "act": 4,
        "duration": 6,
        "prompt": "Young Chinese cultivator tears open a massive stable interdimensional portal with both hands. Inside the portal shows Universe 7 galaxy. Outside remains cyan-blue Zhetian starfield. Runes stabilize the portal edges. Epic wide shot from behind.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["shihhao"],
    },
    {
        "id": "s4_3",
        "act": 4,
        "duration": 5,
        "prompt": "Black-haired saiyan and blue-silver haired saiyan bow respectfully to the cultivator, then turn and walk into the glowing portal. Their figures dissolve into golden and blue light trails. Emotional farewell, medium shot from behind.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["goku", "vegeta", "shihhao"],
    },
    {
        "id": "s4_4",
        "act": 4,
        "duration": 5,
        "prompt": "Young Chinese cultivator closes the portal with a wave. The starfield returns to peaceful cyan-blue. Ancient pagoda floats beside him silently. He stands alone on the starry peak gazing at the calm galaxy. Serene epic final shot, wide angle.",
        "negative": "blurry, low quality, text, watermark, deformed",
        "characters": ["shihhao", "smalltower"],
    },
]

# 台词/旁白
NARRATION = [
    {"start": 4, "end": 13, "speaker": "narrator", "text": "第七宇宙的星河，早已笼罩在躁动不安的乱流之中。卡卡罗特与贝吉塔的巅峰对决，成了撼动宇宙根基的浩劫。这一日，残余力量彻底击穿时空壁垒。他们坠入了一片完全陌生的位面。"},
    {"start": 17, "end": 21, "speaker": "narrator", "text": "遮天世界，刚刚破关的石昊，已然踏入天神境。"},
    {"start": 22, "end": 26, "speaker": "goku", "text": "这里是什么地方？从未见过这样的星域。"},
    {"start": 26, "end": 30, "speaker": "vegeta", "text": "诡异的空间波动……我们被卷到陌生位面了。"},
    {"start": 31, "end": 36, "speaker": "narrator", "text": "语言不通，道则不同。石昊瞬间将二人判定为未知凶兽。"},
    {"start": 38, "end": 41, "speaker": "goku", "text": "好强的力道！"},
    {"start": 43, "end": 48, "speaker": "narrator", "text": "三方大战愈演愈烈，星域濒临崩塌。"},
    {"start": 50, "end": 53, "speaker": "smalltower", "text": "停手，皆是误会。"},
    {"start": 54, "end": 59, "speaker": "narrator", "text": "小塔以大道奥义，消弭了跨位面的认知隔阂。"},
    {"start": 60, "end": 66, "speaker": "goku", "text": "原来只是误会一场！你真的很强，打架超痛快！下次有机会，我们再好好切磋！"},
    {"start": 67, "end": 71, "speaker": "smalltower", "text": "两宇宙位面壁垒隔绝……此方天地必受牵连。"},
    {"start": 71, "end": 75, "speaker": "shihhao", "text": "无妨，我来开路。"},
    {"start": 82, "end": 85, "speaker": "goku+vegeta", "text": "多谢！"},
    {"start": 85, "end": 87, "speaker": "shihhao", "text": "去吧。"},
    {"start": 89, "end": 94, "speaker": "smalltower", "text": "年少天神，执掌时空，一念护诸天，不愧荒天之姿。"},
    {"start": 95, "end": 100, "speaker": "narrator", "text": "诸天浩荡，万界无垠，年少荒天帝，初显镇压万古、守护苍生的无上风采。"},
]

# 尝试加载外部 JSON 分镜；存在则覆盖默认示例
_STORYBOARD_DATA = load_storyboard()
if _STORYBOARD_DATA:
    SHOTS = _STORYBOARD_DATA.get("shots", SHOTS)
    NARRATION = _STORYBOARD_DATA.get("narration", NARRATION)


def shot_prompt_with_chars(shot: dict) -> str:
    """在 prompt 中注入角色固定视觉 token。"""
    parts = [shot["prompt"]]
    for c in shot.get("characters", []):
        token = CHAR_MAP.get(c)
        if token:
            parts.append(token)
    return ", ".join(parts)
