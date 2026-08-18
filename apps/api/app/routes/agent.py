"""POST /api/agent/chat —— AI 智能体对话(SSE 流式:文本/工具事件/媒体结果)。

H2 会话日志(model-visible means logged):chat 流式过程中把进 LLM 的
user/assistant/tool 消息逐条追加落库(AgentMessage);会话 id 经响应头
X-Agent-Session-Id 立即返回前端(SSE 事件类型零变更)。会话管理端点:
列表 / 回放 / 分叉 / 删除,全部 get_current_user + 归属校验(404 不泄露),
nsfw=True 会话仅 X-NSFW 上下文可见(对齐 Job 过滤语义)。
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
            on_message=on_message,
        ):
            yield {"event": "msg", "data": json.dumps(ev, ensure_ascii=False)}
        yield {"event": "done", "data": "{}"}

    # 会话 id 走响应头:SSE 事件契约不变,新/旧前端都能安全忽略
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
