"""操作防护体系(SAFETY,2026-08-17)—— 撤销端点 + 审计日志查询(admin)。

  · POST /api/undo/{token}:撤销窗口内恢复误删作品(Job 软删复活);
    token 仅对被删作品的属主有效(撤销也是本人操作,防越权恢复他人作品)。
  · GET  /api/admin/audit-logs:admin-only 分页审计查询(user_id/action 过滤)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.audit import UNDO_TTL_SECONDS
from app.db import get_session
from app.deps import get_current_user
from app.models import AuditLog, Job, User

router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可访问")


@router.post("/undo/{undo_token}")
def undo(
    undo_token: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """撤销一次可撤销操作(当前:作品删除)。

    校验链:token 存在 → 属主匹配 → 未过期 → 未被撤销过 → 目标仍处软删状态。
    (路径参数名用 undo_token:避开 get_current_user 依赖的 token Query 参数撞名)
    """
    log = session.exec(
        select(AuditLog).where(AuditLog.undo_token == undo_token)
    ).first()
    if log is None or log.user_id != user.id:
        raise HTTPException(status_code=404, detail="撤销凭据不存在")
    if log.undone:
        raise HTTPException(status_code=409, detail="该操作已被撤销过")
    if log.undo_expires_at is not None:
        from datetime import datetime, timezone

        expired = log.undo_expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc)
        if expired:
            raise HTTPException(status_code=410, detail="撤销窗口已过期(10 分钟)")

    if log.action == "job.delete" and log.target_type == "job":
        job = session.exec(select(Job).where(Job.id == log.target_id)).first()
        if job is None or job.user_id != user.id:
            raise HTTPException(status_code=404, detail="作品不存在")
        if job.deleted_at is None:
            # 已被其他 undo 恢复:幂等成功
            return {"ok": True, "restored": True, "id": job.id}
        job.deleted_at = None
        session.add(job)
        log.undone = True
        session.add(log)
        session.add(AuditLog(
            tenant_id=user.tenant_id, user_id=user.id, user_email=user.email,
            action="job.undo", target_type="job", target_id=job.id,
            summary=f"撤销删除作品:{(job.prompt or '')[:40]}",
        ))
        session.commit()
        return {"ok": True, "restored": True, "id": job.id}

    raise HTTPException(status_code=422, detail="该操作类型不支持撤销")


@router.get("/admin/audit-logs")
def list_audit_logs(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user_id: str = Query(default=""),
    action: str = Query(default="", description="按动作前缀过滤,如 job./project."),
    session_: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """admin-only:关键操作审计日志(最新在前)。"""
    _require_admin(user)
    stmt = select(AuditLog)
    if user_id:
        stmt = stmt.where(AuditLog.user_id == user_id)
    if action:
        stmt = stmt.where(AuditLog.action.startswith(action))
    rows = session_.exec(
        stmt.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit)
    ).all()
    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "user_email": r.user_email,
            "action": r.action,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "summary": r.summary,
            "undo_token": r.undo_token,
            "undo_expires_at": r.undo_expires_at.isoformat() if r.undo_expires_at else None,
            "undone": r.undone,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]
