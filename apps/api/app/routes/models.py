"""GET /api/models —— 从 ComfyUI object_info 派生前端下拉项（不硬编码）。

模式感知:不同创作模式用不同模型源,前端按当前 mode 显示对应类别。
- 图像 → CheckpointLoaderSimple 的图像底模(剔除音频/3D 等非图像 checkpoint)
- 视频 → 平台 Wan 工作流实际用的 diffusion_models(双模型管线,只读)
- 3D   → Hunyuan3D ckpt(硬编码,只读)
- 音频 → ACE-Step ckpt(硬编码,只读)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.deps import get_current_user, get_pool
from app.models import User
from app.nsfw_ctx import nsfw_allowed
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
    """
    return [n for n in unet_names if is_nextgen(n)]


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
# 用户手动下载后放到 NAS。分类:realistic(写实)/ anime(动漫)/ flux(FLUX 系)/ lora(配套 LoRA)。

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
        "name": "zImage Turbo",
        "type": "unet",
        "base": "LTX2.3",
        "size": "9GB",
        "civitai_url": "https://civitai.red/models/2221503/zimage-turbo-by-stable-yogi",
        "desc": "Stable Yogi 的 LTX2.3 Turbo 视频底模,可通过环境变量切换",
        "category": "video",
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
