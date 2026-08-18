"""智能体主循环:LLM 工具调用 → 执行 ComfyUI 能力 → 回灌结果,流式产出事件。

Harness 化 M1(2026-08-19,参照 DeepSeek Harness 思想):
- 上下文预算:每轮模型请求前经 agent/context.compress_history 折叠超预算的中间
  历史(首任务锚点+最近上下文保留,tool 配对不变量保证协议合法);
- Skills 按需注入:按最近用户消息从 Skill 市场匹配公共/内置技能,人格要点进
  system(连接 Skill 市场 ↔ 助手,agent_skills_topk=0 关闭);
- 轮次预算配置化:agent_max_rounds(默认 12),tool 事件带 round 字段(契约增量)。
"""
from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncIterator

from sqlmodel import Session, select

from app.agent import llm
from app.agent.context import compress_history
from app.agent.rag import get_kb
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.harness.ctx import get_ctx
from app.models import Agent, Document, User
from app.nsfw_ctx import nsfw_allowed
from app.services import docs as docsvc

logger = logging.getLogger(__name__)

SYSTEM_PREFIX = """你是 ToIV——一个由 ComfyUI 集群驱动的 AI 创作平台的智能助手。
你能通过工具实时为用户生成内容并直接展示结果:
"""

# SYSTEM 静态尾(原则段);工具清单段由工具注册表生成,插在两段之间
SYSTEM_SUFFIX = """

原则:
1. 用户表达创作意图时,主动调用相应工具完成,而不是只给建议。
2. 提示词尽量优化(补充风格、光影、质量词);除非用户指定,图片默认 1:1。
3. 工具会把图片/视频/音乐直接展示给用户,你只需简洁说明你做了什么、给点搭配建议。
4. 用中文,简洁友好。一次对话可多次调用工具(如"生成4张不同风格")。
5. 闲聊或咨询类问题直接回答,不必调用工具。
6. 需要 ComfyUI/模型/参数细节或要搭自定义工作流时,先用 search_knowledge 查证再动手;不要编造不存在的模型名或节点。
7. 工具返回失败/超时/不可用时,如实转告原因并停下;不要同一轮反复重试同一工具或改猜参数绕过。
8. 只确认工具实际成功返回的结果;未执行或未成功的步骤不说成已完成。
9. 用户问模型清单/能力等状态类问题时,先调用工具查当前结果再回答,不凭记忆猜测。
10. 多阶段的大需求(如"做一部短片")先与用户确认拆解方案再动手,不自动连发一整串生成调用;必要时引导使用 Agent Team 任务编排。
11. 生成结果由工具直接展示;不要自己输出媒体链接、markdown 图片语法或本地文件路径。"""

# 挂载文档检索注入的上限:top-k 块数 × 单块 ≤900 字符,控制注入体量不挤爆上下文
_DOC_TOP_K = 6


def system_prompt() -> str:
    """完整 SYSTEM:静态头 + 工具清单段(ctx.tools 注册表生成) + 静态尾。

    每次调用现拼:reset_ctx 后或插件替换工具集时,提示词随注册表即时变化。
    """
    tools_section = get_ctx().service("tools").build_system_prompt()
    return f"{SYSTEM_PREFIX}{tools_section}{SYSTEM_SUFFIX}"


def _last_user_msg(messages: list[dict]) -> str:
    return next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")


async def _rag_context(messages: list[dict]) -> str | None:
    """对最近一条用户消息做向量检索,拼成背景知识块。"""
    last_user = _last_user_msg(messages)
    if not last_user:
        return None
    chunks = await get_kb().retrieve(last_user, k=4)
    if not chunks:
        return None
    body = "\n\n".join(f"### {c.title}\n{c.text}" for c in chunks)
    return f"以下是可能相关的平台知识(供你参考,不必逐条复述给用户):\n\n{body}"


async def _docs_context(
    messages: list[dict], document_ids: list[str], user: User, session: Session
) -> str | None:
    """对用户挂载的文档做余弦 top-k 检索,拼成文档片段块(embedding 不可用→空)。"""
    if not document_ids:
        return None
    last_user = _last_user_msg(messages)
    if not last_user:
        return None
    rows = session.exec(
        select(Document).where(
            Document.user_id == user.id, Document.id.in_(document_ids)  # type: ignore[attr-defined]
        )
    ).all()
    hits = await docsvc.retrieve(list(rows), last_user, k=_DOC_TOP_K)
    if not hits:
        return None
    body = "\n\n".join(f"### 《{h.filename}》片段\n{h.text}" for h in hits)
    return (
        "用户为本轮对话挂载了文档。以下是与最新消息最相关的文档片段,"
        "优先据此回答(可注明出自哪篇文档,不必逐条复述):\n\n" + body
    )


# Skills 按需注入人格要点的截断长度(卡片可能长达 2 万字符,注入须克制)
_SKILL_PROMPT_MAX = 600


def _skills_context(messages: list[dict], user: User, session: Session) -> str | None:
    """Harness 化 M1:按最近用户消息从 Skill 市场匹配技能(公共/内置),注入人格要点。

    匹配:技能名整体命中(权重 3)或描述词逐个命中(各 1),score≥2 入选,
    取 top agent_skills_topk(0=关闭)。R18 技能仅在 R18 上下文注入;
    个人技能不注入(属主人格属私人配置,助手不做代理人)。
    """
    topk = get_settings().agent_skills_topk
    if topk <= 0:
        return None
    query = _last_user_msg(messages)
    if not query:
        return None
    rows = session.exec(select(Agent).where(Agent.user_id == "")).all()
    nsfw_ok = nsfw_allowed(user)

    def _score(a: Agent) -> int:
        if a.is_nsfw and not nsfw_ok:
            return -1
        s = 0
        if a.name and a.name in query:
            s += 3
        for tok in re.split(r"[^\w\u4e00-\u9fff]+", a.description or ""):
            if len(tok) >= 2 and tok in query:
                s += 1
        return s

    scored = sorted(((_score(a), a) for a in rows), key=lambda x: -x[0])
    hits = [a for s, a in scored if s >= 2][:topk]
    # 埋点:匹配决策可观测(技能名+分数;query 长度代替原文,不落用户内容)
    r18_filtered = [a.name for s, a in scored if s == -1]
    logger.info(
        "skills.match: query_len=%d candidates=%d hits=%d topk=%d "
        "scores=%s r18_filtered=%s",
        len(query), len(rows), len(hits), topk,
        [(a.name, s) for s, a in scored if s >= 2][:topk + 2],
        r18_filtered if r18_filtered else [],
    )
    if not hits:
        return None
    parts = []
    for a in hits:
        persona = (a.system_prompt or "")[:_SKILL_PROMPT_MAX]
        entry = f"### {a.name}" + (f"\n{a.description}" if a.description else "")
        entry += f"\n人格要点: {persona}"
        parts.append(entry)
    return (
        "以下是与用户请求可能相关的风格技能(来自 Skill 市场)。"
        "若用户明确点名某技能或意图与其强相关,按其人格与偏好组织回应与提示词:\n\n"
        + "\n\n".join(parts)
    )


async def run(
    messages: list[dict], pool: WorkerPool, user: User, session,
    attachment: dict | None = None,
    document_ids: list[str] | None = None,
    on_message=None,
) -> AsyncIterator[dict]:
    """主循环。on_message:可选 async 回调,每条进/出 LLM 的消息调用一次
    (model-visible means logged;payload = {role, content, tool_calls, media},
    由路由层落库 AgentMessage)。错误事件不落库(从未进入模型上下文)。"""
    # 把所有 system 内容拼到开头唯一一条 system 消息里(vLLM 要求 system 只能在消息列表开头,
    # 多条 system 会被拒绝;LM Studio 宽容但不保证)。用换行 + 分隔标记区分各段。
    sys_parts: list[str] = [system_prompt()]
    context = await _rag_context(messages)
    if context:
        sys_parts.append(context)
    docs_context = await _docs_context(messages, document_ids or [], user, session)
    if docs_context:
        sys_parts.append(docs_context)
    skills_context = _skills_context(messages, user, session)
    if skills_context:
        sys_parts.append(skills_context)
    if attachment and attachment.get("filename"):
        sys_parts.append(
            "用户本轮上传了一张图片。若用户想修改/重绘它,调用 edit_image;"
            "若想把它转成 3D 模型,调用 generate_3d(无需再描述)。"
        )
    msgs: list[dict] = [{"role": "system", "content": "\n\n".join(sys_parts)}]
    msgs.extend(messages)

    tool_reg = get_ctx().service("tools")
    settings = get_settings()

    async def _log(role: str, content: str = "", tool_calls=None, media=None) -> None:
        if on_message is not None:
            await on_message(
                {"role": role, "content": content, "tool_calls": tool_calls, "media": media}
            )

    for rnd in range(1, settings.agent_max_rounds + 1):
        try:
            # Harness 化:每轮请求前按预算折叠中间历史(长对话/多工具结果防溢出;
            # 压缩只作用于本次调用的 working copy,AgentMessage 日志始终全量)
            working = compress_history(msgs, settings.agent_context_budget)
            logger.debug(
                "agent.loop: round=%d/%d msgs=%d chars=%d budget=%d tool_calls_pending=%d",
                rnd, settings.agent_max_rounds, len(working),
                sum(len(m.get("content") or "") for m in working),
                settings.agent_context_budget, len(msgs) - len(working),
            )
            assistant = await get_ctx().service("llm").chat(working, tools=tool_reg.schemas())
        except llm.LLMError as e:
            logger.warning("agent.loop: llm error round=%d err=%s", rnd, e)
            yield {"type": "error", "content": str(e)}
            return

        tool_calls = assistant.get("tool_calls") or []
        content = assistant.get("content") or ""
        if content:
            yield {"type": "text", "content": content}
        if not tool_calls:
            # 最终回答:本轮未再进 LLM,但会随前端历史进入下一轮上下文 → 落库
            if content:
                await _log("assistant", content)
            return

        msgs.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
        await _log("assistant", content, tool_calls=tool_calls)
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            # round 字段:契约增量(前端可忽略),标示本工具调用所在的模型请求轮次
            yield {"type": "tool", "name": name, "args": args, "round": rnd}
            t0 = time.monotonic()
            text, events = await tool_reg.execute(
                name, args,
                {"pool": pool, "user": user, "session": session, "attachment": attachment},
            )
            logger.info(
                "agent.tool: name=%s round=%d took_ms=%d result_len=%d events=%d",
                name, rnd, int((time.monotonic() - t0) * 1000),
                len(text or ""), len(events),
            )
            media: list[dict] = []
            for ev in events:
                yield ev
                if isinstance(ev, dict) and ev.get("urls"):
                    media.append({"type": ev.get("type", ""), "urls": ev["urls"]})
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": text})
            await _log(
                "tool", text,
                tool_calls={"tool_call_id": tc.get("id", ""), "name": name, "args": args},
                media=media,
            )

    yield {"type": "text", "content": "(已达到最大处理步数,请精简需求后重试)"}
    await _log("assistant", "(已达到最大处理步数,请精简需求后重试)")
