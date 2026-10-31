"""Redis 客户端单例(带降级) —— 限流 / 画布事件 / worker 健康缓存共用。

生产 core 上 Redis 监听 127.0.0.1:6379(仅 localhost,无密码),经 TOIV_REDIS_URL 配置。

降级思路与 NAS 降级(app/storage.py 的 drama_output_root)一致:外部依赖可挂,请求不报错。
任何一次 Redis 操作失败,调用方捕获后调 mark_down():
1. 记 warning(限频,避免日志洪水);
2. 进入 _DOWN_COOLDOWN 秒冷却期,期间 get_redis()/get_sync_redis() 直接返回 None,
   各调用方走进程内存回退(单进程行为,与接入 Redis 前一致);
3. 冷却结束后自动放行重试,Redis 恢复后无需重启自动回切。
"""
from __future__ import annotations

import logging
import time

import redis
import redis.asyncio as aioredis

from app.config import get_settings

logger = logging.getLogger(__name__)

# 操作失败后的冷却期(秒):期间不再尝试 Redis,避免每次请求都阻塞在连接超时上
_DOWN_COOLDOWN = 15.0
# warning 限频:同一进程每 60s 最多记一次降级日志
_WARN_INTERVAL = 60.0
# 连接/操作超时:限流在请求热路径上,失败必须快速让位给内存回退
_CONNECT_TIMEOUT = 0.5
_OP_TIMEOUT = 1.0

_async_client: aioredis.Redis | None = None
_sync_client: redis.Redis | None = None
_down_until: float = 0.0  # monotonic 时间戳;> now 表示冷却中
_last_warn: float = 0.0


def _redis_url() -> str:
    return get_settings().redis_url


def _is_down() -> bool:
    return time.monotonic() < _down_until


def mark_down(exc: BaseException) -> None:
    """上报一次 Redis 操作失败:进入冷却期并限频记 warning。

    各调用方在捕获 redis.RedisError / OSError 后调用,随后走进程内存回退。
    """
    global _down_until, _last_warn
    now = time.monotonic()
    _down_until = now + _DOWN_COOLDOWN
    if now - _last_warn >= _WARN_INTERVAL:
        _last_warn = now
        logger.warning(
            "Redis 不可达,降级为进程内存实现,%.0f 秒后重试: %s",
            _DOWN_COOLDOWN, exc,
        )


def get_redis() -> aioredis.Redis | None:
    """返回 async Redis 单例;冷却期内(视为不可达)返回 None,调用方走内存回退。"""
    global _async_client
    if _is_down():
        return None
    if _async_client is None:
        _async_client = aioredis.from_url(
            _redis_url(),
            decode_responses=True,
            socket_connect_timeout=_CONNECT_TIMEOUT,
            socket_timeout=_OP_TIMEOUT,
        )
    return _async_client


def get_sync_redis() -> redis.Redis | None:
    """返回 sync Redis 单例(供同步调用方,如限流器);冷却期内返回 None。"""
    global _sync_client
    if _is_down():
        return None
    if _sync_client is None:
        _sync_client = redis.from_url(
            _redis_url(),
            decode_responses=True,
            socket_connect_timeout=_CONNECT_TIMEOUT,
            socket_timeout=_OP_TIMEOUT,
        )
    return _sync_client


def backend_status() -> str:
    """当前后端状态,供 stats()/health 展示:"redis" / "memory"(降级中)。"""
    return "memory" if _is_down() else "redis"


def _reset_for_tests() -> None:
    """测试专用:清空单例与冷却状态。"""
    global _async_client, _sync_client, _down_until, _last_warn
    _async_client = None
    _sync_client = None
    _down_until = 0.0
    _last_warn = 0.0
