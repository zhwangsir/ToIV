"""统一生成工作台引擎注册表 —— GET /api/models/engines 的元信息源。

设计目标(2026-08-03 UI 重构 W1):**接入新引擎 = 注册表加条目,不再开新视图**。
每个引擎声明 id/label/kind/nsfw/description + 轻量 params 参数 schema,前端据此
动态渲染参数区(text/textarea/number/select/switch/images 映射到 ui 基座组件)。

纪律:
- 可用性探测复用 WorkerPool 既有 pick(模型 + 节点校验 + 熔断/缓存),不新造探测链路;
- NSFW 引擎(10Eros 系)标 nsfw=true,响应按请求的 R18 上下文(X-NSFW 头 → ContextVar)
  过滤;select 选项中的 R18 项(如 ltx2 白名单里的 10eros)同样在 SFW 上下文剔除;
- 参数范围/默认值与 routes/generate.py、routes/ltx_studio.py、routes/video.py 的
  请求模型保持一致,改端点约束时须同步此表。
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from app.capabilities import required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.routes.ltx_studio import _LTX2_UNETS
from app.services.h3 import H3_NODE, get_h3_client
from app.services.longcat import LONGCAT_NODE, get_longcat_client
from app.workflows.model_profiles import is_nextgen, is_nsfw
from app.workflows.style_presets import MediaType, list_presets

# probe:async (pool) -> (available, reason|None);None 表示静态可用性(不做 pool 探测)
ProbeFn = Callable[[WorkerPool], Awaitable["tuple[bool, str | None]"]]


# ---------------------------------------------------------------------------
# 探测(复用 WorkerPool 既有 pick / models._pick_live_client 模式,不新造探测链路)
# ---------------------------------------------------------------------------

async def _probe_pool(pool: WorkerPool, models: set[str], nodes: set[str]) -> tuple[bool, str | None]:
    """用 WorkerPool.pick 探测链路可用性;不可用时给出原因(不抛异常拖垮整个端点)。"""
    try:
        await pool.pick(required=models, required_nodes=nodes)
        return True, None
    except ComfyUIError as e:
        return False, str(e)
    except Exception as e:  # 探测自身异常(网络/替身)同样降级为不可用 + 原因
        return False, f"可用性探测失败: {e}"


async def _probe_image(pool: WorkerPool) -> tuple[bool, str | None]:
    """图像链路:任意一台 worker 可达即可(底模由默认/预设解析,缺模型在提交时报 503)。

    pick(空要求)对单 worker 有快速路径不探测,故沿用 routes/models.py
    _pick_live_client 的逐台尝试模式判可达性。
    """
    last: Exception | None = None
    for client in pool.clients:
        try:
            await client.queue_len()
            return True, None
        except Exception as e:
            last = e
    return False, f"所有 worker 都不可达: {last}"


def _probe_ltx2(kind: str) -> ProbeFn:
    """LTX2 工作室链路(t2v/i2v):distilled 默认底模 + gemma + vae + 对应节点集。

    与 routes/ltx_studio.py 的 _submit_ltx2_job 同源(默认 unet=distilled;
    capabilities.required_models("ltx_t2v") 的默认 UNET 是 10Eros,不适用本链路)。
    """

    async def _run(pool: WorkerPool) -> tuple[bool, str | None]:
        s = get_settings()
        return await _probe_pool(
            pool,
            {"ltx-2.3-distilled.safetensors", s.nsfw_default_gemma, s.nsfw_default_vae},
            required_nodes(kind),
        )

    return _run


def _probe_ltx_nsfw(kind: str) -> ProbeFn:
    """NSFW LTX 链路(10Eros 底模,与 routes/video.py 的 /generate/ltx-* 同源)。"""

    async def _run(pool: WorkerPool) -> tuple[bool, str | None]:
        s = get_settings()
        return await _probe_pool(
            pool,
            {s.nsfw_default_video_ckpt, s.nsfw_default_gemma, s.nsfw_default_vae},
            required_nodes(kind),
        )

    return _run


# H3 探测超时:实例挂起时不能拖垮 /api/models/engines 端点
_H3_PROBE_TIMEOUT = 8.0
_LONGCAT_PROBE_TIMEOUT = 8.0


async def _fetch_h3_nodes() -> set[str]:
    """H3 实例 /object_info 节点集(模块级独立函数,便于测试替身)。"""
    return await get_h3_client().node_names()


async def _probe_h3(pool: WorkerPool) -> tuple[bool, str | None]:
    """H3 专用实例探测:/object_info 含 MiniMaxH3 节点即可用;失败给原因,不拖垮端点。

    与 pool 探测不同:H3 走独立实例(TOIV_H3_BASE_URL),pool 参数仅签名占位。
    若 TOIV_H3_ENABLED=false,直接标不可用,避免前端展示不可提交的引擎。
    """
    if not get_settings().h3_enabled:
        return False, "H3 视频生成引擎已禁用(TOIV_H3_ENABLED=false)"
    try:
        nodes = await asyncio.wait_for(_fetch_h3_nodes(), timeout=_H3_PROBE_TIMEOUT)
    except Exception as e:  # 不可达/超时/替身异常一律降级为不可用 + 原因
        return False, f"H3 实例不可达: {e}"
    if H3_NODE not in nodes:
        return False, f"H3 实例缺少 {H3_NODE} 节点(需 ComfyUI ≥ 0.30)"
    return True, None


async def _fetch_longcat_nodes() -> set[str]:
    """LongCat 实例 /object_info 节点集(模块级独立函数,便于测试替身)。"""
    return await get_longcat_client().node_names()


async def _probe_longcat(pool: WorkerPool) -> tuple[bool, str | None]:
    """LongCat 专用实例探测:/object_info 含 WanVideoModelLoader 节点即可用;失败给原因。

    与 pool 探测不同:LongCat 走 GPU2 独立实例(TOIV_LONGCAT_BASE_URL),pool 参数仅签名占位。
    若 TOIV_LONGCAT_ENABLED=false,直接标不可用,避免前端展示不可提交的引擎。
    getattr 兜底:测试替身 settings 缺该字段时按启用处理(probe 绝不能拖垮端点)。
    """
    if not getattr(get_settings(), "longcat_enabled", True):
        return False, "LongCat 视频生成引擎已禁用(TOIV_LONGCAT_ENABLED=false)"
    try:
        nodes = await asyncio.wait_for(_fetch_longcat_nodes(), timeout=_LONGCAT_PROBE_TIMEOUT)
    except Exception as e:  # 不可达/超时/替身异常一律降级为不可用 + 原因
        return False, f"LongCat 实例不可达: {e}"
    if LONGCAT_NODE not in nodes:
        return False, f"LongCat 实例缺少 {LONGCAT_NODE} 节点(需装有 WanVideo 节点包的实例)"
    return True, None


# ACE-Step 文生音乐底模(与 workflows/ace_step.py AceStepParams.ckpt_name 一致)
_ACE_STEP_CKPT = "ace_step_v1_3.5b.safetensors"


async def _probe_ace(pool: WorkerPool) -> tuple[bool, str | None]:
    """ACE-Step 音乐链路:任一 worker 有底模即可(节点为 ComfyUI 内置,不额外校验)。"""
    return await _probe_pool(pool, {_ACE_STEP_CKPT}, set())


# ---------------------------------------------------------------------------
# 参数 schema 构件
# ---------------------------------------------------------------------------

def _num(key: str, label: str, default: float, *, min_: float, max_: float,
         step: float = 1, hint: str | None = None) -> dict:
    d: dict[str, Any] = {
        "key": key, "label": label, "type": "number",
        "min": min_, "max": max_, "step": step, "default": default,
    }
    if hint:
        d["hint"] = hint
    return d


def _seed() -> dict:
    return {
        "key": "seed", "label": "随机种子", "type": "text", "default": "",
        "hint": "留空随机;填整数可复现同一结果",
    }


def _negative() -> dict:
    return {
        "key": "negative", "label": "负向提示词", "type": "textarea", "default": "",
        "hint": "描述不想要的内容,可留空",
    }


def _images(label: str = "参考图", hint: str = "jpg / png / webp,单张 ≤ 20MB") -> dict:
    # max 对 images 类型表示数量上限
    return {"key": "images", "label": label, "type": "images", "max": 1, "default": None, "hint": hint}


def _ref_image_required() -> dict:
    return _images()


# LTX 视频共用数值参数(Ltx2T2VRequest / video.LtxT2VRequest 同一套范围)
def _ltx_video_params() -> list[dict]:
    return [
        _negative(),
        _num("width", "宽度", 768, min_=256, max_=1920, step=8),
        _num("height", "高度", 384, min_=256, max_=1080, step=8),
        _num("length", "时长(帧)", 97, min_=9, max_=241, hint="帧数需满足 8k+1(如 97/121)"),
        _num("fps", "帧率", 16, min_=4, max_=30),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _num("cfg", "CFG", 1.0, min_=0, max_=20, step=0.5, hint="LTX distilled 建议保持 1.0"),
        _seed(),
        {"key": "use_upscale", "label": "高清放大(2 阶段)", "type": "switch", "default": False},
        {"key": "use_rife", "label": "RIFE 补帧", "type": "switch", "default": False},
    ]


# LTX2 工作室底模白名单(与 routes/ltx_studio.py _LTX2_UNETS 同源,附中文标签)
_LTX2_UNET_LABELS = {
    "ltx-2.3-distilled.safetensors": "LTX 2.3 Distilled",
    "ltx-2.3-22b-distilled-1.1.safetensors": "LTX 2.3 22B Distilled 1.1",
    "ltx-2.3-22b-dev.safetensors": "LTX 2.3 22B Dev",
    "10eros_v14.safetensors": "10Eros v14(R18)",
}


def _ltx2_unet_select() -> dict:
    return {
        "key": "unet_name",
        "label": "视频底模",
        "type": "select",
        "default": "ltx-2.3-distilled.safetensors",
        "options": [
            {"value": name, "label": _LTX2_UNET_LABELS.get(name, name), **({"nsfw": True} if nsfw else {})}
            for name, nsfw in _LTX2_UNETS
        ],
    }


def _image_size_params(default: int = 1024) -> list[dict]:
    return [
        _num("width", "宽度", default, min_=64, max_=2048, step=8),
        _num("height", "高度", default, min_=64, max_=2048, step=8),
    ]


# H3 视频参数(与 routes/h3_studio.py 请求模型同一套范围;32 对齐、17k+5 帧网格)
def _h3_video_params() -> list[dict]:
    return [
        _negative(),
        _num("width", "宽度", 1344, min_=256, max_=1344, step=32, hint="32 对齐,上限 1344×768"),
        _num("height", "高度", 768, min_=256, max_=1344, step=32, hint="32 对齐"),
        _num("length", "时长(帧)", 124, min_=22, max_=362,
             hint="17k+5 帧网格 @24fps(124≈5.2s,362≈15s)"),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _seed(),
    ]


# LongCat 视频参数(与 routes/longcat_studio.py 请求模型同一套范围;16 对齐、17-961 帧)
def _longcat_video_params() -> list[dict]:
    return [
        _negative(),
        _num("width", "宽度", 832, min_=320, max_=1280, step=16, hint="16 对齐,非对齐自动向下取整"),
        _num("height", "高度", 480, min_=320, max_=1280, step=16, hint="16 对齐"),
        _num("num_frames", "时长(帧)", 121, min_=17, max_=961,
             hint="长视频引擎,961 帧@16fps≈60s 单镜头"),
        _num("steps", "采样步数", 10, min_=1, max_=50, hint="蒸馏 LoRA 低步数,默认 10 即可"),
        _num("fps", "帧率", 16, min_=8, max_=30, hint="仅影响成片打包帧率"),
        _seed(),
    ]


# ACE-Step 文生音乐参数(与 routes/audio.py AudioRequest 同一套范围)
def _ace_audio_params() -> list[dict]:
    return [
        {"key": "lyrics", "label": "歌词", "type": "textarea", "default": "",
         "hint": "留空=纯音乐;支持 [verse]/[chorus] 结构标签"},
        _num("seconds", "时长(秒)", 30, min_=5, max_=240, step=1),
        _num("steps", "采样步数", 50, min_=10, max_=150),
        _num("cfg", "CFG", 5.0, min_=0, max_=20, step=0.5),
        _seed(),
    ]


def _image_sampling_params() -> list[dict]:
    return [
        _num("steps", "采样步数", 20, min_=1, max_=150),
        _num("cfg", "CFG", 7.0, min_=0, max_=30, step=0.5,
             hint="次世代底模(flux2/qwen_image/z_image)由服务端强制正确采样,此处不生效"),
        _seed(),
    ]


# ---------------------------------------------------------------------------
# 图像引擎动态选项(底模/采样器/调度器):options 运行时来自 worker object_info
# ---------------------------------------------------------------------------
# 与 routes/models.py 的 /api/models 同源逻辑(那里是列表端点,这里是注册表参数
# 注入)。helper 在此复制而非 import,避免 services → routes 反向依赖成环
# (routes/models.py 已 import 本模块的 list_engines)。

def _enum(info: dict, node: str, field: str) -> list[str]:
    req = info.get(node, {}).get("input", {}).get("required", {})
    opts = req.get(field, [[]])
    return opts[0] if opts and isinstance(opts[0], list) else []


# 非图像底模的 checkpoint(音频/3D 等),从图像底模选项中剔除(与 routes/models.py 一致)
_NON_IMAGE_CKPT_HINTS = ("ace_step", "mmaudio", "hunyuan3d")


def _is_image_ckpt(name: str) -> bool:
    low = name.lower()
    return not any(h in low for h in _NON_IMAGE_CKPT_HINTS)


async def _image_form_options(pool: WorkerPool) -> dict[str, list[str]] | None:
    """从第一台可达 worker 的 object_info 派生图像表单选项;全不可达/异常 → None(回退静态)。"""
    client = None
    ckpt_info: dict = {}
    for c in pool.clients:
        try:
            ckpt_info = await c.object_info("CheckpointLoaderSimple")
            client = c
            break
        except Exception:
            continue
    if client is None:
        return None
    try:
        ks_info = await client.object_info("KSampler")
    except Exception:
        ks_info = {}
    try:
        unet_info = await client.object_info("UNETLoader")
    except Exception:
        unet_info = {}
    # 次世代出图族在 diffusion_models(UNETLoader)里,并入图像可选底模并排前
    ckpts = [n for n in _enum(unet_info, "UNETLoader", "unet_name") if is_nextgen(n)]
    ckpts += [c for c in _enum(ckpt_info, "CheckpointLoaderSimple", "ckpt_name") if _is_image_ckpt(c)]
    # 去重保序(同名不同子目录的 basename 重复)
    seen: set[str] = set()
    ckpts = [c for c in ckpts if not (c in seen or seen.add(c))]
    return {
        "ckpts": ckpts,
        "samplers": _enum(ks_info, "KSampler", "sampler_name"),
        "schedulers": _enum(ks_info, "KSampler", "scheduler"),
    }


def _ckpt_select(*, nsfw_only: bool) -> dict:
    """底模选择:options 运行时注入 worker checkpoints(nsfw_only=True 时只注 R18 底模)。

    声明态兜底为「平台默认底模」空值(worker 不可达时注册表仍可响应);
    注入后每项附 nsfw 标,list_engines 在 SFW 上下文统一剔除。
    """
    return {
        "key": "ckpt_name", "label": "底模", "type": "select",
        "default": "",
        "options": [{"value": "", "label": "平台默认底模"}],
        "options_source": "image_ckpt_nsfw" if nsfw_only else "image_ckpt",
        "hint": "「平台默认底模」由后端选全局默认;R18 底模仅 /nsfw 上下文可见",
    }


def _sampler_select() -> dict:
    return {
        "key": "sampler", "label": "采样器", "type": "select",
        "default": "euler",
        "options": [{"value": "euler", "label": "euler"}],
        "options_source": "sampler",
    }


def _scheduler_select() -> dict:
    return {
        "key": "scheduler", "label": "调度器", "type": "select",
        "default": "normal",
        "options": [{"value": "normal", "label": "normal"}],
        "options_source": "scheduler",
    }


def _style_preset_select() -> dict:
    """风格预设(静态清单,与 routes/generate.py 的 style_preset 字段同源)。

    预设指向 R18 底模的项(如 NSFW写真人像)附 nsfw 标,SFW 上下文剔除;
    sfw_intent=True 的预设(底模命中 hints 但定位主站通用风格)不打标、不剔除。
    """
    return {
        "key": "style_preset", "label": "风格预设", "type": "select",
        "default": "",
        "options": [{"value": "", "label": "不使用"}]
        + [
            {"value": p["id"], "label": p["label"],
             **({"nsfw": True} if is_nsfw(p["ckpt_name"]) and not p["sfw_intent"] else {})}
            for p in list_presets(MediaType.IMAGE)
        ],
        "hint": "选择后由后端自动套用底模/采样参数(显式选的底模优先)",
    }


def _inject_dynamic_options(p: dict, dyn: dict[str, list[str]] | None) -> dict:
    """把 options_source 标记的参数注入运行时选项;dyn 为 None(worker 不可达)时保留声明态兜底。"""
    src = p.pop("options_source", None)
    if src is None or dyn is None:
        p.pop("options_source", None)
        return p
    if src == "image_ckpt":
        p["options"] = [{"value": "", "label": "平台默认底模"}] + [
            {"value": n, "label": n, **({"nsfw": True} if is_nsfw(n) else {})}
            for n in dyn["ckpts"]
        ]
        p["default"] = ""
    elif src == "image_ckpt_nsfw":
        opts = [
            {"value": n, "label": n, "nsfw": True}
            for n in dyn["ckpts"] if is_nsfw(n)
        ]
        if opts:
            p["options"] = opts
            # R18 专区图像引擎默认落到第一个 R18 底模(对齐旧 CreateView 行为)
            p["default"] = opts[0]["value"]
        else:
            p["options"] = [{"value": "", "label": "平台默认底模"}]
            p["default"] = ""
    elif src == "sampler":
        if dyn["samplers"]:
            p["options"] = [{"value": s, "label": s} for s in dyn["samplers"]]
            p["default"] = "euler" if "euler" in dyn["samplers"] else dyn["samplers"][0]
    elif src == "scheduler":
        if dyn["schedulers"]:
            p["options"] = [{"value": s, "label": s} for s in dyn["schedulers"]]
            p["default"] = "normal" if "normal" in dyn["schedulers"] else dyn["schedulers"][0]
    return p


def _image_model_params(*, nsfw_only: bool) -> list[dict]:
    """图像引擎共用的模型/采样选择参数(底模/采样器/调度器/风格预设)。"""
    return [
        _ckpt_select(nsfw_only=nsfw_only),
        _sampler_select(),
        _scheduler_select(),
        _style_preset_select(),
    ]


# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------

_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "txt2img",
        "label": "文生图",
        "kind": "image",
        "nsfw": False,
        "description": "ComfyUI 图像工作流,底模/采样器/调度器/风格预设可选;LoRA 标签(<lora:名称:权重> 可直接写进提示词)",
        "params": [
            _negative(),
            *_image_model_params(nsfw_only=False),
            *_image_size_params(),
            *_image_sampling_params(),
            _num("batch_size", "批量张数", 1, min_=1, max_=8),
        ],
        "probe": _probe_image,
    },
    {
        "id": "img2img",
        "label": "图生图",
        "kind": "image",
        "nsfw": False,
        "description": "以上传参考图为底做重绘,denoise 控制偏离程度",
        "params": [
            _ref_image_required(),
            _negative(),
            *_image_model_params(nsfw_only=False),
            _num("denoise", "重绘幅度", 0.6, min_=0.1, max_=1.0, step=0.05,
                 hint="越小越贴近原图"),
            *_image_sampling_params(),
        ],
        "probe": _probe_image,
    },
    # R18 图像引擎(NSFW 专区图像 tab):与 txt2img/img2img 同一提交链路,
    # 底模选项只注入 R18 ckpt(旧 CreateView nsfw 模式的 listModels 行为);
    # 仅 R18 上下文(X-NSFW 头)可见。
    {
        "id": "nsfw-txt2img",
        "label": "文生图(R18)",
        "kind": "image",
        "nsfw": True,
        "description": "R18 底模成人向文生图,仅 /nsfw 上下文可见;LoRA 标签可写进提示词",
        "params": [
            _negative(),
            *_image_model_params(nsfw_only=True),
            *_image_size_params(),
            *_image_sampling_params(),
            _num("batch_size", "批量张数", 1, min_=1, max_=8),
        ],
        "probe": _probe_image,
    },
    {
        "id": "nsfw-img2img",
        "label": "图生图(R18)",
        "kind": "image",
        "nsfw": True,
        "description": "R18 底模成人向图生图,仅 /nsfw 上下文可见",
        "params": [
            _ref_image_required(),
            _negative(),
            *_image_model_params(nsfw_only=True),
            _num("denoise", "重绘幅度", 0.6, min_=0.1, max_=1.0, step=0.05,
                 hint="越小越贴近原图"),
            *_image_sampling_params(),
        ],
        "probe": _probe_image,
    },
    {
        "id": "ltx2-t2v",
        "label": "LTX 2.3 文生视频",
        "kind": "video",
        "nsfw": False,
        "description": "LTX-2.3 工作室:白名单底模可选,distilled 出片快",
        "params": [_ltx2_unet_select(), *_ltx_video_params()],
        "probe": _probe_ltx2("ltx_t2v"),
    },
    {
        "id": "ltx2-i2v",
        "label": "LTX 2.3 图生视频",
        "kind": "video",
        "nsfw": False,
        "description": "LTX-2.3 工作室:参考图首帧 → 短视频",
        "params": [_ltx2_unet_select(), _ref_image_required(), *_ltx_video_params()],
        "probe": _probe_ltx2("ltx_i2v"),
    },
    {
        "id": "ltx-nsfw-t2v",
        "label": "LTX 2.3 文生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "description": "10Eros 底模成人向文生视频,仅 R18 上下文可见",
        "params": _ltx_video_params(),
        "probe": _probe_ltx_nsfw("ltx_t2v"),
    },
    {
        "id": "ltx-nsfw-i2v",
        "label": "LTX 2.3 图生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "description": "10Eros 底模成人向图生视频,仅 R18 上下文可见",
        "params": [_ref_image_required(), *_ltx_video_params()],
        "probe": _probe_ltx_nsfw("ltx_i2v"),
    },
    # MiniMax H3:专用 ComfyUI ≥ 0.30 实例(TOIV_H3_BASE_URL,默认 workstation :8195),
    # 原生 32kHz 音画同发;probe 探测实例 /object_info 是否含 MiniMaxH3 节点
    {
        "id": "h3-t2v",
        "label": "MiniMax H3 文生视频",
        "kind": "video",
        "nsfw": False,
        "description": "MiniMax H3 新一代视频管线:原生 32kHz 音画同发,专用实例 :8195",
        "params": _h3_video_params(),
        "probe": _probe_h3,
    },
    {
        "id": "h3-i2v",
        "label": "MiniMax H3 图生视频",
        "kind": "video",
        "nsfw": False,
        "description": "MiniMax H3:参考图首帧 → 音画同发短视频,剧情连续性好",
        "params": [_ref_image_required(), *_h3_video_params()],
        "probe": _probe_h3,
    },
    # LongCat-Video:专用 ComfyUI 实例(TOIV_LONGCAT_BASE_URL,默认 workstation GPU2 :8197),
    # 长镜头引擎(961 帧@16fps≈60s);probe 探测实例 /object_info 是否含 WanVideo 节点
    {
        "id": "longcat-t2v",
        "label": "LongCat 文生视频",
        "kind": "video",
        "nsfw": False,
        "description": "LongCat-Video 长视频引擎:蒸馏 LoRA 低步数出片,专用实例 :8197",
        "params": _longcat_video_params(),
        "probe": _probe_longcat,
    },
    {
        "id": "longcat-i2v",
        "label": "LongCat 图生视频",
        "kind": "video",
        "nsfw": False,
        "description": "LongCat-Video 长视频引擎:首帧参考图 → 长镜头,专用实例 :8197",
        "params": [_ref_image_required(), *_longcat_video_params()],
        "probe": _probe_longcat,
    },
    {
        "id": "longcat-continue",
        "label": "LongCat 视频续写",
        "kind": "video",
        "nsfw": False,
        "description": "LongCat-Video:取已有视频末帧续写下一段长镜头(API 缺省宽高/帧率时自动向源视频实测值对齐)",
        "params": [
            {"key": "video", "label": "源视频", "type": "text", "default": "",
             "hint": "/api/images?... 产物 URL(如上一段 LongCat 产物链接)"},
            *_longcat_video_params(),
        ],
        "probe": _probe_longcat,
    },
    # ACE-Step 文生音乐:kind=audio(音频板块生成区;提交路由 /api/generate/audio 既有)
    {
        "id": "ace-music",
        "label": "ACE 文生音乐",
        "kind": "audio",
        "nsfw": False,
        "description": "ACE-Step 1.5:风格标签 + 歌词 → MP3(≤240s);提示词可经 AI 优化为音乐标签",
        "params": _ace_audio_params(),
        "probe": _probe_ace,
    },
]


async def list_engines(pool: WorkerPool, user: User | None = None) -> list[dict[str, Any]]:
    """返回引擎数组(按请求的 R18 上下文过滤 nsfw 引擎与 nsfw 选项)。

    每项:{ id, label, kind, available, unavailable_reason?, nsfw, description?, params }
    params 元素:{ key, label, type, options?, min?, max?, step?, default, hint? }
    """
    r18 = nsfw_allowed(user)
    # 动态选项(底模/采样器/调度器)惰性拉取:仅当引擎声明了 options_source 且
    # 本次响应包含图像引擎时才访问 worker object_info,全失败回退声明态兜底。
    dyn: dict[str, list[str]] | None = None
    dyn_fetched = False
    engines: list[dict[str, Any]] = []
    for spec in _REGISTRY:
        if spec["nsfw"] and not r18:
            continue
        # 参数 schema:SFW 上下文剔除 nsfw 选项(如 ltx2 白名单里的 10eros)
        params: list[dict] = []
        for p in spec["params"]:
            p = dict(p)
            if p.get("options_source"):
                if not dyn_fetched:
                    dyn_fetched = True
                    dyn = await _image_form_options(pool)
                p = _inject_dynamic_options(p, dyn)
            if p.get("options"):
                p["options"] = [o for o in p["options"] if r18 or not o.get("nsfw")]
            params.append(p)

        entry: dict[str, Any] = {
            "id": spec["id"],
            "label": spec["label"],
            "kind": spec["kind"],
            "nsfw": spec["nsfw"],
            "description": spec["description"],
            "params": params,
        }

        probe = spec.get("probe")
        if probe is None:
            available = bool(spec.get("static_available", False))
            reason = spec.get("static_reason")
        else:
            available, reason = await probe(pool)
        entry["available"] = available
        if not available and reason:
            entry["unavailable_reason"] = reason
        engines.append(entry)
    return engines
