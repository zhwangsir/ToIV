"""薄 re-export —— 决策真源已迁至 `app.redline`(D-U1=B)。

按请求的 R18 放行标记:`X-NSFW: 1` header → ContextVar(见 redline.nsfw_intent_var)。
canvas 内建 R18 门控模式;后端只认请求级意图,账户开关不放行;fail-closed;
未成年硬阻断优先。新代码请 `from app.redline import ...`;本模块仅防炸既有 import。


2026-10-26:运行时拦截改 canvas `@/redline` 路由守卫；本模块为 thin re-export。
"""
from __future__ import annotations

from app.redline import (  # noqa: F401
    is_underage,
    job_nsfw_from_intent,
    nsfw_allowed,
    nsfw_intent_var,
    require_nsfw_context,
)

__all__ = [
    "is_underage",
    "job_nsfw_from_intent",
    "nsfw_allowed",
    "nsfw_intent_var",
    "require_nsfw_context",
]
