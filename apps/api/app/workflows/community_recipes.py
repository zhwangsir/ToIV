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
    # ----- MiniMax H3 能力族配方(生成页 /api/models/recipes 预设轨) -----
    # RunningHub 社区卡常写 928P;H3 原生上限是 1344×768(768p),此处不伪造 928。
    # 加速 LoRA 文件名来自 lora_catalog(minimax_h3_turbo / lightx2v 4step)。
    {
        "id": "h3-t2v-15s-768p-accel",
        "label": "H3 文生 15 秒 768P 加速",
        "engine_id": "h3-t2v",
        "nsfw": False,
        "source": "ToIV builtin; RH「15秒928P加速」对应本机原生上限 1344×768",
        "description": "H3 原生单段上限 15s(362 帧@24fps)×768p 加速默认;8 步 + turbo LoRA。不是 928P。",
        "prompt_template": (
            "A sunlit city street at golden hour. A cyclist weaves through traffic, "
            "camera tracking beside them. Soft wind, distant traffic rumble, bicycle bell."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [
            {"name": "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors", "strength": 0.8},
        ],
        "params": {"width": 1344, "height": 768, "duration": 15, "steps": 8},
    },
    {
        "id": "h3-i2v-first-frame",
        "label": "H3 图生·仅首帧",
        "engine_id": "h3-i2v",
        "nsfw": False,
        "source": "ToIV builtin; 能力族 i2v first-frame only",
        "description": "只上传一张首帧,按提示词续写动作/对白/音频。不要尾帧、不要 9 参考。",
        "prompt_template": (
            "Continue from the first frame: the subject takes one natural step forward, "
            "camera slowly dollies in. Soft ambient room tone, a short spoken line."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [],
        "params": {"width": 1344, "height": 768, "duration": 5, "steps": 20},
    },
    {
        "id": "h3-i2v-15s-accel",
        "label": "H3 图生 15 秒加速",
        "engine_id": "h3-i2v",
        "nsfw": False,
        "source": "ToIV builtin; 能力族 i2v 15s accel",
        "description": "首帧驱动 15 秒加速:8 步 + turbo LoRA;须上传首帧。",
        "prompt_template": (
            "From the first frame, the scene unfolds for fifteen seconds: "
            "subject continues the implied action, camera holds then gently pans. "
            "Natural ambience and a brief line of dialogue."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [
            {"name": "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors", "strength": 0.8},
        ],
        "params": {"width": 1344, "height": 768, "duration": 15, "steps": 8},
    },
    {
        "id": "h3-fl2v-transition",
        "label": "H3 首尾帧转场",
        "engine_id": "h3-fl2v",
        "nsfw": False,
        "source": "ToIV builtin; 能力族 fl2v",
        "description": "首尾帧转场:第 1 张=起点,第 2 张=终点,中间插值过渡。不是 Ref2VA 全能参考。",
        "prompt_template": (
            "Smooth transition from the first frame to the last frame. "
            "Camera interpolates naturally; light and motion morph without jump cuts. "
            "Soft whoosh as the scene settles."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [
            {"name": "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors", "strength": 0.8},
        ],
        "params": {"width": 1344, "height": 768, "duration": 5, "steps": 8},
    },
    {
        "id": "h3-r2v-identity",
        "label": "H3 全能参考·身份锁定",
        "engine_id": "h3-r2v",
        "nsfw": False,
        "source": "ToIV builtin; 能力族 r2v identity",
        "description": "全能参考最多 9 图 3 视频 3 音频;提示词用 1-based 标签锁定身份与服装。",
        "prompt_template": (
            "<Picture 1> is the same person throughout. They walk through a quiet lobby, "
            "matching face and outfit from the reference. Optional <Picture 2> for clothing. "
            "Footsteps on marble, distant lobby murmur."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [],
        "params": {"width": 1344, "height": 768, "duration": 5, "steps": 20},
    },
    {
        "id": "h3-r2v-voice-image",
        "label": "H3 声音参考+配图",
        "engine_id": "h3-r2v",
        "nsfw": False,
        "source": "ToIV builtin; 能力族 voice+image",
        "description": "声音参考/克隆须配图或视频,不能纯音频。用 <Picture 1> + <Audio 1>。",
        "prompt_template": (
            "<Picture 1> speaks with the voice of <Audio 1>. "
            "Mouth motion matches the reference audio; keep identity from the still. "
            "Do not invent a different speaker."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [],
        "params": {"width": 1344, "height": 768, "duration": 5, "steps": 20},
    },
    {
        "id": "h3-t2v-8step-turbo",
        "label": "H3 文生 8 步 Turbo LoRA",
        "engine_id": "h3-t2v",
        "nsfw": False,
        "source": "ToIV lora_catalog minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors",
        "description": "8 步 turbo LoRA 草稿档(目录已收录 minimax_h3_turbo / lightx2v 4step)。成片可改回 20 步并卸 LoRA。",
        "prompt_template": (
            "A coastal boardwalk at dusk, people strolling, lanterns flickering. "
            "Camera slowly tracks forward. Waves, distant chatter, a gull call."
        ),
        "negative_template": _CINE_NEGATIVE,
        "loras": [
            {"name": "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors", "strength": 0.8},
        ],
        "params": {"width": 1344, "height": 768, "duration": 5, "steps": 8},
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
