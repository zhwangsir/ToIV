"""按用户的简单滑动窗口限流(进程内)。

P2 单进程开发够用;多进程 / 生产环境应换成 Redis 实现。
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException

from app.models import User

_WINDOW_SECONDS = 60.0
_MAX_PER_WINDOW = 20

_hits: dict[str, deque[float]] = defaultdict(deque)


def enforce_generation_rate_limit(user: User) -> None:
    """每用户每分钟最多 _MAX_PER_WINDOW 次生成,超限抛 429。"""
    now = time.monotonic()
    bucket = _hits[user.id]
    while bucket and now - bucket[0] > _WINDOW_SECONDS:
        bucket.popleft()
    if len(bucket) >= _MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="生成过于频繁，请稍后再试")
    bucket.append(now)
