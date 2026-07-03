"""按请求的 R18 放行标记 —— **仅** /nsfw 专页通过 `X-NSFW: 1` header 放行成人内容。

主站(toiv.dgmt.top)彻底零 R18:请求不带 /nsfw 标记则一律过滤成人内容,账户开关
**不再**放行(防非内部人员在主站看到任何 R18)。R18 必须经 toiv.dgmt.top/nsfw 访问。

ContextVar 每请求隔离(async 安全):中间件按 header 置位,gate/模型列表/作品库读取。
"""
from __future__ import annotations

from contextvars import ContextVar

from app.models import User

nsfw_intent_var: ContextVar[bool] = ContextVar("nsfw_intent", default=False)


def nsfw_allowed(_user: User | None = None) -> bool:
    """R18 放行:仅当本请求带 /nsfw 专页标记(X-NSFW header)。账户开关不再放行,
    保证主站零 R18。参数保留仅为兼容既有调用点。"""
    return nsfw_intent_var.get()
