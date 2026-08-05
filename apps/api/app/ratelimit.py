"""按用户的滑动窗口限流(Redis 优先,进程内存回退)。

生产多进程共享:优先走 Redis(sorted set 滑动窗口,Lua 原子化);
Redis 不可达时自动降级进程内存(单进程行为),恢复后自动回切 —— 见 app/services/redis_client.py。

深化要点(2026-07-26):
1. 多维度限流:不同接口可设不同配额(生成 20/min、登录 5/min、上传 10/min)。
2. 内存回收:空闲用户(>10min 无请求)的 bucket 自动从 _hits 移除,防长期累积。
3. 配额查询:remaining(user, scope) 返回剩余配额,供前端展示倒计时。
4. 精确滑动窗口:使用 monotonic 时间戳 deque,边界精确到毫秒。
5. 重试建议:429 响应携带 Retry-After(窗口剩余时间)。
"""
from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass

import redis as redis_lib
from fastapi import HTTPException

from app.models import User
from app.services import redis_client

# 默认窗口配置:scope → (window_seconds, max_per_window)
_DEFAULT_SCOPES: dict[str, tuple[float, int]] = {
    "generation": (60.0, 20),  # 生成类:每分钟 20 次
    "login": (60.0, 5),        # 登录:每分钟 5 次(防爆破)
    "upload": (60.0, 10),      # 上传:每分钟 10 次
    "default": (60.0, 20),     # 默认
}

# 向后兼容:旧测试用例直接引用 _MAX_PER_WINDOW(_hits[user.id] 旧结构)
# 新实现用 (user_id, scope) 维度,但导出此常量保持 import 兼容
_MAX_PER_WINDOW = _DEFAULT_SCOPES["generation"][1]
# 空闲用户 bucket 回收阈值(秒):超过此时间无请求则从内存移除
_GC_IDLE_SECONDS = 600.0
# GC 触发频率:每 N 次调用检查一次(避免每次调用都遍历)
_GC_CHECK_INTERVAL = 50
_gc_counter = 0


@dataclass
class _Bucket:
    """单用户单 scope 的滑动窗口。"""
    hits: deque[float]
    last_active: float  # 最后一次请求时间(monotonic)


# 按 (user_id|subject, scope) 维度分桶;user 维度为 int,登录等匿名主体为 str
_hits: dict[tuple[int | str, str], _Bucket] = defaultdict(
    lambda: _Bucket(hits=deque(), last_active=0.0)
)


def _get_scope_config(scope: str) -> tuple[float, int]:
    """获取 scope 对应的窗口配置(秒, 配额)。"""
    return _DEFAULT_SCOPES.get(scope, _DEFAULT_SCOPES["default"])


def _maybe_gc() -> None:
    """空闲 bucket 回收:遍历移除超过 _GC_IDLE_SECONDS 无请求的桶。
    每 _GC_CHECK_INTERVAL 次调用触发一次,避免热路径开销。
    """
    global _gc_counter
    _gc_counter += 1
    if _gc_counter % _GC_CHECK_INTERVAL != 0:
        return
    now = time.monotonic()
    stale = [key for key, bucket in _hits.items()
             if now - bucket.last_active > _GC_IDLE_SECONDS]
    for key in stale:
        _hits.pop(key, None)


# ────────────────────────────────
# Redis 滑动窗口(多进程共享;不可达时回退进程内存)
# 键:toiv:ratelimit:{scope}:{user_id}(sorted set,score=命中时间戳 ms,TTL=窗口)
# ────────────────────────────────

# 原子化「清窗 → 计数 → 判断 → 记命中 → 设 TTL」。
# ARGV: now_ms, window_ms, count, max_per, 随后 count 个唯一 member。
# 返回 {1, 0} 放行;{0, 0} 拒绝(retry 提示由 Python 侧另查最早命中计算 ——
# 拒绝是冷路径,多一次 RTT 可忽略;且避免在 Lua 里用 WITHSCORES,
# 其回包结构在真 Redis(扁平)与 fakeredis(嵌套)间不一致,会破坏测试替身)。
_LUA_HIT = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local n = redis.call('ZCARD', KEYS[1])
local count = tonumber(ARGV[3])
local max_per = tonumber(ARGV[4])
if n + count > max_per then
  return {0, 0}
end
for i = 0, count - 1 do
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + i * 0.001, ARGV[5 + i])
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return {1, 0}
"""


def _redis_key(user_id: str, scope: str) -> str:
    return f"toiv:ratelimit:{scope}:{user_id}"


def _redis_hit(r: redis_lib.Redis, user_id: str, scope: str, count: int,
               window: float, max_per: int) -> tuple[bool, float]:
    """经 Redis 消费配额。返回 (是否放行, 拒绝时的 retry_after 秒)。"""
    now_ms = int(time.time() * 1000)
    window_ms = int(window * 1000)
    key = _redis_key(user_id, scope)
    # member 必须唯一(同 ms 多次命中),后缀随机串防冲突
    members = [f"{now_ms}-{uuid.uuid4().hex}-{i}" for i in range(count)]
    allowed, _ = r.register_script(_LUA_HIT)(
        keys=[key],
        args=[now_ms, window_ms, count, max_per, *members],
    )
    if not allowed:
        # 拒绝冷路径:另查最早命中计算 retry 提示(不阻塞计数原子性)
        oldest = r.zrange(key, 0, 0, withscores=True)
        retry_after = window
        if oldest:
            retry_after = max(1.0, window - (now_ms - float(oldest[0][1])) / 1000.0)
        return False, retry_after
    return True, 0.0


def _redis_remaining(r: redis_lib.Redis, user_id: str, scope: str,
                     window: float, max_per: int) -> int:
    """经 Redis 查询剩余配额。"""
    now_ms = int(time.time() * 1000)
    window_ms = int(window * 1000)
    key = _redis_key(user_id, scope)
    _, n = r.pipeline(transaction=False).zremrangebyscore(
        key, "-inf", now_ms - window_ms).zcard(key).execute()
    return max(0, max_per - int(n))


def _raise_429(retry_after: float) -> None:
    raise HTTPException(
        status_code=429,
        detail=f"请求过于频繁,请 {retry_after:.0f} 秒后重试",
        headers={"Retry-After": str(int(retry_after) + 1)},
    )


def _enforce_subject(subject: int | str, scope: str, count: int = 1) -> None:
    """滑动窗口限流核心:主体可以是已认证 user.id(int)或匿名主体字符串(IP/账号)。"""
    if count < 1:
        raise ValueError("count 必须 >= 1")
    window, max_per = _get_scope_config(scope)

    # Redis 优先(多进程共享);不可达时降级进程内存
    r = redis_client.get_sync_redis()
    if r is not None:
        try:
            allowed, retry_after = _redis_hit(
                r, str(subject), scope, count, window, max_per)
            if not allowed:
                _raise_429(retry_after)
            return
        except HTTPException:
            raise
        except (redis_lib.RedisError, OSError) as exc:
            redis_client.mark_down(exc)
            # 继续走进程内存回退

    now = time.monotonic()
    key = (subject, scope)
    bucket = _hits[key]
    bucket.last_active = now

    # 清理窗口外的历史命中
    cutoff = now - window
    while bucket.hits and bucket.hits[0] < cutoff:
        bucket.hits.popleft()

    if len(bucket.hits) + count > max_per:
        # 计算最早命中何时过期,作为 Retry-After 建议
        if bucket.hits:
            retry_after = max(1.0, window - (now - bucket.hits[0]))
        else:
            retry_after = window
        raise HTTPException(
            status_code=429,
            detail=f"请求过于频繁,请 {retry_after:.0f} 秒后重试",
            headers={"Retry-After": str(int(retry_after) + 1)},
        )

    for _ in range(count):
        bucket.hits.append(now)

    _maybe_gc()


def enforce_rate_limit(
    user: User,
    count: int = 1,
    *,
    scope: str = "generation",
) -> None:
    """通用滑动窗口限流(已认证用户)。

    Args:
        user: 当前用户。
        count: 本次请求消费的配额数(必须 >=1)。
        scope: 限流维度 — "generation" / "login" / "upload" / "default"。
               不同 scope 独立计数,互不影响。

    Raises:
        HTTPException(429): 超出配额,detail 含 retry_after 建议秒数。
    """
    _enforce_subject(user.id, scope, count)


def enforce_login_rate_limit(ip: str, account: str) -> None:
    """登录接口限流(认证前匿名主体)。

    双维度:
    - IP 维度("default" 20/min):防跨账号凭证喷洒;
    - IP+账号 维度("login" 5/min):防单账号密码爆破。
    """
    _enforce_subject(f"ip:{ip}", "default")
    _enforce_subject(f"ip:{ip}|acct:{account}", "login")


def enforce_generation_rate_limit(user: User, count: int = 1) -> None:
    """每用户每分钟最多 _MAX_PER_WINDOW 次生成,一次性请求 N 张时消费 N 个配额。

    向后兼容:委托给通用 enforce_rate_limit(scope="generation")。
    """
    enforce_rate_limit(user, count, scope="generation")


def remaining(user: User, scope: str = "generation") -> int:
    """查询指定用户在指定 scope 的剩余配额(供前端展示倒计时)。

    Returns:
        剩余可用次数(>=0)。
    """
    window, max_per = _get_scope_config(scope)

    # Redis 优先;不可达时降级进程内存
    r = redis_client.get_sync_redis()
    if r is not None:
        try:
            return _redis_remaining(r, str(user.id), scope, window, max_per)
        except (redis_lib.RedisError, OSError) as exc:
            redis_client.mark_down(exc)

    now = time.monotonic()
    key = (user.id, scope)
    bucket = _hits.get(key)
    if bucket is None:
        return max_per
    # 清理窗口外
    cutoff = now - window
    while bucket.hits and bucket.hits[0] < cutoff:
        bucket.hits.popleft()
    return max(0, max_per - len(bucket.hits))


def stats() -> dict:
    """返回限流器全局统计(供 /health 展示)。"""
    return {
        "tracked_buckets": len(_hits),
        "scopes": list(_DEFAULT_SCOPES.keys()),
        "gc_idle_seconds": _GC_IDLE_SECONDS,
        "backend": redis_client.backend_status(),
    }
