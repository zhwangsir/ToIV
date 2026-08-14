"""系统遥测:聚合 4 卡 ComfyUI worker 的 GPU 显存/队列状态。

供「创作引擎」HUD 实时显示(需管理员鉴权,避免普通用户窥探集群 GPU 拓扑)。
- 每个 worker 绑定一张 GPU(cuda:0..3),故 worker 顺序即卡序(GPU0..3)。
- 负载信号取**显存占用%**(算力 utilization 需 nvidia-smi,后续接入)。
- 任一 worker 不可达 → 该卡标 offline、负载 0,不影响其余卡。

另挂载 GPU 生成链路冒烟端点(每日自动 + 管理员手动触发)。
"""
from __future__ import annotations

import asyncio
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.config import get_settings
from app.deps import get_current_admin, get_current_user
from app.models import User
from app.services.gpu_smoke import lb_client, run_gpu_smoke, smoke_report_dir

router = APIRouter(tags=["system"])


async def _probe(client: httpx.AsyncClient, url: str, idx: int) -> dict:
    """探一个 worker:显存占用% 作负载 + 队列深度;不可达则 offline。"""
    load = 0.0
    online = False
    queue = 0
    try:
        stats_res = await client.get(f"{url}/system_stats")
        devices = stats_res.json().get("devices", [])
        if devices:
            dev = devices[0]
            total = float(dev.get("vram_total") or 0)
            free = float(dev.get("vram_free") or 0)
            if total > 0:
                load = round((total - free) / total * 100, 1)
            online = True
        queue_res = await client.get(f"{url}/queue")
        body = queue_res.json()
        queue = len(body.get("queue_running", [])) + len(body.get("queue_pending", []))
    except (httpx.HTTPError, ValueError, KeyError):
        pass
    return {"id": f"GPU{idx}", "load": load, "vram": load, "online": online, "queue": queue}


@router.get("/system/llm")
async def llm_model(_: User = Depends(get_current_user)) -> dict:
    """当前默认 LLM 大脑名称(普通用户可读,供顶栏展示)。"""
    settings = get_settings()
    return {
        "model": settings.llm_model,
        "display_model": settings.llm_display_name or settings.llm_model,
        "fallback_model": settings.llm_fallback_model or None,
        "nsfw_model": settings.llm_nsfw_model or None,
        "l2_model": settings.llm_l2_model or None,
        "l3_model": settings.llm_l3_model or None,
    }


@router.get("/system/gpu")
async def gpu_stats(_: User = Depends(get_current_admin)) -> dict:
    """Workstation 本地 PRO6000 实时遥测(显存负载 + 队列深度)。仅管理员可查,避免普通用户窥探集群 GPU 拓扑。"""
    settings = get_settings()
    # 仅取 Workstation 本地 PRO6000(.127)对齐面板;无匹配则退回全部 worker。
    # 当前 GPU 分配(2026-08 集群重排):ComfyUI 通用后端仅 GPU0(:8189,另 GPU2 跑
    # LongCat/H3 专用实例);GPU3 跑 FlashTalk + OpenTalking + JoyCaption + M6 超分
    # :8263,不作 ComfyUI 通用后端(原 Nemotron LLM 已于 2026-08-05 停用)。
    urls = [u for u in settings.worker_urls if "192.168.71.127" in u] or settings.worker_urls
    async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as client:
        cards = await asyncio.gather(*(_probe(client, u, i) for i, u in enumerate(urls)))
    return {
        "gpus": [{"id": c["id"], "load": c["load"], "vram": c["vram"]} for c in cards],
        "queueDepth": sum(c["queue"] for c in cards),
        "outputCount": 0,
        "online": sum(1 for c in cards if c["online"]),
    }


# ── GPU 生成链路每日冒烟(txt2img 小图 + LTX 短视频) ──

_smoke_lock = asyncio.Lock()  # 防并发触发(手动 + 定时撞车)


@router.post("/system/gpu-smoke")
async def gpu_smoke_trigger(_: User = Depends(get_current_admin)) -> dict:
    """手动执行一次 GPU 冒烟(txt2img 小图 + LTX 短视频)。仅管理员。

    同步等待执行完毕返回完整报告;overall 失败时 HTTP 500 + 报告体。
    """
    if _smoke_lock.locked():
        raise HTTPException(status_code=409, detail="已有冒烟任务在执行中")
    async with _smoke_lock:
        settings = get_settings()
        report = await run_gpu_smoke(
            lb_client(),
            report_dir=smoke_report_dir(),
            webhook_url=settings.smoke_alert_webhook,
        )
    if not report.ok:
        raise HTTPException(status_code=500, detail=report.to_dict())
    return report.to_dict()


@router.get("/system/gpu-smoke/latest")
async def gpu_smoke_latest(_: User = Depends(get_current_admin)) -> dict:
    """读取最近一次冒烟报告(每日自动或手动触发均可)。仅管理员。"""
    latest = smoke_report_dir() / "gpu_smoke_latest.json"
    if not latest.exists():
        raise HTTPException(status_code=404, detail="尚无冒烟报告(等待每日定点或手动触发)")
    return json.loads(latest.read_text())
