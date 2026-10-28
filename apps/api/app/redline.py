"""R18/未成年红线 —— 后端唯一决策真源(D-U1=B)·账号全局成人态。

产品口径(2026-10-26 TL · 2026-10-28 P0-5 R5 修订):
  1. **成人态作用域=账号全局**:状态存服务端 `User.content_mode`
     (`ordinary` | `adult`,默认 ordinary);供前端读与提交快照。
  2. **限制/红线只做前端**(P0-5 R5):禁止后端因 content_mode / NSFW /
     未成年做 403/404 资源闸。`X-NSFW` 仅审计旁路(ContextVar),不得单独放行。
  3. **未成年硬关也只前端**:`require_not_underage` 为 no-op 壳;拦截只在
     canvas `redline.ts`。`is_underage` / `birthdate` 仅只读透出供前端同步。
     空 birthdate 策略本波不改(空=非未成年)。
  4. **P0-5 R0–R5**:媒体/列表 UX 闸、提交链成人 UX 403、未成年后端硬关均已退役。
     `nsfw_allowed` 仅作成人态标注/选项面薄封装,禁止当闸。
  5. 在途任务:提交时快照 `Job.adult_at_submit`;切模式不 cancel 在途。

路由/服务须 `from app.redline import ...`;禁止私自解析 X-NSFW 作判据。
中间件可置位 `nsfw_intent_var` 供审计;决策一律走本模块函数。
旧 `app.nsfw_ctx` / `app.r18_policy` 为薄 re-export,勿再扩逻辑。
"""
from __future__ import annotations

from contextvars import ContextVar
from datetime import date
from typing import Any, Literal

from app.models import User

# --- 策略常量(测试与运维文档交叉引用) ---
POLICY_ID = "D-U1=B"
POLICY_DECIDED_AT = "2026-10-26"
POLICY_ENFORCEMENT = "frontend-only"  # P0-5 R5:一切限制/红线只前端(含未成年)
BACKEND_RUNTIME_GATE = False  # 成人 UX + 未成年后端闸均已退役
CANVAS_IS_SOLE_MAIN_UI = True
WEB_INDEPENDENT_NSFW_ZONE_RETIRED = True
# 历史名保留:曾表示「账户 nsfw_enabled 不放行」。现账号 content_mode 为唯一放行源。
ACCOUNT_FLAG_NO_LONGER_ALLOWS = False
ACCOUNT_CONTENT_MODE_IS_SOLE_ALLOW = True
REQUEST_HEADER = "X-NSFW"  # 仅审计;不作 403 判据
REQUEST_HEADER_VALUE = "1"
UNDERAGE_HARD_BLOCK = False  # P0-5 R5:后端不再因未成年 403;硬关只前端
FAIL_CLOSED_WITHOUT_HEADER = False  # 头不再作判据;兼容别名见 FAIL_CLOSED
FAIL_CLOSED_WITHOUT_ADULT_MODE = False  # R3:缺成人态不再后端 403
FAIL_CLOSED = True  # 仍 fail-closed:匿名不视为成人态标注

CONTENT_MODE_ORDINARY = "ordinary"
CONTENT_MODE_ADULT = "adult"
CONTENT_MODES = frozenset({CONTENT_MODE_ORDINARY, CONTENT_MODE_ADULT})
ContentMode = Literal["ordinary", "adult"]

# 历史 403 文案码(后端不再抛;前端 redline.ts 可对照)
R18_CONTEXT_REQUIRED_DETAIL = "该操作为 R18 内容,须切换到成人模式"
UNDERAGE_BLOCK_DETAIL = "未成年账户不可开启或使用 R18 内容"

# 每请求隔离(async 安全):中间件按 header 置位——**仅审计**,nsfw_allowed 不读此值。
nsfw_intent_var: ContextVar[bool] = ContextVar("nsfw_intent", default=False)


def normalize_content_mode(raw: Any) -> ContentMode:
    """规范化账号 content_mode;非法/空 → ordinary。

    写入兼容别名:sfw→ordinary, nsfw→adult(前端占位曾用 sfw|nsfw)。
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
    """只读判定用户是否未成年(birthdate 为空视为成年,避免破坏老数据)。

    P0-5 R5:供 `/auth/me` 与前端同步;**禁止**当后端闸。空 birthdate 策略未改。
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


def adult_mode_enabled(user: User | None = None) -> bool:
    """纯账号成人态(只看 ``content_mode=adult``);**不含**未成年判定。

    勿用本函数做资源拦截 403/404;标注/选项面/前端同步用。
    """
    if user is None:
        return False
    return account_content_mode(user) == CONTENT_MODE_ADULT


def require_not_underage(user: User | None = None) -> None:
    """P0-5 R5 no-op:未成年硬关已改前端(canvas ``redline.ts``)。

    保留符号与调用点以免大面积删调用;后端**永不**因未成年抛 403。
    ``user`` 参数保留以兼容既有签名。
    """
    return None


def nsfw_allowed(user: User | None = None) -> bool:
    """成人态标注薄封装:只跟 ``adult_mode_enabled`` / ``content_mode``。

    X-NSFW / nsfw_intent_var / 遗留 nsfw_enabled / underage **均不改变本结果**。
    无 user(匿名)→ False。

    **Deprecated for gating (P0-5)**:禁止再用于资源拦截 403/404。
    本函数供快照/选项面/前端灰化标注。
    """
    if user is None:
        return False
    return adult_mode_enabled(user)


def require_nsfw_context(user: User | None = None) -> None:
    """历史名:曾要求账号成人态否则 403。

    P0-5 R5:转发 ``require_not_underage``(已 no-op);成人态不足也不再 403。
    """
    require_not_underage(user)


def require_adult_ux(user: User | None = None) -> None:
    """Deprecated no-op 壳:成人 UX 与未成年后端闸均已退役。"""
    require_not_underage(user)


def job_nsfw_from_intent(user: User | None, explicit: bool) -> bool:
    """作品是否打 R18 标:只跟作品意图走。

    explicit=True 时不再因未成年/普通态 403(R5);限制只前端。
    不能单独把试衣/超分/普通二次元打进成人库。
    """
    if not explicit:
        return False
    require_nsfw_context(user)  # no-op
    return True


def adult_at_submit(user: User | None) -> bool:
    """提交瞬间账号是否成人态(写入 Job.adult_at_submit 快照)。

    只跟 content_mode;不因 underage 硬拐。切模式后在途任务继续跑完。
    """
    return nsfw_allowed(user)


def should_apply_softening(user: User | None) -> bool:
    """软化管道入口:仅普通模式可进;成人路径跳过。

    只跟 content_mode;不因 underage 硬拐。匿名 → False。
    """
    if user is None:
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
