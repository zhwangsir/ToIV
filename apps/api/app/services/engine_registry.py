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

from collections.abc import Awaitable, Callable
from typing import Any

from app.capabilities import required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.routes.ltx_studio import _LTX2_UNETS

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


def _image_sampling_params() -> list[dict]:
    return [
        _num("steps", "采样步数", 20, min_=1, max_=150),
        _num("cfg", "CFG", 7.0, min_=0, max_=30, step=0.5,
             hint="次世代底模(flux2/qwen_image/z_image)由服务端强制正确采样,此处不生效"),
        _seed(),
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
        "description": "ComfyUI 图像工作流,默认底模 + 风格预设/LoRA 标签(<lora:名称:权重> 可直接写进提示词)",
        "params": [
            _negative(),
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
    # H3 预留:权重已就绪于 NAS h3/(fl2va int8 + qwen3vl-32b TE),但需 ComfyUI ≥ 0.30
    # 才支持该管线;升级完成后把 probe 换成本链路的模型/节点校验即可接入(见
    # docs/2026-08-03-minimax-h3-eval.md)。此条目用于验证「接入新引擎 = 注册表加条目」。
    {
        "id": "h3",
        "label": "MiniMax H3 文生视频",
        "kind": "video",
        "nsfw": False,
        "description": "MiniMax H3 新一代视频管线,评测已通过,待 ComfyUI 0.30 接入",
        "params": [
            _negative(),
            _num("width", "宽度", 768, min_=256, max_=1920, step=8),
            _num("height", "高度", 384, min_=256, max_=1080, step=8),
            _num("length", "时长(帧)", 97, min_=9, max_=241),
            _seed(),
        ],
        "probe": None,
        "static_available": False,
        "static_reason": "ComfyUI 升级 0.30 后可用(权重已就绪于 NAS h3/)",
    },
]


async def list_engines(pool: WorkerPool, user: User | None = None) -> list[dict[str, Any]]:
    """返回引擎数组(按请求的 R18 上下文过滤 nsfw 引擎与 nsfw 选项)。

    每项:{ id, label, kind, available, unavailable_reason?, nsfw, description?, params }
    params 元素:{ key, label, type, options?, min?, max?, step?, default, hint? }
    """
    r18 = nsfw_allowed(user)
    engines: list[dict[str, Any]] = []
    for spec in _REGISTRY:
        if spec["nsfw"] and not r18:
            continue
        # 参数 schema:SFW 上下文剔除 nsfw 选项(如 ltx2 白名单里的 10eros)
        params: list[dict] = []
        for p in spec["params"]:
            p = dict(p)
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
