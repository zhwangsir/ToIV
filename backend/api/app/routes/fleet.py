"""设备舰队端点(routes/fleet.py)—— GET /api/fleet[/ {device_id}]。

薄路由层:探测/缓存/时序全部在 services/fleet.py(照 observability 模式:
15s 缓存 + 单飞重建 + 环形缓冲时序)。仅管理员(与 /api/observability 同口径,
避免普通用户窥探集群拓扑)。设备离线是正常态,任何探测失败都降级不炸。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_admin, get_current_user
from app.models import Job, User
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




@router.get("/fleet/brief")
async def fleet_brief(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """创作台忙闲只读摘要(任意登录用户):人话排队/hold,**不暴露端口/worker URL**。

    Wave P1.5 / L1:首页与短剧工作台消费;Admin 深潜仍走 /api/fleet。
    """
    snapshot = await fleet.get_snapshot()
    devices = []
    up_sum = total_sum = 0
    online_n = 0
    for d in snapshot.get("devices") or []:
        up = int(d.get("services_up") or 0)
        total = int(d.get("services_total") or 0)
        up_sum += up
        total_sum += total
        if d.get("online"):
            online_n += 1
        devices.append({
            "id": d.get("id"),
            "name": d.get("name"),
            "role": d.get("role"),
            "online": d.get("online"),
            "services_up": up,
            "services_total": total,
            "headline": d.get("headline") or "",
        })
    held = session.exec(
        select(Job).where(
            Job.user_id == user.id,
            Job.status == "held",
            Job.deleted_at == None,  # noqa: E712
        )
    ).all()
    queued = session.exec(
        select(Job).where(
            Job.user_id == user.id,
            Job.status.in_(("queued", "running")),  # type: ignore[attr-defined]
            Job.deleted_at == None,  # noqa: E712
        )
    ).all()
    held_n = len(list(held))
    active_n = len(list(queued))
    if held_n > 0:
        level = "held"
        summary = f"有 {held_n} 个任务在等资源释放；本地算力稍后再自动放行。"
    elif active_n > 0:
        level = "busy"
        summary = f"本地算力忙碌中：你有 {active_n} 个任务在排队或生成。"
    elif total_sum > 0 and up_sum == 0:
        level = "offline"
        summary = "本地算力暂不可达；可先写剧本与定妆，稍后再开拍。"
    elif total_sum > 0 and up_sum < total_sum:
        level = "degraded"
        summary = f"本地算力部分可用（{up_sum}/{total_sum}）；空闲时可直接开拍。"
    else:
        level = "idle"
        summary = "本地算力空闲，可直接开拍；忙碌时任务会自动排队。"
    return {
        "generated_at": snapshot.get("generated_at"),
        "level": level,
        "summary": summary,
        "mine": {"held": held_n, "active": active_n},
        "fleet": {
            "online_devices": online_n,
            "services_up": up_sum,
            "services_total": total_sum,
        },
        "devices": devices,
    }


@router.get("/fleet/{device_id}")
async def fleet_device(device_id: str, _: User = Depends(get_current_admin)) -> dict:
    """设备详情:meta(LAN/TS IP/硬件)+ 服务清单 + sys(sysmetrics)+ 时序。"""
    snapshot = await fleet.get_snapshot()
    detail = fleet.device_detail(snapshot, device_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"未知设备: {device_id}")
    return detail
