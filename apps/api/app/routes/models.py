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
from app.deps import get_current_user, get_pool
from app.models import User
from app.workflows.ace_step import AceStepParams
from app.workflows.hunyuan3d import Hunyuan3DParams
from app.workflows.model_profiles import is_nsfw, is_vpred
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
        {"name": n, "nsfw": is_nsfw(n), "vpred": is_vpred(n)} for n in names
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


def _video_models() -> list[str]:
    """视频模式实际加载的 diffusion_models(Wan 双噪声 UNET);只读展示。"""
    p = WanT2VParams(positive="")
    return [p.high_unet, p.low_unet]


def _sfw_only(names: list[str]) -> list[str]:
    """剔除文件名命中 NSFW 判定的项(用户未开 R18 时服务端强制过滤)。"""
    return [n for n in names if not is_nsfw(n)]


@router.get("/models")
async def list_models(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
):
    client = pool.clients[0]
    try:
        ckpt_info = await client.object_info("CheckpointLoaderSimple")
        ks_info = await client.object_info("KSampler")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    all_ckpts = _enum(ckpt_info, "CheckpointLoaderSimple", "ckpt_name")
    image_ckpts = _image_checkpoints(all_ckpts)

    # R18 软门槛:用户未开时服务端强制剔除成人底模(真过滤,不只前端隐藏)。
    if not user.nsfw_enabled:
        image_ckpts = _sfw_only(image_ckpts)

    # 给图像底模附 nsfw/vpred 分类标(不过滤);并抽出便捷名单供前端筛选。
    image_tagged = _tagged(image_ckpts)
    # 未开 R18 时已剔除 nsfw 底模,nsfw_models 必为 []。
    nsfw_models = [it["name"] for it in image_tagged if it["nsfw"]]
    vpred_models = [it["name"] for it in image_tagged if it["vpred"]]

    # 模式 → {models, editable}。editable=False 表示后端硬编码单/双模型,前端只读展示。
    # image.checkpoints 附带每个底模的 {name,nsfw,vpred} 标(仅图像模式有分类意义)。
    modes = {
        "image": {"models": image_ckpts, "checkpoints": image_tagged, "editable": True},
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
    client = pool.clients[0]
    out: dict[str, object] = {}
    for key, node, field in _LOCAL_SPECS:
        try:
            out[key] = _enum(await client.object_info(node), node, field)
        except ComfyUIError:
            out[key] = []
    # R18 软门槛:用户未开时服务端强制剔除成人底模与成人 LoRA(按文件名 is_nsfw)。
    if not user.nsfw_enabled:
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
