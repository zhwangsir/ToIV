"""模型百科 curated 知识库(WIKI-2026-08-18)—— 为平台在用的底模/LoRA/视频引擎
提供确定性中文卡片:用途、使用方法、提示词方言、来源与许可。

设计原则(与 style_presets 同范式):
  1. 纯数据、无副作用;按「文件名前缀 + 模型类目」匹配本地模型文件
  2. 覆盖生产真实部署的权重(与 style_presets/NSFW_RECOMMENDATIONS 对齐),不猜不臆造
  3. 未命中的文件走 civitai 富化(services/model_wiki.enrich)补全
  4. RAG 问答(services/model_wiki.ask)以本库 + 富化结果为语料

卡片字段:
  filename_prefix  匹配前缀(大小写不敏感,命中文件名开头即认)
  model_type       checkpoints/loras/vae/controlnet/upscale/diffusion_models...
  label            人话名(中文优先)
  base_model       基模(SDXL/SD1.5/FLUX.2/ILLUSTRIOUS/PONY/Wan2.2/原生)
  description      这是什么模型、擅长什么(1-3 句)
  usage            怎么用:采样建议/分辨率/权重/加载方式/在本平台的入口
  prompt_dialect   提示词方言(自然语言长句 / booru 标签 / score_9 前缀 / 中文...)
  trigger_words    LoRA 触发词(确定性注入,不交给 LLM)
  negative_hint    推荐负向提示词
  tags             检索标签(中文)
  nsfw             R18 模型标
  civitai_url      来源页(可查作者/许可/版本)
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CardSpec:
    filename_prefix: str
    label: str
    model_type: str = "checkpoints"
    base_model: str = ""
    description: str = ""
    usage: str = ""
    prompt_dialect: str = ""
    trigger_words: tuple[str, ...] = ()
    negative_hint: str = ""
    tags: tuple[str, ...] = ()
    nsfw: bool = False
    civitai_url: str = ""

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "model_type": self.model_type,
            "base_model": self.base_model,
            "description": self.description,
            "usage": self.usage,
            "prompt_dialect": self.prompt_dialect,
            "trigger_words": list(self.trigger_words),
            "negative_hint": self.negative_hint,
            "tags": list(self.tags),
            "nsfw": self.nsfw,
            "civitai_url": self.civitai_url,
            "source": "curated",
        }


# ─────────────────────────────────────────────────────────────────────────────
# 图像底模(checkpoints / diffusion_models)
# ─────────────────────────────────────────────────────────────────────────────

_IMAGE_CKPT_CARDS: list[CardSpec] = [
    CardSpec(
        filename_prefix="flux2_dev",
        label="FLUX.2 Dev(照片级写实/设计全能王)",
        base_model="FLUX.2",
        description=(
            "Black Forest Labs 的旗舰开源底模,画质天花板级别。自然语言理解强,"
            "擅长照片级写实、产品图、电影感构图、中文海报级设计;"
            "多主体/文字渲染能力显著优于 SDXL 系。"
        ),
        usage=(
            "采样 28-30 步 / CFG 1.0 / euler+simple;分辨率 1024² 或 1280×720;"
            "平台入口:生成页「底模」下拉,或风格预设「照片级写实/产品图/电影感/概念艺术」。"
        ),
        prompt_dialect="英文自然语言长句(完整描述主体/动作/环境/光线/镜头);禁止 booru 标签与质量词堆砌",
        negative_hint="",  # CFG≈1 族负向失效,留空
        tags=("写实", "全能", "设计", "产品图", "电影感", "次世代"),
        civitai_url="",
    ),
    CardSpec(
        filename_prefix="majicMIX realistic",
        label="麦橘写实 majicMIX realistic(亚洲人像专精)",
        base_model="SDXL 1.0",
        description=(
            "经典的亚洲面孔写实人像底模,皮肤质感与光影氛围出色,"
            "商业人像/写真/时尚大片首选;对中文提示词容忍度较高。"
        ),
        usage=(
            "采样 25 步 / CFG 6.5 / dpmpp_2m+karras;推荐 832×1216 竖构图;"
            "写人像时主体描述放前,镜头与光质词放后;风格预设「通用写实」已内置本模。"
        ),
        prompt_dialect="SDXL 逗号标签 + 少量自然语言;质量词适度(raw photo, film grain)",
        negative_hint="ugly, deformed, blurry, bad anatomy, extra limbs, watermark, text",
        tags=("写实", "人像", "亚洲面孔", "写真"),
    ),
    CardSpec(
        filename_prefix="cyberrealisticPony",
        label="CyberRealistic Pony(写实×Pony 混血)",
        base_model="Pony Diffusion V6 XL",
        description=(
            "CyberRealistic 与 Pony V6 的合并模:写实质感打底,兼容 Pony 的"
            "score_9 标签体系与庞大 LoRA 生态;风格化写实与轻度 R18 皆可。"
        ),
        usage=(
            "采样 25-30 步 / CFG 5-6 / euler_a;positive 以 score_9, score_8_up, "
            "score_7_up, score_6_up 开头;可叠 Pony 系 LoRA。"
        ),
        prompt_dialect="Pony score_9 前缀 + danbooru 标签",
        negative_hint="score_6, score_5, score_4, worst quality, low quality",
        tags=("写实", "PONY", "混合", "风格化"),
        civitai_url="https://civitai.com/models/348321",
    ),
    CardSpec(
        filename_prefix="cyberrealistic_v",
        label="CyberRealistic(欧美写实通才)",
        base_model="SDXL 1.0",
        description=(
            "老牌欧美向写实底模,场景/静物/风光均衡,稳定耐用,"
            "适合写实插画感弱的「真照片」需求。"
        ),
        usage="采样 25-30 步 / CFG 5-7 / dpmpp_2m+karras;写实场景与人物通用。",
        prompt_dialect="SDXL 逗号标签;photorealistic, dslr 风格词有效",
        negative_hint="cartoon, anime, illustration, painting, worst quality",
        tags=("写实", "欧美", "场景"),
    ),
    CardSpec(
        filename_prefix="ponyRealism",
        label="Pony Realism(Pony 生态写实向)",
        base_model="Pony Diffusion V6 XL",
        description=(
            "Pony V6 的写实向精调,保留 score 标签体系的同时提升真人质感,"
            "Pony 系 LoRA 兼容性最好。"
        ),
        usage=(
            "采样 25-30 步 / CFG 5-6;score_9 前缀置前;"
            "叠 Pony 系角色/风格 LoRA 是其主要玩法。"
        ),
        prompt_dialect="Pony score_9 前缀 + danbooru 标签",
        negative_hint="score_6, score_5, score_4, blurry, worst quality",
        tags=("写实", "PONY", "LoRA生态"),
    ),
    CardSpec(
        filename_prefix="ponyDiffusionV6",
        label="Pony Diffusion V6 XL(风格化/奇幻全能)",
        base_model="Pony Diffusion V6 XL",
        description=(
            "最流行的风格化 SDXL 底模之一:奇幻/萌系/半写实皆强,"
            "booru 标签训练,LoRA 生态海量;平台风格预设「奇幻风格」基于它。"
        ),
        usage=(
            "采样 25 步 / CFG 5-7 / euler_a+normal;832×1216;"
            "score_9 前缀 + booru 标签(source_anime / style tags 可加)。"
        ),
        prompt_dialect="Pony score_9 前缀 + danbooru 标签",
        negative_hint="worst quality, low quality, score_4",
        tags=("二次元", "奇幻", "风格化", "PONY"),
    ),
    CardSpec(
        filename_prefix="waiIllustriousSDXL",
        label="WAI-ILLUSTRIOUS(现代二次元标准)",
        base_model="Illustrious-XL",
        description=(
            "Illustrious 系现代二次元底模:线条干净、色彩明快、"
            "对当代动漫风格还原度高;平台风格预设「标准二次元」基于它(SFW 定位)。"
        ),
        usage=(
            "采样 25 步 / CFG 5 / euler_a+normal;832×1216;"
            "支持 quality tags(masterpiece, best quality)与 booru 标签。"
        ),
        prompt_dialect="ILLUSTRIOUS booru 标签(1girl/场景/画风)", 
        negative_hint="worst quality, low quality, bad anatomy, missing fingers, extra digits",
        tags=("二次元", "ILLUSTRIOUS", "插画"),
        civitai_url="https://civitai.com/models/827184",
    ),
    CardSpec(
        filename_prefix="hassakuXLIllustrious",
        label="Hassaku XL(柔和插画感二次元)",
        base_model="Illustrious-XL",
        description=(
            "Illustrious 系柔和向:低饱和、空气感、治愈系插画质地,"
            "日常/校园/温馨题材观感佳;平台风格预设「柔和插画」基于它。"
        ),
        usage="采样 25 步 / CFG 5 / dpmpp_2m+karras;832×1216;适合 soft/自然光描述。",
        prompt_dialect="ILLUSTRIOUS booru 标签",
        negative_hint="worst quality, low quality, bad anatomy",
        tags=("二次元", "柔和", "插画", "治愈"),
    ),
    CardSpec(
        filename_prefix="noobaiXL_vpred",
        label="NoobAI-XL v-pred(动漫 NSFW 旗舰)",
        base_model="Illustrious-XL(v-pred)",
        nsfw=True,
        description=(
            "v-prediction 架构的动漫向底模,画质与细节上限高于普通 eps 版,"
            "动漫 R18 题材社区首选之一。"
        ),
        usage=(
            "采样 28 步 / CFG 4.5 / euler+normal;平台检测 v-pred 架构会自动插 "
            "ModelSamplingDiscrete 节点,用户无需手工处理。"
        ),
        prompt_dialect="ILLUSTRIOUS booru 标签(quality masterpieces 前缀有效)",
        negative_hint="worst quality, low quality",
        tags=("二次元", "R18", "VPRED", "ILLUSTRIOUS"),
    ),
    CardSpec(
        filename_prefix="wai_shufflenoob",
        label="WAI ShuffleNoob vPred(WAI×NoobAI 混血)",
        base_model="Illustrious-XL(v-pred)",
        nsfw=True,
        description=(
            "WAI 系列与 NoobAI 的 v-pred 合并:二次元质感 + R18 能力,"
            "v-pred 架构细节好;平台自动处理 ModelSamplingDiscrete。"
        ),
        usage="采样 25-28 步 / CFG 4.5-5;booru 标签;R18 上下文才可见。",
        prompt_dialect="ILLUSTRIOUS booru 标签",
        negative_hint="worst quality, low quality",
        tags=("二次元", "R18", "VPRED"),
    ),
    CardSpec(
        filename_prefix="lustifySDXLNSFW",
        label="Lustify Apex(写实 NSFW)",
        base_model="SDXL 1.0",
        nsfw=True,
        description="写实成人向底模,人体解剖与肤质在 NSFW 写实向中口碑稳定。",
        usage="采样 25 步 / CFG 6 / dpmpp_2m+karras;832×1216;R18 鉴权后可见。",
        prompt_dialect="SDXL 逗号标签",
        negative_hint="ugly, deformed, bad anatomy, watermark",
        tags=("写实", "R18"),
    ),
    CardSpec(
        filename_prefix="uberRealisticPornMerge",
        label="URPM(写实 NSFW 老牌)",
        base_model="SD 1.5",
        nsfw=True,
        description=(
            "SD1.5 时代经典写实 NSFW 合并模,低分辨率出图快,"
            "适合批量迭代或接高清修复二段。"
        ),
        usage="采样 25 步 / CFG 6;512×768 起步;建议叠 4x-UltraSharp 放大。",
        prompt_dialect="SD1.5 逗号标签 + 强质量词",
        negative_hint="ugly, deformed, bad hands, extra limbs, watermark, text",
        tags=("写实", "R18", "SD15"),
    ),
    CardSpec(
        filename_prefix="z_image_turbo",
        label="Z-Image Turbo(8 步极速,Apache 2.0)",
        base_model="Z-Image 6B",
        description=(
            "6B 蒸馏极速底模,8 步出图、单卡秒级;草稿验证/批量预览/"
            "灵感探索首选;Apache 2.0 可商用。"
        ),
        usage=(
            "采样 6-8 步 / CFG 1.0 / euler+simple;1024²;负向留空;"
            "风格预设「极速预览(8步)/草稿模式」基于它。"
        ),
        prompt_dialect="简洁自然语言(主体/环境/光线/风格),忌标签堆砌",
        negative_hint="",
        tags=("极速", "草稿", "可商用", "次世代"),
    ),
    CardSpec(
        filename_prefix="qwen-image",
        label="Qwen-Image(中文文字渲染,可商用)",
        base_model="Qwen-Image",
        description=(
            "阿里 Qwen-Image:中文文字渲染最强开源底模,海报/.banner/带字"
            "物料首选;Apache 2.0 可商用;平台风格预设「中文文字」基于它。"
        ),
        usage=(
            "把要渲染的中文文字用引号写进提示词(如 海报标题「限时特惠」);"
            "1024×1024 或海报竖幅;配合设计类描述词。"
        ),
        prompt_dialect="中英混合自然语言;文字内容务必加引号",
        negative_hint="",
        tags=("中文", "文字", "设计", "可商用", "海报"),
    ),
    CardSpec(
        filename_prefix="nova3DCGXL",
        label="Nova 3DCG XL(3D 渲染感)",
        base_model="SDXL 1.0",
        description="3D CG/皮克斯风渲染质感底模,角色与静物的立体光感强。",
        usage="采样 25-30 步 / CFG 5-7;3d render, pixar style 类风格词有效。",
        prompt_dialect="SDXL 逗号标签",
        negative_hint="worst quality, low quality, flat",
        tags=("3D", "CG", "风格化"),
    ),
]

# ─────────────────────────────────────────────────────────────────────────────
# 视频引擎底模(diffusion_models / checkpoints)
# ─────────────────────────────────────────────────────────────────────────────

_VIDEO_CARDS: list[CardSpec] = [
    CardSpec(
        filename_prefix="wan2.2_t2v",
        label="Wan 2.2 T2V 14B(文生视频主力)",
        base_model="Wan 2.2",
        model_type="diffusion_models",
        description=(
            "阿里万相 2.2 文生视频 14B(fp8),双专家高低噪架构,"
            "通用题材画质/运动自然度均衡,Apache 2.0。"
        ),
        usage=(
            "平台入口:生成页「视频」组引擎;提示词写主体+动作+镜头+氛围,"
            "5 秒内单一动作链;多参考/控制走 Wan VACE/Animate 引擎。"
        ),
        prompt_dialect="英文流畅长句 + 简单运动描述(slow pan, drifting)",
        negative_hint="blurry, lowres, flickering, morphing, deformed, watermark",
        tags=("视频", "文生视频", "WAN"),
    ),
    CardSpec(
        filename_prefix="wan2.2_i2v",
        label="Wan 2.2 I2V 14B(图生视频)",
        base_model="Wan 2.2",
        model_type="diffusion_models",
        description="万相 2.2 图生视频 14B:以参考图首帧驱动,构图可控性最好。",
        usage="上传参考图(建议 ≥854×480);提示词描述运动而非重述画面;denoise 0.75。",
        prompt_dialect="英文运动描述为主(camera, motion, atmosphere)",
        negative_hint="blurry, flickering, morphing, deformed, static frame",
        tags=("视频", "图生视频", "WAN"),
    ),
    CardSpec(
        filename_prefix="longcat-video",
        label="LongCat-Video 13.6B(长视频/数字人)",
        base_model="LongCat-Video",
        model_type="diffusion_models",
        description=(
            "美团开源长视频模型:上下文窗口滑动生成,60 秒单镜头可保持连贯;"
            "LongCat-Avatar 分支支持音频驱动数字人对口型。"
        ),
        usage=(
            "平台入口:视频组 LongCat 引擎;长视频自动开窗(81/overlap16);"
            "数字人对口型走 /api/avatar/talk(图+音频);角色一致性佳。"
        ),
        prompt_dialect="英文自然语言(主体/动作/场景连续过程)",
        negative_hint="",
        tags=("视频", "长视频", "数字人", "对口型"),
    ),
    CardSpec(
        filename_prefix="ltx-video",
        label="LTX-Video(LTX-2.3,音画同出)",
        base_model="LTX-Video",
        model_type="diffusion_models",
        description=(
            "Lightricks LTX 系列:原生音画同出(生成画面同时出音效),"
            "速度快;LTX-2.3 对口型工作流成熟;不适合精确轨迹控制。"
        ),
        usage=(
            "平台入口:R18 视频组 LTX 引擎(10Eros 底模);positive 鼓励写声音"
            "(waves crashing, soft wind);对口型走引擎内 ltx-nsfw-lipsync 工作流。"
        ),
        prompt_dialect="英文画面+运动+声音氛围描述",
        negative_hint="blurry, lowres, watermark, flickering",
        tags=("视频", "音画同出", "对口型", "极速"),
    ),
    CardSpec(
        filename_prefix="h3",
        label="MiniMax H3(电影级长视频+音轨)",
        base_model="H3",
        model_type="diffusion_models",
        description=(
            "MiniMax H3:电影感运镜与主体沿路径运动最强,原生 24fps 音画同出;"
            "单段 362 帧(≈15s),镜头一致性/复杂场景理解优于开源系。"
        ),
        usage=(
            "平台入口:视频组 H3 引擎;帧数自动吸附 17k+5 网格;"
            "负向不可靠——所有要求写正向指令(「不要字幕」→「画面只有角色与场景」)。"
        ),
        prompt_dialect="流畅英文正向长句;一切要求正向化",
        negative_hint="blurry, lowres, watermark(最精简即可)",
        tags=("视频", "电影感", "音画同出", "长视频"),
    ),
]

# ─────────────────────────────────────────────────────────────────────────────
# 场景 LoRA(2026-07-30 部署 42 个短剧场景 LoRA 的类别级说明;单个文件可再 civitai 富化)
# ─────────────────────────────────────────────────────────────────────────────

_LORA_CATEGORY_CARDS: list[CardSpec] = [
    CardSpec(
        filename_prefix="ancient",
        label="古风/古装场景 LoRA",
        model_type="loras",
        base_model="SDXL",
        description="短剧古风场景包:宫廷/江湖/庭院布光与陈设,古风质感统一。",
        usage="LoRA 权重 0.6-0.8;叠在写实或二次元底模上;触发词见各文件富化结果。",
        prompt_dialect="场景描述标签(chinese architecture, hanfu, courtyard)",
        tags=("LoRA", "场景", "古风", "短剧"),
    ),
    CardSpec(
        filename_prefix="campus",
        label="校园场景 LoRA",
        model_type="loras",
        base_model="SDXL",
        description="教室/走廊/操场/夕阳窗光等校园题材场景增强。",
        usage="权重 0.6-0.8;与二次元底模(WAI/Hassaku)搭配最佳。",
        prompt_dialect="场景标签(classroom, sunset light, school uniform)",
        tags=("LoRA", "场景", "校园", "短剧"),
    ),
    CardSpec(
        filename_prefix="urban",
        label="都市夜景场景 LoRA",
        model_type="loras",
        base_model="SDXL",
        description="霓虹街头/写字楼/雨夜反光等都市现代场景。",
        usage="权重 0.6-0.8;夜景霓虹词(neon lights, rain reflection)协同。",
        prompt_dialect="场景标签",
        tags=("LoRA", "场景", "都市", "短剧"),
    ),
    CardSpec(
        filename_prefix="luxe",
        label="商企/奢华场景 LoRA",
        model_type="loras",
        base_model="SDXL",
        description="办公室/会所/酒店大堂等商务奢华空间。",
        usage="权重 0.5-0.8;适合商企短剧与广告感镜头。",
        prompt_dialect="场景标签",
        tags=("LoRA", "场景", "商务", "短剧"),
    ),
    CardSpec(
        filename_prefix="horror",
        label="惊悚/悬疑场景 LoRA",
        model_type="loras",
        base_model="SDXL",
        description="低照度/阴郁色调/废墟等惊悚氛围场景。",
        usage="权重 0.6-0.9;配 dark, dim light, fog 氛围词。",
        prompt_dialect="场景标签",
        tags=("LoRA", "场景", "惊悚", "短剧"),
    ),
]

# 通用放大/工具类
_UTIL_CARDS: list[CardSpec] = [
    CardSpec(
        filename_prefix="4x-UltraSharp",
        label="4x-UltraSharp(帧超分主力)",
        model_type="upscale",
        description="通用 4 倍锐化超分:细节重建稳、不抹纹理,视频 4K 化 fleet 默认模型。",
        usage="平台 M6 超分 fleet(:8261-8263)自动调用;图像走 use_upscale 参数。",
        tags=("放大", "超分", "4K"),
    ),
]

ALL_CARD_SPECS: list[CardSpec] = (
    _IMAGE_CKPT_CARDS + _VIDEO_CARDS + _LORA_CATEGORY_CARDS + _UTIL_CARDS
)


def card_for(filename: str, model_type: str) -> dict | None:
    """按文件名前缀 + 类目匹配 curated 卡片;未命中返回 None(交给 civitai 富化)。

    匹配规则:先找同类目前缀命中;类目不匹配也允许(底模可能出现在
    checkpoints 或 diffusion_models 两个类目,取前缀最长命中者)。
    """
    fn = (filename or "").lower()
    best: CardSpec | None = None
    for spec in ALL_CARD_SPECS:
        if not fn.startswith(spec.filename_prefix.lower()):
            continue
        if spec.model_type == model_type:
            if best is None or len(spec.filename_prefix) > len(best.filename_prefix):
                best = spec
        elif best is None:
            best = spec  # 类目不匹配的弱命中(兜底,给个方向)
    return best.to_dict() if best else None


def list_card_summaries() -> list[dict]:
    """curated 卡片全量(模型百科静态部分 + RAG 语料)。"""
    return [s.to_dict() | {"filename_prefix": s.filename_prefix} for s in ALL_CARD_SPECS]
