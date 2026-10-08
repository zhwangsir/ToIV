"""密码哈希(标准库 pbkdf2,零额外依赖)与 JWT 令牌。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings

_ROUNDS = 200_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ROUNDS)
    return f"pbkdf2_sha256${_ROUNDS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt_b64, hash_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(rounds))
        return hmac.compare_digest(dk, expected)
    except (ValueError, TypeError):
        return False


def create_token(user_id: str, *, scope: str | None = None, expire_minutes: int | None = None) -> str:
    """签发 JWT。scope 非空 = 受限服务令牌(只能访问 app.token_policy.SCOPES[scope] 列出的接口)。"""
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": now + timedelta(minutes=expire_minutes or s.jwt_expire_minutes),
    }
    if scope:
        payload["scope"] = scope
        payload["typ"] = "service"
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256")


def decode_token_claims(token: str) -> dict | None:
    """校验签名与过期并返回完整 claims;失败返回 None。"""
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return payload if isinstance(payload, dict) and payload.get("sub") else None


def decode_token(token: str) -> str | None:
    payload = decode_token_claims(token)
    return payload.get("sub") if payload else None


def token_sha256(token: str) -> str:
    """令牌指纹(完整 sha256 hex):吊销清单只存指纹,不存令牌本身。"""
    return hashlib.sha256(token.encode()).hexdigest()
