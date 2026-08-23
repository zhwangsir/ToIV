"""操作防护体系(SAFETY,2026-08-17)—— 审计日志与撤销窗口。

设计要点:
  · record():关键操作统一落 AuditLog(用户/动作/对象/人话摘要/结构化快照);
    传入 undo_ttl 时签发 undo_token,配合 routes/safety.py 的 POST /api/undo/{token}
    实现「规定时间内恢复误操作」。
  · 与调用方同一事务:record 只 add 不 commit,由调用方 commit(保证操作与日志原子)。
  · 快照(detail)由记录方负责脱敏(不存密码/密钥类字段)。
风险分级(权限/确认门策略,文档即代码):
  L3 admin-only —— 用户管理、工作流部署、审计日志、系统级操作(admin 路由天然门槛)
  L2 危险操作  —— 删除类(项目/角色/会话)+ 批量删除:前端 Modal 确认(后果文案)+ 本审计
  L1 可撤销    —— 作品删除(软删 + undo 窗口,确认门可记忆跳过)
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import asyncio
import logging

from sqlmodel import Session, select

from app.models import AuditLog, Job, User

# 撤销/回收站保留期:作品软删除后 72 小时内可恢复(undo token 与回收站共用同一窗口;
# 过期行由 trash_purge_loop 物理删除)。前端 toast/回收站倒计时均以此为准。
UNDO_TTL_SECONDS = 72 * 3600

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def record(
    session: Session,
    *,
    user: User,
    action: str,
    target_type: str = "",
    target_id: str = "",
    summary: str = "",
    detail: dict | None = None,
    undo_ttl: int | None = None,
) -> tuple[AuditLog, str | None]:
    """记录一条关键操作日志(不 commit,由调用方同一事务提交)。

    undo_ttl 非空时签发 undo_token 并写入过期时间;返回 (log, token)。
    """
    token = uuid.uuid4().hex if undo_ttl is not None else None
    log = AuditLog(
        tenant_id=user.tenant_id,
        user_id=user.id,
        user_email=user.email,
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        summary=summary,
        detail=json.dumps(detail, ensure_ascii=False, default=str) if detail else "",
        undo_token=token,
        undo_expires_at=(_utcnow() + timedelta(seconds=undo_ttl)) if token else None,
    )
    session.add(log)
    return log, token


def snapshot(obj) -> dict:
    """SQLModel 行 → 可 JSON 快照(排除内部字段;用于删除前的留底)。"""
    data = {}
    for k, v in obj.dict().items():
        if k in {"hashed_password"}:
            continue
        data[k] = v
    return data


# ---------------------------------------------------------------------------
# 回收站兜底清理:超过保留期(UNDO_TTL_SECONDS)的软删作品物理删除。
# DELETE /api/jobs/{id}/permanent 与 trash_purge_loop 共用 purge_job_row 删除路径。
# ---------------------------------------------------------------------------


def purge_job_row(session: Session, job: Job) -> None:
    """物理删除一条作品行(不 commit,由调用方同一事务提交)。

    产物文件留在 worker 输出目录(与软删除一致),只清 DB 行。
    """
    session.delete(job)


def purge_expired_trash(engine, ttl: int = UNDO_TTL_SECONDS) -> int:
    """物理删除超过保留期的软删作品;返回清理行数(独立短事务)。"""
    # deleted_at 列是 naive UTC TIMESTAMP(models.py 注释),截止值同样按 naive 比较
    cutoff = (_utcnow() - timedelta(seconds=ttl)).replace(tzinfo=None)
    with Session(engine) as session:
        rows = session.exec(
            select(Job).where(Job.deleted_at != None, Job.deleted_at < cutoff)  # noqa: E712
        ).all()
        for job in rows:
            purge_job_row(session, job)
        session.commit()
    return len(rows)


# 清理节奏:每小时扫一次(保留期 72h,1h 粒度足够)
TRASH_PURGE_INTERVAL = 3600


async def trash_purge_loop(engine, interval: int = TRASH_PURGE_INTERVAL) -> None:
    """周期性清理过期回收站行(防任何原因导致的堆积,自我修复;同 tracker.reconcile_loop 范式)。"""
    while True:
        await asyncio.sleep(interval)
        try:
            n = purge_expired_trash(engine)
            if n:
                logger.info("回收站清理:物理删除 %d 件过期作品", n)
        except Exception as e:  # noqa: BLE001 — 后台任务绝不能因意外冒泡而静默死掉
            logger.warning("trash purge loop error: %s", e)
