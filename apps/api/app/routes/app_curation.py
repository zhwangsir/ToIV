"""市场策展层(2026-09-12)—— 用途分类打标 + 精选合集位 + 分类导航统计。

- POST /api/admin/apps/{aid}/use-case/generate  LLM 打标落库(产出不在枚举回退 other)
- PUT  /api/admin/apps/{aid}/curation           人工改 use_case / featured 开关
- GET  /api/apps/use-cases/summary              分类导航统计(可见性/NSFW 门控同列表)

注意:本路由的 /apps/use-cases/summary 是两段路径,与 routes/apps 的
GET /apps/{aid}(单段)不冲突;注册顺序在 apps 之后(main.py)。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.agent.llm import LLMError
from app.db import get_session
from app.deps import get_current_admin, get_current_user
from app.models import App, User
from app.nsfw_ctx import nsfw_allowed
from app.routes.apps import _visible
from app.services.app_use_case_gen import classify_use_case, save_use_case
from app.services.use_cases import USE_CASE_IDS, USE_CASES

router = APIRouter(tags=["app-curation"])

# 与 routes/app_guides._LLM_503_DETAIL 同口径(LLM 不可用统一 503 + 可手工兜底提示)
_LLM_503_DETAIL = "用途分类服务暂不可用,请稍后重试;也可以手动设置分类"

_FALLBACK_USE_CASE = "other"


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CurationPut(BaseModel):
    use_case: str | None = None
    featured: bool | None = None

    @field_validator("use_case")
    @classmethod
    def _v_use_case(cls, v: Any) -> str | None:
        if v is None:
            return None
        s = str(v).strip()
        if s not in USE_CASE_IDS:
            raise ValueError(f"use_case 须为 {sorted(USE_CASE_IDS)} 之一")
        return s


@router.post("/admin/apps/{aid}/use-case/generate")
async def admin_generate_use_case(
    aid: str,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """LLM 判定用途分类并落库;产出不在枚举时回退 other(fallback=true)。"""
    _ = admin
    a = session.get(App, aid)
    if not a:
        raise HTTPException(status_code=404, detail="应用不存在")
    try:
        use_case, fallback = await classify_use_case(session, a)
    except LLMError as e:
        raise HTTPException(status_code=503, detail=_LLM_503_DETAIL) from e
    save_use_case(session, aid, use_case)
    return {"app_id": aid, "use_case": use_case, "fallback": fallback}


@router.put("/admin/apps/{aid}/curation")
def admin_put_curation(
    aid: str,
    body: CurationPut,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """人工改用途分类/精选开关;只动这两列(内置应用也可策展,不受 PUT 白名单限制)。"""
    _ = admin
    a = session.get(App, aid)
    if not a:
        raise HTTPException(status_code=404, detail="应用不存在")
    if body.use_case is not None:
        a.use_case = body.use_case
    if body.featured is not None:
        a.featured = body.featured
    a.updated_at = _now()
    session.add(a)
    session.commit()
    session.refresh(a)
    return {"app_id": a.id, "use_case": a.use_case or "", "featured": bool(a.featured)}


@router.get("/apps/use-cases/summary")
def use_cases_summary(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """各用途分类的可见应用计数(导航位数据源)。

    可见性口径与 GET /api/apps 列表一致:_visible(目录尊重 is_public;个人=本人
    或上架;admin 可见 soft-hide)+ NSFW 门控(无 X-NSFW 头不计 nsfw 应用)。
    12 类全量返回(count 可为 0),顺序 = 导航展示顺序。
    """
    allow_nsfw = nsfw_allowed(user)
    counts: dict[str, int] = {uc: 0 for uc, _ in USE_CASES}
    # 行数不大(550 级),按列表口径逐行过滤
    for a in session.exec(select(App)).all():
        if not _visible(a, user):
            continue
        if a.is_nsfw and not allow_nsfw:
            continue
        uc = (a.use_case or "").strip()
        if uc in counts:
            counts[uc] += 1
    return [{"id": uc, "label": label, "count": counts[uc]} for uc, label in USE_CASES]
