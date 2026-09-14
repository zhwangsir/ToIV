"""自愈闭环 Phase1(2026-09-15)—— 导入即测烟测 admin 端点。

- POST /api/admin/apps/{aid}/smoke        单应用真跑一遍(同步等待结果)
- POST /api/admin/apps/smoke/batch        批量烟测(单飞,fire-and-forget)
- GET  /api/admin/apps/smoke/status       批次进行态

结果落 App.smoke_status/smoke_cls/smoke_error/smoke_at;市场 AppOut 已透出。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_admin
from app.models import App, User
from app.services import app_smoke as smoke_svc
from app.comfy.pool import WorkerPool
from app.deps import get_pool
from app import audit

router = APIRouter(tags=["app-smoke"])


class SmokeBatchRequest(BaseModel):
    limit: int = Field(default=50, ge=1, le=500)
    include_nsfw: bool = False  # R18 应用默认跳过(烟测走 SFW 口径)


@router.post("/admin/apps/{app_id}/smoke")
async def smoke_one_app(
    app_id: str,
    admin: User = Depends(get_current_admin),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    a = session.get(App, app_id)
    if not a:
        raise HTTPException(status_code=404, detail="应用不存在")
    result = await smoke_svc.run_app_smoke(pool, session, a)
    audit.record(
        session, user=admin, action="app.smoke", target_type="app", target_id=app_id,
        summary=f"烟测 {result['status']} {result['cls']}", detail=result,
    )
    return result


@router.post("/admin/apps/smoke/batch")
async def smoke_batch(
    body: SmokeBatchRequest,
    admin: User = Depends(get_current_admin),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    task = smoke_svc.spawn_smoke_batch(pool, limit=body.limit, include_nsfw=body.include_nsfw)
    if task is None:
        raise HTTPException(status_code=409, detail="烟测批次已在运行中")
    audit.record(
        session, user=admin, action="app.smoke_batch", target_type="app", target_id="",
        summary=f"批量烟测 limit={body.limit} nsfw={body.include_nsfw}", detail={},
    )
    return {"started": True, "limit": body.limit, "include_nsfw": body.include_nsfw}


@router.get("/admin/apps/smoke/status")
def smoke_status() -> dict:
    return {"running": smoke_svc.smoke_running(), "summary": smoke_svc.last_smoke_summary()}


@router.get("/admin/selfheal/proposals")
def list_selfheal_proposals(
    limit: int = 50,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    from app.services import selfheal_llm

    return {"proposals": selfheal_llm.list_proposals(session, limit=limit)}


@router.post("/admin/selfheal/proposals/{proposal_id}/reject")
def reject_selfheal_proposal(
    proposal_id: str,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    from app.services import selfheal_llm

    try:
        out = selfheal_llm.reject_proposal(session, proposal_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    audit.record(
        session, user=admin, action="app.selfheal_reject", target_type="app",
        target_id=out.get("app_id") or "", summary="驳回 LLM 修复提案并还原原始图", detail=out,
    )
    return out
