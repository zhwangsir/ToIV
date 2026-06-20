"""管理员后台 —— 列出所有用户及用量、删除用户(仅 admin)。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_admin
from app.models import Job, Tenant, User
from app.routes.auth import normalize_account
from app.security import hash_password
from app.usage import user_usage

router = APIRouter()


class CreateUserRequest(BaseModel):
    email: str  # 账号(用户名)
    password: str = Field(min_length=6, max_length=128)
    role: str = "user"

    @field_validator("email")
    @classmethod
    def _v_account(cls, v: str) -> str:
        return normalize_account(v)

    @field_validator("role")
    @classmethod
    def _v_role(cls, v: str) -> str:
        return v if v in ("user", "admin") else "user"


def _user_summary(user: User, session: Session) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "created_at": user.created_at.isoformat(),
        "usage": user_usage(session, user.id),
    }


@router.post("/admin/users")
def create_user(
    body: CreateUserRequest,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    if session.exec(select(User).where(User.email == body.email)).first():
        raise HTTPException(status_code=409, detail="账号已存在")
    tenant = Tenant(name=body.email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        tenant_id=tenant.id,
        role=body.role,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return _user_summary(user, session)


@router.get("/admin/users")
def list_users(
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> list[dict]:
    users = session.exec(select(User).order_by(User.created_at)).all()
    return [
        {
            "id": u.id,
            "email": u.email,
            "role": u.role,
            "created_at": u.created_at.isoformat(),
            "usage": user_usage(session, u.id),
        }
        for u in users
    ]


@router.delete("/admin/users/{user_id}")
def delete_user(
    user_id: str,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="不能删除自己")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    # 删除其作业与租户,彻底清理
    for job in session.exec(select(Job).where(Job.user_id == user.id)).all():
        session.delete(job)
    tenant = session.get(Tenant, user.tenant_id)
    session.delete(user)
    if tenant:
        session.delete(tenant)
    session.commit()
    return {"deleted": user_id}
