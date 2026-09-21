"""自愈闭环延伸工具(A3,2026-09-21)——烟测失败归因与修复建议经 agent 呈现/执行。

用户问「哪些应用坏了/为什么坏/帮我修」时的流程:
list_smoke_failures(失败清单+归因) → explain_app_failure(单应用详解+修复建议+已有提案)
→ (用户确认后) run_app_smoke(重测验证;LLM/确定性修复已在管线内自动进行)
→ reject_app_fix(发现 LLM 补丁帮倒忙时回滚)。

设计纪律与 tools_drama 一致:全部委托 services(app_smoke/selfheal_llm)不复制逻辑;
自愈是管理面——非 admin 用户一律拒绝(与 routes/admin 同语义)。
"""
from __future__ import annotations

import logging

from sqlmodel import select

from app.agent.tools_gen import _err_event, _job_event
from app.models import App, SelfhealProposal, User

logger = logging.getLogger(__name__)

_CLS_ADVICE = {
    "missing_node": "worker 缺节点包(设备侧装包后可恢复)",
    "missing_model": "缺模型权重(需下载落盘后重测)",
    "validation": "参数/绑定校验问题(确定性修复器可自动改写,重测即验)",
    "runtime": "执行期错误(看错误摘要定位;可能节点参数或上游资源)",
    "resource": "显存/内存不足(空闲窗口重试或降低负载档)",
    "timeout": "排队/执行超时(空闲窗口重测可收,非产品缺陷)",
    "transport": "媒体转运失败(引用的产物已删除或不可达,应用数据问题)",
    "app_data": "应用数据顽固问题(引用失效素材,需内容侧修复)",
    "unknown": "未归类(看错误摘要人工判断)",
}

TOOL_SCHEMAS_SELFHEAL = [
    {
        "type": "function",
        "function": {
            "name": "list_smoke_failures",
            "description": (
                "列出烟测失败/超时的应用及结构化归因(用户问「哪些应用坏了/不能跑/"
                "烟测失败」时调用;仅管理员可用)。返回归因类+错误摘要+可修复性建议。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "最多返回几条(默认 10,上限 30)", "default": 10},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "explain_app_failure",
            "description": (
                "详解一个应用的烟测失败:归因类/错误摘要/修复建议/已有 LLM 修复提案"
                "(用户问「XX 应用为什么坏/能不能修」时调用;仅管理员可用)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "app_id": {"type": "string", "description": "应用 id(list_smoke_failures 或 list_apps 返回)"},
                },
                "required": ["app_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_app_smoke",
            "description": (
                "对一个应用现场重跑烟测(修复后验证/用户说「再测一次」时用;仅管理员可用)。"
                "管线内会自动做归因+确定性修复重试+LLM 修复;同步执行,可能数分钟,属正常。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "app_id": {"type": "string", "description": "应用 id"},
                },
                "required": ["app_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reject_app_fix",
            "description": (
                "回滚一个 LLM 修复提案(发现自动补丁把应用改坏/试提交更差时用;"
                "仅管理员可用)。回滚后工作流还原到补丁前。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "proposal_id": {"type": "string", "description": "提案 id(explain_app_failure 返回)"},
                },
                "required": ["proposal_id"],
            },
        },
    },
]


def _admin_gate(user: User) -> str | None:
    if getattr(user, "role", "") != "admin":
        return "自愈工具仅管理员可用(烟测/修复是管理面操作)。"
    return None


def _cls_line(cls: str) -> str:
    return _CLS_ADVICE.get(cls or "unknown", _CLS_ADVICE["unknown"])


async def exec_list_smoke_failures(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    gate = _admin_gate(user)
    if gate:
        return gate, [_err_event("权限不足")]
    session = ctx["session"]
    try:
        limit = max(1, min(30, int(args.get("limit") or 10)))
    except (TypeError, ValueError):
        limit = 10
    rows = session.exec(
        select(App)
        .where(App.smoke_status.in_(("fail", "timeout")))
        .order_by(App.smoke_at.desc())
        .limit(limit)
    ).all()
    if not rows:
        return "当前所有应用烟测均通过或尚未测过。", []
    lines = [f"共 {len(rows)} 个应用烟测未通过:"]
    for a in rows:
        cls = a.smoke_cls or "unknown"
        err = (a.smoke_error or "").replace("\n", " ")[:80]
        lines.append(f"- {a.name}(id={a.id}):[{cls}] {_cls_line(cls)};{err}")
    lines.append("逐一看详情用 explain_app_failure(app_id);确认要重测某应用用 run_app_smoke(app_id)。")
    return "\n".join(lines), []


async def exec_explain_app_failure(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    gate = _admin_gate(user)
    if gate:
        return gate, [_err_event("权限不足")]
    session = ctx["session"]
    a = session.get(App, str(args.get("app_id") or ""))
    if a is None:
        return "应用不存在。", [_err_event("应用不存在")]
    lines = [f"应用「{a.name}」(id={a.id}):"]
    lines.append(f"- 烟测状态: {a.smoke_status or '未测'}(归因类 {a.smoke_cls or '—'})")
    if a.smoke_error:
        lines.append(f"- 失败摘要: {a.smoke_error[:300]}")
    lines.append(f"- 修复建议: {_cls_line(a.smoke_cls or 'unknown')}")
    props = session.exec(
        select(SelfhealProposal)
        .where(SelfhealProposal.app_id == a.id)
        .order_by(SelfhealProposal.created_at.desc())
        .limit(5)
    ).all()
    if props:
        lines.append("- 已有 LLM 修复提案:")
        for p in props:
            note = (p.note or "")[:80]
            lines.append(f"  · {p.id}[{p.status}]({p.failure_cls}){note}")
        lines.append("  觉得补丁帮倒忙可 reject_app_fix(proposal_id) 回滚。")
    if a.smoke_status in ("fail", "timeout"):
        lines.append("用户确认后可 run_app_smoke(app_id) 现场重测(管线会自动归因+修复重试)。")
    return "\n".join(lines), []


async def exec_run_app_smoke(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    gate = _admin_gate(user)
    if gate:
        return gate, [_err_event("权限不足")]
    session = ctx["session"]
    pool = ctx["pool"]
    a = session.get(App, str(args.get("app_id") or ""))
    if a is None:
        return "应用不存在。", [_err_event("应用不存在")]
    from app.services import app_smoke as smoke_svc

    try:
        result = await smoke_svc.run_app_smoke(pool, session, a)
    except Exception as e:
        return f"烟测执行失败: {e}", [_err_event("烟测执行失败", str(e)[:200])]
    status = result.get("status", "?")
    cls = result.get("cls", "")
    fixes = result.get("fixes") or []
    lines = [f"「{a.name}」烟测结果: {status}" + (f"(归因类 {cls})" if cls else "")]
    if fixes:
        lines.append("管线自动修复: " + "; ".join(str(f)[:80] for f in fixes[:5]))
    if status != "pass":
        lines.append(f"建议: {_cls_line(cls)}")
        lines.append("可用 explain_app_failure(app_id) 看完整归因与提案。")
    return "\n".join(lines), []


async def exec_reject_app_fix(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    gate = _admin_gate(user)
    if gate:
        return gate, [_err_event("权限不足")]
    session = ctx["session"]
    from app.services import selfheal_llm

    try:
        out = selfheal_llm.reject_proposal(session, str(args.get("proposal_id") or ""))
    except Exception as e:
        return f"回滚失败: {e}", [_err_event("回滚失败", str(e)[:200])]
    return f"提案已回滚(工作流已还原到补丁前): {out}", []
