"""Redis 接入(限流/画布事件/worker 健康缓存)测试。

正常路径用 fakeredis 验证;降级路径模拟 Redis 抛错,断言回退进程内存且不报错。
全局 conftest 已默认禁用 Redis(走内存回退),本文件按需注入 fakeredis 覆盖。
"""
from __future__ import annotations

import asyncio
import json
import time

import fakeredis
import fakeredis.aioredis
import pytest
import redis as redis_lib
from fastapi import HTTPException

from app import canvas_events
from app.comfy.pool import WorkerPool
from app.models import User
from app.ratelimit import _hits, enforce_generation_rate_limit, remaining
from app.services import redis_client


def _user(uid: str) -> User:
    return User(id=uid, email="u", hashed_password="x", tenant_id="t")


# ────────────────────────────────
# redis_client 熔断降级
# ────────────────────────────────


def test_redis_client_mark_down_enters_cooldown(monkeypatch):
    """mark_down 后冷却期内 get_* 返回 None,backend_status 变 memory。"""
    monkeypatch.undo()  # 恢复真实 get_redis/get_sync_redis(conftest 默认禁用)
    assert redis_client.get_sync_redis() is not None
    assert redis_client.backend_status() == "redis"
    redis_client.mark_down(redis_lib.ConnectionError("boom"))
    assert redis_client.get_sync_redis() is None
    assert redis_client.get_redis() is None
    assert redis_client.backend_status() == "memory"


def test_redis_client_recovers_after_cooldown(monkeypatch):
    """冷却期结束后自动放行重试(Redis 恢复无需重启回切)。"""
    monkeypatch.undo()
    redis_client.mark_down(redis_lib.ConnectionError("boom"))
    assert redis_client.get_sync_redis() is None
    # 把冷却截止时间拨到过去,模拟冷却期结束
    monkeypatch.setattr(redis_client, "_down_until", time.monotonic() - 1)
    assert redis_client.get_sync_redis() is not None
    assert redis_client.backend_status() == "redis"


def test_mark_down_logs_warning_throttled(monkeypatch, caplog):
    """降级记 warning 且限频(60s 内只记一次)。"""
    monkeypatch.undo()
    with caplog.at_level("WARNING", logger="app.services.redis_client"):
        redis_client.mark_down(redis_lib.ConnectionError("boom"))
        redis_client.mark_down(redis_lib.ConnectionError("boom2"))
    warnings = [r for r in caplog.records if "降级为进程内存" in r.message]
    assert len(warnings) == 1


# ────────────────────────────────
# 限流器:Redis 正常路径
# ────────────────────────────────


def _inject_sync_redis(monkeypatch) -> fakeredis.FakeStrictRedis:
    fake = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr(redis_client, "get_sync_redis", lambda: fake)
    return fake


def test_ratelimit_redis_path_consumes_and_429(monkeypatch):
    """Redis 路径:配额计数落 Redis(sorted set),超额 429 带 Retry-After。"""
    fake = _inject_sync_redis(monkeypatch)
    _hits.clear()
    user = _user("u-redis-rl")
    enforce_generation_rate_limit(user, count=15)
    key = "toiv:ratelimit:generation:u-redis-rl"
    assert fake.zcard(key) == 15
    assert 0 < fake.pttl(key) <= 60_000  # 键带 TTL(窗口时长)
    assert len(_hits) == 0  # Redis 路径不写进程内存
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user, count=10)
    assert exc.value.status_code == 429
    assert "Retry-After" in (exc.value.headers or {})
    assert fake.zcard(key) == 15  # 拒绝不消费配额


def test_ratelimit_redis_remaining(monkeypatch):
    """remaining() 走 Redis 计数。"""
    _inject_sync_redis(monkeypatch)
    user = _user("u-redis-remain")
    assert remaining(user) == 20
    enforce_generation_rate_limit(user, count=8)
    assert remaining(user) == 12


def test_ratelimit_shared_across_clients(monkeypatch):
    """两个客户端(模拟两个进程)共享同一配额桶。"""
    server = fakeredis.FakeServer()
    c1 = fakeredis.FakeStrictRedis(server=server, decode_responses=True)
    c2 = fakeredis.FakeStrictRedis(server=server, decode_responses=True)
    user = _user("u-redis-shared")
    monkeypatch.setattr(redis_client, "get_sync_redis", lambda: c1)
    enforce_generation_rate_limit(user, count=20)  # 进程 1 用满
    monkeypatch.setattr(redis_client, "get_sync_redis", lambda: c2)
    with pytest.raises(HTTPException) as exc:  # 进程 2 看到同样额度
        enforce_generation_rate_limit(user)
    assert exc.value.status_code == 429


# ────────────────────────────────
# 限流器:Redis 不可达 → 进程内存回退
# ────────────────────────────────


class _BrokenSyncRedis(fakeredis.FakeStrictRedis):
    """register_script 即抛连接错误,模拟 Redis 不可达。"""

    def register_script(self, script):  # noqa: ARG002
        raise redis_lib.ConnectionError("redis down")


def test_ratelimit_falls_back_to_memory(monkeypatch):
    """Redis 抛错 → 自动降级进程内存,请求不报错,行为与接入前一致。"""
    broken = _BrokenSyncRedis(decode_responses=True)
    monkeypatch.setattr(redis_client, "get_sync_redis", lambda: broken)
    _hits.clear()
    user = _user("u-fallback")
    enforce_generation_rate_limit(user, count=5)  # 不抛异常
    assert len(_hits[(user.id, "generation")].hits) == 5  # 落在内存桶
    assert redis_client._is_down()  # 已进入冷却期
    # 降级后限流语义不变:超额仍 429
    enforce_generation_rate_limit(user, count=15)
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user, count=1)
    assert exc.value.status_code == 429


def test_ratelimit_remaining_falls_back_to_memory(monkeypatch):
    """remaining() 的 Redis 失败同样回退内存,不报错。"""
    broken = _BrokenSyncRedis(decode_responses=True)
    monkeypatch.setattr(redis_client, "get_sync_redis", lambda: broken)
    _hits.clear()
    user = _user("u-fallback-remain")
    assert remaining(user) == 20


# ────────────────────────────────
# 画布事件:Redis relay 跨进程投递 + 降级
# ────────────────────────────────


async def test_canvas_publish_also_goes_to_redis(monkeypatch):
    """publish 进程内投递不变,同时尽力发到 Redis channel。"""
    server = fakeredis.FakeServer()
    api_redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    other = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    monkeypatch.setattr(redis_client, "get_redis", lambda: api_redis)

    q = canvas_events.subscribe_queue("cv-pub")
    try:
        await asyncio.sleep(0.05)  # 等 relay 订阅就绪
        # 另一个"进程"挂 pubsub 收 channel
        ps = other.pubsub()
        await ps.subscribe("toiv:canvas:cv-pub")
        await canvas_events.publish("cv-pub", {"kind": "node", "id": 1})
        assert (await asyncio.wait_for(q.get(), 1)) == {"kind": "node", "id": 1}
        # Redis channel 上也收到了(带 origin 防回声)
        msg = await asyncio.wait_for(ps.get_message(timeout=1), 2)
        while msg is None or msg.get("type") != "message":
            msg = await asyncio.wait_for(ps.get_message(timeout=1), 2)
        payload = json.loads(msg["data"])
        assert payload["event"] == {"kind": "node", "id": 1}
        assert payload["origin"] == canvas_events._ORIGIN
        await ps.unsubscribe("toiv:canvas:cv-pub")
        await ps.aclose()
        await asyncio.sleep(0.05)  # 让 relay 消费掉自己发的事件(应跳过)
        assert q.empty()  # 自己发出的事件不被 relay 回声重复投递
    finally:
        canvas_events.unsubscribe_queue("cv-pub", q)


async def test_canvas_relay_delivers_remote_events(monkeypatch):
    """其他进程发到 Redis channel 的事件经 relay 回投本进程订阅者。"""
    server = fakeredis.FakeServer()
    api_redis = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    other = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    monkeypatch.setattr(redis_client, "get_redis", lambda: api_redis)

    q = canvas_events.subscribe_queue("cv-relay")
    try:
        await asyncio.sleep(0.05)  # 等 relay 订阅就绪
        await other.publish(
            "toiv:canvas:cv-relay",
            json.dumps({"origin": "other-process", "event": {"kind": "edge", "id": 7}}),
        )
        assert (await asyncio.wait_for(q.get(), 1)) == {"kind": "edge", "id": 7}
    finally:
        canvas_events.unsubscribe_queue("cv-relay", q)


async def test_canvas_publish_survives_redis_failure(monkeypatch):
    """Redis publish 抛错 → 只记降级,进程内投递不受影响,请求不报错。"""

    class _BrokenAsyncRedis:
        async def publish(self, *a, **kw):
            raise redis_lib.ConnectionError("redis down")

        def pubsub(self):
            raise redis_lib.ConnectionError("redis down")

    monkeypatch.setattr(redis_client, "get_redis", lambda: _BrokenAsyncRedis())
    q = canvas_events.subscribe_queue("cv-down")
    try:
        await canvas_events.publish("cv-down", {"kind": "node", "id": 2})
        assert (await asyncio.wait_for(q.get(), 1)) == {"kind": "node", "id": 2}
        assert redis_client._is_down()
    finally:
        canvas_events.unsubscribe_queue("cv-down", q)


# ────────────────────────────────
# worker 健康缓存:Redis 共享 + 降级
# ────────────────────────────────


class _ProbeClient:
    """带调用计数的 ComfyUIClient 替身。"""

    def __init__(self, name: str, qlen: int):
        self.base_url = f"http://{name}:8000"
        self._qlen = qlen
        self.calls = 0

    async def queue_len(self) -> int:
        self.calls += 1
        return self._qlen


async def test_pool_health_cache_shared_via_redis(monkeypatch):
    """进程 1 探测结果写 Redis;进程 2 命中共享缓存,免真实探测。"""
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(redis_client, "get_redis", lambda: fake)

    a1, b1 = _ProbeClient("wa", qlen=5), _ProbeClient("wb", qlen=1)
    pool1 = WorkerPool([a1, b1])
    assert (await pool1.pick()) is b1  # 触发真实探测并共享
    assert a1.calls == 1 and b1.calls == 1
    data = await fake.hgetall("toiv:worker-health:http://wb:8000")
    assert data["queue_len"] == "1"
    assert int(await fake.ttl("toiv:worker-health:http://wb:8000")) > 0

    a2, b2 = _ProbeClient("wa", qlen=99), _ProbeClient("wb", qlen=99)
    pool2 = WorkerPool([a2, b2])
    assert (await pool2.pick()) is b2  # 共享缓存:b 仍是最闲
    assert a2.calls == 0 and b2.calls == 0  # 未发起真实探测


async def test_pool_falls_back_when_redis_down(monkeypatch):
    """Redis 读写抛错 → 降级为本进程缓存,真实探测照常,不报错。"""

    class _BrokenAsyncRedis:
        async def hgetall(self, *a, **kw):
            raise redis_lib.ConnectionError("redis down")

        async def hset(self, *a, **kw):
            raise redis_lib.ConnectionError("redis down")

        async def expire(self, *a, **kw):
            raise redis_lib.ConnectionError("redis down")

    monkeypatch.setattr(redis_client, "get_redis", lambda: _BrokenAsyncRedis())
    busy, idle = _ProbeClient("px-busy", qlen=9), _ProbeClient("px-idle", qlen=1)
    pool = WorkerPool([busy, idle])
    assert (await pool.pick()) is idle
    assert busy.calls == 1 and idle.calls == 1  # 走了真实探测
    assert redis_client._is_down()
