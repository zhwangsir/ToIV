"""社区精选配方(RECIPES,2026-08-17)—— CivitAI 真实作品逆向提炼的可直用预设。

数据来源:2026-08-17 从 CivitAI 抓取的 7 个高热度作品元数据(经官方 API withMeta
+nsfw 参数,原始 JSON 见 /tmp/civitai_meta 留档)。可复刻的核心是 kenpechi 的
Wan2.2 I2V「四幕结构」prompt 骨架(主体动作→镜头→收尾→声音)与固定负向模板;
LoRA 触发词(m15510n4ry/d0gg1e/pull0ut/b0dyshot)与平台已装的
WAN_I2V_NSFW_LORAS 六件套一一对应,选配方即整套带入。

落地方式:GET /api/models/recipes 透出(按用户 NSFW 门控过滤);前端参数面板
「社区配方」选择器一键应用:prompt 模板 + negative 模板 + LoRA 组合 + 参数。
"""
from __future__ import annotations

from typing import Any

# kenpechi 固定负向模板(中英混排,7 作品同款,原样保留)
_CINE_NEGATIVE = (
    "watermark, text, subtitles, letterbox, pillarbox, frame, border, split screen, "
    "noise, artifacts, blur, vignette, 色调艳丽,过曝,静态,细节模糊不清,字幕,风格,作品,"
    "画作,画面,静止,整体发灰,最差质量,低质量,JPEG压缩残留,丑陋的,残缺的,多余的手指,"
    "画得不好的手部,画得不好的脸部,畸形的,毁容的,形态畸形的肢体,手指融合,"
    "静止不动的画面,杂乱的背景,三条腿,背景人很多,倒着走"
)

# 四幕结构骨架说明(作品共性:末段专职写音频;纯视频管线下该段作为画面氛围指引保留)
_FOUR_ACT_NOTE = (
    "四幕结构(kenpechi 实证):①触发词+主体动作长句(密集使用运动学动词:piston/bounce/"
    "jiggle/recoil)②同段复述+镜头运动指令 ③收尾动作(pull0ut 系)④纯音频/氛围描述。"
    "每幕之间用「 / 」分隔;触发词必须放段首。"
)

RECIPES: list[dict[str, Any]] = [
    {
        "id": "wan-kenpechi-missionary",
        "label": "Wan 写实传教士位 POV(kenpechi 同款)",
        "engine_id": "wan-nsfw-i2v",
        "nsfw": True,
        "source": "CivitAI 139346628 / 139345695(kenpechi,Wan2.2 I2V-A14B,704×1280 15s 48fps)",
        "description": _FOUR_ACT_NOTE,
        "prompt_template": (
            "m15510n4ry, a woman is lying on her back with her legs spread looking up at "
            "the viewer, having intense sex with a man. {动作细节:piston/bounce/jiggle 等"
            "运动学描述} \n\n She stares at the camera with a seductive stare. She keeps "
            "looking at the camera. \n\n Authentic film look, High-fidelity details / "
            "{同段复述} The camera smoothly zooms out slowly. / pull0ut. {收尾动作+b0dyshot"
            "特写} / {音频段:音效+呻吟+语气描述}"
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [
            {"name": "DR34ML4Y_I2V_14B_LOW_V2", "strength": 0.8},
            {"name": "WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1", "strength": 0.7},
            {"name": "NSFW-22-H-e8", "strength": 0.8},
        ],
        "params": {"width": 704, "height": 1280, "duration": 15, "steps": 6},
    },
    {
        "id": "wan-kenpechi-doggy",
        "label": "Wan 写实后入位 POV(kenpechi 同款)",
        "engine_id": "wan-nsfw-i2v",
        "nsfw": True,
        "source": "CivitAI 139346895(kenpechi,Wan2.2 I2V-A14B,704×1280 15s 48fps)",
        "description": _FOUR_ACT_NOTE,
        "prompt_template": (
            "d0gg1e, A woman is having doggy style sex with a man. {动作细节:臀部 jiggle/"
            "recoil/rhythmic up-and-down motion 等运动学描述} \n\n She stares at the camera "
            "with a seductive stare. She keeps looking at the camera. \n\n Authentic film "
            "look, High-fidelity details / {同段复述} The camera smoothly zooms out slowly. / "
            "pull0ut. {收尾动作+b0dyshot 特写} / {音频段:音效+呻吟+语气描述}"
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [
            {"name": "DR34ML4Y_I2V_14B_LOW_V2", "strength": 0.8},
            {"name": "WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1", "strength": 0.7},
            {"name": "NSFW-22-H-e8", "strength": 0.8},
        ],
        "params": {"width": 704, "height": 1280, "duration": 15, "steps": 6},
    },
]


def recipes_for(engine_id: str = "", include_nsfw: bool = False) -> list[dict[str, Any]]:
    """按引擎过滤配方;NSFW 配方仅在调用方完成 R18 门控后请求(include_nsfw=True)。"""
    out = []
    for r in RECIPES:
        if engine_id and r["engine_id"] != engine_id:
            continue
        if r["nsfw"] and not include_nsfw:
            continue
        out.append(r)
    return out
