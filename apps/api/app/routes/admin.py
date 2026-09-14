"""管理员后台 —— 列出所有用户及用量、删除用户(仅 admin)。"""
from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
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
    # 出生日期(可选,不强制填写)。填写后用于未成年防护硬阻断(R18 不可见)。
    birthdate: Optional[date] = None

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
        birthdate=body.birthdate,
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
    # User/Tenant 之间无 ORM relationship,SQLAlchemy UOW 不保证跨 mapper 删除顺序;
    # flush 强制先发 DELETE FROM user,解除 user_tenant_id_fkey 引用后再删租户,
    # 否则 PG(SQLite 开 FK 亦然)报 ForeignKeyViolation 500。
    session.flush()
    if tenant and not session.exec(select(User).where(User.tenant_id == tenant.id)).first():
        session.delete(tenant)
    from app import audit as _audit

    _audit.record(
        session, user=admin, action="admin.user.delete", target_type="user",
        target_id=user_id, summary=f"管理员删除用户:{user.email}",
        detail={"email": user.email, "tenant_id": user.tenant_id},
    )
    session.commit()
    return {"deleted": user_id}


# ---------------------------------------------------------------------------
# 内置 AI 知识图谱(admin):实体 + 关系 JSON 导出 / 一跳查询
# ---------------------------------------------------------------------------


@router.get("/admin/knowledge-graph")
def admin_knowledge_graph(
    entity: str = Query(default="", max_length=200),
    depth: int = Query(default=1, ge=1, le=3),
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """导出内置 AI 最小知识图谱;带 entity 时只返回命中节点的 ≤depth 跳邻域。

    含 admin 出处字段(RH webappId / civitai / engine.source.url)。普通用户 403。
    """
    from app.services.knowledge_graph import build_builtin_knowledge_graph, query_neighborhood

    _ = admin  # 门控已由 Depends(get_current_admin) 完成
    graph = build_builtin_knowledge_graph(session)
    if entity.strip():
        sub = query_neighborhood(graph, entity, depth=depth)
        return {"mode": "query", "entity": entity, "depth": depth, **sub}
    return {"mode": "export", **graph}
