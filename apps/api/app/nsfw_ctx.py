"""薄 re-export —— 决策真源已迁至 `app.redline`(D-U1=B · 账号全局成人态)。

放行看账号 `content_mode=adult`;`X-NSFW` 仅审计(ContextVar),不作判据。
未成年硬阻断优先。新代码请 `from app.redline import ...`。
"""
from __future__ import annotations

from app.redline import (  # noqa: F401
    adult_at_submit,
    adult_mode_enabled,
    is_underage,
    job_nsfw_from_intent,
    nsfw_allowed,
    nsfw_intent_var,
    require_adult_ux,
    require_not_underage,
    require_nsfw_context,
)

__all__ = [
    "adult_at_submit",
    "adult_mode_enabled",
    "is_underage",
    "job_nsfw_from_intent",
    "nsfw_allowed",
    "nsfw_intent_var",
    "require_adult_ux",
    "require_not_underage",
    "require_nsfw_context",
]
