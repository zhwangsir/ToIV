"""账号设置路由 —— R18 分区软开关的读写。

每用户一个持久化 `nsfw_enabled` 软开关(默认 False=SFW)。前端调本端点切换;
真正的「过滤」由服务端各分区端点强制执行(见 models/marketplace/jobs/generate),
本端点只负责把开关落库。需登录。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User

router = APIRouter()


class NsfwToggleRequest(BaseModel):
    enabled: bool


@router.post("/account/nsfw")
def set_nsfw(
    body: NsfwToggleRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """设置当前用户的 R18 分区软开关,返回最新值。"""
    user.nsfw_enabled = body.enabled
    session.add(user)
    session.commit()
    return {"nsfw_enabled": user.nsfw_enabled}
