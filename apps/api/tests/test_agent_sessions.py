"""H2 会话日志测试(/api/agent/chat 落库 + 会话管理端点)。

覆盖:
  - chat 流式落库:user/assistant 消息齐;工具回合 user/assistant/tool 三类齐
    (model-visible means logged);标题取首条 user 消息前 30 字
  - 会话 id 经 X-Agent-Session-Id 响应头返回;续聊只追加本轮新输入
  - 列表(归属隔离 + 消息数 + updated_at 倒序)/ 回放 / 分叉(截断)/ 删除
  - R18:nsfw 会话无 X-NSFW 头不可见(列表过滤 + 详情/续聊 404)
  - 未认证 401
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent import llm
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import AgentMessage, AgentSession, Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
def _make_user(session: Session, email: str) -> User:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


class _FakeClient:
    """list_models 工具链最小替身。"""

    base_url = "http://fake-worker:8188"

    async def object_info(self, kind: str) -> dict:
        return {
            "CheckpointLoaderSimple": {
                "input": {"required": {"ckpt_name": [["a.safetensors", "b.safetensors"]]}}
            }
        }


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    app.dependency_overrides[get_pool] = lambda: SimpleNamespace(clients=[_FakeClient()])

    with Session(engine) as s:
        alice = _make_user(s, "alice@toiv.ai")
        bob = _make_user(s, "bob@toiv.ai")
        ids = (alice.id, bob.id)
    yield TestClient(app), create_token(ids[0]), create_token(ids[1]), engine, ids
    app.dependency_overrides.clear()


def _auth(token: str, nsfw: bool = False) -> dict:
    h = {"Authorization": f"Bearer {token}"}
    if nsfw:
        h["X-NSFW"] = "1"
    return h


def _mock_llm(monkeypatch, script: list[dict]) -> list[list[dict]]:
    """按调用顺序返回脚本草稿;记录每次调用的 messages。"""
    calls: list[list[dict]] = []

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4, enable_thinking=None):
        calls.append(messages)
        return script[min(len(calls) - 1, len(script) - 1)]

    monkeypatch.setattr(llm, "chat", fake_chat)
    return calls


def _chat(c: TestClient, token: str, messages: list[dict], nsfw: bool = False, **extra):
    return c.post(
        "/api/agent/chat",
        headers=_auth(token, nsfw),
        json={"messages": messages, **extra},
    )


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    """解析 SSE 体为 [(event, data_json)];兼容 \\r\\n\\r\\n 与 \\n\\n 分隔。"""
    import re

    out: list[tuple[str, dict]] = []
    for block in re.split(r"\r?\n\r?\n", text):
        ev, data = "message", ""
        for line in block.splitlines():
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if data:
            out.append((ev, json.loads(data)))
    return out


def _messages(engine, sid: str) -> list[AgentMessage]:
    with Session(engine) as s:
        return list(
            s.exec(
                select(AgentMessage)
                .where(AgentMessage.session_id == sid)
                .order_by(AgentMessage.id.asc())
            ).all()
        )


# --------------------------------------------------------------------------- #
# chat 落库
# --------------------------------------------------------------------------- #
def test_chat_creates_session_and_logs_user_and_assistant(ctx, monkeypatch):
    c, alice, _, engine, _ = ctx
    _mock_llm(monkeypatch, [{"content": "你好,有什么可以帮你?"}])

    r = _chat(c, alice, [{"role": "user", "content": "你好"}])
    assert r.status_code == 200, r.text
    sid = r.headers.get("x-agent-session-id")
    assert sid, "响应头必须携带会话 id"
    events = _parse_sse(r.text)
    assert ("msg", {"type": "text", "content": "你好,有什么可以帮你?"}) in events
    assert events[-1][0] == "done"

    rows = _messages(engine, sid)
    assert [m.role for m in rows] == ["user", "assistant"]
    assert rows[0].content == "你好"
    assert rows[1].content == "你好,有什么可以帮你?"

    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        assert sess is not None and sess.title == "你好" and sess.nsfw is False


def test_chat_title_truncates_to_30_chars(ctx, monkeypatch):
    c, alice, _, engine, _ = ctx
    _mock_llm(monkeypatch, [{"content": "ok"}])
    long_msg = "一" * 50
    r = _chat(c, alice, [{"role": "user", "content": long_msg}])
    sid = r.headers["x-agent-session-id"]
    with Session(engine) as s:
        assert s.get(AgentSession, sid).title == "一" * 30


def test_chat_tool_round_logs_user_assistant_tool(ctx, monkeypatch):
    """工具回合:user + assistant(带 tool_calls)+ tool(结果)三类消息齐。"""
    c, alice, _, engine, _ = ctx
    _mock_llm(
        monkeypatch,
        [
            {
                "content": "",
                "tool_calls": [
                    {"id": "t1", "function": {"name": "list_models", "arguments": "{}"}}
                ],
            },
            {"content": "已为你列出模型"},
        ],
    )
    r = _chat(c, alice, [{"role": "user", "content": "有哪些模型"}])
    assert r.status_code == 200, r.text
    sid = r.headers["x-agent-session-id"]
    events = _parse_sse(r.text)
    # SSE 事件类型契约不变:tool 事件 + text 事件
    assert any(e == "msg" and d.get("type") == "tool" and d.get("name") == "list_models" for e, d in events)

    rows = _messages(engine, sid)
    assert [m.role for m in rows] == ["user", "assistant", "tool", "assistant"]
    asst = rows[1]
    assert json.loads(asst.tool_calls)[0]["function"]["name"] == "list_models"
    tool_row = rows[2]
    assert "a.safetensors" in tool_row.content  # 工具结果原文(进 LLM 的内容)
    assert json.loads(tool_row.tool_calls)["name"] == "list_models"
    assert rows[3].content == "已为你列出模型"


def test_chat_continue_only_appends_new_user_message(ctx, monkeypatch):
    """续聊:历史已在库,只追加本轮新输入,不重复落库整段历史。"""
    c, alice, _, engine, _ = ctx
    _mock_llm(monkeypatch, [{"content": "回答一"}, {"content": "回答二"}])
    r1 = _chat(c, alice, [{"role": "user", "content": "问题一"}])
    sid = r1.headers["x-agent-session-id"]

    r2 = _chat(
        c, alice,
        [
            {"role": "user", "content": "问题一"},
            {"role": "assistant", "content": "回答一"},
            {"role": "user", "content": "问题二"},
        ],
        session_id=sid,
    )
    assert r2.status_code == 200, r2.text
    assert r2.headers["x-agent-session-id"] == sid
    rows = _messages(engine, sid)
    assert [m.role for m in rows] == ["user", "assistant", "user", "assistant"]
    assert [m.content for m in rows if m.role == "user"] == ["问题一", "问题二"]


def test_chat_continue_one_item_body_uses_db_history(ctx, monkeypatch):
    """续聊只上送最新 user 时,模型仍看到库里的上文(含 assistant)。"""
    c, alice, _, engine, _ = ctx
    calls = _mock_llm(monkeypatch, [{"content": "回答一"}, {"content": "回答二"}])
    r1 = _chat(c, alice, [{"role": "user", "content": "问题一"}])
    sid = r1.headers["x-agent-session-id"]
    r2 = _chat(c, alice, [{"role": "user", "content": "问题二"}], session_id=sid)
    assert r2.status_code == 200, r2.text
    assert len(calls) >= 2
    contents = [m.get("content") or "" for m in calls[1]]
    assert "问题一" in contents
    assert "回答一" in contents
    assert "问题二" in contents


def test_chat_with_foreign_session_id_404(ctx, monkeypatch):
    c, alice, bob, _, _ = ctx
    _mock_llm(monkeypatch, [{"content": "hi"}])
    sid = _chat(c, alice, [{"role": "user", "content": "你好"}]).headers["x-agent-session-id"]
    r = _chat(c, bob, [{"role": "user", "content": "继续"}], session_id=sid)
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 列表 / 回放 / 归属
# --------------------------------------------------------------------------- #
def test_sessions_list_with_count_and_ownership(ctx, monkeypatch):
    c, alice, bob, _, _ = ctx
    _mock_llm(monkeypatch, [{"content": "答"}])
    _chat(c, alice, [{"role": "user", "content": "甲"}])
    _chat(c, alice, [{"role": "user", "content": "乙"}])

    r = c.get("/api/agent/sessions", headers=_auth(alice))
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 2
    assert {s["title"] for s in rows} == {"甲", "乙"}
    assert all(s["message_count"] == 2 for s in rows)
    # updated_at 倒序
    assert [s["updated_at"] for s in rows] == sorted(
        [s["updated_at"] for s in rows], reverse=True
    )
    # bob 不可见
    assert c.get("/api/agent/sessions", headers=_auth(bob)).json() == []


def test_session_replay_and_ownership(ctx, monkeypatch):
    c, alice, bob, _, _ = ctx
    _mock_llm(monkeypatch, [{"content": "答"}])
    sid = _chat(c, alice, [{"role": "user", "content": "问"}]).headers["x-agent-session-id"]

    r = c.get(f"/api/agent/sessions/{sid}", headers=_auth(alice))
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == sid and body["message_count"] == 2
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]
    assert body["messages"][1]["media"] == []

    assert c.get(f"/api/agent/sessions/{sid}", headers=_auth(bob)).status_code == 404
    assert c.get("/api/agent/sessions/ghost", headers=_auth(alice)).status_code == 404


def test_session_detail_backfills_submit_generation_results(ctx):
    """W4(2026-08-31):submit_generation 工具消息(无媒体)回放时按 job_id 回填 Job 表
    最新产物——异步作业对话结束后完成的场景也能看到;仅 done 回填,他人 Job 不回填。"""
    c, alice, _, engine, ids = ctx
    alice_id = ids[0]
    jid = "a" * 32
    with Session(engine) as s:
        user = s.get(User, alice_id)
        sess = AgentSession(user_id=alice_id, title="回填")
        s.add(sess)
        s.commit()
        s.refresh(sess)
        s.add(AgentMessage(session_id=sess.id, role="user", content="画两张"))
        s.add(AgentMessage(
            session_id=sess.id, role="assistant", content="",
            tool_calls=json.dumps([{"id": "t1", "function": {"name": "submit_generation", "arguments": "{}"}}]),
        ))
        # submit_generation 的工具回执:文本内含 job_id,media 为空(对话期间作业未完成)
        s.add(AgentMessage(
            session_id=sess.id, role="tool",
            content=f"作业已提交(job_id={jid},引擎 文生图),后台生成中。",
            tool_calls=json.dumps({"tool_call_id": "t1", "name": "submit_generation", "args": {}}),
        ))
        s.add(AgentMessage(session_id=sess.id, role="assistant", content="已提交,约 1 分钟"))
        s.commit()
        sid = sess.id
        # 作业在对话结束后完成
        s.add(Job(
            id=jid, tenant_id=user.tenant_id, user_id=alice_id, prompt_id="p1",
            worker="http://w1:8188", kind="txt2img", status="done", prompt="cat",
            result=json.dumps(["/api/images?filename=a.png&sig=x"]),
        ))
        # 他人同名 job(不应泄漏)
        bob_row = s.exec(select(User).where(User.email == "bob@toiv.ai")).first()
        s.add(Job(
            id="b" * 32, tenant_id=bob_row.tenant_id, user_id=bob_row.id, prompt_id="p2",
            worker="http://w1:8188", kind="txt2img", status="done", prompt="other",
            result=json.dumps(["/api/images?filename=secret.png&sig=y"]),
        ))
        s.commit()

    body = c.get(f"/api/agent/sessions/{sid}", headers=_auth(alice)).json()
    tool_msg = next(m for m in body["messages"] if m["role"] == "tool")
    assert tool_msg["media"] == [{"type": "image", "urls": ["/api/images?filename=a.png&sig=x"]}]
    assert "secret" not in json.dumps(body)

    # 作业未完成 → 不回填
    with Session(engine) as s:
        job = s.get(Job, jid)
        job.status = "running"
        job.result = ""
        s.add(job)
        s.commit()
    body2 = c.get(f"/api/agent/sessions/{sid}", headers=_auth(alice)).json()
    tool_msg2 = next(m for m in body2["messages"] if m["role"] == "tool")
    assert tool_msg2["media"] == []


# --------------------------------------------------------------------------- #
# 分叉 / 删除
# --------------------------------------------------------------------------- #
def test_fork_full_and_truncated(ctx, monkeypatch):
    c, alice, _, engine, _ = ctx
    _mock_llm(monkeypatch, [{"content": "答一"}, {"content": "答二"}])
    sid = _chat(c, alice, [{"role": "user", "content": "问一"}]).headers["x-agent-session-id"]
    _chat(
        c, alice,
        [
            {"role": "user", "content": "问一"},
            {"role": "assistant", "content": "答一"},
            {"role": "user", "content": "问二"},
        ],
        session_id=sid,
    )
    rows = _messages(engine, sid)
    assert len(rows) == 4

    # 全量分叉
    r = c.post(f"/api/agent/sessions/{sid}/fork", headers=_auth(alice), json={})
    assert r.status_code == 200, r.text
    fork_id = r.json()["id"]
    assert fork_id != sid and r.json()["message_count"] == 4

    # 截断分叉:复制到第 2 条为止(含)
    r2 = c.post(
        f"/api/agent/sessions/{sid}/fork",
        headers=_auth(alice),
        json={"at_message_id": rows[1].id},
    )
    assert r2.status_code == 200
    fork2 = r2.json()
    assert fork2["message_count"] == 2
    detail = c.get(f"/api/agent/sessions/{fork2['id']}", headers=_auth(alice)).json()
    assert [m["content"] for m in detail["messages"]] == ["问一", "答一"]

    # 截断点不属于本会话 → 404
    r3 = c.post(
        f"/api/agent/sessions/{sid}/fork",
        headers=_auth(alice),
        json={"at_message_id": 999999},
    )
    assert r3.status_code == 404


def test_fork_ownership(ctx, monkeypatch):
    c, alice, bob, _, _ = ctx
    _mock_llm(monkeypatch, [{"content": "答"}])
    sid = _chat(c, alice, [{"role": "user", "content": "问"}]).headers["x-agent-session-id"]
    assert c.post(f"/api/agent/sessions/{sid}/fork", headers=_auth(bob), json={}).status_code == 404


def test_delete_session(ctx, monkeypatch):
    c, alice, bob, _, _ = ctx
    _mock_llm(monkeypatch, [{"content": "答"}])
    sid = _chat(c, alice, [{"role": "user", "content": "问"}]).headers["x-agent-session-id"]

    assert c.delete(f"/api/agent/sessions/{sid}", headers=_auth(bob)).status_code == 404
    r = c.delete(f"/api/agent/sessions/{sid}", headers=_auth(alice))
    assert r.status_code == 200 and r.json()["ok"] is True
    assert c.get(f"/api/agent/sessions/{sid}", headers=_auth(alice)).status_code == 404
    assert c.get("/api/agent/sessions", headers=_auth(alice)).json() == []


# --------------------------------------------------------------------------- #
# R18 过滤(对齐 Job:无 X-NSFW 头一律不可见)
# --------------------------------------------------------------------------- #
def test_nsfw_session_filtered_without_header(ctx, monkeypatch):
    c, alice, _, _, _ = ctx
    _mock_llm(monkeypatch, [{"content": "答"}])
    sid = _chat(c, alice, [{"role": "user", "content": "R18 创作"}], nsfw=True).headers[
        "x-agent-session-id"
    ]

    # 无头:列表过滤、详情/分叉/删除/续聊 404
    assert c.get("/api/agent/sessions", headers=_auth(alice)).json() == []
    assert c.get(f"/api/agent/sessions/{sid}", headers=_auth(alice)).status_code == 404
    assert (
        c.post(f"/api/agent/sessions/{sid}/fork", headers=_auth(alice), json={}).status_code
        == 404
    )
    assert c.delete(f"/api/agent/sessions/{sid}", headers=_auth(alice)).status_code == 404
    assert (
        _chat(c, alice, [{"role": "user", "content": "继续"}], session_id=sid).status_code
        == 404
    )

    # 带头:可见
    r = c.get("/api/agent/sessions", headers=_auth(alice, nsfw=True))
    assert [s["id"] for s in r.json()] == [sid]
    assert r.json()[0]["nsfw"] is True
    assert c.get(f"/api/agent/sessions/{sid}", headers=_auth(alice, nsfw=True)).status_code == 200


# --------------------------------------------------------------------------- #
# 未认证
# --------------------------------------------------------------------------- #
def test_unauthenticated_401(ctx):
    c, *_ = ctx
    assert c.post("/api/agent/chat", json={"messages": [{"role": "user", "content": "x"}]}).status_code == 401
    assert c.get("/api/agent/sessions").status_code == 401
    assert c.get("/api/agent/sessions/s1").status_code == 401
    assert c.post("/api/agent/sessions/s1/fork", json={}).status_code == 401
    assert c.delete("/api/agent/sessions/s1").status_code == 401
