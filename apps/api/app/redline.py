"""R18/未成年红线 —— 后端唯一决策真源(D-U1=B)·账号全局成人态。

产品口径(2026-10-26 TL 钉死 · 账号全局):
  1. **成人态作用域=账号全局**:状态存服务端 `User.content_mode`
     (`ordinary` | `adult`,默认 ordinary)。
  2. **403 唯一判据=账号态**:`nsfw_allowed(user)` 只看账号 `content_mode`
     + 未成年硬关; **不信任**前端声明。`X-NSFW` 仅审计旁路(ContextVar),
     不得单独放行。
  3. 未成年硬阻断优先于账号成人态(法律底线;成人态不得覆盖)。
  4. 双闸:前端 `redline.ts` UX + 本模块 API 硬闸。成人路径完整放行 NSFW,
     物理上不得进入 softening 管道。
  5. 在途任务:提交时快照 `Job.adult_at_submit`;切模式不 cancel 在途;
     403 只拦新请求。

路由/服务须 `from app.redline import ...`;禁止私自解析 X-NSFW 作判据。
中间件可置位 `nsfw_intent_var` 供审计;决策一律走本模块函数。
旧 `app.nsfw_ctx` / `app.r18_policy` 为薄 re-export,勿再扩逻辑。
"""
from __future__ import annotations

from contextvars import ContextVar
from datetime import date
from typing import Any, Literal

from fastapi import HTTPException

from app.models import User

# --- 策略常量(测试与运维文档交叉引用) ---
POLICY_ID = "D-U1=B"
POLICY_DECIDED_AT = "2026-10-26"
POLICY_ENFORCEMENT = "dual-gate-account"  # Wave1+: frontend UX + backend 403 on account mode
BACKEND_RUNTIME_GATE = True
CANVAS_IS_SOLE_MAIN_UI = True
WEB_INDEPENDENT_NSFW_ZONE_RETIRED = True
# 历史名保留:曾表示「账户 nsfw_enabled 不放行」。现账号 content_mode 为唯一放行源。
ACCOUNT_FLAG_NO_LONGER_ALLOWS = False
ACCOUNT_CONTENT_MODE_IS_SOLE_ALLOW = True
REQUEST_HEADER = "X-NSFW"  # 仅审计;不作 403 判据
REQUEST_HEADER_VALUE = "1"
UNDERAGE_HARD_BLOCK = True
FAIL_CLOSED_WITHOUT_HEADER = False  # 头不再作判据;兼容别名见 FAIL_CLOSED
FAIL_CLOSED_WITHOUT_ADULT_MODE = True
FAIL_CLOSED = FAIL_CLOSED_WITHOUT_ADULT_MODE

CONTENT_MODE_ORDINARY = "ordinary"
CONTENT_MODE_ADULT = "adult"
CONTENT_MODES = frozenset({CONTENT_MODE_ORDINARY, CONTENT_MODE_ADULT})
ContentMode = Literal["ordinary", "adult"]

# 403 文案码(路由勿自拟绕过语义)
R18_CONTEXT_REQUIRED_DETAIL = "该操作为 R18 内容,须切换到成人模式"
UNDERAGE_BLOCK_DETAIL = "未成年账户不可开启或使用 R18 内容"

# 每请求隔离(async 安全):中间件按 header 置位——**仅审计**,nsfw_allowed 不读此值。
nsfw_intent_var: ContextVar[bool] = ContextVar("nsfw_intent", default=False)


def normalize_content_mode(raw: Any) -> ContentMode:
    """规范化账号 content_mode;非法/空 → ordinary。

    写入兼容别名: sfw→ordinary, nsfw→adult(前端占位曾用 sfw|nsfw)。
    对外真值仍只回 ordinary|adult(TL 钉死)。
    """
    v = (str(raw) if raw is not None else "").strip().lower()
    if v in (CONTENT_MODE_ADULT, "nsfw", "r18"):
        return CONTENT_MODE_ADULT
    return CONTENT_MODE_ORDINARY


def account_content_mode(user: User | None) -> ContentMode:
    """读账号 content_mode(默认 ordinary)。不看 X-NSFW。"""
    if user is None:
        return CONTENT_MODE_ORDINARY
    return normalize_content_mode(getattr(user, "content_mode", None))


def is_underage(user: User | None) -> bool:
    """判断用户是否未成年(birthdate 为空视为成年,避免破坏老数据)。

    WHY:未成年防护硬阻断的基础判定。老数据无 birthdate,空值放行以兼容;
    一旦填写且不足 18 岁,则 nsfw_allowed 与成人态切换端点均拒绝。
    """
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
    """R18 放行:仅当账号 `content_mode=adult` 且非未成年。

    X-NSFW / nsfw_intent_var / 遗留 nsfw_enabled **均不放行**。
    未成年硬阻断优先级最高:即便账号被标成人也一律拒绝。
    无 user(匿名)→ False(fail-closed)。
    """
    if user is None:
        return False
    if is_underage(user):
        return False
    return account_content_mode(user) == CONTENT_MODE_ADULT


def require_nsfw_context(user: User | None = None) -> None:
    """显式要求当前账号处于成人态;否则 403。不改变 SFW 调用方行为。"""
    if is_underage(user):
        raise HTTPException(status_code=403, detail=UNDERAGE_BLOCK_DETAIL)
    if not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail=R18_CONTEXT_REQUIRED_DETAIL)


def job_nsfw_from_intent(user: User | None, explicit: bool) -> bool:
    """作品是否打 R18 标:只跟作品意图走,不跟「人是否开了成人模式」单独走。

    账号成人态只做门控(explicit=True 时须放行,否则 403),不能单独把
    试衣/超分/普通二次元打进成人库。
    """
    if not explicit:
        return False
    require_nsfw_context(user)
    return True


def adult_at_submit(user: User | None) -> bool:
    """提交瞬间账号是否成人态(写入 Job.adult_at_submit 快照)。

    切模式后在途任务继续跑完;403 只作用于新请求。本快照不随后续切模式改写。
    """
    return nsfw_allowed(user)


def should_apply_softening(user: User | None) -> bool:
    """软化管道入口闸:仅普通模式误触可进;成人路径物理跳过。

    未成年/匿名/成人 → False(不进 softening)。
    """
    if user is None or is_underage(user):
        return False
    return account_content_mode(user) == CONTENT_MODE_ORDINARY


def header_means_nsfw_intent(header_value: str | None) -> bool:
    """中间件解头入口(审计用):比较原始头值是否等于 REQUEST_HEADER_VALUE。

    不得用于 nsfw_allowed / 403 判据。
    """
    return (header_value or "") == REQUEST_HEADER_VALUE


def audit_nsfw_header_present() -> bool:
    """当前请求是否带 X-NSFW(审计/日志);与放行无关。"""
    return bool(nsfw_intent_var.get())
