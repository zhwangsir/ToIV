"""R18/未成年红线 —— 后端唯一决策真源(D-U1=B)。

产品口径:
  1. canvas = 唯一主 UI;开启 R18 后客户端附 `X-NSFW: 1`。
  2. 后端只认请求级意图(本模块 ContextVar);账户 `nsfw_enabled` 废弃不放行。
  3. 未成年硬阻断优先于任何头/开关(法律底线)。
  4. fail-closed:无 `X-NSFW` → 成人模型/智能体/作品一律不可见/不可操作;
     **SFW 主站不依赖红线开关**,无头时行为完整可用。

路由/服务须 `from app.redline import ...`;禁止私自解析 X-NSFW 头。
中间件只负责置位 `nsfw_intent_var`;决策一律走本模块函数。
旧 `app.nsfw_ctx` / `app.r18_policy` 为薄 re-export,勿再扩逻辑。
"""
from __future__ import annotations

from contextvars import ContextVar
from datetime import date

from fastapi import HTTPException

from app.models import User

# --- 策略常量(测试与运维文档交叉引用) ---
POLICY_ID = "D-U1=B"
POLICY_DECIDED_AT = "2026-10-15"
CANVAS_IS_SOLE_MAIN_UI = True
WEB_INDEPENDENT_NSFW_ZONE_RETIRED = True  # 架构目标;经典壳引擎台残债另见决策卡
ACCOUNT_FLAG_NO_LONGER_ALLOWS = True
REQUEST_HEADER = "X-NSFW"
REQUEST_HEADER_VALUE = "1"
UNDERAGE_HARD_BLOCK = True
FAIL_CLOSED_WITHOUT_HEADER = True
FAIL_CLOSED = FAIL_CLOSED_WITHOUT_HEADER  # 别名,对外统一口径

# 403 文案码(路由勿自拟绕过语义)
R18_CONTEXT_REQUIRED_DETAIL = "该操作为 R18 内容,须在 R18 上下文(X-NSFW)下使用"
UNDERAGE_BLOCK_DETAIL = "未成年账户不可开启或使用 R18 内容"

# 每请求隔离(async 安全):中间件按 header 置位,gate/模型列表/作品库读取。
nsfw_intent_var: ContextVar[bool] = ContextVar("nsfw_intent", default=False)


def is_underage(user: User | None) -> bool:
    """判断用户是否未成年(birthdate 为空视为成年,避免破坏老数据)。

    WHY:未成年防护硬阻断的基础判定。老数据无 birthdate,空值放行以兼容;
    一旦填写且不足 18 岁,则 nsfw_allowed 与 R18 开关端点均拒绝。
    """
    if user is None:
        return False
    # getattr 兜底:测试替身(SimpleNamespace 等)与无此字段的 user-like 对象
    # 视为未填写生日(成年),避免破坏既有调用点
    birthdate = getattr(user, "birthdate", None)
    if not birthdate:
        return False
    today = date.today()
    # 已过今年生日则岁差为 0,否则 -1:修正跨月/跨日的实际年龄
    age = today.year - birthdate.year - (
        (today.month, today.day) < (birthdate.month, birthdate.day)
    )
    return age < 18


def nsfw_allowed(user: User | None = None) -> bool:
    """R18 放行:仅当本请求带 `X-NSFW: 1`(canvas R18 模式或其它显式上下文)。

    账户开关不再放行(fail-closed)。未成年硬阻断优先级最高:即便带头也一律拒绝。
    参数保留为兼容既有调用点。无头时返回 False —— SFW 路径仍完整可用。
    """
    if is_underage(user):
        return False
    return nsfw_intent_var.get()


def require_nsfw_context(user: User | None = None) -> None:
    """显式要求当前请求处于 R18 上下文;否则 403。不改变 SFW 调用方行为。"""
    if not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail=R18_CONTEXT_REQUIRED_DETAIL)


def job_nsfw_from_intent(user: User | None, explicit: bool) -> bool:
    """作品是否打 R18 标:只跟作品意图走,不跟「人是否开了 R18 模式」单独走。

    X-NSFW 头只做门控(explicit=True 时须放行,否则 403),不能单独把
    试衣/超分/普通二次元打进成人库。
    """
    if not explicit:
        return False
    require_nsfw_context(user)
    return True


def header_means_nsfw_intent(header_value: str | None) -> bool:
    """中间件唯一解头入口:比较原始头值是否等于 REQUEST_HEADER_VALUE。"""
    return (header_value or "") == REQUEST_HEADER_VALUE
