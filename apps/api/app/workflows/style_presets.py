"""风格预设 —— 按内容风格自动选择最佳模型组合+采样参数+提示词策略。

设计原则:
  1. 不依赖未开源/未部署的模型;所有预设指向 worker 实测可用的权重
  2. 覆盖图像/视频/文本多模态,按用途分层
  3. 纯数据驱动,无副作用;API 层通过 resolve_style_preset() 获取配置

风格分类体系:
  - 写实类: realistic / photo / product(产品图) / cinematic(电影感) / portrait(人像)
  - 二次元类: anime / anime_soft(柔和插画) / chibi(Q版)
  - 设计类: chinese_text(中文文字渲染,商用首选) / flat_design(扁平设计) / concept_art(概念艺术)
  - 极速类: turbo(8步预览) / draft(草稿快速迭代)
  - 视频类: video_realistic / video_anime / video_fast
  - NSFW类: nsfw_realistic / nsfw_anime (R18门控由上层处理)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class MediaType(str, Enum):
    IMAGE = "image"
    VIDEO = "video"


@dataclass(frozen=True)
class SamplingOverride:
    """采样参数覆盖(None 表示沿用模型 profile 默认值)。"""

    steps: int | None = None
    cfg: float | None = None
    sampler: str | None = None
    scheduler: str | None = None
    denoise: float | None = None


@dataclass(frozen=True)
class StylePreset:
    """单个风格预设的完整配置。

    ckpt_name: 指定底模/UNET文件名(必须是 worker 已部署的)
    media: image / video
    sampling: 采样参数覆盖
    negative_prompt: 该风格推荐负向提示词(次世代CFG≈1族可为空)
    prompt_hint: 附加到 positive 的风格提示词尾缀(纯文本,不含 <lora:> 等 A1111 语法)
    loras: 叠加加载的 LoRA 列表,每项 (带子目录的文件名, 权重),架构须匹配 ckpt
    width / height: 推荐分辨率
    description: 人类可读描述(前端展示用)
    llm_layer: 文案生成时推荐的 LLM 层(L1实时/L2主力/L3精修/L4无审查)
    commercial_safe: 是否可商用(授权友好)
    """

    id: str
    label: str
    ckpt_name: str
    media: MediaType = MediaType.IMAGE
    sampling: SamplingOverride = field(default_factory=SamplingOverride)
    negative_prompt: str = ""
    prompt_hint: str = ""
    loras: tuple[tuple[str, float], ...] = ()
    width: int = 1024
    height: int = 1024
    description: str = ""
    llm_layer: str = "L2"
    commercial_safe: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# 图像预设 —— 所有模型名经 worker /object_info 核实(2026-07-25)
# ─────────────────────────────────────────────────────────────────────────────

_IMAGE_PRESETS: dict[str, StylePreset] = {
    # ── 写实类 ──────────────────────────────────────────────────────────
    "realistic": StylePreset(
        id="realistic",
        label="通用写实",
        ckpt_name="majicMIX realistic 麦橘写实_v7.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=6.5, sampler="dpmpp_2m", scheduler="karras"),
        negative_prompt="ugly, deformed, blurry, bad anatomy, extra limbs, watermark, text",
        width=832,
        height=1216,
        description="全能写实人像/场景,麦橘写实v7,worker已部署",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "photo": StylePreset(
        id="photo",
        label="照片级写实",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        width=1024,
        height=1024,
        description="FLUX.2 dev,画质天花板,自然语言提示词,忌堆质量标签",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "product": StylePreset(
        id="product",
        label="产品图/商品摄影",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=30, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", product photography, studio lighting, white background, commercial photography, high detail",
        width=1024,
        height=1024,
        description="FLUX.2 产品摄影,适合电商/营销物料",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "cinematic": StylePreset(
        id="cinematic",
        label="电影感",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", cinematic lighting, film grain, anamorphic lens, moody atmosphere, shallow depth of field",
        width=1280,
        height=720,
        description="FLUX.2 电影感画面,宽银幕构图",
        llm_layer="L3",
        commercial_safe=False,
    ),
    "portrait": StylePreset(
        id="portrait",
        label="人像特写",
        ckpt_name="cyberrealistic_v120.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=6.0, sampler="dpmpp_2m", scheduler="karras"),
        negative_prompt="ugly, deformed, cross-eye, bad anatomy, extra fingers, watermark",
        width=832,
        height=1216,
        description="CyberRealistic v1.2 人像,肤质优秀",
        llm_layer="L2",
        commercial_safe=False,
    ),

    # ── 中文/商用文字渲染类 ─────────────────────────────────────────────
    # Qwen-Image **底模**(非 Lightning)→ 真 CFG 2.5~4,对齐 model_profiles 档案 3.5
    "chinese_text": StylePreset(
        id="chinese_text",
        label="中文文字渲染(商用首选)",
        ckpt_name="qwen_image_fp8_e4m3fn.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=3.5, sampler="euler", scheduler="simple"),
        width=1024,
        height=1024,
        description="Qwen-Image 1.0,中文文字渲染最强,Apache 2.0可商用",
        llm_layer="L2",
        commercial_safe=True,
    ),
    "commercial_design": StylePreset(
        id="commercial_design",
        label="商用设计/海报",
        ckpt_name="qwen_image_fp8_e4m3fn.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=3.5, sampler="euler", scheduler="simple"),
        prompt_hint=", graphic design, poster design, clean layout, professional",
        width=1024,
        height=1440,
        description="Qwen-Image 商用海报设计,文字+图像一体,可商用",
        llm_layer="L2",
        commercial_safe=True,
    ),

    # ── 二次元类 ───────────────────────────────────────────────────────
    "anime": StylePreset(
        id="anime",
        label="标准二次元",
        ckpt_name="waiIllustriousSDXL_v170.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="euler_a", scheduler="normal"),
        negative_prompt="worst quality, low quality, bad anatomy, missing fingers, extra digits",
        width=832,
        height=1216,
        description="WAI-Illustrious-SDXL v1.7,现代二次元标准",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "anime_soft": StylePreset(
        id="anime_soft",
        label="柔和插画",
        ckpt_name="hassakuXLIllustrious_v34.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="dpmpp_2m", scheduler="karras"),
        negative_prompt="worst quality, low quality, bad anatomy",
        width=832,
        height=1216,
        description="Hassaku Illustrious v3.4,柔和插画风格",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "chibi": StylePreset(
        id="chibi",
        label="Q版/可爱",
        ckpt_name="nova3DCGXL_ilV90.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=22, cfg=5.0, sampler="euler_a", scheduler="normal"),
        negative_prompt="worst quality, low quality, bad anatomy",
        width=768,
        height=768,
        description="Nova Anime 3D/2.5D Q版风格",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "anime_high_quality": StylePreset(
        id="anime_high_quality",
        label="二次元高品质(v-pred)",
        ckpt_name="noobaiXL_vpred10.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=4.5, sampler="euler", scheduler="normal"),
        negative_prompt="worst quality, low quality",
        width=832,
        height=1216,
        description="NoobAI-XL V-Pred v1.0,v-pred架构画质更高,自动插ModelSamplingDiscrete",
        llm_layer="L3",
        commercial_safe=False,
    ),

    # ── 概念/艺术类 ─────────────────────────────────────────────────────
    "concept_art": StylePreset(
        id="concept_art",
        label="概念艺术",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", concept art, digital painting, artstation, highly detailed",
        width=1280,
        height=720,
        description="FLUX.2 概念艺术/场景设计",
        llm_layer="L3",
        commercial_safe=False,
    ),
    "fantasy": StylePreset(
        id="fantasy",
        label="奇幻风格",
        ckpt_name="ponyDiffusionV6XL_v6.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="euler_a", scheduler="normal"),
        negative_prompt="worst quality, low quality",
        width=832,
        height=1216,
        description="Pony Diffusion V6,奇幻/风格化/booru标签体系",
        llm_layer="L2",
        commercial_safe=False,
    ),

    # ── 极速/预览类 ─────────────────────────────────────────────────────
    "turbo": StylePreset(
        id="turbo",
        label="极速预览(8步)",
        ckpt_name="z_image_turbo_bf16.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=8, cfg=1.0, sampler="euler", scheduler="simple"),
        width=1024,
        height=1024,
        description="Z-Image Turbo 6B,8步极速出图,批量/预览首选,Apache 2.0",
        llm_layer="L1",
        commercial_safe=True,
    ),
    "draft": StylePreset(
        id="draft",
        label="草稿模式",
        ckpt_name="z_image_turbo_bf16.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=6, cfg=1.0, sampler="euler", scheduler="simple"),
        width=768,
        height=768,
        description="Z-Image Turbo 6步快速草稿,用于快速构图验证",
        llm_layer="L1",
        commercial_safe=True,
    ),

    # ── NSFW 类(上层须先通过年龄门控) ───────────────────────────────────
    "nsfw_realistic": StylePreset(
        id="nsfw_realistic",
        label="NSFW写真人像",
        ckpt_name="lustifySDXLNSFW_apexV8.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=6.0, sampler="dpmpp_2m", scheduler="karras"),
        negative_prompt="ugly, deformed, bad anatomy, watermark",
        width=832,
        height=1216,
        description="Lustify NSFW Apex V8,写实成人内容",
        llm_layer="L4",
        commercial_safe=False,
    ),
    "nsfw_anime": StylePreset(
        id="nsfw_anime",
        label="NSFW二次元",
        ckpt_name="autismmixSDXL_autismmixPony.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="euler_a", scheduler="normal"),
        negative_prompt="worst quality, low quality, bad anatomy",
        width=832,
        height=1216,
        description="AutismMix Pony,二次元NSFW",
        llm_layer="L4",
        commercial_safe=False,
    ),
    "nsfw_pony": StylePreset(
        id="nsfw_pony",
        label="Pony风格NSFW",
        ckpt_name="cyberrealisticPony_v180Coreshift.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="euler_a", scheduler="normal"),
        negative_prompt="worst quality, low quality",
        width=832,
        height=1216,
        description="CyberRealistic Pony V18 Coreshift",
        llm_layer="L4",
        commercial_safe=False,
    ),

    # ── 短剧场景 LoRA 预设(2026-07-30 已部署 42 个 scene LoRA) ─────────
    "ancient_chinese": StylePreset(
        id="ancient_chinese",
        label="古风汉服",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", ancient chinese style, hanfu, traditional architecture, elegant pose, flowing robes, silk fabric, oriental aesthetics",
        loras=(("ancient_chinese/hanfu_flux_v2.safetensors", 0.8),),
        width=832,
        height=1216,
        description="古风短剧场景,FLUX+hanfu_flux_v2,汉服与传统建筑",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "modern_urban": StylePreset(
        id="modern_urban",
        label="现代都市",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", modern city, neon lights, urban atmosphere, night scene, skyscrapers, street photography, cinematic",
        loras=(("modern_urban/city_streets_at_night_flux.safetensors", 0.75),),
        width=1024,
        height=1024,
        description="现代都市短剧场景,FLUX+city_streets_at_night_flux,霓虹夜景",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "campus": StylePreset(
        id="campus",
        label="校园青春",
        ckpt_name="waiIllustriousSDXL_v170.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="euler_a", scheduler="normal"),
        prompt_hint=", campus youth, school uniform, cherry blossoms, soft anime style, classroom, student, warm sunlight",
        loras=(("campus/linaqruf_anime_detailer.safetensors", 0.7),),
        width=832,
        height=1216,
        description="校园青春短剧场景,SDXL+linaqruf_anime_detailer,柔和二次元",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "luxury_business": StylePreset(
        id="luxury_business",
        label="高端商战",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", luxury business, executive suit, premium office, golden tone, corporate, elegant interior, shallow depth of field",
        width=1024,
        height=1024,
        description="高端商战短剧场景,FLUX,精英商务氛围(LoRA 待验证后启用)",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "special_effects": StylePreset(
        id="special_effects",
        label="特效/科幻",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", sci-fi special effects, cyberpunk city, neon glow, cinematic lighting, futuristic, holographic, lens flare",
        width=1280,
        height=720,
        description="特效科幻短剧场景,FLUX,赛博朋克电影感(视频LoRA 不兼容图像,仅文字提示)",
        llm_layer="L3",
        commercial_safe=False,
    ),
    "horror_thriller": StylePreset(
        id="horror_thriller",
        label="悬疑惊悚",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", horror thriller, dark atmosphere, suspense, film grain, shadows, eerie lighting, 1980s horror film",
        loras=(("horror_thriller/1980s_horror_krea2.safetensors", 0.85),),
        width=1024,
        height=1024,
        description="悬疑惊悚短剧场景,FLUX+1980s_horror_krea2,暗调胶片质感",
        llm_layer="L3",
        commercial_safe=False,
    ),
    "comedy_romantic": StylePreset(
        id="comedy_romantic",
        label="甜宠喜剧",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", romantic comedy, sweet couple, warm lighting, soft focus, bokeh, pastel colors, cozy atmosphere",
        loras=(("comedy_romantic/flux_romanticism.safetensors", 0.75),),
        width=832,
        height=1216,
        description="甜宠喜剧短剧场景,FLUX+flux_romanticism,温馨浪漫氛围",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "history_war": StylePreset(
        id="history_war",
        label="历史战争",
        ckpt_name="waiIllustriousSDXL_v170.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=25, cfg=5.0, sampler="euler_a", scheduler="normal"),
        prompt_hint=", historical war, medieval knight, battlefield, epic composition, dramatic lighting, smoke, armor",
        loras=(("history_war/medieval_knight_sdxl.safetensors", 0.8),),
        width=1280,
        height=720,
        description="历史战争短剧场景,SDXL+medieval_knight_sdxl,史诗战场构图",
        llm_layer="L3",
        commercial_safe=False,
    ),
    "camera_movement": StylePreset(
        id="camera_movement",
        label="镜头运动",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", cinematic lighting, dynamic camera angle, depth of field, dramatic shot, anamorphic lens, film grain, moody",
        loras=(("camera_movement/ntc_cinematic_lighting.safetensors", 0.7),),
        width=1280,
        height=720,
        description="镜头运动质感短剧场景,FLUX+ntc_cinematic_lighting,电影灯光与运镜",
        llm_layer="L3",
        commercial_safe=False,
    ),
    "director_style": StylePreset(
        id="director_style",
        label="导演风格",
        ckpt_name="flux2_dev_fp8mixed.safetensors",
        media=MediaType.IMAGE,
        sampling=SamplingOverride(steps=28, cfg=1.0, sampler="euler", scheduler="simple"),
        prompt_hint=", director style, cinematic framing, color grading, storytelling composition, wide angle, establishing shot",
        width=1280,
        height=720,
        description="导演风格短剧场景,FLUX,电影级构图与色调(视频LoRA 不兼容图像,仅文字提示)",
        llm_layer="L3",
        commercial_safe=False,
    ),
}

# ─────────────────────────────────────────────────────────────────────────────
# 视频预设
# ─────────────────────────────────────────────────────────────────────────────

_VIDEO_PRESETS: dict[str, StylePreset] = {
    "video_realistic": StylePreset(
        id="video_realistic",
        label="真人视频(高质量)",
        ckpt_name="wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
        media=MediaType.VIDEO,
        sampling=SamplingOverride(steps=30, cfg=1.0),
        width=848,
        height=480,
        description="Wan 2.2 T2V 14B 高质量模式,真人画质天花板",
        llm_layer="L3",
        commercial_safe=True,
    ),
    "video_realistic_fast": StylePreset(
        id="video_realistic_fast",
        label="真人视频(快速)",
        ckpt_name="wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
        media=MediaType.VIDEO,
        sampling=SamplingOverride(steps=20, cfg=1.0),
        width=848,
        height=480,
        description="Wan 2.2 T2V 14B 快速模式",
        llm_layer="L2",
        commercial_safe=True,
    ),
    "video_anime": StylePreset(
        id="video_anime",
        label="动漫视频",
        ckpt_name="ltx-2.3-22b-distilled_transformer_only_fp8_scaled.safetensors",
        media=MediaType.VIDEO,
        sampling=SamplingOverride(steps=30, cfg=1.0),
        width=768,
        height=432,
        description="LTX-2.3 22B,动漫风格视频,速度快",
        llm_layer="L2",
        commercial_safe=False,
    ),
    "video_fast": StylePreset(
        id="video_fast",
        label="快速草稿视频",
        ckpt_name="ltx-video-2b-v0.9.5.safetensors",
        media=MediaType.VIDEO,
        sampling=SamplingOverride(steps=20, cfg=1.0),
        width=768,
        height=432,
        description="LTX-Video 2B,最快草稿迭代",
        llm_layer="L1",
        commercial_safe=False,
    ),
    "video_i2v": StylePreset(
        id="video_i2v",
        label="图生视频",
        ckpt_name="wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
        media=MediaType.VIDEO,
        sampling=SamplingOverride(steps=25, cfg=1.0, denoise=0.75),
        width=848,
        height=480,
        description="Wan 2.2 I2V 14B,图生视频高质量",
        llm_layer="L2",
        commercial_safe=True,
    ),
}

ALL_PRESETS: dict[str, StylePreset] = {**_IMAGE_PRESETS, **_VIDEO_PRESETS}

IMAGE_PRESET_IDS: tuple[str, ...] = tuple(_IMAGE_PRESETS.keys())
VIDEO_PRESET_IDS: tuple[str, ...] = tuple(_VIDEO_PRESETS.keys())

DEFAULT_IMAGE_PRESET = "chinese_text"
DEFAULT_VIDEO_PRESET = "video_realistic_fast"


def resolve_style_preset(
    style_id: str | None,
    media: MediaType = MediaType.IMAGE,
) -> StylePreset:
    """按 style_id 解析预设;无效/None 时返回对应媒体类型的默认预设。"""
    if style_id and style_id in ALL_PRESETS:
        return ALL_PRESETS[style_id]
    if media == MediaType.VIDEO:
        return ALL_PRESETS[DEFAULT_VIDEO_PRESET]
    return ALL_PRESETS[DEFAULT_IMAGE_PRESET]


def list_presets(media: MediaType | None = None) -> list[dict]:
    """返回预设列表(可序列化为JSON),供前端展示。"""
    results = []
    presets = ALL_PRESETS.values()
    if media is not None:
        presets = [p for p in presets if p.media == media]
    for p in sorted(presets, key=lambda x: (x.media.value, x.id)):
        results.append({
            "id": p.id,
            "label": p.label,
            "media": p.media.value,
            "ckpt_name": p.ckpt_name,
            "width": p.width,
            "height": p.height,
            "description": p.description,
            "recommended_steps": p.sampling.steps,
            "recommended_cfg": p.sampling.cfg,
            "commercial_safe": p.commercial_safe,
            "llm_layer": p.llm_layer,
        })
    return results
