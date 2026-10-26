"""R18/未成年 —— 后端兼容面（2026-10-26 改口径）。

产品拍板：运行时拦截改 **canvas 前端** `@/redline` 路由守卫；
后端不再因缺 X-NSFW / 未成年对生成/列表 **403**。
本地自用可接受 API 直调绕过。

本模块保留函数名与 ContextVar，避免 import 炸测：
  - `nsfw_allowed`：仅「有头 True / 无头 False」，供打标与可选软过滤
  - `require_nsfw_context`：**no-op**（不再 raise）
  - `job_nsfw_from_intent`：显式意图即打标，不因无头 403
  - `is_underage`：仍可供只读/迁移；**不**再参与后端门控

前端真源：`apps/canvas/web/src/redline.ts`。
旧 `app.nsfw_ctx` / `app.r18_policy` 为薄 re-export。
"""
from __future__ import annotations

from contextvars import ContextVar
from datetime import date

from app.models import User

# --- 策略常量 ---
POLICY_ID = "D-U1=B"
POLICY_DECIDED_AT = "2026-10-15"
POLICY_ENFORCEMENT = "frontend-route-guard"  # 2026-10-26：拦截改前端
CANVAS_IS_SOLE_MAIN_UI = True
WEB_INDEPENDENT_NSFW_ZONE_RETIRED = True
ACCOUNT_FLAG_NO_LONGER_ALLOWS = True
REQUEST_HEADER = "X-NSFW"
REQUEST_HEADER_VALUE = "1"
UNDERAGE_HARD_BLOCK = True  # 前端守卫执行；后端不 403
# 无头不再后端 fail-closed 拦业务；保留别名供文档/测试改口径
FAIL_CLOSED_WITHOUT_HEADER = False
FAIL_CLOSED = FAIL_CLOSED_WITHOUT_HEADER
BACKEND_RUNTIME_GATE = False

# 文案码保留（前端失败卡 / 历史分类仍可能引用）
R18_CONTEXT_REQUIRED_DETAIL = "该操作为 R18 内容,须在 R18 上下文(X-NSFW)下使用"
UNDERAGE_BLOCK_DETAIL = "未成年账户不可开启或使用 R18 内容"

nsfw_intent_var: ContextVar[bool] = ContextVar("nsfw_intent", default=False)


def is_underage(user: User | None) -> bool:
    """只读年龄判定（birthdate 空=成年）。后端门控不再调用此结果拦请求。"""
    if user is None:
        return False
    birthdate = getattr(user, "birthdate", None)
    if not birthdate:
        return False
    today = date.today()
    age = today.year - birthdate.year - (
        (today.month, today.day) < (birthdate.month, birthdate.day)
    )
    return age < 18


def nsfw_allowed(user: User | None = None) -> bool:
    """有 X-NSFW 头 → True，否则 False。仅打标/可选软过滤；不 403。

    参数保留兼容调用点。未成年不再在此否决（改前端）。
    """
    _ = user  # 兼容签名
    return nsfw_intent_var.get()


def require_nsfw_context(user: User | None = None) -> None:
    """历史门控入口；2026-10-26 起 **no-op**（拦截改前端路由守卫）。"""
    _ = user
    return None


def job_nsfw_from_intent(user: User | None, explicit: bool) -> bool:
    """作品是否打 R18 标：跟显式意图；无头不再 403。

    无 explicit → False；有 explicit → True（API 直调可打标，本地自用接受）。
    """
    _ = user
    return bool(explicit)


def header_means_nsfw_intent(header_value: str | None) -> bool:
    """中间件唯一解头入口。"""
    return (header_value or "") == REQUEST_HEADER_VALUE
