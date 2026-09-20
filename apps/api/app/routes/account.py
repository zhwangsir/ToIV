"""账号设置路由 —— 默认智能体偏好的读写。

[DEPRECATED] `POST /account/nsfw` 是遗留的 R18 账户软开关端点:`nsfw_enabled`
字段自 2026-08-08 起不再作为任何判定来源(全站统一 X-NSFW 请求头,见 nsfw_ctx),
端点仅为兼容旧客户端保留,仍落库但无实际过滤效果(未成年硬阻断保留)。
前端已无任何调用处;年龄确认改为 /nsfw 专页前端弹窗(localStorage 记录)。

另:`PUT /api/account/preferences` 改当前用户默认智能体 id(顶栏全局默认),
optimize 端点在未显式传 agent_id 时读此值。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.nsfw_ctx import is_underage

router = APIRouter()


class NsfwToggleRequest(BaseModel):
    enabled: bool


class PreferencesRequest(BaseModel):
    default_agent_id: str | None = Field(default=None, max_length=64)
    # 作品库偏好跨端同步(2026-09-21):JSON 字符串(空串=不动该字段);后端只存不解析
    favorites: str | None = Field(default=None, max_length=200_000)
    views: str | None = Field(default=None, max_length=200_000)
    density: str | None = Field(default=None, max_length=16)
    style_cards: str | None = Field(default=None, max_length=400_000)


@router.post("/account/nsfw")
def set_nsfw(
    body: NsfwToggleRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """[DEPRECATED] 遗留 R18 账户软开关:仅落库记录,不再影响任何 NSFW 判定。

    全站 R18 语义统一为 X-NSFW 请求头(nsfw_ctx.nsfw_allowed);本端点只为
    兼容旧客户端保留。未成年硬阻断仍保留,防止遗留开关被未成年账户置位。"""
    # 未成年硬阻断:即便绕过前端也无法开启 R18,服务端兜底拒绝
    if body.enabled and is_underage(user):
        raise HTTPException(status_code=403, detail="未成年用户不可开启 R18 模式")
    user.nsfw_enabled = body.enabled
    session.add(user)
    session.commit()
    return {"nsfw_enabled": user.nsfw_enabled}


@router.put("/account/preferences")
def set_preferences(
    body: PreferencesRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """设置当前用户的默认智能体 id(顶栏全局默认;None=走 kind 默认系统提示)。

    不校验 agent 是否存在 / 是否 NSFW:默认智能体只是偏好,optimize 端点在解析时
    才做存在性/NSFW/applies_to 校验(用户可能设了个后被删的智能体,此时 optimize
    兜底为 kind 默认)。NSFW 智能体作为默认也只会在 /nsfw 专页(带 X-NSFW)下生效。
    """
    user.default_agent_id = body.default_agent_id or None
    session.add(user)
    # 偏好同步:upsert(行可能不存在)
    from app.models import UserPreference
    pref = session.get(UserPreference, user.id)
    if pref is None:
        pref = UserPreference(user_id=user.id)
    changed = False
    for field in ("favorites", "views", "density", "style_cards"):
        val = getattr(body, field)
        if val is not None and val != getattr(pref, field):
            setattr(pref, field, val)
            changed = True
    if changed:
        from datetime import datetime as _dt
        pref.updated_at = _dt.utcnow()
    session.add(pref)
    session.commit()
    return {"default_agent_id": user.default_agent_id}


@router.get("/account/preferences")
def get_preferences(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """拉取跨端偏好(作品库收藏/视图/密度/风格卡);无记录返回空串字段。"""
    from app.models import UserPreference
    pref = session.get(UserPreference, user.id)
    if pref is None:
        return {"favorites": "", "views": "", "density": "", "style_cards": ""}
    return {
        "favorites": pref.favorites,
        "views": pref.views,
        "density": pref.density,
        "style_cards": pref.style_cards,
    }
