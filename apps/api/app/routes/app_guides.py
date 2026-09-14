"""应用说明书(AppGuide)—— 公开读已发布 + Admin CRUD(P1/P3)。

- GET  /api/apps/{id}/guide          已发布说明书(鉴权同其他 app 读)
- GET  /api/admin/apps/{id}/guide    管理员读(草稿亦可见;无则空壳)
- PUT  /api/admin/apps/{id}/guide    管理员 upsert
- POST /api/admin/apps/{id}/guide/generate   LLM 生成草稿落库(status=draft)
- GET  /api/admin/app-guides         管理员列表全部说明书
- POST /api/admin/app-guides/publish-all     全部 draft 批量发布
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app.agent.llm import LLMError
from app.db import get_session
from app.deps import get_current_admin, get_current_user
from app.models import App, AppGuide, User
from app.nsfw_ctx import nsfw_allowed
from app.services.app_guide_gen import generate_guide_draft, save_guide

router = APIRouter(tags=["app-guides"])

_GUIDE_STATUSES = {"draft", "published"}

# 与 routes/apps._LLM_503_DETAIL 同口径(LLM 不可用统一 503 + 可手工兜底提示)
_LLM_503_DETAIL = "说明卡生成服务暂不可用,请稍后重试;也可以手动编写说明书"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_list(v: Any) -> list:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return []


def _guide_out(g: AppGuide) -> dict:
    return {
        "app_id": g.app_id,
        "purpose": g.purpose or "",
        "when_to_use": g.when_to_use or "",
        "steps": _as_list(g.steps),
        "inputs": _as_list(g.inputs),
        "outputs": _as_list(g.outputs),
        "tips": _as_list(g.tips),
        "related_app_ids": _as_list(g.related_app_ids),
        "status": g.status if g.status in _GUIDE_STATUSES else "draft",
        "updated_at": g.updated_at.isoformat() if g.updated_at else None,
    }


def _empty_guide(app_id: str) -> dict:
    return {
        "app_id": app_id,
        "purpose": "",
        "when_to_use": "",
        "steps": [],
        "inputs": [],
        "outputs": [],
        "tips": [],
        "related_app_ids": [],
        "status": "draft",
        "updated_at": None,
    }


def _app_visible_for_read(a: App, user: User) -> bool:
    """与 routes.apps._visible 对齐:目录尊重 is_public;admin 可见 soft-hide;个人=本人或上架。"""
    if a.user_id:
        return a.user_id == user.id or a.is_public
    if getattr(user, "role", None) == "admin":
        return True
    return bool(a.is_public)


class GuidePut(BaseModel):
    purpose: str = ""
    when_to_use: str = ""
    steps: list[Any] = Field(default_factory=list)
    inputs: list[Any] = Field(default_factory=list)
    outputs: list[Any] = Field(default_factory=list)
    tips: list[Any] = Field(default_factory=list)
    related_app_ids: list[str] = Field(default_factory=list)
    status: Literal["draft", "published"] = "draft"

    @field_validator("related_app_ids", mode="before")
    @classmethod
    def _v_related(cls, v: Any) -> list:
        if v is None:
            return []
        if not isinstance(v, list):
            raise ValueError("related_app_ids 须为数组")
        out: list[str] = []
        for x in v:
            s = str(x).strip()
            if s:
                out.append(s)
        return out


@router.get("/apps/{aid}/guide")
def get_published_guide(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """读已发布说明书;应用不可见或不存在 → 404;草稿/无记录 → 404。"""
    a = session.get(App, aid)
    if not a or not _app_visible_for_read(a, user):
        raise HTTPException(status_code=404, detail="应用不存在")
    if a.is_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=404, detail="应用不存在")
    g = session.get(AppGuide, aid)
    if not g or g.status != "published":
        raise HTTPException(status_code=404, detail="说明书不存在或未发布")
    return _guide_out(g)


@router.get("/admin/app-guides")
def admin_list_guides(
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> list[dict]:
    _ = admin
    rows = session.exec(select(AppGuide).order_by(AppGuide.updated_at.desc())).all()
    return [_guide_out(g) for g in rows]


@router.get("/admin/apps/{aid}/guide")
def admin_get_guide(
    aid: str,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    _ = admin
    if not session.get(App, aid):
        raise HTTPException(status_code=404, detail="应用不存在")
    g = session.get(AppGuide, aid)
    if not g:
        return _empty_guide(aid)
    return _guide_out(g)


@router.put("/admin/apps/{aid}/guide")
def admin_put_guide(
    aid: str,
    body: GuidePut,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    _ = admin
    if not session.get(App, aid):
        raise HTTPException(status_code=404, detail="应用不存在")
    g = session.get(AppGuide, aid)
    if not g:
        g = AppGuide(app_id=aid)
    g.purpose = body.purpose or ""
    g.when_to_use = body.when_to_use or ""
    g.steps = list(body.steps or [])
    g.inputs = list(body.inputs or [])
    g.outputs = list(body.outputs or [])
    g.tips = list(body.tips or [])
    g.related_app_ids = list(body.related_app_ids or [])
    g.status = body.status
    g.updated_at = _now()
    session.add(g)
    session.commit()
    session.refresh(g)
    return _guide_out(g)


@router.post("/admin/apps/{aid}/guide/generate")
async def admin_generate_guide(
    aid: str,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """LLM 生成说明卡草稿并落库(status=draft,不自动发布);返回完整 AppGuide。"""
    _ = admin
    a = session.get(App, aid)
    if not a:
        raise HTTPException(status_code=404, detail="应用不存在")
    try:
        draft = await generate_guide_draft(a)
    except LLMError as e:
        raise HTTPException(status_code=503, detail=_LLM_503_DETAIL) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _guide_out(save_guide(session, aid, draft, status="draft"))


@router.post("/admin/app-guides/publish-all")
def admin_publish_all_guides(
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """全部 draft 说明书批量置 published(批量生成抽检通过后用);返回发布条数。"""
    _ = admin
    rows = session.exec(select(AppGuide).where(AppGuide.status == "draft")).all()
    now = _now()
    for g in rows:
        g.status = "published"
        g.updated_at = now
        session.add(g)
    session.commit()
    return {"published": len(rows)}
