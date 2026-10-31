"""按用户滑动窗口限流测试。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models import User
from app.ratelimit import _hits, enforce_generation_rate_limit, enforce_rate_limit, remaining


def test_rate_limit_consumes_count():
    """按 count 一次性消费 N 个配额。

    深化后:_hits 值为 _Bucket 数据结构,需读 .hits 字段。
    """
    _hits.clear()
    user = User(id="u-count", email="u", hashed_password="x", tenant_id="t")
    enforce_generation_rate_limit(user, count=5)
    assert len(_hits[(user.id, "generation")].hits) == 5


def test_rate_limit_rejects_excess_count():
    """超出窗口余量时抛 429。

    深化后:错误消息从"生成过于频繁"改为"请求过于频繁"(通用化,支持多 scope)。
    """
    _hits.clear()
    user = User(id="u-limit", email="u", hashed_password="x", tenant_id="t")
    enforce_generation_rate_limit(user, count=15)
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user, count=10)
    assert exc.value.status_code == 429
    assert "过于频繁" in exc.value.detail
    # 深化新增:429 响应应携带 Retry-After 头
    assert exc.value.headers is not None
    assert "Retry-After" in exc.value.headers


def test_rate_limit_scope_isolation():
    """深化新增:不同 scope 互不影响。"""
    _hits.clear()
    user = User(id="u-scope", email="u", hashed_password="x", tenant_id="t")
    # generation 满 20,login 仍可用(独立计数)
    enforce_generation_rate_limit(user, count=20)
    enforce_rate_limit(user, count=4, scope="login")  # login 限额 5,4 应通过
    assert remaining(user, "login") == 1


def test_remaining_returns_correct_value():
    """深化新增:remaining() 返回剩余配额。"""
    _hits.clear()
    user = User(id="u-remain", email="u", hashed_password="x", tenant_id="t")
    assert remaining(user, "generation") == 20
    enforce_generation_rate_limit(user, count=8)
    assert remaining(user, "generation") == 12


def test_retry_after_header_set():
    """深化新增:429 响应含 Retry-After 头,值 >=1。"""
    _hits.clear()
    user = User(id="u-retry", email="u", hashed_password="x", tenant_id="t")
    enforce_generation_rate_limit(user, count=20)
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user, count=1)
    ra = int(exc.value.headers["Retry-After"])
    assert 1 <= ra <= 61
