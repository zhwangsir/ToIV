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

from sqlmodel import Session

from app.models import AuditLog, User

# 撤销窗口:作品软删除后 10 分钟内可恢复(前端 toast 展示倒计时入口)
UNDO_TTL_SECONDS = 600


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
