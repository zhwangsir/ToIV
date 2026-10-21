"""F3：北向 KPI 事件写入 + 汇总读取。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.services import product_kpi as kpi

router = APIRouter(tags=["product-kpi"])


class KpiEventIn(BaseModel):
    event_type: str = Field(min_length=1, max_length=64)
    project_id: str = Field(default="", max_length=64)
    payload: dict[str, Any] | None = None


@router.post("/studio/kpi/events")
def post_kpi_event(
    body: KpiEventIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    try:
        row = kpi.record_event(
            session,
            tenant_id=user.tenant_id,
            user_id=user.id,
            project_id=body.project_id or "",
            event_type=body.event_type,
            payload=body.payload,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {
        "id": row.id,
        "event_type": row.event_type,
        "project_id": row.project_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/studio/kpi/summary")
def get_kpi_summary(
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return kpi.summarize(session, tenant_id=user.tenant_id, days=days)
