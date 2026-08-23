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
from app.comfy import client as comfy_client
from app.services import engine_registry, redis_client


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


@pytest.fixture(autouse=True)
def _clear_engine_avail_cache():
    """引擎可用性短 TTL 缓存跨请求共享,用例间须重置保证探测替身生效。"""
    engine_registry.reset_avail_cache()
    yield
    engine_registry.reset_avail_cache()


@pytest.fixture(autouse=True)
def _clear_comfy_client_pool():
    """comfy.client 模块级 AsyncClient 池的传输连接绑定创建时的事件循环;
    pytest-asyncio 每用例一个新循环,跨用例复用会抛
    'bound to a different event loop'(全量跑时污染后续用例)。
    用例间直接清空缓存字典——测试环境允许连接随 GC 回收,
    不能走 close_clients()(旧循环绑定的传输在新循环 aclose 会再抛同款错)。"""
    comfy_client._http_clients.clear()
    yield
    comfy_client._http_clients.clear()


@pytest.fixture(autouse=True)
def _pref_dataset_tmp(monkeypatch, tmp_path):
    """偏好数据集导出目录指向临时目录:finalize 自动导出钩子默认开,
    不隔离的话任何跑 finalize 的用例会往仓库 data/preference_dataset/ 写文件。"""
    from app.config import get_settings

    monkeypatch.setattr(
        get_settings(), "pref_dataset_dir", str(tmp_path / "preference_dataset")
    )
