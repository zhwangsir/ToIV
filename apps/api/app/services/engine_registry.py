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
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.capabilities import required_models, required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.workflows.model_profiles import AR_IMAGE, AR_VIDEO
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.services.h3 import H3_NODE, get_h3_client, is_h3_nsfw_lora
from app.services.longcat import LONGCAT_NODE, get_longcat_client
from app.services.qwen_edit import QWEN_EDIT_NODE, get_qwen_edit_client
from app.workflows.qwen_edit import CAMERA_PRESETS, QWEN_EDIT_UNET
from app.workflows.model_profiles import is_image_ckpt, is_nextgen, is_nsfw
from app.workflows.model_wiki import card_for
from app.workflows.style_presets import MediaType, list_presets
from app.workflows.wan_i2v import WAN_I2V_NSFW_LORAS

# probe:async (pool) -> (available, reason|None);None 表示静态可用性(不做 pool 探测)
ProbeFn = Callable[[WorkerPool], Awaitable["tuple[bool, str | None]"]]

# 引擎可用性短 TTL 缓存:可用性取决于 worker 状态,与请求用户无关,可跨请求共享。
# /api/models/engines 是工作台首屏必调接口,QA-FULL-2026-08-11 实测串行探测
# 0.55-3.37s 波动;并行 gather + 8s TTL 缓存后命中时零探测开销。
_AVAIL_TTL = 8.0
_avail_cache: dict[str, tuple[bool, str | None]] = {}
_avail_cache_at: float = 0.0


def _mark_avail_probed() -> None:
    global _avail_cache_at
    _avail_cache_at = time.monotonic()


def reset_avail_cache() -> None:
    """清空可用性缓存(测试隔离 / 运维即时刷新用)。"""
    _avail_cache.clear()
    global _avail_cache_at
    _avail_cache_at = 0.0


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


async def _fetch_h3_loras() -> list[str] | None:
    """H3 实例 LoraLoaderModelOnly 的 lora_name 枚举(模块级独立函数,便于测试替身)。

    不可达/缺节点 → None:注册表回退声明态空 options,绝不拖垮 /api/models/engines。
    """
    try:
        info = await asyncio.wait_for(
            get_h3_client().object_info("LoraLoaderModelOnly"), timeout=_H3_PROBE_TIMEOUT
        )
    except Exception:
        return None
    return _enum(info, "LoraLoaderModelOnly", "lora_name")


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


# Wan2.2-Animate / Wan2.1-VACE 与 LongCat 同实例(:8197);在 longcat 探测基础上
# 追加引擎关键节点检查(缺节点 = wrapper 版本过旧,标不可用并给原因)
WAN_ANIMATE_NODE = "WanVideoAnimateEmbeds"
WAN_VACE_NODE = "WanVideoVACEEncode"


async def _probe_wan_node(pool: WorkerPool, node: str, label: str) -> tuple[bool, str | None]:
    ok, reason = await _probe_longcat(pool)
    if not ok:
        return ok, reason
    try:
        nodes = await asyncio.wait_for(_fetch_longcat_nodes(), timeout=_LONGCAT_PROBE_TIMEOUT)
    except Exception as e:
        return False, f"{label} 实例不可达: {e}"
    if node not in nodes:
        return False, f"{label} 实例缺少 {node} 节点(需升级 WanVideoWrapper 节点包)"
    return True, None


async def _probe_wan_animate(pool: WorkerPool) -> tuple[bool, str | None]:
    return await _probe_wan_node(pool, WAN_ANIMATE_NODE, "Wan-Animate")


async def _probe_wan_vace(pool: WorkerPool) -> tuple[bool, str | None]:
    return await _probe_wan_node(pool, WAN_VACE_NODE, "Wan-VACE")


# Qwen-Image-Edit 探测超时:实例挂起时不能拖垮 /api/models/engines 端点
_QWEN_EDIT_PROBE_TIMEOUT = 8.0


async def _fetch_qwen_edit_meta() -> tuple[set[str], set[str]]:
    """Qwen-Image-Edit 实例 (节点集, 模型名集)(模块级独立函数,便于测试替身)。"""
    client = get_qwen_edit_client()
    return await client.node_names(), await client.model_names()


async def _probe_qwen_edit(pool: WorkerPool) -> tuple[bool, str | None]:
    """Qwen-Image-Edit 专用实例探测:含 TextEncodeQwenImageEdit 节点 + 编辑 UNET 在枚举即可用。

    与 pool 探测不同:走 pc02 独立实例(TOIV_QWEN_EDIT_BASE_URL),pool 参数仅签名占位。
    """
    try:
        nodes, models = await asyncio.wait_for(
            _fetch_qwen_edit_meta(), timeout=_QWEN_EDIT_PROBE_TIMEOUT
        )
    except Exception as e:  # 不可达/超时/替身异常一律降级为不可用 + 原因
        return False, f"Qwen-Image-Edit 实例不可达: {e}"
    if QWEN_EDIT_NODE not in nodes:
        return False, f"Qwen-Image-Edit 实例缺少 {QWEN_EDIT_NODE} 节点"
    if QWEN_EDIT_UNET not in models:
        return False, f"Qwen-Image-Edit 实例缺少编辑 UNET {QWEN_EDIT_UNET}"
    return True, None


# Qwen-Image-Edit 相机角度下拉标签(指令原文见 workflows/qwen_edit.CAMERA_PRESETS)
_QWEN_EDIT_CAMERA_LABELS: dict[str, str] = {
    "forward": "镜头前移",
    "left": "镜头左移",
    "right": "镜头右移",
    "up": "镜头上移",
    "down": "镜头下移",
    "rotate_left": "向左旋转 45°",
    "rotate_right": "向右旋转 45°",
    "top_down": "俯视",
    "wide": "广角",
    "closeup": "特写",
}


# Qwen-Image-Edit 参数(与 routes/generate.py QwenEditRequest 同一套约束)
def _qwen_edit_params() -> list[dict]:
    return [
        _ref_image_required(),
        {
            "key": "camera", "label": "相机角度", "type": "select", "default": "",
            "options": [{"value": "", "label": "无(仅语义编辑)"}]
            + [{"value": k, "label": _QWEN_EDIT_CAMERA_LABELS.get(k, k)} for k in CAMERA_PRESETS],
            "hint": "多角度相机控制 LoRA;选择后自动把运镜指令拼进提示词",
        },
        {"key": "fast", "label": "快速档(Lightning 8 步)", "type": "switch", "default": True,
         "hint": "关闭走 20 步标准档,质量更高但慢约 2.5 倍"},
        _seed(),
    ]


# ACE-Step 文生音乐底模(与 workflows/ace_step.py AceStepParams.ckpt_name 一致)
_ACE_STEP_CKPT = "ace_step_v1_3.5b.safetensors"


async def _probe_ace(pool: WorkerPool) -> tuple[bool, str | None]:
    """ACE-Step 音乐链路:任一 worker 有底模即可(节点为 ComfyUI 内置,不额外校验)。"""
    return await _probe_pool(pool, {_ACE_STEP_CKPT}, set())


async def _probe_wan_i2v(pool: WorkerPool) -> tuple[bool, str | None]:
    """Wan2.2 I2V NSFW 链路(pool worker):底模/加速 LoRA/节点链 + 6 个 Civitai 配方 LoRA 全量校验。

    配方 LoRA 缺失直接标不可用并透出缺哪个(比生成期 ComfyUI 400 更易定位);
    与 routes/video.py 的 /generate/video 同一能力要求(capabilities kind="video")。
    """
    models = required_models("video") | set(WAN_I2V_NSFW_LORAS)
    return await _probe_pool(pool, models, required_nodes("video"))


# ---------------------------------------------------------------------------
# 参数 schema 构件
# ---------------------------------------------------------------------------

def _num(key: str, label: str, default: float, *, min_: float, max_: float,
         step: float = 1, hint: str | None = None, ar: tuple[float, float] | None = None) -> dict:
    d: dict[str, Any] = {
        "key": key, "label": label, "type": "number",
        "min": min_, "max": max_, "step": step, "default": default,
    }
    if hint:
        d["hint"] = hint
    if ar is not None:
        # 宽高比(w/h)安全域:仅挂在 width 参数上,前端据此做宽高联动纠正
        d["ar"] = [ar[0], ar[1]]
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


def _audio(label: str = "驱动音频", hint: str = "wav / mp3 / m4a / ogg / flac,单个 ≤ 20MB") -> dict:
    return {"key": "audio", "label": label, "type": "audio", "max": 1, "default": None, "hint": hint}


# RES-2026-08-18:输出分辨率档(融合超分)。所有视频生成引擎统一后处理选项:
# 原生直出(默认)或 720p→4K 二次超分(生成完成后自动经超分集群帧级放大,
# 后端 maybe_chain_upscale 挂链,前端结果卡显示「超分中」)。与
# workflows/video_upscale.TARGET_CHOICES 同源;值透传到路由 resolution_target。
def _resolution_target_select() -> dict:
    return {
        "key": "resolution_target", "label": "输出分辨率", "type": "select", "default": "",
        "options": [
            {"value": "", "label": "原生直出(不超分)"},
            {"value": "720p", "label": "720P (1280×720,二次超分)"},
            {"value": "1080p", "label": "1080P (1920×1080,二次超分)"},
            {"value": "2k", "label": "2K (2560×1440,二次超分)"},
            {"value": "4k", "label": "4K (3840×2160,二次超分)"},
        ],
        "hint": "选档后先按引擎原生上限生成,完成后自动二次超分至目标分辨率(横竖随源画幅)",
    }


# R18 LTX 视频参数:分辨率/时长改预设下拉(8 对齐 + 秒数由提交层经统一策略层解析),
# 其余(步数/CFG/种子/高清放大/RIFE 补帧)与 SFW 链路一致。
_LTX_NSFW_RESOLUTIONS = [
    ("864x480", "480p 横版 (864×480)"),
    ("1280x720", "720p 横版 (1280×720)"),
    ("1920x1080", "1080p 横版 (1920×1080)"),
    ("480x864", "480p 竖版 (480×864)"),
    ("720x1280", "720p 竖版 (720×1280)"),
]

_LTX_NSFW_DURATIONS = [
    ("4", "4 秒"),
    ("6", "6 秒"),
    ("8", "8 秒"),
    ("10", "10 秒"),
    ("15", "15 秒"),
]


def _ltx_nsfw_video_params() -> list[dict]:
    return [
        _negative(),
        {
            "key": "resolution", "label": "分辨率", "type": "select", "default": "1280x720",
            "options": [{"value": v, "label": label} for v, label in _LTX_NSFW_RESOLUTIONS],
        },
        {
            "key": "duration", "label": "时长", "type": "select", "default": "6",
            "options": [{"value": v, "label": label} for v, label in _LTX_NSFW_DURATIONS],
            "hint": "实际帧数按帧率换算并吸附 8k+1 网格,秒差大时生成后精确裁切",
        },
        _num("fps", "帧率", 16, min_=4, max_=30),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _num("cfg", "CFG", 1.0, min_=0, max_=20, step=0.5, hint="LTX distilled 建议保持 1.0"),
        _seed(),
        {"key": "use_upscale", "label": "高清放大(2 阶段)", "type": "switch", "default": False},
        {"key": "use_rife", "label": "RIFE 补帧", "type": "switch", "default": False},
        _resolution_target_select(),
    ]


def _image_size_params(default: int = 1024) -> list[dict]:
    return [
        _num("width", "宽度", default, min_=64, max_=2048, step=8,
             hint="比例限 1:2~2:1,超出自动纠正", ar=AR_IMAGE),
        _num("height", "高度", default, min_=64, max_=2048, step=8),
    ]


# H3 视频参数(与 routes/h3_studio.py 请求模型同一套范围;32 对齐、时长按秒,
# 内部 17k+5 网格 @24fps,超 15s 单段上限自动分段续写并精确裁切)
def _h3_video_params() -> list[dict]:
    return [
        _negative(),
        _num("width", "宽度", 1344, min_=256, max_=1344, step=32,
             hint="32 对齐,上限 1344×768;比例限 9:16~16:9", ar=AR_VIDEO),
        _num("height", "高度", 768, min_=256, max_=1344, step=32, hint="32 对齐"),
        _num("duration", "时长(秒)", 5, min_=0.5, max_=60, step=0.5,
             hint="支持任意时长;超 15s 单段上限自动分段续写并精确裁切"),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _seed(),
        _h3_loras_select(),
        _resolution_target_select(),
    ]


# R18 H3 视频参数:分辨率/时长改预设下拉(32 对齐 + 秒数由提交层经统一策略层解析),
# 其余(步数/种子/LoRA)与 SFW H3 链路一致;固定 24fps,无 cfg(H3 模板内锁定)。
# 注意 720 非 32 对齐,720p 档用 1280×736 / 736×1280 替代。
_H3_NSFW_RESOLUTIONS = [
    ("832x480", "480p 横版 (832×480)"),
    ("1280x736", "720p 横版 (1280×736)"),
    ("1344x768", "768p 横版 (1344×768)"),
    ("480x832", "480p 竖版 (480×832)"),
    ("736x1280", "720p 竖版 (736×1280)"),
    ("768x1344", "768p 竖版 (768×1344)"),
]

# 固定 24fps;非网格时长自动吸附 17k+5 网格后精确裁切
_H3_NSFW_DURATIONS = [
    ("4", "4 秒"),
    ("6", "6 秒"),
    ("8", "8 秒"),
    ("10", "10 秒"),
    ("15", "15 秒"),
]


def _h3_nsfw_video_params() -> list[dict]:
    return [
        _negative(),
        {
            "key": "resolution", "label": "分辨率", "type": "select", "default": "1280x736",
            "options": [{"value": v, "label": label} for v, label in _H3_NSFW_RESOLUTIONS],
        },
        {
            "key": "duration", "label": "时长", "type": "select", "default": "6",
            "options": [{"value": v, "label": label} for v, label in _H3_NSFW_DURATIONS],
            "hint": "H3 固定 24fps;非网格时长自动吸附 17k+5 网格后精确裁切",
        },
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _seed(),
        _h3_loras_select(),
        _resolution_target_select(),
    ]


def _h3_loras_select() -> dict:
    """H3 LoRA 叠加(多选 + 单项强度):options 运行时来自 H3 实例 LoraLoaderModelOnly 枚举。

    声明态兜底为空 options(实例不可达时注册表仍可响应,前端仅显示「无 LoRA 可选」);
    已知 R18 LoRA(services/h3.H3_NSFW_LORAS)注入时打 nsfw 标,SFW 上下文统一剔除。
    min/max/step 为强度滑杆范围(与 routes/h3_studio.H3LoraInput 同一约束)。
    """
    return {
        "key": "loras", "label": "LoRA 叠加", "type": "loras",
        "default": [],
        "options": [],
        "options_source": "h3_loras",
        "min": 0.5, "max": 1.0, "step": 0.05,
        "hint": "可选,最多 3 个;推荐强度 0.5-1.0(默认 0.6);R18 LoRA 仅 /nsfw 专区可选",
    }


# ── Wan2.2 I2V NSFW(2026-08-17 Civitai 爆款配方复刻)──
# 分辨率预设:Wan 训练甜点 832×480 + kenpechi 720p 档 1280×704(请求模型钳位上限 1280)
_WAN_NSFW_RESOLUTIONS = [
    ("832x480", "480p 横版 (832×480)"),
    ("480x832", "480p 竖版 (480×832)"),
    ("1280x704", "720p 横版 (1280×704,kenpechi 档)"),
    ("704x1280", "720p 竖版 (704×1280,kenpechi 档)"),
]

# 时长预设:fps 固定 16(Wan 甜点帧率),帧数须 4n+1 且 ≤121(单段上限)
# 3s→49 帧 / 5s→81 帧 / 7.5s→121 帧,更长走作品库末帧续写
_WAN_NSFW_DURATIONS = [
    ("3", "3 秒 (49 帧)"),
    ("5", "5 秒 (81 帧)"),
    ("7.5", "7.5 秒 (121 帧,单段上限)"),
]

# LoRA 选项标签:文件名 → (中文标签,含触发词);值集合须与 WAN_I2V_NSFW_LORAS 一致
_WAN_NSFW_LORA_LABELS: dict[str, str] = {
    "NSFW-22-H-e8.safetensors": "通用 NSFW 概念·HIGH(触发词 nsfwsks)",
    "wan22-m4crom4sti4-i2v-20epoc-high-k3nk.safetensors": "胸部物理·HIGH(m4crom4sti4)",
    "WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors": "POV 体精/拔出·HIGH(b0dyshot)",
    "Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors": "加速 v1030·HIGH(替代默认加速,4 步档)",
    "DR34ML4Y_I2V_14B_LOW_V2.safetensors": "体位五件套·LOW(m15510n4ry/bl0wj0b/d0gg1e/c0wg1rl/d0ubl3_bj)",
    "56Low-noise-Cumshot-Aesthetics.safetensors": "体液美学(动漫)·LOW",
}


def _wan_nsfw_loras_select() -> dict:
    """Wan2.2 NSFW LoRA 叠加(多选 + 单项强度):静态策划清单(只露配方内 6 个,不暴露整目录)。

    与 H3 不同:Wan 配方是固定逆向结果,文件名/侧别/默认强度由后端注册表
    WAN_I2V_NSFW_LORAS 判定;前端只传 name+strength,侧别用户无感。
    min/max/step 为强度滑杆范围(甜点位 0.6-0.8,与 routes/video.WanLoraInput 约束兼容)。
    """
    return {
        "key": "loras", "label": "NSFW LoRA 叠加", "type": "loras",
        "default": [],
        "options": [
            {"value": name, "label": _WAN_NSFW_LORA_LABELS.get(name, name), "nsfw": True}
            for name in WAN_I2V_NSFW_LORAS
        ],
        "min": 0.3, "max": 1.2, "step": 0.05,
        "hint": "HIGH 侧管构图/动作,LOW 侧管细节/质感;触发词须写进提示词句首,推荐强度 0.6-0.8,最多 4 个",
    }


def _wan_nsfw_i2v_params() -> list[dict]:
    """Wan2.2 I2V NSFW 参数(与 routes/video.py WanI2VRequest 同一套范围;
    时长按秒,前端换算 4n+1 帧;fps 固定 16 不外露)。"""
    return [
        _negative(),
        {
            "key": "resolution", "label": "分辨率", "type": "select", "default": "832x480",
            "options": [{"value": v, "label": label} for v, label in _WAN_NSFW_RESOLUTIONS],
        },
        {
            "key": "duration", "label": "时长", "type": "select", "default": "5",
            "options": [{"value": v, "label": label} for v, label in _WAN_NSFW_DURATIONS],
            "hint": "固定 16fps;单段上限 121 帧(7.5s),更长用作品库末帧续写",
        },
        {"key": "full_quality", "label": "满血档(成片)", "type": "switch", "default": False,
         "hint": "不挂加速 LoRA,20 步 + cfg 3.5/3.0;质量更高但慢约 4 倍"},
        _seed(),
        _wan_nsfw_loras_select(),
        _resolution_target_select(),
    ]


# LongCat 视频参数(与 routes/longcat_studio.py 请求模型同一套范围;16 对齐、时长按秒,
# 内部 17-961 帧无网格,>241 帧自动上下文窗口;超单段上限由统一策略层报 422)
def _longcat_video_params() -> list[dict]:
    return [
        _negative(),
        _num("width", "宽度", 832, min_=320, max_=1280, step=16,
             hint="16 对齐;比例限 9:16~16:9,超出自动纠正", ar=AR_VIDEO),
        _num("height", "高度", 480, min_=320, max_=1280, step=16, hint="16 对齐"),
        _num("duration", "时长(秒)", 7.5, min_=0.5, max_=60, step=0.5,
             hint="长视频引擎,单镜头上限 961 帧(16fps≈60s);>15s 自动启用上下文窗口分段采样"),
        _num("steps", "采样步数", 10, min_=1, max_=50, hint="蒸馏 LoRA 低步数,默认 10 即可"),
        _num("fps", "帧率", 16, min_=8, max_=30, hint="仅影响成片打包帧率"),
        _seed(),
        _resolution_target_select(),
    ]


# LongCat-Avatar 数字人参数(与 routes/avatar_studio.py 请求模型同一套范围;
# 16 对齐、时长按秒(内部 17-2500 帧,4k+1 网格;>93 帧自动续段),
# fps 默认 25 与 WhisperEmbeds 特征帧率同源)
def _avatar_talk_params() -> list[dict]:
    return [
        _images(label="人像首帧", hint="jpg / png,单张 ≤ 20MB"),
        {"key": "audio", "label": "驱动音频", "type": "text", "default": "",
         "hint": "wav / mp3,经 /api/upload 上传(kind=avatar,≤20MB)"},
        _negative(),
        _num("width", "宽度", 480, min_=320, max_=1280, step=16,
             hint="16 对齐;比例限 9:16~16:9,超出自动纠正", ar=AR_VIDEO),
        _num("height", "高度", 832, min_=320, max_=1280, step=16, hint="16 对齐"),
        _num("duration", "时长(秒)", 3.7, min_=0.5, max_=100, step=0.1,
             hint="默认 25fps;>3.7s 自动按 93 帧窗口续段,上限 2500 帧(25fps≈100s)"),
        _num("fps", "帧率", 25, min_=8, max_=30, hint="Whisper 特征帧率与打包帧率同源"),
        _num("steps", "采样步数", 12, min_=1, max_=50, hint="dmd 蒸馏 LoRA 低步数,默认 12"),
        _seed(),
    ]


# Wan2.2-Animate 动作迁移参数(与 routes/wan_studio.py WanAnimateRequest 同一套范围;
# 时长按秒,内部 4k+1 网格吸附,秒差大时生成后精确裁切)
def _wan_animate_params() -> list[dict]:
    return [
        _ref_image_required(),
        {"key": "video", "label": "驱动视频", "type": "video", "default": None,
         "hint": "mp4 / webm / mov,≤200MB;动作来源(与参考图同 worker 互钉)"},
        _negative(),
        _num("width", "宽度", 832, min_=320, max_=1280, step=16,
             hint="16 对齐;比例限 9:16~16:9,超出自动纠正", ar=AR_VIDEO),
        _num("height", "高度", 480, min_=320, max_=1280, step=16, hint="16 对齐"),
        _num("duration", "时长(秒)", 7.5, min_=0.5, max_=31, step=0.5,
             hint="上限 501 帧(16fps≈31s);驱动视频截断到该时长,非网格时长生成后精确裁切"),
        _num("steps", "采样步数", 6, min_=1, max_=50, hint="官方示例 6 步(dpm++_sde)"),
        _num("fps", "帧率", 16, min_=8, max_=30, hint="与驱动视频重采样/打包帧率同源"),
        _seed(),
    ]


# Wan2.1-VACE 多参考图参数(与 routes/wan_studio.py WanVaceRequest 同一套范围;
# 时长按秒,内部 4k+1 网格吸附,秒差大时生成后精确裁切)
def _wan_vace_params() -> list[dict]:
    return [
        {"key": "images", "label": "参考图(1-4 张)", "type": "images", "max": 4,
         "default": None, "hint": "角色/物体/场景参考,jpg / png / webp,单张 ≤ 20MB"},
        _negative(),
        _num("width", "宽度", 832, min_=320, max_=1280, step=16,
             hint="16 对齐;比例限 9:16~16:9,超出自动纠正", ar=AR_VIDEO),
        _num("height", "高度", 480, min_=320, max_=1280, step=16, hint="16 对齐"),
        _num("duration", "时长(秒)", 5, min_=0.5, max_=15, step=0.5,
             hint="上限 241 帧(16fps≈15s);非网格时长生成后精确裁切"),
        _num("steps", "采样步数", 20, min_=1, max_=50, hint="官方示例 20 步(unipc)"),
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


# 编辑专用 DiT(qwen_image_edit_2509/2511):纯图像编辑模型,无参考图走文生图必败,
# 不掺进文生图/图生图底模下拉(编辑走 qwen-image-edit 引擎的专用实例与固定图)。
_EDIT_ONLY_UNET_HINTS = ("qwen_image_edit",)


def _is_image_ckpt(name: str) -> bool:
    # 唯一事实源在 workflows/model_profiles(与 routes/models.py 同一份剔除清单)
    return is_image_ckpt(name)


# 组件分片/子文件:diffusion_models 下按目录拆放的 HF 组件(text_encoder/transformer/vae 等)
# 与 HF 分片命名(model-0000X-of-0000Y / diffusion_pytorch_model-*.safetensors)。
# 它们随 is_nextgen 文件名子串(如 Qwen-Image/…)混入图像底模下拉,选中即报错,必须剔除。
_COMPONENT_DIR_HINTS = ("/text_encoder/", "/transformer/", "/vae/", "/clip/", "/audio_encoders/")
_SHARD_NAME_HINTS = ("diffusion_pytorch_model", "-of-")  # model-00001-of-00004 等分片命名


def _is_component_shard(name: str) -> bool:
    low = name.lower()
    if "/" in low and any(h in low for h in _COMPONENT_DIR_HINTS):
        return True
    base = low.rsplit("/", 1)[-1]
    if base.startswith("diffusion_pytorch_model"):
        return True
    # HF 分片:model-00001-of-00004.safetensors 形态
    if "-of-" in base and base.startswith("model-"):
        return True
    return False


def _is_nextgen_image_ckpt(name: str) -> bool:
    """次世代图像底模(flux2/qwen_image/z_image)且非组件分片。"""
    return is_nextgen(name) and not _is_component_shard(name)


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
    # (剔除组件分片:Qwen-Image/text_encoder|transformer|vae 等目录件选中即报错;
    #  再剔除编辑专用 DiT:qwen_image_edit 系不能文生图)
    ckpts = [
        n for n in _enum(unet_info, "UNETLoader", "unet_name")
        if _is_nextgen_image_ckpt(n) and not any(h in n.lower() for h in _EDIT_ONLY_UNET_HINTS)
    ]
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


def _ckpt_option(name: str, *, nsfw: bool) -> dict:
    """底模下拉项:命中 curated 卡片时用「人话名 · 文件名」做 label 并附一句话简介(desc),
    未命中保持裸文件名(行为与旧版一致)。"""
    card = card_for(name, "checkpoints")
    opt: dict[str, Any] = {"value": name, "label": name}
    if card:
        opt["label"] = f"{card['label']} · {name}"
        if card.get("description"):
            opt["desc"] = card["description"]
    if nsfw:
        opt["nsfw"] = True
    return opt


def _inject_dynamic_options(p: dict, dyn: dict[str, list[str]] | None) -> dict:
    """把 options_source 标记的参数注入运行时选项;dyn 为 None(worker 不可达)时保留声明态兜底。"""
    src = p.pop("options_source", None)
    if src is None or dyn is None:
        p.pop("options_source", None)
        return p
    if src == "image_ckpt":
        p["options"] = [{"value": "", "label": "平台默认底模"}] + [
            _ckpt_option(n, nsfw=is_nsfw(n))
            for n in dyn["ckpts"]
        ]
        p["default"] = ""
    elif src == "image_ckpt_nsfw":
        opts = [
            _ckpt_option(n, nsfw=True)
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
# 注册表(由 EnginePlugin 在 bootstrap 时填充;submit 绑定供前端/CLI 自省)
# ---------------------------------------------------------------------------

# profile 停用引擎集合(minimal/headless 等 profile 裁剪用)
_disabled_engines: set[str] = set()


def set_disabled_engines(engines: set[str]) -> None:
    """设置 profile 停用的引擎 id 集合;变更后探测缓存失效。"""
    global _disabled_engines
    _disabled_engines = set(engines)
    reset_avail_cache()


def get_disabled_engines() -> set[str]:
    """当前 profile 停用的引擎 id 集合(副本)。"""
    return set(_disabled_engines)


def _default_registry() -> list[dict[str, Any]]:
    """构建默认引擎注册表(20 条,含 submit 绑定)。由 EnginePlugin 或惰性调用填充。"""
    return [
    {
        "id": "txt2img",
        "label": "文生图",
        "kind": "image",
        "nsfw": False,
        "submit": {"route": "/api/generate/txt2img", "kind": "txt2img"},
        "description": "ComfyUI 图像工作流,底模/采样器/调度器/风格预设可选;LoRA 标签(<lora:名称:权重> 可直接写进提示词)",
        "source": {
            "name": "ComfyUI",
            "url": "https://github.com/comfyanonymous/ComfyUI",
            "author": "comfyanonymous 与开源社区",
            "note": "图像工作流引擎;底模由「模型」参数动态解析(NAS 共享模型库)",
        },
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
        "submit": {"route": "/api/generate/img2img", "kind": "img2img"},
        "description": "以上传参考图为底做重绘,denoise 控制偏离程度",
        "source": {
            "name": "ComfyUI",
            "url": "https://github.com/comfyanonymous/ComfyUI",
            "author": "comfyanonymous 与开源社区",
            "note": "图像重绘工作流;底模由「模型」参数动态解析(NAS 共享模型库)",
        },
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
    # Qwen-Image-Edit-2509:专用 ComfyUI 实例(TOIV_QWEN_EDIT_BASE_URL,默认 pc02 :8194),
    # 语义编辑 + 多角度相机控制;probe 探测实例 TextEncodeQwenImageEdit 节点 + 编辑 UNET
    {
        "id": "qwen-image-edit",
        "label": "智能编辑(Qwen)",
        "kind": "image",
        "nsfw": False,
        "submit": {"route": "/api/generate/qwen-edit", "kind": "qwen_edit"},
        "description": "Qwen-Image-Edit-2509:自然语言语义编辑 + 多角度相机控制,专用实例 :8194",
        "source": {
            "name": "Qwen-Image-Edit-2509",
            "url": "https://huggingface.co/Qwen/Qwen-Image-Edit-2509",
            "author": "阿里巴巴(Qwen 团队)",
            "note": "开源权重语义图像编辑;相机控制为社区 Multiple-angles LoRA,本地自部署专用实例",
        },
        "params": _qwen_edit_params(),
        "probe": _probe_qwen_edit,
    },
    # R18 图像引擎(NSFW 专区图像 tab):与 txt2img/img2img 同一提交链路,
    # 底模选项只注入 R18 ckpt(旧 CreateView nsfw 模式的 listModels 行为);
    # 仅 R18 上下文(X-NSFW 头)可见。
    {
        "id": "nsfw-txt2img",
        "label": "文生图(R18)",
        "kind": "image",
        "nsfw": True,
        "submit": {"route": "/api/generate/txt2img", "kind": "txt2img"},
        "description": "R18 底模成人向文生图,仅 R18 上下文可见;LoRA 标签可写进提示词",
        "source": {
            "name": "URPM (Uber Realistic Porn Merge)",
            "url": "https://civitai.com/models/22622",
            "author": "Civitai 社区合并模型",
            "note": "默认 R18 底模为 URPM v1.3(SD1.5);「模型」参数可选其他已装 R18 ckpt",
        },
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
        "submit": {"route": "/api/generate/img2img", "kind": "img2img"},
        "description": "R18 底模成人向图生图,仅 R18 上下文可见",
        "source": {
            "name": "URPM (Uber Realistic Porn Merge)",
            "url": "https://civitai.com/models/22622",
            "author": "Civitai 社区合并模型",
            "note": "默认 R18 底模为 URPM v1.3(SD1.5);「模型」参数可选其他已装 R18 ckpt",
        },
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
    # LTX-2.3 NSFW(R18 保留;SFW 的 LTX-2.5 已于 2026-08-23 退役移除)
    {
        "id": "ltx-nsfw-t2v",
        "label": "LTX 2.3 文生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "submit": {"route": "/api/generate/ltx-t2v", "kind": "ltx-t2v"},
        "description": "10Eros 底模成人向文生视频,仅 R18 上下文可见",
        "source": {
            "name": "LTX-Video 2.3 + 10Eros v14",
            "url": "https://civitai.com/models/2447875",
            "author": "Lightricks × Civitai 社区(10Eros)",
            "note": "10Eros 为社区训练的 LTX2.3 NSFW 专用底模,已内置为默认视频 UNET",
        },
        "params": _ltx_nsfw_video_params(),
        "probe": _probe_ltx_nsfw("ltx_t2v"),
    },
    {
        "id": "ltx-nsfw-i2v",
        "label": "LTX 2.3 图生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "submit": {"route": "/api/generate/ltx-i2v", "kind": "ltx-i2v"},
        "description": "10Eros 底模成人向图生视频,仅 R18 上下文可见",
        "source": {
            "name": "LTX-Video 2.3 + 10Eros v14",
            "url": "https://civitai.com/models/2447875",
            "author": "Lightricks × Civitai 社区(10Eros)",
            "note": "10Eros 为社区训练的 LTX2.3 NSFW 专用底模,已内置为默认视频 UNET",
        },
        "params": [_ref_image_required(), *_ltx_nsfw_video_params()],
        "probe": _probe_ltx_nsfw("ltx_i2v"),
    },
    {
        "id": "ltx-nsfw-lipsync",
        "label": "LTX 2.3 对口型(R18)",
        "kind": "video",
        "nsfw": True,
        "submit": {"route": "/api/generate/ltx-lipsync", "kind": "ltx-lipsync"},
        "description": "10Eros 底模成人向口型同步:人物参考图 + 驱动音频 → 对口型视频",
        "source": {
            "name": "LTX-Video 2.3 + 10Eros v14",
            "url": "https://civitai.com/models/2447875",
            "author": "Lightricks × Civitai 社区(10Eros)",
            "note": "10Eros 为社区训练的 LTX2.3 NSFW 专用底模;ID LoRA 可选(身份保持)",
        },
        "params": [
            _images(label="人物参考图"),
            _audio(),
            *_ltx_nsfw_video_params(),
            {
                "key": "id_lora", "label": "ID LoRA(可选)", "type": "text", "default": "",
                "hint": "worker loras 目录内的身份保持 LoRA 文件名,留空不用",
            },
            _num("id_lora_strength", "ID LoRA 强度", 0.8, min_=0, max_=2, step=0.1),
        ],
        "probe": _probe_ltx_nsfw("ltx_lipsync"),
    },
    # MiniMax H3:专用 ComfyUI ≥ 0.30 实例(TOIV_H3_BASE_URL,默认 workstation :8195),
    # 原生 32kHz 音画同发;probe 探测实例 /object_info 是否含 MiniMaxH3 节点
    {
        "id": "h3-t2v",
        "label": "MiniMax H3 文生视频",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/h3/t2v", "kind": "h3-t2v"},
        "description": "MiniMax H3 新一代视频管线:原生 32kHz 音画同发,专用实例 :8195",
        "source": {
            "name": "MiniMax H3(海螺视频开源权重)",
            "url": "https://huggingface.co/MiniMaxAI",
            "author": "MiniMax",
            "note": "开源权重视频模型,原生音画同发;本地自部署专用实例",
        },
        "params": _h3_video_params(),
        "probe": _probe_h3,
    },
    {
        "id": "h3-i2v",
        "label": "MiniMax H3 图生视频",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/h3/i2v", "kind": "h3-i2v"},
        "description": "MiniMax H3:参考图首帧 → 音画同发短视频,剧情连续性好",
        "source": {
            "name": "MiniMax H3(海螺视频开源权重)",
            "url": "https://huggingface.co/MiniMaxAI",
            "author": "MiniMax",
            "note": "开源权重视频模型,原生音画同发;本地自部署专用实例",
        },
        "params": [_ref_image_required(), *_h3_video_params()],
        "probe": _probe_h3,
    },
    # R18 H3 引擎(NSFW 专区视频 tab):与 h3-t2v/h3-i2v 同一提交链路(POST /api/h3/*),
    # 专区内自带 X-NSFW 头 → 产物打标进 R18 作品库、R18 LoRA 门控放行;
    # probe 复用 _probe_h3,可用性与 SFW 版天然一致。仅 R18 上下文可见。
    {
        "id": "h3-nsfw-t2v",
        "label": "MiniMax H3 文生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "submit": {"route": "/api/h3/t2v", "kind": "h3-t2v"},
        "description": "MiniMax H3 成人向文生视频:原生 32kHz 音画同发,可叠 R18 LoRA,专用实例 :8195",
        "source": {
            "name": "MiniMax H3 + 社区 R18 LoRA",
            "url": "https://huggingface.co/MiniMaxAI",
            "author": "MiniMax × Civitai 社区(LoRA)",
            "note": "底模为 MiniMax 开源权重;R18 能力由社区 LoRA 提供(civitai),仅 R18 上下文可选",
        },
        "params": _h3_nsfw_video_params(),
        "probe": _probe_h3,
    },
    {
        "id": "h3-nsfw-i2v",
        "label": "MiniMax H3 图生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "submit": {"route": "/api/h3/i2v", "kind": "h3-i2v"},
        "description": "MiniMax H3 成人向图生视频:参考图首帧 → 音画同发,可叠 R18 LoRA",
        "source": {
            "name": "MiniMax H3 + 社区 R18 LoRA",
            "url": "https://huggingface.co/MiniMaxAI",
            "author": "MiniMax × Civitai 社区(LoRA)",
            "note": "底模为 MiniMax 开源权重;R18 能力由社区 LoRA 提供(civitai),仅 R18 上下文可选",
        },
        "params": [_ref_image_required(), *_h3_nsfw_video_params()],
        "probe": _probe_h3,
    },
    # Wan2.2 I2V NSFW(2026-08-17 Civitai 爆款配方复刻):与 SFW 主链同一路由
    # (POST /api/generate/video),pool worker 执行;专区内自带 X-NSFW 头 →
    # 产物打标进 R18 作品库、loras 入参生效(SFW 请求带 loras 一律静默剔除)。
    # LoRA 清单为静态策划(WAN_I2V_NSFW_LORAS 6 个),侧别由后端注册表判定。
    {
        "id": "wan-nsfw-i2v",
        "label": "Wan2.2 图生视频(R18)",
        "kind": "video",
        "nsfw": True,
        "submit": {"route": "/api/generate/video", "kind": "wan_i2v"},
        "description": "Wan2.2 双专家 14B 成人向图生视频:Civitai 爆款配方复刻(通用概念 + 体位/物理 LoRA 双专家分侧叠加)",
        "source": {
            "name": "Wan2.2 I2V-A14B + Civitai 社区 NSFW LoRA 配方",
            "url": "https://civitai.com/models/2073605",
            "author": "阿里巴巴(Wan 团队)× Civitai 社区(kenpechi 等配方作者)",
            "note": "底模为 Wan2.2 开源权重;NSFW 能力由社区 LoRA 分侧叠加提供,仅 R18 上下文可选",
        },
        "params": [_ref_image_required(), *_wan_nsfw_i2v_params()],
        "probe": _probe_wan_i2v,
    },
    # LongCat-Video:专用 ComfyUI 实例(TOIV_LONGCAT_BASE_URL,默认 workstation GPU2 :8197),
    # 长镜头引擎(961 帧@16fps≈60s);probe 探测实例 /object_info 是否含 WanVideo 节点
    {
        "id": "longcat-t2v",
        "label": "LongCat 文生视频",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/longcat/t2v", "kind": "longcat-t2v"},
        "description": "LongCat-Video 长视频引擎:蒸馏 LoRA 低步数出片,专用实例 :8197",
        "source": {
            "name": "LongCat-Video 13.6B",
            "url": "https://huggingface.co/meituan-longcat/LongCat-Video",
            "author": "美团(LongCat 团队)",
            "note": "开源权重长视频模型,单镜头最长 ≈60s;本地自部署专用实例",
        },
        "params": _longcat_video_params(),
        "probe": _probe_longcat,
    },
    {
        "id": "longcat-i2v",
        "label": "LongCat 图生视频",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/longcat/i2v", "kind": "longcat-i2v"},
        "description": "LongCat-Video 长视频引擎:首帧参考图 → 长镜头,专用实例 :8197",
        "source": {
            "name": "LongCat-Video 13.6B",
            "url": "https://huggingface.co/meituan-longcat/LongCat-Video",
            "author": "美团(LongCat 团队)",
            "note": "开源权重长视频模型,单镜头最长 ≈60s;本地自部署专用实例",
        },
        "params": [_ref_image_required(), *_longcat_video_params()],
        "probe": _probe_longcat,
    },
    {
        "id": "longcat-continue",
        "label": "LongCat 视频续写",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/longcat/continue", "kind": "longcat-continue"},
        "description": "LongCat-Video:取已有视频末帧续写下一段长镜头(API 缺省宽高/帧率时自动向源视频实测值对齐)",
        "source": {
            "name": "LongCat-Video 13.6B",
            "url": "https://huggingface.co/meituan-longcat/LongCat-Video",
            "author": "美团(LongCat 团队)",
            "note": "开源权重长视频模型;末帧续写实现超长视频分段生成",
        },
        "params": [
            {"key": "video", "label": "源视频", "type": "text", "default": "",
             "hint": "/api/images?... 产物 URL(如上一段 LongCat 产物链接)"},
            *_longcat_video_params(),
        ],
        "probe": _probe_longcat,
    },
    # LongCat-Avatar:音频驱动数字人(v1.5,whisper-large-v3 音频编码),
    # 与 longcat-t2v 同一专用实例(:8197);probe 复用 _probe_longcat
    {
        "id": "avatar-talk",
        "label": "LongCat-Avatar 数字人",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/avatar/talk", "kind": "avatar-talk"},
        "description": "LongCat-Avatar 音频驱动数字人:人像首帧 + 说话音频 → 口型同步视频,专用实例 :8197",
        "source": {
            "name": "LongCat-Avatar v1.5",
            "url": "https://huggingface.co/meituan-longcat",
            "author": "美团(LongCat 团队)",
            "note": "音频驱动数字人;音频编码 whisper-large-v3(OpenAI 开源),人声分离 MelBand RoFormer",
        },
        "params": _avatar_talk_params(),
        "probe": _probe_longcat,
    },
    # Wan2.2-Animate:参考图角色 + 驱动视频 → 动作迁移;与 LongCat 同实例(:8197),
    # probe 在 longcat 基础上追加 WanVideoAnimateEmbeds 节点检查
    {
        "id": "wan-animate",
        "label": "Wan2.2 动作迁移",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/wan/animate", "kind": "wan-animate"},
        "description": "Wan2.2-Animate 14B:参考图角色按驱动视频动作表演(双轨骨骼+表情迁移),专用实例 :8197",
        "source": {
            "name": "Wan2.2-Animate-14B",
            "url": "https://huggingface.co/Wan-AI/Wan2.2-Animate-14B",
            "author": "阿里巴巴(Wan 团队)",
            "note": "Apache 2.0 开源权重;动作迁移/角色替换双模式,本地自部署专用实例",
        },
        "params": _wan_animate_params(),
        "probe": _probe_wan_animate,
    },
    # Wan2.1-VACE:多参考图(1-4 张,+可选首尾帧)→ 视频;同实例(:8197)
    {
        "id": "wan-vace",
        "label": "VACE 多参考视频",
        "kind": "video",
        "nsfw": False,
        "submit": {"route": "/api/wan/vace", "kind": "wan-vace"},
        "description": "Wan2.1-VACE 14B:多参考图(角色/物体/场景)+ 可选首尾帧 → 一致性视频,专用实例 :8197",
        "source": {
            "name": "Wan2.1-VACE-14B",
            "url": "https://huggingface.co/ali-vilab/VACE-Wan2.1-14B",
            "author": "阿里巴巴(VILAB)",
            "note": "Apache 2.0 开源权重;多参考图/首尾帧/局部编辑一体化视频模型",
        },
        "params": _wan_vace_params(),
        "probe": _probe_wan_vace,
    },
    # ACE-Step 文生音乐:kind=audio(音频板块生成区;提交路由 /api/generate/audio 既有)
    {
        "id": "ace-music",
        "label": "ACE 文生音乐",
        "kind": "audio",
        "nsfw": False,
        "submit": {"route": "/api/generate/audio", "kind": "audio"},
        "description": "ACE-Step 1.5:风格标签 + 歌词 → MP3(≤240s);提示词可经 AI 优化为音乐标签",
        "source": {
            "name": "ACE-Step v1.5 3.5B",
            "url": "https://huggingface.co/ACE-Step",
            "author": "ACE Studio × 阶跃星辰(StepFun)",
            "note": "开源权重音乐生成模型;本地自部署,底模 ace_step_v1_3.5b.safetensors",
        },
        "params": _ace_audio_params(),
        "probe": _probe_ace,
    },
    ]


# 运行时注册表:由 populate_registry 填充(EnginePlugin bootstrap 或惰性初始化)
_REGISTRY: list[dict[str, Any]] = []
_registry_populated = False


def populate_registry(disabled: set[str] | None = None) -> None:
    """填充引擎注册表。由 EnginePlugin 在 bootstrap 时调用;幂等(重复调用不重建)。

    disabled 为 None 时保持当前停用集不变(幂等重入);显式传入则替换。
    """
    global _registry_populated
    if not _registry_populated:
        _REGISTRY.extend(_default_registry())
        _registry_populated = True
    if disabled is not None:
        set_disabled_engines(disabled)


def _ensure_registry() -> None:
    """惰性填充:未走插件 bootstrap 时(测试直调 list_engines)自动填充。"""
    if not _registry_populated:
        populate_registry()


def _reset_registry_for_tests() -> None:
    """测试隔离:清空注册表与停用集,下次 populate_registry 重建。"""
    global _registry_populated, _disabled_engines
    _REGISTRY.clear()
    _registry_populated = False
    _disabled_engines = set()
    reset_avail_cache()


def _inject_h3_lora_options(p: dict, loras: list[str] | None) -> dict:
    """把 options_source=h3_loras 的参数注入 H3 实例 LoRA 选项;实例不可达(None)保留声明态空 options。"""
    p.pop("options_source", None)
    if loras:
        p["options"] = [
            {"value": n, "label": n, **({"nsfw": True} if is_h3_nsfw_lora(n) else {})}
            for n in loras
        ]
    return p


async def list_engines(pool: WorkerPool, user: User | None = None) -> list[dict[str, Any]]:
    """返回引擎数组(按请求的 R18 上下文过滤 nsfw 引擎与 nsfw 选项)。

    每项:{ id, label, kind, available, unavailable_reason?, nsfw, description?, params, submit? }
    params 元素:{ key, label, type, options?, min?, max?, step?, default, hint? }
    profile 停用的引擎:available=False, unavailable_reason="disabled by profile"。
    """
    _ensure_registry()
    r18 = nsfw_allowed(user)
    # 动态选项(底模/采样器/调度器)惰性拉取:仅当引擎声明了 options_source 且
    # 本次响应包含图像引擎时才访问 worker object_info,全失败回退声明态兜底。
    dyn: dict[str, list[str]] | None = None
    dyn_fetched = False
    # H3 LoRA 选项走 H3 专用实例(非 pool),同样惰性一次拉取
    h3_loras: list[str] | None = None
    h3_loras_fetched = False
    engines: list[dict[str, Any]] = []
    pending: list[tuple[dict[str, Any], ProbeFn]] = []
    now = time.monotonic()
    cache_fresh = (now - _avail_cache_at) < _AVAIL_TTL
    for spec in _REGISTRY:
        if spec["nsfw"] and not r18:
            continue
        # 参数 schema:SFW 上下文剔除 nsfw 选项(如 ltx2 白名单里的 10eros)
        params: list[dict] = []
        for p in spec["params"]:
            p = dict(p)
            src = p.get("options_source")
            if src == "h3_loras":
                if not h3_loras_fetched:
                    h3_loras_fetched = True
                    h3_loras = await _fetch_h3_loras()
                p = _inject_h3_lora_options(p, h3_loras)
            elif src:
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
        if "source" in spec:
            entry["source"] = spec["source"]
        if "submit" in spec:
            entry["submit"] = spec["submit"]

        # profile 停用:跳过探测,直接标不可用
        if spec["id"] in _disabled_engines:
            entry["available"] = False
            entry["unavailable_reason"] = "disabled by profile"
            engines.append(entry)
            continue

        probe = spec.get("probe")
        if probe is None:
            entry["available"] = bool(spec.get("static_available", False))
            if not entry["available"] and spec.get("static_reason"):
                entry["unavailable_reason"] = spec["static_reason"]
        elif cache_fresh and spec["id"] in _avail_cache:
            available, reason = _avail_cache[spec["id"]]
            entry["available"] = available
            if not available and reason:
                entry["unavailable_reason"] = reason
        else:
            pending.append((entry, probe))
        engines.append(entry)

    # 可用性探测并行化:串行 await 16 个引擎 probe 曾使端点 0.55-3.37s 波动
    # (QA-FULL-2026-08-11 P1);gather 后总耗时≈最慢单个 probe,结果写短 TTL 缓存。
    if pending:
        results = await asyncio.gather(*(probe(pool) for _, probe in pending))
        for (entry, _), (available, reason) in zip(pending, results):
            _avail_cache[entry["id"]] = (available, reason)
            entry["available"] = available
            if not available and reason:
                entry["unavailable_reason"] = reason
        _mark_avail_probed()
    return engines
