"""GET /api/models —— 从 ComfyUI object_info 派生前端下拉项（不硬编码）。

模式感知:不同创作模式用不同模型源,前端按当前 mode 显示对应类别。
- 图像 → CheckpointLoaderSimple 的图像底模(剔除音频/3D 等非图像 checkpoint)
- 视频 → 平台 Wan 工作流实际用的 diffusion_models(双模型管线,只读)
- 3D   → Hunyuan3D ckpt(硬编码,只读)
- 音频 → ACE-Step ckpt(硬编码,只读)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import ModelCard, User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.services.engine_registry import list_engines, reset_avail_cache
from app.workflows.ace_step import AceStepParams
from app.workflows.hunyuan3d import Hunyuan3DParams
from app.workflows.llm_router import list_content_types, list_llm_endpoints
from app.workflows.model_profiles import (
    detect_model_family,
    is_nextgen,
    is_nsfw,
    is_vpred,
    profile_for,
)
from app.workflows.model_health import generate_health_report
from app.workflows.style_presets import list_presets, MediaType
from app.workflows.wan_t2v import WanT2VParams

router = APIRouter()


def _enum(info: dict, node: str, field: str) -> list[str]:
    req = info.get(node, {}).get("input", {}).get("required", {})
    opts = req.get(field, [[]])
    return opts[0] if opts and isinstance(opts[0], list) else []


def _tagged(names: list[str]) -> list[dict]:
    """给一批 checkpoint 附 nsfw/vpred 标(仅分类,不过滤——平台无限制)。

    每项形如 {"name": str, "nsfw": bool, "vpred": bool},供前端做「NSFW 档」
    筛选与 v-pred 提示。顺序与入参一致。
    """
    return [
        {
            "name": n,
            "nsfw": is_nsfw(n),
            "vpred": is_vpred(n),
            # A 期:族标签 + 是否次世代 + 是否用负向(前端据此自适应 UI:
            # 次世代隐 CFG/采样、负向失效族隐负向框、提示词切自然语言)。
            "family": detect_model_family(n),
            "nextgen": is_nextgen(n),
            "neg": profile_for(n).neg_prompt,
        }
        for n in names
    ]


# 非图像底模的 checkpoint(由别的模式/管线使用),从图像 checkpoint 列表中剔除。
# 用子串匹配(大小写不敏感),避免把音频/3D/视频专用 checkpoint 混入图像选择器。
_NON_IMAGE_CKPT_HINTS = (
    "ace_step",     # ACE-Step 音频
    "mmaudio",      # MMAudio 音频
    "hunyuan3d",    # Hunyuan3D 三维
    # LTX 视频底模:LTXVGemmaCLIPModelLoader 的 ltxv_path 只枚举 checkpoints 目录,
    # 故视频 DiT 必须落 checkpoints/,但不筛掉会混进图像底模下拉(选中即报错)。
    "ltx-",         # LTX-2.3 视频 DiT(t2v/i2v/lipdub)
    "10eros",       # 10Eros LTX 系 NSFW 视频 UNET(经 UNETLoader 加载,非图像底模)
)


def _is_image_ckpt(name: str) -> bool:
    low = name.lower()
    return not any(h in low for h in _NON_IMAGE_CKPT_HINTS)


def _image_checkpoints(all_ckpts: list[str]) -> list[str]:
    return [c for c in all_ckpts if _is_image_ckpt(c)]


def _nextgen_image_models(unet_names: list[str]) -> list[str]:
    """UNETLoader(diffusion_models)里的次世代出图族(flux2/qwen_image/z_image)。

    这些底模不走 CheckpointLoaderSimple,故不在 all_ckpts 里;并入图像可选模型。
    视频 Wan 的 UNET 不是次世代出图族,is_nextgen 判否,自然排除。
    组件分片(Qwen-Image/text_encoder|transformer|vae 等 HF 目录件)也须剔除——
    它们因子串命中 is_nextgen 混入下拉,选中即报错(engine_registry._is_component_shard 同源)。
    """
    from app.services.engine_registry import _is_component_shard

    return [n for n in unet_names if is_nextgen(n) and not _is_component_shard(n)]


def _video_models() -> list[str]:
    """视频模式实际加载的 diffusion_models(Wan 双噪声 UNET);只读展示。"""
    p = WanT2VParams(positive="")
    return [p.high_unet, p.low_unet]


def _sfw_only(names: list[str]) -> list[str]:
    """剔除文件名命中 NSFW 判定的项(用户未开 R18 时服务端强制过滤)。"""
    return [n for n in names if not is_nsfw(n)]


def _nsfw_only(names: list[str]) -> list[str]:
    """仅保留 NSFW 模型(/nsfw 专页:只展示成人向模型,不混入 SFW)。"""
    return [n for n in names if is_nsfw(n)]


async def _pick_live_client(pool: WorkerPool):
    """在 worker 池里找第一台可达的 worker,返回 (client, ckpt_info)。

    修「硬查 clients[0],单台挂则整体 502」的脆弱性:逐台尝试 object_info,
    第一台成功即用;全部不可达才 502。
    """
    last: Exception | None = None
    for client in pool.clients:
        try:
            return client, await client.object_info("CheckpointLoaderSimple")
        except ComfyUIError as e:
            last = e
    raise HTTPException(status_code=502, detail=f"所有 worker 都不可达: {last}")


@router.get("/models")
async def list_models(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
    client, ckpt_info = await _pick_live_client(pool)
    try:
        ks_info = await client.object_info("KSampler")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    all_ckpts = _enum(ckpt_info, "CheckpointLoaderSimple", "ckpt_name")
    # 次世代出图族在 diffusion_models(UNETLoader)里,并入图像可选模型;worker 缺则为空。
    try:
        unet_info = await client.object_info("UNETLoader")
        all_unets = _enum(unet_info, "UNETLoader", "unet_name")
    except ComfyUIError:
        all_unets = []
    # 次世代族排前(可发现性:它们是 A 期升级的推荐底模,列表首位默认落在次世代)
    image_ckpts = _nextgen_image_models(all_unets) + _image_checkpoints(all_ckpts)

    # 模型过滤:/nsfw 专页只显示 NSFW 模型,主站只显示 SFW 模型。
    if nsfw_allowed(user):
        image_ckpts = _nsfw_only(image_ckpts)
    else:
        image_ckpts = _sfw_only(image_ckpts)

    # 把全局默认底模提到首位，确保前端下拉/画布的默认选中与 settings.default_ckpt 一致。
    # 默认模型若因 NSFW 过滤被剔除，则不强行置顶（避免在 SFW 上下文出现不可选项）。
    default_ckpt_name = get_settings().default_ckpt
    if default_ckpt_name and default_ckpt_name in image_ckpts:
        image_ckpts = [default_ckpt_name] + [c for c in image_ckpts if c != default_ckpt_name]

    # 给图像底模附 nsfw/vpred 分类标(不过滤);并抽出便捷名单供前端筛选。
    image_tagged = _tagged(image_ckpts)
    # 未开 R18 时已剔除 nsfw 底模,nsfw_models 必为 []。
    nsfw_models = [it["name"] for it in image_tagged if it["nsfw"]]
    vpred_models = [it["name"] for it in image_tagged if it["vpred"]]

    # 模式 → {models, editable}。editable=False 表示后端硬编码单/双模型,前端只读展示。
    # image.checkpoints 附带每个底模的 {name,nsfw,vpred} 标(仅图像模式有分类意义)。
    # 平台默认底模(settings.default_ckpt);前端据此把初始选中对齐后端默认,
    # 避免默认落到列表首位的未验证模型(A 期:default=z_image 已实测可出图)。
    default_ckpt = default_ckpt_name if default_ckpt_name in image_ckpts else None
    modes = {
        "image": {
            "models": image_ckpts,
            "checkpoints": image_tagged,
            "editable": True,
            "default": default_ckpt,
        },
        "video": {"models": _video_models(), "editable": False},
        "model3d": {"models": [Hunyuan3DParams(image="").ckpt_name], "editable": False},
        "audio": {"models": [AceStepParams(tags="").ckpt_name], "editable": False},
    }

    return {
        # 向后兼容:checkpoints 现在是「图像底模」而非全量(视频/3D/音频不再混入)
        "checkpoints": image_ckpts,
        # 每个图像底模附 {name,nsfw,vpred};nsfw/vpred 便捷名单供「NSFW 档」筛选与提示。
        "checkpoints_tagged": image_tagged,
        "nsfw_models": nsfw_models,
        "vpred_models": vpred_models,
        "samplers": _enum(ks_info, "KSampler", "sampler_name"),
        "schedulers": _enum(ks_info, "KSampler", "scheduler"),
        "modes": modes,
    }


# (分类标签, 节点, 字段)
_LOCAL_SPECS = [
    ("checkpoints", "CheckpointLoaderSimple", "ckpt_name"),
    ("loras", "LoraLoader", "lora_name"),
    ("vae", "VAELoader", "vae_name"),
    ("controlnet", "ControlNetLoader", "control_net_name"),
    ("upscale", "UpscaleModelLoader", "model_name"),
]


@router.get("/models/local")
async def local_models(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
) -> dict[str, object]:
    """按类型列出 worker 上已安装的本地模型。

    向后兼容:各类型仍是 list[str]。额外附 checkpoint 分类(不过滤):
      - checkpoints_tagged:[{name,nsfw,vpred}, ...]
      - nsfw_models / vpred_models:便捷名单(取自 checkpoints)
    """
    client, _ = await _pick_live_client(pool)
    out: dict[str, object] = {}
    for key, node, field in _LOCAL_SPECS:
        try:
            out[key] = _enum(await client.object_info(node), node, field)
        except ComfyUIError:
            out[key] = []
    # 模型过滤:/nsfw 专页只显示 NSFW 模型,主站只显示 SFW 模型。
    if nsfw_allowed(user):
        for key in ("checkpoints", "loras"):
            names = out.get(key, [])
            if isinstance(names, list):
                out[key] = _nsfw_only(names)
    else:
        for key in ("checkpoints", "loras"):
            names = out.get(key, [])
            if isinstance(names, list):
                out[key] = _sfw_only(names)
    ckpts = out.get("checkpoints", [])
    tagged = _tagged(ckpts if isinstance(ckpts, list) else [])
    out["checkpoints_tagged"] = tagged
    # 未开 R18 时 checkpoints 已剔除 nsfw,nsfw_models 必为 []。
    out["nsfw_models"] = [it["name"] for it in tagged if it["nsfw"]]
    out["vpred_models"] = [it["name"] for it in tagged if it["vpred"]]
    return out


# ---------------------------------------------------------------------------
# NSFW 模型推荐清单(静态,基于 civitai 调研)
# ---------------------------------------------------------------------------
# 不从 civitai API 实时拉取(避免网络延迟/限流),数据写死在此。
# 仅供 /nsfw 专区展示,帮用户发现热门 NSFW 底模 + 配套 LoRA;下载链接指向 civitai,
# 用户手动下载后放到 NAS。分类:realistic(写实)/ anime(动漫)/ flux(FLUX 系)/ lora(配套 LoRA)
# / video(LTX2.3 视频)/ h3(MiniMax H3 视频 LoRA)。

NSFW_RECOMMENDATIONS: list[dict] = [
    # —— 写实向 ——
    {
        "name": "epiCRealism XL",
        "type": "checkpoint",
        "base": "SDXL 1.0",
        "size": "6.6GB",
        "civitai_url": "https://civitai.com/models/277058",
        "desc": "高质感写实真人,皮肤光影顶级",
        "category": "realistic",
    },
    {
        "name": "PornMaster-色情大师",
        "type": "checkpoint",
        "base": "SDXL 1.0",
        "size": "6.8GB",
        "civitai_url": "https://civitai.com/models/266408",
        "desc": "SDXL 纯 NSFW 写实首选,人体结构准",
        "category": "realistic",
    },
    {
        "name": "URPM (Uber Realistic Porn Merge)",
        "type": "checkpoint",
        "base": "SD 1.5",
        "size": "2GB",
        "civitai_url": "https://civitai.com/models/22622",
        "desc": "纯色情写实合并,NSFW 专项",
        "category": "realistic",
    },
    {
        "name": "LUSTIFY",
        "type": "checkpoint",
        "base": "SDXL 1.0",
        "size": "6.6GB",
        "civitai_url": "https://civitai.com/models/267078",
        "desc": "纯 SDXL NSFW,效果稳定",
        "category": "realistic",
    },
    {
        "name": "CyberRealistic",
        "type": "checkpoint",
        "base": "SD 1.5",
        "size": "4GB",
        "civitai_url": "https://civitai.com/models/4475",
        "desc": "NSFW 写实向调教",
        "category": "realistic",
    },
    # —— 动漫向 ——
    {
        "name": "Pony Diffusion V6 XL",
        "type": "checkpoint",
        "base": "Pony",
        "size": "6.6GB",
        "civitai_url": "https://civitai.com/models/257749",
        "desc": "Pony 系始祖,NSFW 动漫生态最大",
        "category": "anime",
    },
    {
        "name": "WAI-illustrious-SDXL",
        "type": "checkpoint",
        "base": "Illustrious",
        "size": "6.6GB",
        "civitai_url": "https://civitai.com/models/1294491",
        "desc": "Illustrious NSFW 旗舰,下载量动画类第一",
        "category": "anime",
    },
    {
        "name": "NoobAI-XL (NAI-XL)",
        "type": "checkpoint",
        "base": "NoobAI",
        "size": "6.8GB",
        "civitai_url": "https://civitai.com/models/833294",
        "desc": "动漫 NSFW + vpred 采样",
        "category": "anime",
    },
    {
        "name": "Hassaku XL",
        "type": "checkpoint",
        "base": "Illustrious",
        "size": "6.6GB",
        "civitai_url": "https://civitai.com/models/640177",
        "desc": "重度 hentai 首选",
        "category": "anime",
    },
    # —— FLUX 向 ——
    {
        "name": "Big Love",
        "type": "checkpoint",
        "base": "Flux.2 Klein",
        "size": "9GB",
        "civitai_url": "https://civitai.com/models/618359",
        "desc": "基于 Flux.2 Klein,项目已支持 klein 变体",
        "category": "flux",
    },
    {
        "name": "STOIQO NewReality",
        "type": "checkpoint",
        "base": "Flux.1 D",
        "size": "11GB",
        "civitai_url": "https://civitai.com/models/429328",
        "desc": "FLUX.1 系 NSFW 写实",
        "category": "flux",
    },
    # —— LoRA 配套 ——
    {
        "name": "Nudify XL: Better Bodies",
        "type": "lora",
        "base": "SDXL",
        "size": "435MB",
        "civitai_url": "https://civitai.com/models/270876",
        "desc": "SDXL 身体/裸露增强",
        "category": "lora",
    },
    {
        "name": "ExpressiveH (Hentai LoRa)",
        "type": "lora",
        "base": "Pony",
        "size": "218MB",
        "civitai_url": "https://civitai.com/models/238390",
        "desc": "Pony hentai 表情/动作",
        "category": "lora",
    },
    # —— LTX2.3 视频专用 ——
    {
        "name": "LTX2.3 10Eros",
        "type": "unet",
        "base": "LTX2.3",
        "size": "11GB",
        "civitai_url": "https://civitai.red/models/2447875/ltx23-10eros",
        "desc": "NSFW 视频专用 LTX2.3 底模,已内置为默认视频 UNET",
        "category": "video",
    },
    {
        "name": "LTX2.3 All in One",
        "type": "lora",
        "base": "LTX2.3",
        "size": "2.3GB",
        "civitai_url": "https://civitai.red/models/2553704/ltx23-all-in-one-sfw-nsfw-ltx-director-id-lora-controlnet-detailer-upscaler-interpolator",
        "desc": "LTX Director / ID LoRA / ControlNet / Detailer / Upscaler / Interpolator 合集",
        "category": "video",
    },
    {
        # 已在 NAS(loras/ltx2.3/),10Eros/LTX2.3 NSFW 运动增强;civitai 检索入口,
        # 未定位到稳定模型页 ID(下载按钮自动禁用,展示元数据用)
        "name": "LTX2.3 NSFW Motion",
        "type": "lora",
        "base": "LTX2.3",
        "size": "1.1GB",
        "civitai_url": "https://civitai.com/models?query=LTX2.3%20NSFW%20motion",
        "desc": "10Eros 配套 NSFW 运动 LoRA(00750),已在 NAS 可直接选用",
        "category": "video",
    },
    {
        "name": "Sulphur Better NSFW Motion",
        "type": "lora",
        "base": "LTX2.3",
        "size": "625MB",
        "civitai_url": "https://civitai.com/models?query=Sulphur%20better%20NSFW%20motion",
        "desc": "Sulphur 的 LTX2.3 NSFW 动作改善 LoRA,已在 NAS 可直接选用",
        "category": "video",
    },
    {
        "name": "zImage Turbo",
        "type": "unet",
        "base": "LTX2.3",
        "size": "9GB",
        "civitai_url": "https://civitai.red/models/2221503/zimage-turbo-by-stable-yogi",
        "desc": "Stable Yogi 的 LTX2.3 Turbo 视频底模,可通过环境变量切换",
        "category": "video",
    },
    # —— MiniMax H3 视频 LoRA(专用实例 :8195;安装落 NAS toiv/comfyui-models/h3/loras,
    #    H3 工作室「LoRA 叠加」参数即可选;一键安装走 NAS 下载,下同)——
    {
        "name": "H3 Riding POV (I2V)",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.19GB",
        "civitai_url": "https://civitai.red/models/2446218",
        # 该模型有 10Eros/LTXV2.3 多版本,须精确指定 H3 版(最新版不是 H3)
        "version_id": "3203205",
        "desc": "骑乘位 POV i2v LoRA,文件名 riding_pose_H3_i2v_v1.0.safetensors;"
        "推荐强度 0.5-1.0(作者建议 0.6,同页附提示词模板);需安装",
        "category": "h3",
    },
    {
        "name": "H3 Footjob",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.12GB",
        "civitai_url": "https://civitai.red/models/2839680",
        "version_id": "3205326",
        "desc": "足交动作 LoRA,文件名 H3_footjob_v0_step1000_fixed.safetensors;"
        "推荐强度 0.6-1.0;需安装",
        "category": "h3",
    },
    {
        "name": "H3 Cxy Kiss Lora",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.58GB",
        "civitai_url": "https://civitai.red/models/2842199",
        "version_id": "3208556",
        "desc": "亲吻动作 LoRA(作者标 SFW),文件名 cxy_kiss_lora_h3_v01_step1500.safetensors;"
        "推荐强度 0.6-1.0;需安装",
        "category": "h3",
    },
    {
        "name": "H3 Innie Pussy",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.28GB",
        "civitai_url": "https://civitai.red/models/2841940",
        "version_id": "3208228",
        "desc": "私处特写 LoRA,文件名 h3_musubi_v4-000040.safetensors;"
        "推荐强度 0.6-1.0;需安装",
        "category": "h3",
    },
    # ── 生态扩充(2026-08-08,civitai 按下载量调研)────────────────────
    {
        "name": "Daring's Deepthroat H3",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "1.11GB",
        "civitai_url": "https://civitai.red/models/2476698",
        "version_id": "3205475",
        "desc": "深喉动作 LoRA(H3 生态下载量第一 20k+),文件名 deepthroat_v1.safetensors;"
        "推荐强度 0.6-1.0;需安装",
        "category": "h3",
    },
    {
        "name": "H3 Vagina",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.14GB",
        "civitai_url": "https://civitai.red/models/2835594",
        # v0.2(step2500)为最新 H3 版
        "version_id": "3200540",
        "desc": "私处结构 LoRA(5.2k 下载),文件名 minimax_vag_000002500.safetensors;"
        "推荐强度 0.6-1.0;需安装",
        "category": "h3",
    },
    {
        "name": "SexGod's NaughtyTimes H3",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "2.31GB",
        "civitai_url": "https://civitai.red/models/2836176",
        "version_id": "3200994",
        "desc": "综合动作增强 LoRA(6.8k 下载,大体积高 rank),文件名 SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors;"
        "推荐强度 0.5-0.8;需安装",
        "category": "h3",
    },
    {
        "name": "Minimax H3 lightx2v Turbo(加速)",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.29GB",
        "civitai_url": "https://civitai.red/models/2837571",
        # lightx2v_4step_turbo_v0.1(primary 为 1.82GB 全量版,另有 resized rank21 小体积版可选)
        "version_id": "3206543",
        "desc": "SFW 加速 LoRA(4 步出片,5k 下载),文件名 minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors;"
        "配合低步数使用;需安装",
        "category": "h3",
    },
    # ── 生态扩充(2026-08-10,civitai tag 调研:MiniMax H3 底 LoRA 全生态仅 ~17 个)──
    {
        "name": "HMNSFW AIO Sex LoRA",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.29GB",
        "civitai_url": "https://civitai.red/models/2834417",
        "version_id": "3206518",
        "desc": "AIO 综合 NSFW 动作 LoRA(H3 生态下载量第一 1.9w),文件名 HMNSFW_AIO_V2.safetensors;"
        "I2V/T2V 通用;推荐强度 0.5-0.8;需安装",
        "category": "h3",
    },
    {
        "name": "AI Girl: Fictional Women Series30 H3",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.28GB",
        "civitai_url": "https://civitai.red/models/2845077",
        "version_id": "3212165",
        "desc": "架空女性角色系列 LoRA(作者标 SFW),文件名 AI_Girl_Fictional_Women_Series30_H3.safetensors;"
        "角色一致性增强;需安装",
        "category": "h3",
    },
    {
        "name": "MiniMAX H3 Turbo 850 步加速(合并剪枝版)",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "1.32GB",
        "civitai_url": "https://civitai.red/models/2838852",
        "version_id": "3204289",
        "desc": "加速 LoRA(850 步 ema 剪枝版,适配 pruned 底模合并),文件名 minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors;"
        "配合低步数使用;需安装",
        "category": "h3",
    },
    # ── 生态扩充(2026-08-11,按创作者作品集调研 HearmemanAI/blo01 新增)──
    {
        "name": "HMPussy (Pussy/Anus) H3",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.29GB",
        "civitai_url": "https://civitai.red/models/2846342",
        # v0.5 stills+motion;另有 v0.1 (ver=3213728, 597MB) 旧版
        "version_id": "3215304",
        "desc": "局部特写增强 LoRA(HearmemanAI,H3 生态下载量第二梯队),文件名 vagassist_e40.safetensors;"
        "推荐强度 0.5-0.8;需安装",
        "category": "h3",
    },
    {
        "name": "Stomach Bulge H3 (I2V)",
        "type": "lora",
        "base": "MiniMax H3",
        "size": "0.19GB",
        "civitai_url": "https://civitai.red/models/1445226",
        # 多 base 模型,必须锚定 H3 版本(其他版本是 LTXV2.3/Wan)
        "version_id": "3213696",
        "desc": "腹部隆起动作 LoRA(blo01,全 base 累计 3.6w 下载),文件名 stomach_bulge_H3_i2v_v1.0.safetensors;"
        "I2V 专用;推荐强度 0.5-0.8;需安装",
        "category": "h3",
    },
]


@router.get("/models/nsfw-recommendations")
async def nsfw_recommendations(
    user: User = Depends(get_current_user),
) -> dict:
    """返回静态 NSFW 模型推荐清单(基于 civitai 调研,不从 API 实时拉取)。

    供 /nsfw 专区「NSFW 推荐」tab 展示,帮用户发现热门成人向底模与配套 LoRA。
    下载链接指向 civitai,用户手动下载后放到 NAS;需登录认证(主站零 R18 痕迹,
    此端点仅返回静态元数据,不含实际成人内容)。
    """
    return {"items": NSFW_RECOMMENDATIONS, "count": len(NSFW_RECOMMENDATIONS)}


@router.get("/models/engines")
async def list_generation_engines(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
) -> dict:
    """统一生成工作台引擎注册表:引擎元信息 + 参数 schema + 实时可用性。

    接入新引擎 = 在 services/engine_registry 注册条目,前端按 schema 动态渲染参数区。
    NSFW 引擎(10Eros 系)仅在 R18 上下文(X-NSFW 头)出现;SFW 上下文同时剔除
    select 选项里的 R18 项(如 ltx2 白名单的 10eros 底模)。
    """
    engines = await list_engines(pool, user)
    return {"engines": engines, "count": len(engines)}


@router.post("/models/engines/refresh")
async def refresh_generation_engines(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
) -> dict:
    """清空引擎可用性缓存并重新探测,返回全量引擎(前端「重新检测」按钮)。

    与 GET /models/engines 的差别仅在强制重探测;R18 上下文过滤规则一致。
    """
    reset_avail_cache()
    engines = await list_engines(pool, user)
    return {"engines": engines, "count": len(engines)}


@router.get("/models/presets")
async def list_style_presets(
    media: str | None = None,
    user: User = Depends(get_current_user),
) -> dict:
    """返回风格预设列表,供前端选择器使用。

    Args:
        media: 可选,筛选媒体类型 "image" / "video";不传则返回全部
    """
    mt = None
    if media:
        try:
            mt = MediaType(media)
        except ValueError:
            mt = None
    presets = list_presets(mt)
    return {"presets": presets, "count": len(presets)}


@router.get("/models/llm-endpoints")
async def list_llm(
    user: User = Depends(get_current_user),
) -> dict:
    """返回四层 LLM 端点配置(模型ID/地址/超时/适用场景)。"""
    return {
        "endpoints": list_llm_endpoints(),
        "content_types": list_content_types(),
    }


@router.get("/models/recipes")
async def list_community_recipes(
    engine: str = "",
    user: User = Depends(get_current_user),
) -> dict:
    """社区精选配方(CivitAI 真实作品逆向):prompt 模板 + 负向模板 + LoRA 组合 + 参数。

    R18 门控:仅 /nsfw 专页上下文(nsfw_allowed)才返回 nsfw 配方,主站一律剔除。
    engine 可选过滤(如 wan-nsfw-i2v / ltx25-t2v)。
    """
    from app.workflows.community_recipes import recipes_for

    rows = recipes_for(engine_id=engine, include_nsfw=nsfw_allowed(user))
    return {"recipes": rows, "count": len(rows)}


# ---------------------------------------------------------------------------
# 模型百科(WIKI-2026-08-18):每个模型「是什么/怎么用/哪里来」+ RAG 自然语言问答
# ---------------------------------------------------------------------------

def _visible(card: dict, user: User) -> bool:
    """R18 门控:主站剔除 nsfw 卡片(与 /models/local 的过滤口径一致)。"""
    return (not card.get("nsfw")) or nsfw_allowed(user)


@router.get("/models/wiki")
async def model_wiki_list(
    type: str = "",
    q: str = "",
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """模型百科列表:worker 本地清单 × curated 卡片 × civitai 富化缓存 合成。

    type 过滤类目;q 模糊匹配 文件名/名称/标签/描述;未富化模型 has_detail=False。
    """
    from app.services import model_wiki as svc

    inventory = await svc.local_inventory(pool)
    cards = svc.build_cards(inventory, session)
    cards = [c for c in cards if _visible(c, user)]
    if type:
        cards = [c for c in cards if c["model_type"] == type]
    if q:
        ql = q.lower()
        cards = [
            c for c in cards
            if ql in c["filename"].lower() or ql in c["label"].lower()
            or any(ql in t.lower() for t in c.get("tags", []))
            or ql in c.get("description", "").lower()
        ]
    return {"cards": cards, "count": len(cards)}


@router.get("/models/wiki/detail")
async def model_wiki_detail(
    filename: str,
    type: str,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """单模型卡片详情(模型库文件点击展开);R18 模型主站 404(不泄露存在性)。"""
    from app.services import model_wiki as svc

    card = svc._merge(filename, type, session.get(ModelCard, svc._card_id(filename, type)))
    if not _visible(card, user):
        raise HTTPException(status_code=404, detail="模型不存在")
    return card


@router.post("/models/wiki/enrich")
async def model_wiki_enrich(
    body: dict,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """admin:civitai 批量富化(补全介绍/触发词/基模/许可),结果落库缓存。

    body: {"force": bool, "max": int, "targets": [[filename, type], ...]}
    targets 缺省 = 全部未富化模型(按文件名序取前 max 条)。
    """
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可执行富化")
    from app.services import model_wiki as svc

    targets = body.get("targets") or []
    if not targets:
        inventory = await svc.local_inventory(pool)
        cards = svc.build_cards(inventory, session)
        targets = [[c["filename"], c["model_type"]] for c in cards if not c["has_detail"]]
    force = bool(body.get("force"))
    max_count = int(body.get("max") or 40)
    result = await svc.enrich_models(
        [tuple(t) for t in targets if isinstance(t, (list, tuple)) and len(t) == 2],
        session, force=force, max_count=max_count,
    )
    return result


@router.post("/models/ask")
async def model_wiki_ask(
    body: dict,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """自然语言问模型(RAG):embedding 检索 → LLM 中文作答,附匹配卡片。

    例:「画写实人像用哪个底模」「wai 是什么模型」「长视频用什么」。
    """
    from app.services import model_wiki as svc

    question = str(body.get("question") or "").strip()[:500]
    if not question:
        raise HTTPException(status_code=422, detail="问题不能为空")
    enforce_generation_rate_limit(user)
    inventory = await svc.local_inventory(pool)
    cards = [c for c in svc.build_cards(inventory, session) if _visible(c, user)]
    result = await svc.ask_model_wiki(question, cards)
    return result


@router.get("/models/health")
async def model_health(
    user: User = Depends(get_current_user),
) -> dict:
    """模型健康检查:核实 worker 模型文件存在性 + LLM 端点连通性。

    返回整体状态、缺失关键模型列表及替代建议。适合管理后台/心跳监控调用。
    """
    report = await generate_health_report()
    return {
        "overall_status": report.overall_status.value,
        "timestamp": report.timestamp,
        "image_models": [
            {
                "name": m.name,
                "status": m.status.value,
                "exists": m.exists,
            }
            for m in report.image_models
        ],
        "text_encoders": [
            {
                "name": m.name,
                "status": m.status.value,
                "exists": m.exists,
            }
            for m in report.text_encoders
        ],
        "vaes": [
            {
                "name": m.name,
                "status": m.status.value,
                "exists": m.exists,
            }
            for m in report.vaes
        ],
        "llm_endpoints": [
            {
                "layer": e.layer,
                "model_id": e.model_id,
                "status": e.status.value,
                "response_time_ms": e.response_time_ms,
                "error": e.error,
            }
            for e in report.llm_endpoints
        ],
        "missing_critical": report.missing_critical,
        "suggestions": report.suggestions,
    }
