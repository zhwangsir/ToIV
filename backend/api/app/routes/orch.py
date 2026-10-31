"""冷层服务编排端点(routes/orch.py)—— GET /api/orch/services + POST wake。

薄路由层:注册表/状态机/SSH/健康检查全在 services/service_orchestrator.py。
GET 仅 admin(集群拓扑与 /api/fleet 同口径,避免普通用户窥探);
POST wake 普通登录用户即可(冷服务按需唤醒是业务链路前置)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.deps import get_current_admin, get_current_user
from app.models import User
from app.services import service_orchestrator as orch

router = APIRouter(tags=["orch"])


@router.get("/orch/services")
async def orch_services(_: User = Depends(get_current_admin)) -> dict:
    """冷层服务清单:状态机状态 / 闲置时长 / 启停次数 / 最后错误。

    读取路径先并行探活校正(3s 超时/服务,见 orch.probe_and_reconcile):
    API 重启丢内存态后,实际在跑的服务不会再错误显示 stopped。
    """
    return await orch.list_services_live()


@router.post("/orch/services/{name}/wake")
async def orch_wake(name: str, user: User = Depends(get_current_user)) -> dict:
    """手动唤醒冷服务:sleeping/stopped/error → waking → running(幂等)。"""
    return await orch.ensure_running(name)
