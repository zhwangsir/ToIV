"""鉴权路由：登录 / 当前用户。

不开放自助注册 —— 账号由管理员统一发放(见 routes/admin.py)。
账号标识为用户名(不强制邮箱),由管理员创建。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.security import create_token, verify_password
from app.usage import user_usage


def normalize_account(value: str) -> str:
    v = value.strip().lower()
    if not (3 <= len(v) <= 64):
        raise ValueError("账号长度需 3-64")
    return v


class LoginRequest(BaseModel):
    email: str  # 账号标识(用户名)
    password: str

    @field_validator("email")
    @classmethod
    def _v(cls, v: str) -> str:
        return normalize_account(v)


router = APIRouter()


def _user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "nsfw_enabled": user.nsfw_enabled,
    }


@router.post("/auth/login")
def login(body: LoginRequest, session: Session = Depends(get_session)) -> dict:
    user = session.exec(select(User).where(User.email == body.email)).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="账号或密码错误")
    return {"token": create_token(user.id), "user": _user_dict(user)}


@router.get("/auth/me")
def me(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"user": _user_dict(user), "usage": user_usage(session, user.id)}
