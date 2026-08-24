"""设备舰队端点(routes/fleet.py)—— GET /api/fleet[/ {device_id}]。

薄路由层:探测/缓存/时序全部在 services/fleet.py(照 observability 模式:
15s 缓存 + 单飞重建 + 环形缓冲时序)。仅管理员(与 /api/observability 同口径,
避免普通用户窥探集群拓扑)。设备离线是正常态,任何探测失败都降级不炸。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_admin
from app.models import User
from app.services import fleet

router = APIRouter(tags=["fleet"])


@router.get("/fleet")
async def fleet_summary(_: User = Depends(get_current_admin)) -> dict:
    """全设备摘要:online / services_up/total / headline 一句话指标。"""
    snapshot = await fleet.get_snapshot()
    return {
        "generated_at": snapshot["generated_at"],
        "cache_ttl_sec": snapshot["cache_ttl_sec"],
        "devices": [
            {
                "id": d["id"],
                "name": d["name"],
                "role": d["role"],
                "online": d["online"],
                "services_up": d["services_up"],
                "services_total": d["services_total"],
                "headline": d["headline"],
            }
            for d in snapshot["devices"]
        ],
    }


@router.get("/fleet/{device_id}")
async def fleet_device(device_id: str, _: User = Depends(get_current_admin)) -> dict:
    """设备详情:meta(LAN/TS IP/硬件)+ 服务清单 + sys(sysmetrics)+ 时序。"""
    snapshot = await fleet.get_snapshot()
    detail = fleet.device_detail(snapshot, device_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"未知设备: {device_id}")
    return detail
