"""按用户滑动窗口限流测试。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models import User
from app.ratelimit import _hits, enforce_generation_rate_limit


def test_rate_limit_consumes_count():
    """按 count 一次性消费 N 个配额。"""
    _hits.clear()
    user = User(id="u-count", email="u", hashed_password="x", tenant_id="t")
    enforce_generation_rate_limit(user, count=5)
    assert len(_hits[user.id]) == 5


def test_rate_limit_rejects_excess_count():
    """超出窗口余量时抛 429。"""
    _hits.clear()
    user = User(id="u-limit", email="u", hashed_password="x", tenant_id="t")
    enforce_generation_rate_limit(user, count=15)
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user, count=10)
    assert exc.value.status_code == 429
    assert "生成过于频繁" in exc.value.detail
