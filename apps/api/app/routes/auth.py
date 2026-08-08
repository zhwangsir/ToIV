"""鉴权路由：登录 / 当前用户。

不开放自助注册 —— 账号由管理员统一发放(见 routes/admin.py)。
账号标识为用户名(不强制邮箱),由管理员创建。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_login_rate_limit
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
        # [DEPRECATED] 遗留 R18 账户软开关,仅作历史记录透出;不再作为任何判定来源
        "nsfw_enabled": user.nsfw_enabled,
        "default_agent_id": getattr(user, "default_agent_id", None),
    }


def _client_ip(request: Request) -> str:
    """取真实客户端 IP:经反代(OpenResty/Nginx)时取 X-Forwarded-For 首跳。"""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


@router.post("/auth/login")
def login(
    body: LoginRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    # 认证前限流:IP 20/min(防喷洒)+ IP+账号 5/min(防爆破);超限 429
    enforce_login_rate_limit(_client_ip(request), body.email)
    user = session.exec(select(User).where(User.email == body.email)).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="账号或密码错误")
    return {"token": create_token(user.id), "user": _user_dict(user)}


class TestLoginRequest(BaseModel):
    key: str


@router.post("/auth/test-login")
def test_login(body: TestLoginRequest, session: Session = Depends(get_session)) -> dict:
    """AI 测试通道:密钥换 admin token,免登录表单。仅 TOIV_TEST_KEY 非空且匹配时放行。
    前端 /?testkey=<key> 调它一跳进 app。密钥可随时在 .env 清空停用。"""
    key = get_settings().test_key.strip()
    # 生产环境关闭测试通道:test_key 为空时直接 404，避免暴露"该端点存在测试通道"这一信息给攻击者
    if not key:
        raise HTTPException(status_code=404, detail="测试通道未启用")
    if body.key != key:
        raise HTTPException(status_code=403, detail="测试通道密钥错误")
    # 发配置的 admin 账号 token(便于 AI 测全部功能,含管理台);无则取任一 admin
    email = get_settings().admin_email.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first() if email else None
    if user is None:
        user = session.exec(select(User).where(User.role == "admin")).first()
    if user is None:
        raise HTTPException(status_code=503, detail="无可用管理员账号")
    return {"token": create_token(user.id), "user": _user_dict(user)}


@router.get("/auth/me")
def me(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"user": _user_dict(user), "usage": user_usage(session, user.id)}
