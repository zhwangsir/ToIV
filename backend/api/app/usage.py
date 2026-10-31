"""用量统计 —— 按作业类型统计某用户的生成次数。"""
from __future__ import annotations

from sqlmodel import Session, func, select

from app.models import Job


def user_usage(session: Session, user_id: str) -> dict:
    rows = session.exec(
        select(Job.kind, func.count())
        .where(Job.user_id == user_id)
        .group_by(Job.kind)
    ).all()
    by_kind = {kind: count for kind, count in rows}
    return {"total": sum(by_kind.values()), "by_kind": by_kind}
