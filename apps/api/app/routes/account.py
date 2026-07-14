"""账号设置路由 —— R18 分区软开关 + 默认智能体偏好的读写。

每用户一个持久化 `nsfw_enabled` 软开关(默认 False=SFW)。前端调本端点切换;
真正的「过滤」由服务端各分区端点强制执行(见 models/marketplace/jobs/generate),
本端点只负责把开关落库。需登录。

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


@router.post("/account/nsfw")
def set_nsfw(
    body: NsfwToggleRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """设置当前用户的 R18 分区软开关,返回最新值。"""
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
    session.commit()
    return {"default_agent_id": user.default_agent_id}
