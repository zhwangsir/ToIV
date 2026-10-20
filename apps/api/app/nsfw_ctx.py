"""按请求的 R18 放行标记 —— `X-NSFW: 1` header → ContextVar。

D-U1=B(2026-10-15):canvas 内建 R18 门控模式,开启后客户端在**全部** ToIV API
请求上附加本头;后端只认请求级意图,账户 `nsfw_enabled` **不再**放行。
web 独立 /nsfw 专区面已退役(架构目标);遗留「经典壳暂留 NSFW 引擎台」是 F12
执行债,不改变本模块语义。

fail-closed:无头 → 成人内容不可见/不可操作。未成年硬阻断优先于任何头。

ContextVar 每请求隔离(async 安全):中间件按 header 置位,gate/模型列表/作品库读取。
策略常量见 `app.r18_policy`。
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
    """R18 放行:仅当本请求带 `X-NSFW: 1`(canvas R18 模式或其它显式上下文)。

    账户开关不再放行(fail-closed)。未成年硬阻断优先级最高:即便带头也一律拒绝。
    参数保留为兼容既有调用点。
    """
    if is_underage(user):
        return False
    return nsfw_intent_var.get()


def job_nsfw_from_intent(user: User | None, explicit: bool) -> bool:
    """作品是否打 R18 标:只跟作品意图走,不跟「人是否开了 R18 模式」单独走。

    X-NSFW 头只做门控(explicit=True 时须放行,否则 403),不能单独把
    试衣/超分/普通二次元打进成人库。
    """
    if not explicit:
        return False
    if not nsfw_allowed(user):
        from fastapi import HTTPException

        raise HTTPException(
            status_code=403,
            detail="该操作为 R18 内容,须在 R18 上下文(X-NSFW)下使用",
        )
    return True
