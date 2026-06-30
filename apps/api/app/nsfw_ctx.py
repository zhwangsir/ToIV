"""按请求的 R18 放行标记 —— /nsfw 专页通过 `X-NSFW: 1` header 放行成人内容,
**不动账户全局开关**(主页 / 作品库 / 模型列表零痕迹)。

ContextVar 每请求隔离(async 安全):中间件按 header 置位,gate/模型列表读取。
账户 nsfw_enabled 与本请求标记取「或」—— 两条路任一开启即放行。
"""
from __future__ import annotations

from contextvars import ContextVar

from app.models import User

nsfw_intent_var: ContextVar[bool] = ContextVar("nsfw_intent", default=False)


def nsfw_allowed(user: User) -> bool:
    """R18 放行:账户已开 OR 本请求带 /nsfw 专页标记。"""
    return bool(getattr(user, "nsfw_enabled", False)) or nsfw_intent_var.get()
