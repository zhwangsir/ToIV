"""模型档案 —— 按 checkpoint 文件名做能力适配与分类(纯函数,不封锁)。

平台理念:对 NSFW 不做硬封锁,后端只暴露**分类 / 能力适配**,限制留给用户自加。

本模块两件事:
  1. v-prediction 检测 + 推荐采样:NoobAI-XL-Vpred 等 v-pred 模型出图须在
     checkpoint 后插 `ModelSamplingDiscrete`(sampling="v_prediction", zsnr=True),
     否则发灰/糊。`is_vpred(name)` 按文件名子串判定,`vpred_sampling()` 给推荐采样。
  2. NSFW / R18 分类:`is_nsfw(name)` 按文件名子串或 curated 集合判定,**仅打标不过滤**。

所有判定基于文件名(大小写不敏感),纯函数返回新对象,无副作用。
class_type 与 inputs 依 ComfyUI `comfy_extras/nodes_model_advanced.py` 的
`ModelSamplingDiscrete`:required model(MODEL) / sampling(enum) / zsnr(BOOLEAN),输出 MODEL@0。
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, replace

# ---------------------------------------------------------------------------
# v-prediction
# ---------------------------------------------------------------------------

# 文件名命中以下任一子串(大小写不敏感)即视为 v-prediction 模型。
# 覆盖常见写法:vpred / v-pred / v_pred / v-prediction / v_prediction。
_VPRED_HINTS: tuple[str, ...] = (
    "vpred",
    "v-pred",
    "v_pred",
    "v-prediction",
    "v_prediction",
)


@dataclass(frozen=True)
class SamplingProfile:
    """v-pred 推荐采样参数(供前端默认值 / 后端兜底,不强制)。

    NoobAI-XL-Vpred 等 v-pred 模型实测:euler + normal/karras、cfg 4~5 较稳;
    zsnr=True 配合 ModelSamplingDiscrete 修正灰图。rescale 可选,默认不开。
    """

    sampling: str = "v_prediction"
    zsnr: bool = True
    sampler: str = "euler"
    scheduler: str = "normal"
    cfg: float = 4.5


# 单例推荐档(不可变);需要变体时另建,不修改本对象。
VPRED_SAMPLING = SamplingProfile()


def is_vpred(name: str) -> bool:
    """文件名是否提示 v-prediction(子串匹配,大小写不敏感)。"""
    low = name.lower()
    return any(h in low for h in _VPRED_HINTS)


# ---------------------------------------------------------------------------
# 架构(SDXL vs SD1.5)—— 决定出图分辨率档,避免分辨率失配导致崩坏/重复
# ---------------------------------------------------------------------------

# 文件名命中以下任一子串(大小写不敏感)即按 SDXL 架构出图(~1MP)。
# 本仓常见 SDXL 底模:animagineXL / ponyDiffusionV6XL / prefectIllustriousXL /
# noobaiXL / sd_xl_base 等均含 "xl";动漫系另列 pony/noobai/illustrious/animagine 兜底。
_SDXL_HINTS: tuple[str, ...] = (
    "xl",
    "pony",
    "noobai",
    "illustrious",
    "animagine",
    "playground",
    "pornmix",
    "moody",
)


def is_sdxl(name: str) -> bool:
    """文件名是否提示 SDXL 架构(子串匹配,大小写不敏感)。命不中按 SD1.5 处理。"""
    low = name.lower()
    return any(h in low for h in _SDXL_HINTS)


# ---------------------------------------------------------------------------
# 模型族识别 —— 供提示词优化器「说目标模型的母语」
# ---------------------------------------------------------------------------

# 不同底模族的提示词「方言」截然不同:Pony 要质量分标签、SDXL 动漫要 danbooru 标签、
# Flux/Qwen 要自然语言长句且忌堆质量词。识别按文件名子串,顺序敏感(先特殊后通用)。
# 返回值之一:pony / sdxl_anime / sdxl / flux / qwen / sd15。
def detect_model_family(name: str) -> str:
    """按模型文件名判定族(决定图构造 + 采样档 + 提示词方言)。命不中归 sd15。

    次世代族(flux2 / qwen_image / z_image)优先于通用 flux/qwen 判定,因其文件名也含
    "flux"/"qwen" 子串,顺序敏感(先特殊后通用)。
    """
    low = (name or "").lower()
    # —— 次世代(UNET/diffusion_models 图,CFG≈1,负向失效)——
    if "flux.2" in low or "flux-2" in low or "flux2" in low:
        return "flux2"
    if "z_image" in low or "z-image" in low or "zimage" in low:
        return "z_image"
    if "qwen_image" in low or "qwen-image" in low:
        return "qwen_image"
    # —— LTX 视频(轻量,12G 可跑,CFG=1 + 无负向)——
    if "10eros" in low:
        return "10eros"
    if "ltx" in low:
        return "ltx"
    # —— 传统 checkpoint 图 ——
    if "pony" in low:
        return "pony"
    if "flux" in low:
        return "flux"
    if "qwen" in low:
        return "qwen"
    # cyberrealistic:pony 变体已在上面被 "pony" 命中;此处仅捕获 Illustrious 基的
    # CyberIllustrious(文件名 cyberrealistic_v120,无 xl/illustrious 子串,否则误落 sd15)。
    if any(h in low for h in ("illustrious", "noobai", "animagine", "anime", "wai", "hassaku", "cyberrealistic")):
        return "sdxl_anime"
    if is_sdxl(low):
        return "sdxl"
    return "sd15"


def fit_resolution(ckpt_name: str, width: int, height: int) -> tuple[int, int]:
    """按底模架构把请求宽高缩放到合适像素档(保持宽高比,snap 到 8 的倍数)。

    SDXL 原生 ~1024²(1MP);SD1.5 ~0.4MP 且长边封顶 896 —— 各自架构在错档分辨率下
    会崩坏/重复(SD1.5 在 1024 出双头、SDXL 在 512 糊成抽象)。前端给的宽高只定**宽高比**,
    实际像素由本函数按架构决定。
    """
    width = max(64, width)
    height = max(64, height)
    ar = width / height
    # 分辨率档按**架构族**定:仅 SD1.5 走 0.4MP 小档,其余(SDXL/SDXL动漫/Pony/次世代/
    # flux/qwen)均 ~1MP 原生。按 family 而非 is_sdxl 判断,兼容文件名不含 "xl" 的
    # SDXL 衍生(如 cyberrealistic_v120 = CyberIllustrious),避免误落 640² 崩坏。
    if detect_model_family(ckpt_name) != "sd15":
        budget = 1024 * 1024
        long_cap = 1536
    else:
        budget = 640 * 640
        long_cap = 896
    h = math.sqrt(budget / ar)
    w = h * ar
    longest = max(w, h)
    if longest > long_cap:
        scale = long_cap / longest
        w *= scale
        h *= scale

    def snap(v: float) -> int:
        return max(64, int(round(v / 8)) * 8)

    return snap(w), snap(h)


def vpred_sampling() -> SamplingProfile:
    """返回 v-pred 推荐采样档(不可变单例)。"""
    return VPRED_SAMPLING


# ---------------------------------------------------------------------------
# NSFW / R18 分类(仅打标,不封锁)
# ---------------------------------------------------------------------------

# 文件名命中以下任一子串(大小写不敏感)即归为 NSFW 档。包含两类:
#   - 倾向 NSFW 的底模家族(pony / noobai / animagine / illustrious / realisticvision …)
#   - 显式 NSFW 关键词(nsfw / r18 / hentai / uncensored / porn / xxx …)
# 仅用于前端「NSFW 档」筛选与提示,**不据此过滤任何模型**。
_DEFAULT_NSFW_HINTS: tuple[str, ...] = (
    # 底模家族
    "pony",
    "noobai",
    "animagine",
    "illustrious",
    "realisticvision",
    # civitai 调研批(2026-07)新增 NSFW 底模家族:文件名不含通用族词、需显式登记,
    # 否则泄漏到主站(is_nsfw 决定 /nsfw 门槛)。均为成人向底模,打标即隐藏于主站。
    "cyberrealistic",  # CyberRealistic Pony / CyberIllustrious
    "shufflenoob",     # WAI-SHUFFLE-NOOB(vpred)
    "nova3dcg",        # Nova 3DCG XL(2.5D 手办 CG)
    "lustify",         # LUSTIFY(纯 SDXL 写实 NSFW)
    "hassaku",         # Hassaku XL(浓烈 hentai)
    "autismmix",       # AutismMix(Pony 动漫基座)
    # civitai 调研补充批(2026-07):热门 NSFW 底模,文件名无通用族词兜底,需显式登记
    "pornmaster",      # PornMaster 系列(SDXL 写实/动漫 NSFW 专项)
    "urpm",            # Uber Realistic Porn Merge(SD1.5 纯色情写实合并)
    "yiffy",           # YiffyMix(furry / hentai 向)
    "biglove",         # Big Love(FLUX.2 Klein NSFW)
    "big_love",        # Big Love 变体文件名用下划线分隔
    "stoiqo",          # STOIQO NewReality(FLUX.1 NSFW 写实)
    "lazymix",         # LazyMix(素人写实 NSFW)
    "wai",             # WAI 系列(WAI-illustrious / WAI-RealMix 等动漫 NSFW)
    # 显式关键词
    "nsfw",
    "r18",
    "hentai",
    "uncensored",
    "porn",
    "xxx",
)

# 允许通过环境变量覆盖/扩展 curated 集合(逗号分隔,大小写不敏感)。
# TOIV_NSFW_HINTS 设置后**替换**默认集合;TOIV_NSFW_EXTRA 在默认基础上**追加**。
_ENV_NSFW_OVERRIDE = "TOIV_NSFW_HINTS"
_ENV_NSFW_EXTRA = "TOIV_NSFW_EXTRA"


def _parse_hint_env(value: str) -> tuple[str, ...]:
    return tuple(h.strip().lower() for h in value.split(",") if h.strip())


def nsfw_hints() -> tuple[str, ...]:
    """当前生效的 NSFW 判定子串集合(环境变量可覆盖/追加)。

    - 设 TOIV_NSFW_HINTS → 整体替换默认集合。
    - 设 TOIV_NSFW_EXTRA → 在默认集合基础上追加。
    二者皆未设 → 返回内置默认集合。每次返回新元组(读快照,不缓存)。
    """
    override = os.environ.get(_ENV_NSFW_OVERRIDE, "").strip()
    if override:
        return _parse_hint_env(override)
    extra = os.environ.get(_ENV_NSFW_EXTRA, "").strip()
    if extra:
        return _DEFAULT_NSFW_HINTS + _parse_hint_env(extra)
    return _DEFAULT_NSFW_HINTS


def is_nsfw(name: str) -> bool:
    """文件名是否归为 NSFW / R18 档(子串匹配,大小写不敏感)。

    注意:这是**分类**而非封锁——调用方据此打标/提示,绝不据此过滤模型。
    """
    low = name.lower()
    return any(h in low for h in nsfw_hints())


# ---------------------------------------------------------------------------
# ModelSamplingDiscrete 节点注入(v-pred 出图链修正)
# ---------------------------------------------------------------------------

# v-pred 注入节点 id:避开主图常用小数字 id(1-20)与 LoRA 链基址(100+)。
_VPRED_NODE_ID = "50"


# ---------------------------------------------------------------------------
# 次世代出图族(A 期)—— 采样档案 + UNET 图配方
# ---------------------------------------------------------------------------
# 次世代族用 diffusion_models(UNETLoader)而非 CheckpointLoaderSimple,且关键正确性:
# 真实 CFG≈1 + guidance 节点、Euler/res_multistep + simple、**禁 Karras**、**负向失效**
# (合成器不发负向)。以下把每族的「采样参数」与「图结构配方」作数据集中于此,
# 端点只据此分发,不写 per-model 分支(见开发协议)。

_NEXTGEN_FAMILIES: tuple[str, ...] = ("flux2", "qwen_image", "z_image")


@dataclass(frozen=True)
class GenProfile:
    """按族的推荐生成参数(服务端据此强制,尤其次世代的 cfg=1 / 无负向)。"""

    sampler: str = "euler"
    scheduler: str = "normal"
    cfg: float = 7.0
    steps: int = 20
    megapixels: float = 1.0
    neg_prompt: bool = True  # False = 该族负向失效,合成/图里不发负向
    graph: str = "sd"  # sd | qwen_image | z_image | flux2(决定用哪条工作流图)


@dataclass(frozen=True)
class NextgenRecipe:
    """次世代 UNET 图的家族配方:配套权重默认名 + 结构节点选择。

    权重名是「默认伴随件」(worker 上已实测存在的文件名);实际主模型名由用户选择传入。
    clip_type/model_sampling/latent_node/text_encode 均来自 worker /object_info 实测枚举。
    """

    clip_type: str  # CLIPLoader.type 枚举值
    clip_name: str  # 默认文本编码器权重(diffusion_models 图必须显式加载)
    vae_name: str  # 默认 VAE 权重
    text_encode: str = "CLIPTextEncode"  # 或 TextEncodeZImageOmni(Z-Image 专用)
    model_sampling: str = ""  # "" | ModelSamplingAuraFlow | ModelSamplingFlux
    shift: float = 3.1  # AuraFlow/Flux 的 shift
    latent_node: str = "EmptySD3LatentImage"  # 或 EmptyFlux2LatentImage
    guidance: float | None = None  # 非空 → 插 FluxGuidance 节点
    # 文本编码器候选(按优先级);非空时调用方应经 pool.first_available 解析,
    # 避免默认候选未部署导致派单 503(2026-07-30 qwen_3_vl_8b 教训)
    clip_candidates: tuple[str, ...] = ()


# 采样档案(§10;cfg=1/无负向为次世代关键正确性)。未列族回落 GenProfile() 默认(SD 风)。
_PROFILES: dict[str, GenProfile] = {
    # FLUX.2 dev(画质天花板):真实 CFG=1 + FluxGuidance,euler+simple,~25 步,负向失效。
    "flux2": GenProfile(sampler="euler", scheduler="simple", cfg=1.0, steps=25,
                        megapixels=1.0, neg_prompt=False, graph="flux2"),
    # Qwen-Image **底模**(非 Lightning:文件名无 lightning/turbo/steps)→ 真 CFG 2.5~4 + 负向有效。
    # (若日后用 Qwen-Image-Lightning 蒸馏档,应另族/另档走 cfg=1/无负向。)
    "qwen_image": GenProfile(sampler="euler", scheduler="simple", cfg=3.5, steps=20,
                             megapixels=1.0, neg_prompt=True, graph="qwen_image"),
    "z_image": GenProfile(sampler="res_multistep", scheduler="simple", cfg=1.0, steps=8,
                          megapixels=1.0, neg_prompt=False, graph="z_image"),
    # LTX2.3 视频(轻量,distilled CFG=1,无负向;10Eros 为 NSFW 变体,同采样档)
    "ltx": GenProfile(sampler="euler", scheduler="normal", cfg=1.0, steps=20,
                      megapixels=1.0, neg_prompt=False, graph="ltx"),
    "10eros": GenProfile(sampler="euler", scheduler="normal", cfg=1.0, steps=20,
                         megapixels=1.0, neg_prompt=False, graph="ltx"),
    # 传统族:常规 CFG + 负向有效(is_vpred 仍单独触发 ModelSamplingDiscrete)
    "pony": GenProfile(sampler="euler_ancestral", scheduler="normal", cfg=6.0, steps=28),
    "sdxl_anime": GenProfile(sampler="euler_ancestral", scheduler="normal", cfg=5.0, steps=28),
    "sdxl": GenProfile(sampler="dpmpp_2m_sde", scheduler="karras", cfg=6.0, steps=30),
    "sd15": GenProfile(sampler="euler", scheduler="normal", cfg=7.0, steps=20),
}

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  QWEN-IMAGE 编码器版本说明(2026-07-29 更新)                              ║
# ║                                                                          ║
# ║  Qwen-Image 1.0 (2025-08) → Qwen2.5-VL 文本编码器                       ║
# ║    文件名: qwen_2.5_vl_7b_fp8_scaled.safetensors (当前 worker 实测存在)  ║
# ║                                                                          ║
# ║  Qwen-Image 2.0 (2026-02/05) → Qwen3-VL 文本编码器(架构升级)            ║
# ║    已下载 Qwen3-VL-8B-Instruct 满血;目录加载或单文件转换后使用           ║
# ║    单文件转换后命名: qwen_3_vl_7b.safetensors / qwen_3_vl_8b.safetensors ║
# ║    目录加载路径: text_encoders/qwen_3_vl_8b_instruct/                   ║
# ║                                                                          ║
# ║  Qwen-Image 3.0 (2026-07-21 发布预览) → 权重尚未开源,暂不支持            ║
# ║                                                                          ║
# ║  第一个候选为当前默认(必须已部署);其余为降级/兼容选项。                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# 次世代图配方(worker :8002 /object_info 实测:节点存在、类型枚举含 qwen_image/flux2)。
#    Z-Image 三件套(z_image_turbo/qwen_3_4b/ae)已在;FLUX.2 dev 用 mistral_3_small,Klein 用 qwen_3_4b。
_QWEN_IMAGE_CLIP_CANDIDATES: tuple[str, ...] = (
    # 当前默认: Qwen-Image 2.0 已部署的 Qwen3-VL-8B-Instruct(目录形式)
    "qwen_3_vl_8b_instruct",
    # Qwen-Image 2.0 单文件转换后候选
    # "qwen_3_vl_8b.safetensors",           # 满血 Qwen3-VL 8B 单文件转换后
    # "qwen_3_vl_7b.safetensors",           # 兼容旧命名(7B 单文件转换后)
    # Qwen-Image 1.0 兼容兜底
    "qwen_2.5_vl_7b_fp8_scaled.safetensors",
)
_NEXTGEN_RECIPES: dict[str, NextgenRecipe] = {
    "qwen_image": NextgenRecipe(
        clip_type="qwen_image",
        clip_name=_QWEN_IMAGE_CLIP_CANDIDATES[0],  # 默认用第一个候选
        vae_name="qwen_image_vae.safetensors",
        model_sampling="ModelSamplingAuraFlow",
        shift=3.1,
        latent_node="EmptySD3LatentImage",
        clip_candidates=_QWEN_IMAGE_CLIP_CANDIDATES,
    ),
    "z_image": NextgenRecipe(
        clip_type="lumina2",  # ⚠️ 待 worker smoke 校准(Z-Image 用 qwen_3_4b + TextEncodeZImageOmni)
        clip_name="qwen_3_4b.safetensors",
        vae_name="ae.safetensors",
        text_encode="TextEncodeZImageOmni",
        latent_node="EmptySD3LatentImage",
    ),
    # FLUX.2 编码器按变体不同(见 nextgen_recipe 的按名解析):dev→Mistral-3-small、
    # Klein→qwen_3_4b(worker 已有)。此处默认 dev 的 Mistral;Klein 在解析时替换。
    "flux2": NextgenRecipe(
        clip_type="flux2",
        # dev 编码器:Comfy-Org/flux2-dev 实际文件名为 mistral_3_small_flux2_fp8(无 _scaled),
        # 配 fp8mixed UNET;已下载到 NAS text_encoders。
        clip_name="mistral_3_small_flux2_fp8.safetensors",
        vae_name="flux2-vae.safetensors",
        model_sampling="ModelSamplingFlux",
        latent_node="EmptyFlux2LatentImage",
        guidance=3.5,
    ),
}


def is_nextgen(name: str) -> bool:
    """该模型是否走次世代 UNET 图(而非 SD checkpoint 图)。"""
    return detect_model_family(name) in _NEXTGEN_FAMILIES


def profile_for(name: str) -> GenProfile:
    """按模型名返回推荐生成参数档(未知族回落 SD 风默认)。"""
    return _PROFILES.get(detect_model_family(name), GenProfile())


def nextgen_recipe(name: str) -> NextgenRecipe | None:
    """按模型名返回次世代图配方;非次世代返回 None。

    FLUX.2 按变体换文本编码器:Klein → qwen_3_4b(worker 已有,可即用);
    dev → Mistral-3-small(需下载)。其余族用族级默认配方。
    """
    fam = detect_model_family(name)
    recipe = _NEXTGEN_RECIPES.get(fam)
    if recipe is None:
        return None
    if fam == "flux2" and "klein" in name.lower():
        return replace(recipe, clip_name="qwen_3_4b.safetensors")
    return recipe


def model_sampling_node(
    src_model: list,
    profile: SamplingProfile = VPRED_SAMPLING,
    node_id: str = _VPRED_NODE_ID,
) -> tuple[dict, list]:
    """构造一个 `ModelSamplingDiscrete` 节点,接在 src_model 之后。

    返回 (节点 dict, 新 model 引用)。把 src_model(通常是 checkpoint 的 [ckpt,0]
    或 LoRA 链末端)穿过本节点,下游 KSampler.model 改引本节点输出 [node_id, 0]。
    不可变:返回新 dict 与新引用,不改动入参。
    """
    nodes = {
        node_id: {
            "class_type": "ModelSamplingDiscrete",
            "inputs": {
                "model": list(src_model),
                "sampling": profile.sampling,
                "zsnr": profile.zsnr,
            },
        }
    }
    return nodes, [node_id, 0]
