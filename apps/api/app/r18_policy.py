"""薄 re-export —— 策略常量真源已迁至 `app.redline`。

新代码请 `from app.redline import POLICY_ID, REQUEST_HEADER, ...`。


2026-10-26:运行时拦截改 canvas `@/redline` 路由守卫；本模块为 thin re-export。
"""
from __future__ import annotations

from app.redline import (  # noqa: F401
    ACCOUNT_FLAG_NO_LONGER_ALLOWS,
    CANVAS_IS_SOLE_MAIN_UI,
    FAIL_CLOSED,
    FAIL_CLOSED_WITHOUT_HEADER,
    POLICY_DECIDED_AT,
    POLICY_ID,
    REQUEST_HEADER,
    REQUEST_HEADER_VALUE,
    UNDERAGE_HARD_BLOCK,
    WEB_INDEPENDENT_NSFW_ZONE_RETIRED,
)

__all__ = [
    "ACCOUNT_FLAG_NO_LONGER_ALLOWS",
    "CANVAS_IS_SOLE_MAIN_UI",
    "FAIL_CLOSED",
    "FAIL_CLOSED_WITHOUT_HEADER",
    "POLICY_DECIDED_AT",
    "POLICY_ID",
    "REQUEST_HEADER",
    "REQUEST_HEADER_VALUE",
    "UNDERAGE_HARD_BLOCK",
    "WEB_INDEPENDENT_NSFW_ZONE_RETIRED",
]
