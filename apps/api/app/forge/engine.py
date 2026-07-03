"""Forge 引擎适配 —— 把 reForge 的同步 sdapi 包装成 ToIV 的异步 Job 模型。

Forge `/sdapi/v1/txt2img` 是**阻塞**调用(直接返回 base64 图,无 prompt_id / 队列 /
WebSocket)。这里把它套进 ToIV 既有的「提交→prompt_id→SSE/轮询→落库」异步流程:

  提交 → 合成 prompt_id → 建 Job(queued)→ 后台 asyncio task 调 Forge(阻塞)
       → base64 存盘 → 落库(done)→ 立即返回 prompt_id(与 ComfyUI 路径同构,前端无感)

进度由 SSE 侧轮询 Forge `/sdapi/v1/progress`(全局当前任务;ToIV 低并发,单实例串行,够用)。
进程内作业态 `_jobs` 由后台 task 写、SSE 读(同一 api 进程);api 重启则回落 DB Job 状态。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import tempfile
from pathlib import Path

from app.comfy.tracker import mark_done, mark_status
from app.forge.client import ForgeClient, ForgeError
from app.storage import content_subdir

logger = logging.getLogger(__name__)

# 产物落盘目录(生成内容根,可切 NAS);served by routes/forge.py
FORGE_DIR = content_subdir("forge")

# 进程内 Forge 作业态:prompt_id -> {status: queued|running|done|error, images: [url], error: str|None}
_jobs: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()

# ComfyUI 采样器名 → A1111/Forge 采样器名(覆盖 ToIV 常用集;未命中回落 Euler a)
_SAMPLER_MAP = {
    "euler": "Euler",
    "euler_ancestral": "Euler a",
    "dpmpp_2m": "DPM++ 2M",
    "dpmpp_2m_sde": "DPM++ 2M SDE",
    "dpmpp_2m_sde_gpu": "DPM++ 2M SDE",
    "dpmpp_sde": "DPM++ SDE",
    "dpmpp_3m_sde": "DPM++ 3M SDE",
    "dpm_2": "DPM2",
    "dpm_2_ancestral": "DPM2 a",
    "heun": "Heun",
    "lms": "LMS",
    "ddim": "DDIM",
    "uni_pc": "UniPC",
}


def forge_image_url(name: str) -> str:
    return f"/api/forge/image/{name}"


def job_state(prompt_id: str) -> dict | None:
    """SSE 读当前 Forge 作业态(None 表示尚未登记 / 已清理)。"""
    return _jobs.get(prompt_id)


def map_sampler(name: str) -> str:
    return _SAMPLER_MAP.get((name or "").lower(), "Euler a")


def txt2img_payload(
    *,
    positive: str,
    negative: str = "",
    steps: int = 20,
    cfg: float = 7.0,
    width: int = 512,
    height: int = 512,
    sampler: str = "euler",
    scheduler: str = "normal",
    seed: int | None = None,
    batch_size: int = 1,
    ckpt: str | None = None,
) -> dict:
    """ToIV txt2img 参数 → sdapi /txt2img 载荷。

    用 override_settings 按请求临时切底模(免全局 set_options 抢占),
    override_settings_restore_afterwards=False 避免每次还原触发额外模型加载。
    """
    payload: dict = {
        "prompt": positive,
        "negative_prompt": negative,
        "steps": steps,
        "cfg_scale": cfg,
        "width": width,
        "height": height,
        "sampler_name": map_sampler(sampler),
        "batch_size": batch_size,
        "n_iter": 1,
        "send_images": True,
        "save_images": False,
    }
    # A1111 新版支持 scheduler 维度(karras 等);ComfyUI 的 karras 调度映射过去
    if scheduler and scheduler.lower() in ("karras", "exponential", "sgm_uniform"):
        payload["scheduler"] = scheduler.lower()
    if seed is not None:
        payload["seed"] = seed
    if ckpt:
        payload["override_settings"] = {"sd_model_checkpoint": ckpt}
        payload["override_settings_restore_afterwards"] = False
    return payload


def _decode(b64: str) -> bytes:
    # sdapi 可能返回 "data:image/png;base64,xxxx" 或纯 base64
    return base64.b64decode(b64.split(",", 1)[-1])


async def _run(client: ForgeClient, prompt_id: str, endpoint: str, payload: dict) -> None:
    """后台:调 Forge(阻塞)→ 存图 → 更新进程态 + 落库。绝不向上冒泡(后台任务)。"""
    _jobs[prompt_id] = {"status": "running", "images": [], "error": None}
    try:
        result = (
            await client.img2img(payload) if endpoint == "img2img"
            else await client.txt2img(payload)
        )
        images = result.get("images") or []
        urls: list[str] = []
        if images:
            FORGE_DIR.mkdir(parents=True, exist_ok=True)
            for i, b64 in enumerate(images):
                name = f"forge-{prompt_id}-{i}.png"
                (FORGE_DIR / name).write_bytes(_decode(b64))
                urls.append(forge_image_url(name))
        _jobs[prompt_id] = {"status": "done", "images": urls, "error": None}
        mark_done(prompt_id, urls)  # 同写 DB(作品库 / api 重启回落)
    except ForgeError as e:
        logger.warning("forge job %s failed: %s", prompt_id, e)
        _jobs[prompt_id] = {"status": "error", "images": [], "error": str(e)}
        mark_status(prompt_id, "error")
    except Exception as e:  # noqa: BLE001 — 后台任务不可静默崩
        logger.warning("forge job %s crashed: %s", prompt_id, e)
        _jobs[prompt_id] = {"status": "error", "images": [], "error": "Forge 出图异常"}
        mark_status(prompt_id, "error")


def spawn(client: ForgeClient, prompt_id: str, endpoint: str, payload: dict) -> None:
    """提交后即启动后台出图(fire-and-forget,保留强引用防 GC)。"""
    _jobs[prompt_id] = {"status": "queued", "images": [], "error": None}
    task = asyncio.create_task(_run(client, prompt_id, endpoint, payload))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
