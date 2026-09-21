"""市场列表响应缓存(2026-09-17 性能修复)。

GET /api/apps 每次都全表查询 + 2195 行构造 + JSON 序列化(2MB,实测 4-14s,
封面批并发时更糟)。列表是热路径且容忍短暂陈旧:这里按 (user, 查询参数,
版本号) 缓存编码后的 JSON 字节,TTL 45s;任何用户/管理侧写操作调 bump()
立即失效(封面 demo/smoke 等后台美化写不 bump,靠 TTL 过期,陈旧 ≤45s
可接受)。缓存的是 jsonable 字节,命中时跳过 pydantic 序列化。
"""
from __future__ import annotations

import threading
import time

_TTL_S = 45.0
_MAX_ENTRIES = 12
_VER = 0
_CACHE: dict[tuple, tuple[float, bytes]] = {}
# 单飞重建锁(2026-09-21):缓存失效/TTL 过期瞬间,N 个并发请求会各自全表查询+
# 5140 行构造(冷路径 10-30s),每条都占住一个 DB 连接——目录规模化后叠加慢流式
# 挂会话可直接楔死连接池。重建全局单飞:后来者等首个重建完直接吃新缓存。
_REBUILD_LOCK = threading.Lock()


def bump() -> None:
    """任意应用写操作后调用:立刻失效全部缓存条目。"""
    global _VER
    _VER += 1
    _CACHE.clear()


def make_key(user_id: str, allow_nsfw: bool, params: dict) -> tuple:
    return (_VER, user_id, allow_nsfw, tuple(sorted((k, str(v)) for k, v in params.items())))


def get(key: tuple) -> bytes | None:
    hit = _CACHE.get(key)
    if not hit:
        return None
    at, payload = hit
    if time.monotonic() - at > _TTL_S:
        _CACHE.pop(key, None)
        return None
    return payload


def put(key: tuple, payload: bytes) -> None:
    if len(_CACHE) >= _MAX_ENTRIES:
        oldest = min(_CACHE, key=lambda k: _CACHE[k][0])
        _CACHE.pop(oldest, None)
    _CACHE[key] = (time.monotonic(), payload)


def rebuild_lock() -> threading.Lock:
    """缓存重建单飞锁:get 未命中后在锁内二次 get,double-check 防重复重建。"""
    return _REBUILD_LOCK
