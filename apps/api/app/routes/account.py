"""账号设置路由 —— 内容模式 / 默认智能体偏好。

`GET|PATCH /me/mode` + `GET|PUT /account/content-mode`:账号全局成人态(ordinary|adult)读写。
content_mode 供前端同步与快照;切换只写库,不 cancel 在途任务(后端不加闸)。
多设备:写后更新 content_mode_updated_at,客户端 ≤30s 轮询本端点或 /auth/me。

[DEPRECATED] `POST /account/nsfw` 遗留软开关:仍落库 nsfw_enabled,但若 enabled=True
会同步将 content_mode 置 adult(兼容旧客户端);判定真源仍是 content_mode。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.redline import (
    CONTENT_MODE_ADULT,
    CONTENT_MODE_ORDINARY,
    CONTENT_MODES,
    account_content_mode,
    normalize_content_mode,
    require_not_underage,
)

router = APIRouter()


class NsfwToggleRequest(BaseModel):
    enabled: bool


class ContentModeRequest(BaseModel):
    content_mode: str = Field(..., max_length=16)


class PreferencesRequest(BaseModel):
    default_agent_id: str | None = Field(default=None, max_length=64)
    # 作品库偏好跨端同步(2026-09-21):JSON 字符串(空串=不动该字段);后端只存不解析
    favorites: str | None = Field(default=None, max_length=200_000)
    views: str | None = Field(default=None, max_length=200_000)
    density: str | None = Field(default=None, max_length=16)
    style_cards: str | None = Field(default=None, max_length=400_000)


def _mode_payload(user: User) -> dict:
    mode = account_content_mode(user)
    updated = getattr(user, "content_mode_updated_at", None)
    return {
        "content_mode": mode,
        "updated_at": updated.isoformat() if updated else None,
    }


def _set_content_mode(user: User, mode: str, session: Session) -> User:
    mode = normalize_content_mode(mode)
    if mode == CONTENT_MODE_ADULT:
        # P0-5 R5:require_not_underage 已 no-op;切 adult 不得 403
        require_not_underage(user)
    prev = account_content_mode(user)
    user.content_mode = mode
    # 兼容遗留列:成人态时标记曾经开启
    # 同步遗留列(兼容 /auth/me.nsfw_enabled 透出)
    user.nsfw_enabled = mode == CONTENT_MODE_ADULT
    if mode != prev:
        user.content_mode_updated_at = datetime.now(timezone.utc)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@router.get("/account/content-mode")
def get_content_mode(
    user: User = Depends(get_current_user),
) -> dict:
    """拉取账号全局内容模式(多设备轮询用;含 updated_at)。"""
    return _mode_payload(user)


@router.put("/account/content-mode")
def set_content_mode(
    body: ContentModeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """切换账号全局内容模式。不 cancel 任何在途任务;403 只影响后续新请求。"""
    raw = (body.content_mode or "").strip().lower()
    # 接受 ordinary|adult 与过渡别名 sfw|nsfw|r18
    if raw not in CONTENT_MODES and raw not in ("sfw", "nsfw", "r18"):
        raise HTTPException(
            status_code=422,
            detail=f"content_mode 须为 {CONTENT_MODE_ORDINARY} 或 {CONTENT_MODE_ADULT}",
        )
    user = _set_content_mode(user, raw, session)
    return _mode_payload(user)


@router.post("/account/nsfw")
def set_nsfw(
    body: NsfwToggleRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """[DEPRECATED] 遗留开关:enabled=True → content_mode=adult;False → ordinary。

    仍写 nsfw_enabled;判定真源为 content_mode。未成年硬关只前端(R5)。
    """
    mode = CONTENT_MODE_ADULT if body.enabled else CONTENT_MODE_ORDINARY
    user = _set_content_mode(user, mode, session)
    return {
        "nsfw_enabled": user.nsfw_enabled,
        "content_mode": account_content_mode(user),
        "updated_at": (
            user.content_mode_updated_at.isoformat()
            if user.content_mode_updated_at
            else None
        ),
    }




@router.get("/me/mode")
def get_me_mode(
    user: User = Depends(get_current_user),
) -> dict:
    """账号全局内容模式(前端 redline 真源轮询)。等价 GET /account/content-mode。"""
    return _mode_payload(user)


@router.patch("/me/mode")
def patch_me_mode(
    body: ContentModeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """切换账号全局内容模式。不 cancel 在途;403 只拦后续新请求。"""
    raw = (body.content_mode or "").strip().lower()
    if raw not in CONTENT_MODES and raw not in ("sfw", "nsfw", "r18"):
        raise HTTPException(
            status_code=422,
            detail=f"content_mode 须为 {CONTENT_MODE_ORDINARY} 或 {CONTENT_MODE_ADULT}",
        )
    user = _set_content_mode(user, raw, session)
    return _mode_payload(user)


@router.put("/account/preferences")
def set_preferences(
    body: PreferencesRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """设置当前用户的默认智能体 id(顶栏全局默认;None=走 kind 默认系统提示)。

    不校验 agent 是否存在 / 是否 NSFW:默认智能体只是偏好,optimize 端点在解析时
    才做存在性/NSFW/applies_to 校验。NSFW 智能体作为默认也只会在成人态下生效。
    """
    user.default_agent_id = body.default_agent_id or None
    session.add(user)
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
