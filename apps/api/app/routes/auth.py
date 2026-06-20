"""鉴权路由：注册 / 登录 / 当前用户。

同步 def 路由由 FastAPI 在线程池执行，避免阻塞事件循环。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Tenant, User
from app.security import create_token, hash_password, verify_password

router = APIRouter()


def _normalize_email(v: str) -> str:
    v = v.strip().lower()
    if "@" not in v or "." not in v.split("@")[-1]:
        raise ValueError("邮箱格式无效")
    return v


class RegisterRequest(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=6, max_length=128)

    @field_validator("email")
    @classmethod
    def _v_email(cls, v: str) -> str:
        return _normalize_email(v)


class LoginRequest(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def _v_email(cls, v: str) -> str:
        return _normalize_email(v)


def _auth_payload(user: User, credits: int) -> dict:
    return {
        "token": create_token(user.id),
        "user": {"id": user.id, "email": user.email},
        "credits": credits,
    }


@router.post("/auth/register")
def register(body: RegisterRequest, session: Session = Depends(get_session)) -> dict:
    if session.exec(select(User).where(User.email == body.email)).first():
        raise HTTPException(status_code=409, detail="该邮箱已注册")
    settings = get_settings()
    tenant = Tenant(name=body.email.split("@")[0], credits=settings.signup_credits)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return _auth_payload(user, tenant.credits)


@router.post("/auth/login")
def login(body: LoginRequest, session: Session = Depends(get_session)) -> dict:
    user = session.exec(select(User).where(User.email == body.email)).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    tenant = session.get(Tenant, user.tenant_id)
    return _auth_payload(user, tenant.credits if tenant else 0)


@router.get("/auth/me")
def me(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    tenant = session.get(Tenant, user.tenant_id)
    return {
        "user": {"id": user.id, "email": user.email},
        "credits": tenant.credits if tenant else 0,
    }
