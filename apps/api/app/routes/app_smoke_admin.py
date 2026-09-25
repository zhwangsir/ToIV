"""自愈闭环 Phase1(2026-09-15)—— 导入即测烟测 admin 端点。

- POST /api/admin/apps/{aid}/smoke        单应用真跑一遍(同步等待结果)
- POST /api/admin/apps/smoke/batch        批量烟测(单飞,fire-and-forget)
- GET  /api/admin/apps/smoke/status       批次进行态

结果落 App.smoke_status/smoke_cls/smoke_error/smoke_at;市场 AppOut 已透出。
"""
from __future__ import annotations

from fastapi import Query, APIRouter, Depends, HTTPException
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
    timeout_s: int | None = Query(default=None, ge=60, le=3600),
) -> dict:
    a = session.get(App, app_id)
    if not a:
        raise HTTPException(status_code=404, detail="应用不存在")
    result = await smoke_svc.run_app_smoke(pool, session, a, timeout_s=timeout_s)
    audit.record(
        session, user=admin, action="app.smoke", target_type="app", target_id=app_id,
        summary=f"烟测 {result['status']} {result['cls']}", detail=result,
    )
    session.commit()
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
    session.commit()
    return {"started": True, "limit": body.limit, "include_nsfw": body.include_nsfw}


@router.get("/admin/apps/smoke/status")
def smoke_status() -> dict:
    return {"running": smoke_svc.smoke_running(), "summary": smoke_svc.last_smoke_summary()}


class DemoCoverRequest(BaseModel):
    limit: int = Field(default=40, ge=1, le=600)


@router.post("/admin/apps/covers/demo")
async def demo_cover_batch(  # async:def 里才有 running loop,create_task 需要(同步 def 会 500)
    body: DemoCoverRequest,
    admin: User = Depends(get_current_admin),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """真实 demo 封面批(单飞):应用自工作流真跑 + 美女素材,产物做封面。"""
    from app.services import app_cover_demo

    if app_cover_demo.demo_running():
        raise HTTPException(status_code=409, detail="demo 封面批次已在运行中")
    planned = len(app_cover_demo.plan_demo_targets(session, body.limit))
    task = app_cover_demo.spawn_demo_batch(pool, limit=body.limit)
    if task is None:
        raise HTTPException(status_code=409, detail="demo 封面批次已在运行中")
    audit.record(
        session, user=admin, action="app.cover_demo", target_type="app", target_id="",
        summary=f"demo 封面批 limit={body.limit} 待做={planned}", detail={},
    )
    session.commit()
    return {"started": True, "limit": body.limit, "planned": planned}


@router.get("/admin/apps/covers/demo/status")
def demo_cover_status() -> dict:
    from app.services import app_cover_demo

    return app_cover_demo.last_demo_summary()


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
    session.commit()
    return out




class BulkPublicRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    is_public: bool


@router.get("/admin/closeout-summary")
def closeout_summary(
    admin: User = Depends(get_current_admin),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """收尾运营快照:公开市场烟测分布 + soft-hide 计数 + 封面闸。"""
    from collections import Counter
    from sqlmodel import select
    from app.services import app_cover_demo

    rows = session.exec(select(App)).all()
    public = [a for a in rows if a.is_public]
    hidden = [a for a in rows if (not a.is_public) and a.is_builtin]
    smoke = Counter((a.smoke_status or "") or "untested" for a in public)
    # normalize empty key
    if "" in smoke:
        smoke["untested"] = smoke.pop("")
    gate = app_cover_demo.cover_gate_state(session, pool)
    return {
        "apps_total": len(rows),
        "public_total": len(public),
        "soft_hidden_builtin": len(hidden),
        "smoke": {
            "pass": smoke.get("pass", 0),
            "fail": smoke.get("fail", 0),
            "timeout": smoke.get("timeout", 0),
            "running": smoke.get("running", 0),
            "untested": smoke.get("untested", 0) + smoke.get("", 0),
        },
        "cover_gate": gate,
        "smoke_batch": {
            "running": smoke_svc.smoke_running(),
            "summary": smoke_svc.last_smoke_summary(),
        },
        "demo_batch": app_cover_demo.last_demo_summary(),
    }


@router.post("/admin/apps/bulk-public")
def bulk_set_public(
    body: BulkPublicRequest,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """批量 soft-hide / 上架(改 is_public);单条失败不中断。"""
    ids = [i.strip() for i in body.ids if (i or "").strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="ids 不能为空")
    if len(ids) > 200:
        raise HTTPException(status_code=400, detail="单次最多 200 个")
    done: list[str] = []
    missing: list[str] = []
    for aid in ids:
        a = session.get(App, aid)
        if a is None:
            missing.append(aid)
            continue
        a.is_public = body.is_public
        done.append(aid)
        audit.record(
            session,
            user=admin,
            action="app.bulk_public",
            target_type="app",
            target_id=aid,
            summary=f"{'上架' if body.is_public else 'soft-hide'} {aid}",
            detail={"is_public": body.is_public},
        )
    session.commit()
    return {
        "is_public": body.is_public,
        "done": len(done),
        "missing": len(missing),
        "ids": done,
        "missing_ids": missing,
    }


class PreflightRequest(BaseModel):
    workflow_json: dict
    required_nodes: list[str] = Field(default_factory=list)


@router.post("/admin/apps/preflight")
async def preflight_app(
    body: PreflightRequest,
    admin: User = Depends(get_current_admin),
    pool: WorkerPool = Depends(get_pool),
) -> dict:
    """导入前依赖预检(模型/节点全 fleet 可得性);导入管线入库前调用。"""
    from app.services import app_smoke

    return await app_smoke.preflight_check(pool, body.workflow_json, body.required_nodes or [])
