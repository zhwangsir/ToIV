"""系统遥测:聚合 4 卡 ComfyUI worker 的 GPU 显存/队列状态。

供「创作引擎」HUD 实时显示(需管理员鉴权,避免普通用户窥探集群 GPU 拓扑)。
- 每个 worker 绑定一张 GPU(cuda:0..3),故 worker 顺序即卡序(GPU0..3)。
- 负载信号取**显存占用%**(算力 utilization 需 nvidia-smi,后续接入)。
- 任一 worker 不可达 → 该卡标 offline、负载 0,不影响其余卡。
"""
from __future__ import annotations

import asyncio

import httpx
from fastapi import APIRouter, Depends

from app.config import get_settings
from app.deps import get_current_admin
from app.models import User

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


@router.get("/system/gpu")
async def gpu_stats(_: User = Depends(get_current_admin)) -> dict:
    """Workstation 本地 PRO6000 实时遥测(显存负载 + 队列深度)。仅管理员可查,避免普通用户窥探集群 GPU 拓扑。"""
    settings = get_settings()
    # 仅取 Workstation 本地 PRO6000(.127,gpu0/1/2 三张)对齐面板;无匹配则退回全部 worker
    # GPU3 已让给 Nemotron LLM,不再作 ComfyUI 后端
    urls = [u for u in settings.worker_urls if "192.168.71.127" in u] or settings.worker_urls
    async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as client:
        cards = await asyncio.gather(*(_probe(client, u, i) for i, u in enumerate(urls)))
    return {
        "gpus": [{"id": c["id"], "load": c["load"], "vram": c["vram"]} for c in cards],
        "queueDepth": sum(c["queue"] for c in cards),
        "outputCount": 0,
        "online": sum(1 for c in cards if c["online"]),
    }
