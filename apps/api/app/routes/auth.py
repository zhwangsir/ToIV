"""鉴权路由：登录 / 当前用户。

不开放自助注册 —— 账号由管理员统一发放(见 routes/admin.py)。
账号标识为用户名(不强制邮箱),由管理员创建。
"""
from __future__ import annotations

import hmac
import secrets

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Tenant, User
from app.ratelimit import enforce_login_rate_limit, enforce_subject_rate_limit
from app.security import create_token, hash_password, verify_password
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
def test_login(body: TestLoginRequest, request: Request, session: Session = Depends(get_session)) -> dict:
    """AI 测试通道:密钥换 admin token,免登录表单。仅 TOIV_TEST_KEY 非空且匹配时放行。
    前端 /?testkey=<key> 调它一跳进 app。密钥可随时在 .env 清空停用。"""
    key = get_settings().test_key.strip()
    # 生产环境关闭测试通道:test_key 为空时直接 404，避免暴露"该端点存在测试通道"这一信息给攻击者
    if not key:
        raise HTTPException(status_code=404, detail="测试通道未启用")
    # 认证前限流:复用 login scope(60s/5 次)防密钥爆破;主体按 IP+端点维度,
    # 与 /auth/login 的配额互不影响。放在 404 判定之后,未启用环境不消耗配额
    enforce_subject_rate_limit(f"ip:{_client_ip(request)}|test-login", "login")
    # 常量时间比较,防时序侧信道探测密钥
    if not hmac.compare_digest(body.key.encode(), key.encode()):
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


# ──────────────────────────────────────────────────────────
# 微信小程序登录:code 换 openid,首登自动开户,返回形状与 /auth/login 一致
# ──────────────────────────────────────────────────────────
class WechatLoginRequest(BaseModel):
    code: str  # 小程序 wx.login() 拿到的临时登录凭证
    nickname: str | None = None  # 可选昵称(User 无昵称字段,不入库,仅占位兼容前端传参)

    @field_validator("code")
    @classmethod
    def _v(cls, v: str) -> str:
        v = v.strip()
        if not (1 <= len(v) <= 128):
            raise ValueError("code 长度需 1-128")
        return v


def _wechat_code2session(code: str, appid: str, secret: str) -> dict:
    """调腾讯 jscode2session 用 code 换 openid(同步短超时 5s)。
    抽成模块级私有函数便于测试 monkeypatch;网络异常 → 502。"""
    try:
        resp = httpx.get(
            "https://api.weixin.qq.com/sns/jscode2session",
            params={
                "appid": appid,
                "secret": secret,
                "js_code": code,
                "grant_type": "authorization_code",
            },
            timeout=5.0,
        )
        return resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="微信服务不可达") from exc


def _default_tenant(session: Session) -> Tenant:
    """默认租户:当前单租户现状,取库中第一个(按 created_at 稳定排序);
    无任何记录则创建 name="default" 的租户(首个微信用户场景)。"""
    tenant = session.exec(select(Tenant).order_by(Tenant.created_at)).first()
    if tenant is None:
        tenant = Tenant(name="default")
        session.add(tenant)
        session.commit()
        session.refresh(tenant)
    return tenant


def _create_wechat_user(session: Session, openid: str) -> User:
    """微信首登自动开户:email 用 wx-{openid}@wechat.local 占位(满足 unique);
    密码为随机占位串 —— 该账号永远走微信通道,不可账密登录。"""
    tenant = _default_tenant(session)
    user = User(
        email=f"wx-{openid}@wechat.local",
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        tenant_id=tenant.id,
        role="user",
        wechat_openid=openid,
    )
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        # 极小概率撞 email 唯一约束:追加短随机后缀重试一次
        session.rollback()
        user.email = f"{user.email}-{secrets.token_hex(4)}"
        session.add(user)
        session.commit()
    session.refresh(user)
    return user


@router.post("/auth/wechat")
def wechat_login(
    body: WechatLoginRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    # 认证前限流:对齐 test-login 写法,按 IP+端点维度复用 login scope(60s/5 次)
    enforce_subject_rate_limit(f"ip:{_client_ip(request)}|wechat-login", "login")
    settings = get_settings()
    if settings.wechat_dev_bypass:
        # 开发过渡:不调腾讯,code 直接映射 deterministic openid(生产必须关)
        openid = f"dev-{body.code}"
    else:
        if not (settings.wechat_appid.strip() and settings.wechat_secret):
            raise HTTPException(status_code=503, detail="微信登录未配置")
        data = _wechat_code2session(
            body.code, settings.wechat_appid, settings.wechat_secret
        )
        errcode = data.get("errcode", 0)
        if errcode:
            raise HTTPException(
                status_code=401,
                detail=f"微信登录失败: errcode={errcode} {data.get('errmsg', '')}",
            )
        openid = data.get("openid")
        if not openid:
            raise HTTPException(status_code=502, detail="微信服务响应异常")
    user = session.exec(select(User).where(User.wechat_openid == openid)).first()
    if user is None:
        user = _create_wechat_user(session, openid)
    return {"token": create_token(user.id), "user": _user_dict(user)}
