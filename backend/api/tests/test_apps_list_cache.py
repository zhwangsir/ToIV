"""市场列表缓存单飞+会话早释(2026-09-21 生产事故修复)回归测试。

事故链:目录规模化(5140 公开应用,7MB 列表)后,/api/apps 慢流式响应在
FastAPI「yield 依赖响应流完才 teardown」语义下把 DB 会话挂到流完,
默认池 5+10 全楔死(pg 15 条 idle in transaction)→ 全 API 假死。
修复:①池显式放大+pre_ping;②list_apps 命中/冷路径返回 Response 前
显式 session.close();③缓存重建全局单飞(double-check)。
"""
from __future__ import annotations

import threading
import time

from app.services import apps_list_cache


def test_cache_put_get_bump_cycle():
    key = apps_list_cache.make_key("u1", False, {"q": ""})
    apps_list_cache.bump()
    key = apps_list_cache.make_key("u1", False, {"q": ""})
    assert apps_list_cache.get(key) is None
    apps_list_cache.put(key, b"[]")
    assert apps_list_cache.get(key) == b"[]"
    apps_list_cache.bump()
    # bump 后版本号变了,旧 key 不再命中;新 key 也未写入
    assert apps_list_cache.get(key) is None


def test_cache_ttl_expiry(monkeypatch):
    key = ("vtest", "u2", False, ())
    apps_list_cache.put(key, b"{}")
    assert apps_list_cache.get(key) == b"{}"
    real = time.monotonic
    monkeypatch.setattr(apps_list_cache.time, "monotonic", lambda: real() + 999)
    assert apps_list_cache.get(key) is None


def test_rebuild_lock_is_global_singleton():
    assert apps_list_cache.rebuild_lock() is apps_list_cache.rebuild_lock()
    assert isinstance(apps_list_cache.rebuild_lock(), type(threading.Lock()))


def test_list_apps_source_early_close_and_singleflight():
    """list_apps 三条返回路径都必须先 session.close() 再返回流式 Response,
    且冷路径走 rebuild_lock 单飞(double-check)——防止回退到挂会话流式。"""
    import inspect

    from app.routes import apps as apps_routes

    src = inspect.getsource(apps_routes.list_apps)
    assert src.count("session.close()") >= 3, "命中/单飞复核/冷路径三处都必须显式早释会话"
    assert "apps_list_cache.rebuild_lock()" in src, "冷路径必须走单飞锁"
    lock_idx = src.index("apps_list_cache.rebuild_lock()")
    # 锁内必须二次 get(double-check),否则单飞形同虚设
    after = src[lock_idx:]
    assert after.count("apps_list_cache.get(key)") >= 1, "锁内须二次 get 复核"


def test_db_engine_pool_kwargs_for_postgres():
    """db.py 必须对 PG URL 显式池放大+保活(默认 5+10 在慢流下会楔死);
    SQLite 路径不得携带池参数(源码不变式,防回退)。"""
    import inspect

    from app import db as db_mod

    src = inspect.getsource(db_mod)
    assert '"pool_size": 20' in src
    assert '"max_overflow": 20' in src
    assert '"pool_pre_ping": True' in src
    assert '"pool_recycle": 1800' in src
    assert '"pool_timeout": 15' in src
    assert '_settings.database_url.startswith("sqlite")' in src
