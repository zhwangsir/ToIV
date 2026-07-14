"""按请求的 R18 放行标记 —— **仅** /nsfw 专页通过 `X-NSFW: 1` header 放行成人内容。

主站(toiv.dgmt.top)彻底零 R18:请求不带 /nsfw 标记则一律过滤成人内容,账户开关
**不再**放行(防非内部人员在主站看到任何 R18)。R18 必须经 toiv.dgmt.top/nsfw 访问。

ContextVar 每请求隔离(async 安全):中间件按 header 置位,gate/模型列表/作品库读取。
"""
from __future__ import annotations

from contextvars import ContextVar
from datetime import date

from app.models import User

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
    """R18 放行:仅当本请求带 /nsfw 专页标记(X-NSFW header)。账户开关不再放行,
    保证主站零 R18。

    未成年硬阻断优先级最高:即便带 /nsfw 标记也一律拒绝,防未成年绕过专页
    标记访问 R18 模型/内容。参数保留为兼容既有调用点。"""
    # 未成年硬阻断:任何 NSFW 不可见,优先于请求级 X-NSFW 标记
    if is_underage(user):
        return False
    return nsfw_intent_var.get()
