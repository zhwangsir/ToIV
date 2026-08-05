"""pytest 全局配置。

开发机/部署机上 127.0.0.1:6379 可能有真实 Redis 在跑;为保证测试确定性,
默认禁用 Redis 客户端(各模块走进程内存回退路径,行为与接入 Redis 前一致)。
需要验证 Redis 路径的用例在测试内自行注入 fakeredis 覆盖(get_redis/get_sync_redis)。

限流状态同理:进程内存 _hits 若跨用例累积,登录类用例(同 IP "testclient")
会在全量跑时互相挤占配额 → 业务无关的 429。每个用例前清空,保持隔离。
"""
from __future__ import annotations

import pytest

from app import ratelimit
from app.services import redis_client


@pytest.fixture(autouse=True)
def _disable_redis(monkeypatch):
    redis_client._reset_for_tests()
    monkeypatch.setattr(redis_client, "get_redis", lambda: None)
    monkeypatch.setattr(redis_client, "get_sync_redis", lambda: None)
    yield
    redis_client._reset_for_tests()


@pytest.fixture(autouse=True)
def _clear_ratelimit():
    ratelimit._hits.clear()
    yield
    ratelimit._hits.clear()
