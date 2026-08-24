"""POST /api/agent/chat —— AI 智能体对话(SSE 流式:文本/工具事件/媒体结果)。

H2 会话日志(model-visible means logged):chat 流式过程中把进 LLM 的
user/assistant/tool 消息逐条追加落库(AgentMessage);会话 id 经响应头
X-Agent-Session-Id 立即返回前端(SSE 事件类型零变更)。会话管理端点:
列表 / 回放 / 分叉 / 删除,全部 get_current_user + 归属校验(404 不泄露),
nsfw=True 会话仅 X-NSFW 上下文可见(对齐 Job 过滤语义)。

深度接管(2026-08-24):在既有 msg 包络(text/error/tool/媒体)之外新增三类
顶层 SSE 事件(协议固定,前端按 event 名订阅):
  event: tool      data: {"id","name","status":"start|ok|error","summary","detail"?}
  event: job       data: {"job_id","kind","status","label","hold_reason"?,"results"?}
  event: proposal  data: {"proposal_id","title","body","estimate"}
确认回执:POST /api/agent/chat/resume 把用户对决(proposal approve/modify/reject)
注入对话上下文并继续 chat 循环,响应仍是同构 SSE 流。
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.agent import llm, runner
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import AgentMessage, AgentSession, User, _now
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()

# runner 事件 type → 顶层 SSE event 名(深度接管协议;其余事件仍走 msg 包络)
_STREAM_EVENT_NAMES = {"tool_event": "tool", "job": "job", "proposal": "proposal"}


def _sse_event(ev: dict) -> dict:
    """把 runner 产出的事件 dict 映射为 SSE 帧(新协议事件拆顶层,其余包 msg)。"""
    t = ev.get("type") if isinstance(ev, dict) else None
    if t in _STREAM_EVENT_NAMES:
        return {"event": _STREAM_EVENT_NAMES[t],
                "data": json.dumps(ev.get("data", {}), ensure_ascii=False)}
    return {"event": "msg", "data": json.dumps(ev, ensure_ascii=False)}


class ChatMessage(BaseModel):
    role: str
    content: str = Field(max_length=8000)


class ImageRef(BaseModel):
    filename: str = Field(max_length=512)
    worker: str = Field(max_length=256)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    image: ImageRef | None = None
    # 挂载的文档 id(文档上传与长文本理解;检索相关片段注入上下文,见 runner._docs_context)
    document_ids: list[str] = Field(default_factory=list, max_length=8)
    # 会话 id(H2):空=新会话(创建后 id 经响应头返回);带值=续聊(归属/R18 校验失败 404)
    session_id: str | None = Field(default=None, max_length=64)


# --------------------------------------------------------------------------- #
# 会话日志内部助手
# --------------------------------------------------------------------------- #
def _get_owned_session(session: Session, user: User, sid: str) -> AgentSession:
    """取当前用户的会话;不存在/非本人/主站碰 R18 一律 404(不泄露存在性)。"""
    sess = session.get(AgentSession, sid)
    if sess is None or sess.user_id != user.id:
        raise HTTPException(status_code=404, detail="会话不存在")
    if sess.nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=404, detail="会话不存在")
    return sess


def _append_message(
    session: Session,
    sess: AgentSession,
    role: str,
    content: str = "",
    tool_calls=None,
    media=None,
) -> None:
    """追加一条消息事件并 bump 会话 updated_at(列表按它倒序)。"""
    session.add(
        AgentMessage(
            session_id=sess.id,
            role=role,
            content=content or "",
            tool_calls=json.dumps(tool_calls, ensure_ascii=False) if tool_calls else "",
            media=json.dumps(media, ensure_ascii=False) if media else "",
        )
    )
    sess.updated_at = _now()
    session.add(sess)
    session.commit()


def _session_dict(sess: AgentSession, message_count: int) -> dict:
    return {
        "id": sess.id,
        "title": sess.title,
        "nsfw": sess.nsfw,
        "created_at": sess.created_at.isoformat(),
        "updated_at": sess.updated_at.isoformat(),
        "message_count": message_count,
    }


def _message_dict(row: AgentMessage) -> dict:
    return {
        "id": row.id,
        "role": row.role,
        "content": row.content,
        "tool_calls": json.loads(row.tool_calls) if row.tool_calls else None,
        "media": json.loads(row.media) if row.media else [],
        "created_at": row.created_at.isoformat(),
    }


# --------------------------------------------------------------------------- #
# 对话(SSE 流式;事件类型契约不变:text/tool/image/video/audio/model3d/error + done)
# --------------------------------------------------------------------------- #
@router.post("/agent/chat")
async def agent_chat(
    body: ChatRequest,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    msgs = [{"role": m.role, "content": m.content} for m in body.messages]
    attachment = body.image.model_dump() if body.image else None

    # ── 会话解析/创建(会话 id 经响应头立即返回前端,供续聊携带)──
    if body.session_id:
        sess = _get_owned_session(session, user, body.session_id)
        # 续聊:历史已在库,只落本轮新输入(最后一条 user 消息)
        last = msgs[-1] if msgs else None
        if last and last.get("role") == "user":
            _append_message(session, sess, "user", last.get("content", ""))
    else:
        title = next((m["content"] for m in msgs if m.get("role") == "user"), "")[:30]
        sess = AgentSession(user_id=user.id, title=title, nsfw=nsfw_allowed(user))
        session.add(sess)
        session.commit()
        session.refresh(sess)
        # 新会话:body 全量消息即本会话输入,逐条落库(model-visible means logged)
        for m in msgs:
            if m.get("role") in ("user", "assistant"):
                _append_message(session, sess, m["role"], m.get("content", ""))

    async def on_message(msg: dict) -> None:
        """runner 每条进/出 LLM 的消息回调(assistant/tool)。"""
        _append_message(
            session, sess, msg["role"], msg.get("content", ""),
            msg.get("tool_calls"), msg.get("media"),
        )

    async def stream():
        async for ev in runner.run(
            msgs, pool, user, session, attachment, body.document_ids,
            on_message=on_message, agent_session=sess,
        ):
            yield _sse_event(ev)
        yield {"event": "done", "data": "{}"}

    # 会话 id 走响应头:SSE 事件契约不变,新/旧前端都能安全忽略
    return EventSourceResponse(stream(), headers={"X-Agent-Session-Id": sess.id})


# --------------------------------------------------------------------------- #
# 提案确认回执(深度接管):approve/modify/reject 注入对话上下文并继续 chat 循环
# --------------------------------------------------------------------------- #
class ResumeRequest(BaseModel):
    conversation_id: str = Field(max_length=64)
    proposal_id: str = Field(max_length=64)
    action: str  # approve | modify | reject
    note: str | None = Field(default=None, max_length=2000)


_ACTION_STATUS = {"approve": "approved", "modify": "modified", "reject": "rejected"}


def _decision_message(prop: dict, action: str, note: str | None) -> str:
    """把用户对决拼成一条 user 消息(含方案要点回顾,保证模型看得到方案全文)。"""
    title = prop.get("title", "")
    pid = prop.get("proposal_id", "")
    body = (prop.get("body") or "")[:2000]
    head = {
        "approve": f"【方案确认】我批准了方案「{title}」(proposal_id={pid})。",
        "modify": f"【方案修改】我原则上同意方案「{title}」(proposal_id={pid}),但有修改意见。",
        "reject": f"【方案拒绝】我拒绝了方案「{title}」(proposal_id={pid})。",
    }[action]
    parts = [head]
    if note:
        parts.append(f"我的意见:{note}")
    parts.append(f"方案要点回顾:\n{body}")
    parts.append({
        "approve": "请按该方案开始执行(逐步 optimize_prompt → submit_generation,提交后告知 job_id 与预计耗时)。",
        "modify": "请按我的意见调整方案;若改动大请重新 propose_plan,改动小可直接按调整后方向执行。",
        "reject": "先不要执行任何生成,和我重新讨论方向。",
    }[action])
    return "\n\n".join(parts)


@router.post("/agent/chat/resume")
async def agent_chat_resume(
    body: ResumeRequest,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
):
    """提案回执:确认/修改/拒绝注入对话上下文,继续 chat 循环(同构 SSE 流)。"""
    enforce_generation_rate_limit(user)
    if body.action not in _ACTION_STATUS:
        raise HTTPException(status_code=422, detail="action 必须是 approve|modify|reject")
    sess = _get_owned_session(session, user, body.conversation_id)
    if not sess.pending_proposal:
        raise HTTPException(status_code=404, detail="该会话没有待确认的提案")
    prop = json.loads(sess.pending_proposal)
    if prop.get("proposal_id") != body.proposal_id:
        raise HTTPException(status_code=404, detail="提案不存在或已被新提案覆盖")
    if prop.get("status") != "pending":
        raise HTTPException(status_code=409, detail="该提案已处理过,请勿重复提交")

    # 落对决存根(状态保留在会话上,供前端回放展示)
    prop["status"] = _ACTION_STATUS[body.action]
    prop["note"] = body.note or ""
    sess.pending_proposal = json.dumps(prop, ensure_ascii=False)
    session.add(sess)
    session.commit()

    # 从消息日志重建模型可见历史(user/assistant 原文;tool 中间结果不回放,
    # 与前端续聊只带两类消息的口径一致),再注入对决消息
    rows = session.exec(
        select(AgentMessage)
        .where(AgentMessage.session_id == sess.id)
        .order_by(AgentMessage.id.asc())
    ).all()
    msgs = [
        {"role": r.role, "content": r.content}
        for r in rows
        if r.role in ("user", "assistant") and r.content
    ]
    decision = _decision_message(prop, body.action, body.note)
    msgs.append({"role": "user", "content": decision})
    _append_message(session, sess, "user", decision)

    async def on_message(msg: dict) -> None:
        _append_message(
            session, sess, msg["role"], msg.get("content", ""),
            msg.get("tool_calls"), msg.get("media"),
        )

    async def stream():
        async for ev in runner.run(
            msgs, pool, user, session, on_message=on_message, agent_session=sess,
        ):
            yield _sse_event(ev)
        yield {"event": "done", "data": "{}"}

    return EventSourceResponse(stream(), headers={"X-Agent-Session-Id": sess.id})


# --------------------------------------------------------------------------- #
# 会话管理:列表 / 回放 / 分叉 / 删除
# --------------------------------------------------------------------------- #
@router.get("/agent/sessions")
async def list_agent_sessions(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的会话列表(updated_at 倒序,含消息数)。主站过滤 R18 会话。"""
    stmt = select(AgentSession).where(AgentSession.user_id == user.id)
    if not nsfw_allowed(user):
        stmt = stmt.where(AgentSession.nsfw == False)  # noqa: E712  SQLModel 需 == 生成 SQL
    rows = session.exec(stmt.order_by(AgentSession.updated_at.desc())).all()
    if not rows:
        return []
    counts = dict(
        session.exec(
            select(AgentMessage.session_id, func.count())
            .where(AgentMessage.session_id.in_([s.id for s in rows]))  # type: ignore[attr-defined]
            .group_by(AgentMessage.session_id)
        ).all()
    )
    return [_session_dict(s, int(counts.get(s.id, 0))) for s in rows]


@router.get("/agent/sessions/{sid}")
async def get_agent_session(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """会话详情:全消息回放(id 升序即对话顺序)。"""
    sess = _get_owned_session(session, user, sid)
    rows = session.exec(
        select(AgentMessage)
        .where(AgentMessage.session_id == sid)
        .order_by(AgentMessage.id.asc())
    ).all()
    return {**_session_dict(sess, len(rows)), "messages": [_message_dict(r) for r in rows]}


class ForkRequest(BaseModel):
    # 复制到该消息为止(含);空=复制全部
    at_message_id: int | None = None


@router.post("/agent/sessions/{sid}/fork")
async def fork_agent_session(
    sid: str,
    body: ForkRequest | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """分叉:从源会话复制消息(可选截断到 at_message_id)生成新会话。"""
    src = _get_owned_session(session, user, sid)
    rows = session.exec(
        select(AgentMessage)
        .where(AgentMessage.session_id == sid)
        .order_by(AgentMessage.id.asc())
    ).all()
    at = body.at_message_id if body else None
    if at is not None:
        if all(r.id != at for r in rows):
            raise HTTPException(status_code=404, detail="消息不存在")
        rows = [r for r in rows if r.id <= at]
    fork = AgentSession(user_id=user.id, title=src.title, nsfw=src.nsfw)
    session.add(fork)
    session.commit()
    session.refresh(fork)
    for r in rows:
        session.add(
            AgentMessage(
                session_id=fork.id,
                role=r.role,
                content=r.content,
                tool_calls=r.tool_calls,
                media=r.media,
            )
        )
    session.commit()
    return _session_dict(fork, len(rows))


@router.delete("/agent/sessions/{sid}")
async def delete_agent_session(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """删除会话及其全部消息事件。"""
    sess = _get_owned_session(session, user, sid)
    rows = session.exec(
        select(AgentMessage).where(AgentMessage.session_id == sid)
    ).all()
    for r in rows:
        session.delete(r)
    session.delete(sess)
    from app import audit as _audit

    _audit.record(
        session, user=user, action="session.delete", target_type="agent_session",
        target_id=sid, summary=f"删除智能体会话({len(rows)} 条消息)",
    )
    session.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 子 Agent 编排(M2:大需求拆解 DAG;复用 AgentRun 底座,事件经 /agent-runs 消费)
# --------------------------------------------------------------------------- #
class SubagentRequest(BaseModel):
    goal: str = Field(min_length=4, max_length=2000)
    max_tasks: int = Field(default=5, ge=2, le=8)
    learn: bool = False  # 完成后把产物提炼为个人技能卡(Skill 市场可编辑/分享)


@router.post("/agent/subagent", status_code=202)
async def create_subagent_run(
    body: SubagentRequest,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
):
    """大需求 → 子任务 DAG 后台执行(research 类子代理可联网调研)。

    返回 run_id;进度/产物事件流复用现有 GET /api/agent-team/agent-runs/{id}/events
    (同底座同归属校验)。learn=true 时 run 成功后自动沉淀 0-3 张个人技能卡。
    """
    enforce_generation_rate_limit(user)
    from app.agent import subagent as sa

    try:
        run = await sa.create_run(session, user, body.goal, body.max_tasks)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"任务拆解失败:{e}") from e
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=f"拆解模型不可用:{e}") from e

    bind = session.get_bind()
    owner_id = user.id

    def _factory():
        return Session(bind)

    async def _drive() -> None:
        """后台驱动:工具循环的 session/user 与请求生命周期解耦(独立会话重绑)。"""
        with _factory() as tool_session:
            fresh_user = tool_session.get(User, owner_id) or user
            tool_ctx = {"pool": pool, "user": fresh_user, "session": tool_session}
            async for _ in sa.execute_run(
                run.id, _factory, fresh_user, tool_ctx=tool_ctx, learn=body.learn,
            ):
                pass

    asyncio.create_task(_drive())
    return {
        "run_id": run.id, "status": run.status, "learn": body.learn,
        "events_url": f"/api/agent-team/agent-runs/{run.id}/events",
    }
