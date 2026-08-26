"""深度接管生成工具测试(tools_gen.py + resume 端点,2026-08-24)。

覆盖:
- 4 个新工具经 tool_seam 注册(schema 与 TOOL_SCHEMAS_GEN 同源);
- submit_generation 替身链路(stub 引擎可用性 + stub tracker + fake pool/client,
  走真实 routes/generate 提交函数):Job 落库、job 事件、立即返回不阻塞;
- R18 逐引擎门控:无 X-NSFW 上下文被拦(403 语义,executor 不到提交);
- check_jobs:状态/held 原因/done 产物签名 URL;跨用户不可见;
- optimize_prompt 工具复用 routes/optimize 同一链路(LLM 替身);
- propose_plan 持久化 + /api/agent/chat/resume 三态(approve/modify/reject)
  + 404/409 边界。

每个用例前后 reset_ctx()(同 test_harness_tools 纪律)。
"""
from __future__ import annotations

import json
import re
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent import llm, tools_gen
from app.db import get_session
from app.deps import get_pool
from app.harness.ctx import get_ctx, reset_ctx
from app.main import app
from app.models import AgentMessage, AgentSession, Job, Tenant, User
from app.nsfw_ctx import nsfw_intent_var
from app.security import create_token, hash_password
from app.services import engine_registry


@pytest.fixture(autouse=True)
async def _fresh_ctx():
    await reset_ctx()
    yield
    await reset_ctx()


# --------------------------------------------------------------------------- #
# 工具级 fixture(fake pool/client + 真库 session)
# --------------------------------------------------------------------------- #
class _FakeClient:
    def __init__(self, base_url: str = "http://fake:8188") -> None:
        self.base_url = base_url
        self.queued: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.queued.append(graph)
        return f"pid-{len(self.queued)}"


class _FakePool:
    def __init__(self, client: _FakeClient) -> None:
        self.clients = [client]

    async def pick(self, required=None, required_nodes=None):
        return self.clients[0]


@pytest.fixture
def db_env():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="gen@toiv.ai", hashed_password="x", tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        yield s, user


def _ctx(pool, user, session, attachment=None, agent_session=None):
    return {
        "pool": pool, "user": user, "session": session,
        "attachment": attachment, "agent_session": agent_session,
    }


def _stub_engines_available(monkeypatch, *engine_ids: str):
    """引擎可用性替身:给定 id 可用,其余不在列表(不影响 get_engine_spec 原始条目)。"""
    async def fake_list_engines(pool, user=None):
        return [
            {"id": eid, "label": eid, "kind": "image", "nsfw": False,
             "available": True, "params": []}
            for eid in engine_ids
        ]

    monkeypatch.setattr(engine_registry, "list_engines", fake_list_engines)


# --------------------------------------------------------------------------- #
# 注册
# --------------------------------------------------------------------------- #
def test_gen_tools_registered_after_builtin():
    reg = get_ctx().service("tools")
    names = reg.names
    for n in ("submit_generation", "list_entities", "check_jobs", "optimize_prompt", "propose_plan", "adjust_3d"):
        assert n in names
    # 追加在 10 个同步小工具之后
    assert names[-6:] == [
        "submit_generation", "list_entities", "check_jobs", "optimize_prompt", "propose_plan", "adjust_3d"
    ]
    schemas = {s["function"]["name"]: s for s in reg.schemas()}
    assert schemas["submit_generation"]["function"]["parameters"]["required"] == [
        "engine_id", "positive"
    ]
    # 提交/优化走路由自带限流,守卫不双记配额
    assert reg.get("submit_generation").rate_scope == ""
    assert reg.get("optimize_prompt").rate_scope == ""


def test_dispatch_covers_all_registry_engines():
    """注册表 22 个引擎全部有提交分发(防新增引擎漏接)。"""
    engine_registry.populate_registry()
    ids = [s["id"] for s in engine_registry._REGISTRY]
    assert len(ids) == 22
    missing = [eid for eid in ids if eid not in tools_gen._DISPATCH]
    assert missing == []


# --------------------------------------------------------------------------- #
# submit_generation
# --------------------------------------------------------------------------- #
async def test_submit_txt2img_stub_chain(db_env, monkeypatch):
    """替身链路:真实 routes/generate 提交函数 + fake pool + stub tracker。"""
    s, user = db_env
    # tracker 替身:不真挂后台轮询(其落库行为由 tracker 自身测试锁定)
    monkeypatch.setattr("app.routes.generate.spawn_tracker", lambda client, pid: None)
    _stub_engines_available(monkeypatch, "txt2img")
    client = _FakeClient()

    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "submit_generation",
        {"engine_id": "txt2img", "positive": "a cat", "params": {"width": 512, "height": 512}},
        _ctx(_FakePool(client), user, s),
    )
    assert "作业已提交" in text and "job_id=" in text
    assert len(client.queued) == 1, "真实提交函数建图并 queue_prompt"
    # Job 落库 + job 事件(queued,无 results)
    job = s.exec(select(Job).where(Job.user_id == user.id)).first()
    assert job is not None and job.status == "queued" and job.kind == "txt2img"
    job_events = [e for e in events if e.get("type") == "job"]
    assert len(job_events) == 1
    data = job_events[0]["data"]
    assert data["job_id"] == job.id and data["status"] == "queued"
    assert data["kind"] == "txt2img" and "results" not in data


async def test_submit_unknown_engine(db_env):
    s, user = db_env
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "submit_generation", {"engine_id": "ghost", "positive": "x"},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "未知引擎" in text
    assert events[0]["data"]["status"] == "error"
    assert s.exec(select(Job)).all() == []


# --------------------------------------------------------------------------- #
# 全局主体库:list_entities 工具 + submit_generation 的 entity_ids 注入
# --------------------------------------------------------------------------- #
def _entity(session, user, name: str, *, kind: str = "character",
            prompt_hint: str = "", ref_image: str = "") -> "Entity":
    from app.models import Entity as _E

    e = _E(tenant_id=user.tenant_id, user_id=user.id, kind=kind, name=name,
           prompt_hint=prompt_hint, ref_image=ref_image)
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


async def test_list_entities_tool(db_env):
    """list_entities:列出当前用户主体(含 id/kind/有图标记);空库给引导文案。"""
    s, user = db_env
    reg = get_ctx().service("tools")
    text, _ = await reg.execute("list_entities", {}, _ctx(_FakePool(_FakeClient()), user, s))
    assert "主体库为空" in text

    e = _entity(s, user, "阿明", prompt_hint="1boy, silver hair",
                ref_image='{"filename":"a.png","worker":"http://w:8189"}')
    _entity(s, user, "旧仓库", kind="scene")
    text, _ = await reg.execute("list_entities", {}, _ctx(_FakePool(_FakeClient()), user, s))
    assert f"id={e.id}" in text and "阿明" in text and "有图" in text
    # kind 过滤
    text, _ = await reg.execute(
        "list_entities", {"kind": "scene"}, _ctx(_FakePool(_FakeClient()), user, s)
    )
    assert "旧仓库" in text and "阿明" not in text


def test_apply_entity_refs_injects_hint_and_image(db_env):
    """entity_ids 注入:prompt_hint 拼入提示词;首个有图主体补 image/worker(显式优先)。"""
    s, user = db_env
    e1 = _entity(s, user, "阿明", prompt_hint="1boy, silver hair",
                 ref_image='{"filename":"aming.png","worker":"http://w:8189"}')
    e2 = _entity(s, user, "旧仓库", kind="scene", prompt_hint="old warehouse, night")
    pos, params, names = tools_gen._apply_entity_refs(
        s, user, [e1.id, e2.id], "a boy runs", {}, ("image", "worker"),
    )
    assert names == ["阿明", "旧仓库"]
    assert "a boy runs" in pos and "1boy, silver hair" in pos and "old warehouse" in pos
    assert params["image"] == "aming.png" and params["worker"] == "http://w:8189"

    # 显式 image 参数优先,不被主体覆盖
    pos, params, _ = tools_gen._apply_entity_refs(
        s, user, [e1.id], "p", {"image": "explicit.png"}, ("image", "worker"),
    )
    assert params["image"] == "explicit.png"

    # 纯文本引擎(无 image 媒体键):只注入提示词,不补图
    _, params, _ = tools_gen._apply_entity_refs(s, user, [e1.id], "p", {}, ())
    assert "image" not in params


def test_apply_entity_refs_isolation_and_url_form(db_env):
    """他人主体静默跳过;站内 /api/images URL 形态可还原注入句柄。"""
    s, user = db_env
    other = User(email="other@toiv.ai", hashed_password="x", tenant_id=user.tenant_id)
    s.add(other)
    s.commit()
    s.refresh(other)
    foreign = _entity(s, other, "别人的", prompt_hint="not yours")
    _, params, names = tools_gen._apply_entity_refs(
        s, user, [foreign.id], "p", {}, ("image", "worker"),
    )
    assert names == [] and "image" not in params, "他人主体不解析不注入"

    url_entity = _entity(
        s, user, "URL图", ref_image="/api/images?filename=u.png&worker=http://w:8189&type=output"
    )
    _, params, names = tools_gen._apply_entity_refs(
        s, user, [url_entity.id], "p", {}, ("image", "worker"),
    )
    assert names == ["URL图"]
    assert params["image"] == "u.png" and params["worker"] == "http://w:8189"


async def test_submit_engine_unavailable(db_env, monkeypatch):
    s, user = db_env

    async def fake_list_engines(pool, user=None):
        return [{"id": "h3-t2v", "label": "MiniMax H3 文生视频", "kind": "video",
                 "nsfw": False, "available": False,
                 "unavailable_reason": "H3 实例不可达", "params": []}]

    monkeypatch.setattr(engine_registry, "list_engines", fake_list_engines)
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "submit_generation", {"engine_id": "h3-t2v", "positive": "一只猫在跑"},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "当前不可用" in text and "H3 实例不可达" in text
    assert events[0]["data"]["status"] == "error"


async def test_submit_r18_engine_blocked_without_nsfw(db_env):
    """R18 引擎无 X-NSFW 上下文 → 403 语义文本,不到提交(逐引擎门控)。"""
    s, user = db_env
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "submit_generation", {"engine_id": "h3-nsfw-t2v", "positive": "nsfw clip"},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "403" in text and "R18" in text
    assert events[0]["data"]["status"] == "error"
    assert s.exec(select(Job)).all() == [], "被拦时不落 Job"


async def test_submit_r18_engine_allowed_with_nsfw(db_env, monkeypatch):
    """R18 上下文放行:stub 专用实例提交函数(h3_studio 同一入口)。"""
    s, user = db_env
    _stub_engines_available(monkeypatch, "h3-nsfw-t2v")

    async def fake_h3_t2v(req, user, session):
        job = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="h3pid",
                  worker="http://h3:8195", kind="h3_t2v", status="queued",
                  prompt=req.positive, seed=1, nsfw=True)
        session.add(job)
        session.commit()
        session.refresh(job)
        return {"prompt_id": "h3pid", "client_id": "", "worker": "http://h3:8195", "seed": 1}

    monkeypatch.setattr("app.routes.h3_studio.generate_h3_t2v", fake_h3_t2v)
    token = nsfw_intent_var.set(True)
    try:
        reg = get_ctx().service("tools")
        text, events = await reg.execute(
            "submit_generation", {"engine_id": "h3-nsfw-t2v", "positive": "clip"},
            _ctx(_FakePool(_FakeClient()), user, s),
        )
    finally:
        nsfw_intent_var.reset(token)
    assert "作业已提交" in text
    job = s.exec(select(Job).where(Job.prompt_id == "h3pid")).first()
    assert job is not None and job.nsfw is True
    data = [e for e in events if e.get("type") == "job"][0]["data"]
    assert data["job_id"] == job.id and data["status"] == "queued"


async def test_submit_held_job_reports_hold_reason(db_env, monkeypatch):
    """hold 排队:submit 返回 held + hold_reason 时,job 事件带 hold_reason。"""
    s, user = db_env
    _stub_engines_available(monkeypatch, "longcat-t2v")

    async def fake_longcat_t2v(req, user, session):
        job = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="hold-abc",
                  worker="http://lc:8197", kind="longcat_t2v", status="held",
                  prompt=req.positive, seed=1, hold_reason="显存不足")
        session.add(job)
        session.commit()
        session.refresh(job)
        return {"prompt_id": "hold-abc", "held": True, "hold_reason": "显存不足",
                "worker": "http://lc:8197", "seed": 1}

    monkeypatch.setattr("app.routes.longcat_studio.generate_longcat_t2v", fake_longcat_t2v)
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "submit_generation", {"engine_id": "longcat-t2v", "positive": "长镜头"},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "排队" in text and "显存不足" in text
    data = [e for e in events if e.get("type") == "job"][0]["data"]
    assert data["status"] == "held" and data["hold_reason"] == "显存不足"


# --------------------------------------------------------------------------- #
# check_jobs
# --------------------------------------------------------------------------- #
async def test_check_jobs_status_and_results(db_env):
    s, user = db_env
    done = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="p1",
               worker="w", kind="h3_t2v", status="done",
               result=json.dumps(["/api/images?filename=a.mp4&sig=xyz"]))
    held = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="hold-x",
               worker="w", kind="longcat_t2v", status="held", hold_reason="VRAM 不足")
    err = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="p3",
              worker="w", kind="txt2img", status="error")
    other = Job(tenant_id="t", user_id="someone-else", prompt_id="p9",
                worker="w", kind="txt2img", status="done")
    for j in (done, held, err, other):
        s.add(j)
    s.commit()
    for j in (done, held, err, other):
        s.refresh(j)

    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "check_jobs", {"job_ids": [done.id, held.id, err.prompt_id, other.id, "ghost"]},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert f"{done.id} [h3_t2v]:done" in text and "产物 1 个" in text
    assert f"{held.id} [longcat_t2v]:held" in text and "VRAM 不足" in text
    assert f"{err.id} [txt2img]:error" in text  # prompt_id 入参解析到同一 Job
    assert f"{other.id}:不存在" in text, "他人作业不可见"
    assert "ghost:不存在" in text
    # done 的补发 job 事件带签名 URL;held/error 不发
    job_events = [e for e in events if e.get("type") == "job"]
    assert len(job_events) == 1
    assert job_events[0]["data"]["results"] == ["/api/images?filename=a.mp4&sig=xyz"]


# --------------------------------------------------------------------------- #
# optimize_prompt(复用 routes/optimize 同一链路)
# --------------------------------------------------------------------------- #
async def test_optimize_tool_reuses_route(db_env, monkeypatch):
    s, user = db_env
    seen: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        seen["system"] = messages[0]["content"]
        seen["layer"] = layer
        return {"content": '{"positive": "a fluffy cat, masterpiece", "negative": "blurry"}'}

    monkeypatch.setattr(llm, "chat_layered", fake_chat_layered)
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "optimize_prompt", {"prompt": "一只猫", "kind": "image"},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "a fluffy cat, masterpiece" in text
    assert "blurry" in text
    assert events == []
    # 与 /api/optimize 同一系统提示(内容感知规则在)
    assert "提示词工程师" in seen["system"]


async def test_optimize_tool_video_engine_dialect(db_env, monkeypatch):
    """视频 + engine=h3-t2v:走 H3 方言系统提示(负向全正向化)。"""
    s, user = db_env
    seen: dict = {}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        seen["system"] = messages[0]["content"]
        return {"content": '{"positive": "a cat runs", "negative": "blurry"}'}

    monkeypatch.setattr(llm, "chat_layered", fake_chat_layered)
    reg = get_ctx().service("tools")
    await reg.execute(
        "optimize_prompt",
        {"prompt": "猫跑", "kind": "video", "engine": "h3-t2v"},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "MiniMax H3" in seen["system"] and "正向指令" in seen["system"]


# --------------------------------------------------------------------------- #
# propose_plan 持久化 + resume 三态(路由级,TestClient)
# --------------------------------------------------------------------------- #
class _ListModelsClient:
    base_url = "http://fake-worker:8188"

    async def object_info(self, kind: str) -> dict:
        return {"CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["a.safetensors"]]}}}}


@pytest.fixture
def route_ctx(monkeypatch):
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
    app.dependency_overrides[get_pool] = lambda: SimpleNamespace(clients=[_ListModelsClient()])

    with Session(engine) as s:
        tenant = Tenant(name="alice")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="alice@toiv.ai", hashed_password=hash_password("password1"),
                    tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


def _mock_llm(monkeypatch, script: list[dict]):
    calls: list[list[dict]] = []

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):
        calls.append(messages)
        return script[min(len(calls) - 1, len(script) - 1)]

    monkeypatch.setattr(llm, "chat", fake_chat)
    return calls


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _parse_sse(text: str) -> list[tuple[str, dict]]:
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


def _chat_with_proposal(c: TestClient, token: str, monkeypatch) -> tuple[str, dict]:
    """跑一轮 propose_plan 对话,返回 (session_id, proposal_data)。"""
    _mock_llm(monkeypatch, [
        {"content": "", "tool_calls": [{
            "id": "tc_1",
            "function": {"name": "propose_plan", "arguments": json.dumps(
                {"title": "三段短片方案", "body": "1. 出底图\n2. H3 出三段\n3. 拼接",
                 "estimate": "约 45 分钟"})},
        }]},
        {"content": "方案已出,请确认"},
    ])
    r = c.post("/api/agent/chat", headers=_auth(token),
               json={"messages": [{"role": "user", "content": "帮我做一部三段短片"}]})
    assert r.status_code == 200, r.text
    sid = r.headers["x-agent-session-id"]
    events = _parse_sse(r.text)
    # 新协议:顶层 tool(start/ok) 与 proposal 事件
    tool_events = [d for e, d in events if e == "tool"]
    assert [d["status"] for d in tool_events] == ["start", "ok"]
    assert tool_events[0]["id"] == "tc_1" and tool_events[0]["name"] == "propose_plan"
    proposals = [d for e, d in events if e == "proposal"]
    assert len(proposals) == 1
    assert proposals[0]["title"] == "三段短片方案"
    assert proposals[0]["estimate"] == "约 45 分钟"
    assert events[-1][0] == "done"
    return sid, proposals[0]


def _pending_status(engine, sid: str):
    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        return json.loads(sess.pending_proposal) if sess and sess.pending_proposal else None


def test_propose_plan_persists_pending(route_ctx, monkeypatch):
    c, token, engine = route_ctx
    sid, prop = _chat_with_proposal(c, token, monkeypatch)
    stored = _pending_status(engine, sid)
    assert stored is not None
    assert stored["proposal_id"] == prop["proposal_id"]
    assert stored["status"] == "pending"


def test_resume_approve_continues_chat(route_ctx, monkeypatch):
    c, token, engine = route_ctx
    sid, prop = _chat_with_proposal(c, token, monkeypatch)
    _mock_llm(monkeypatch, [{"content": "好的,开始执行第一步"}])
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": prop["proposal_id"], "action": "approve",
    })
    assert r.status_code == 200, r.text
    assert r.headers["x-agent-session-id"] == sid
    events = _parse_sse(r.text)
    assert ("msg", {"type": "text", "content": "好的,开始执行第一步"}) in events
    assert events[-1][0] == "done"
    # 对决注入对话上下文(user 消息落库,含方案要点回顾)
    with Session(engine) as s:
        rows = list(s.exec(
            select(AgentMessage).where(AgentMessage.session_id == sid)
            .order_by(AgentMessage.id.asc())
        ).all())
    decision = [m for m in rows if m.role == "user" and "【方案确认】" in m.content]
    assert len(decision) == 1 and "三段短片方案" in decision[0].content
    assert rows[-1].content == "好的,开始执行第一步"
    assert _pending_status(engine, sid)["status"] == "approved"


def test_resume_modify_includes_note(route_ctx, monkeypatch):
    c, token, engine = route_ctx
    sid, prop = _chat_with_proposal(c, token, monkeypatch)
    _mock_llm(monkeypatch, [{"content": "按修改意见调整"}])
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": prop["proposal_id"],
        "action": "modify", "note": "改成两段,动漫画风",
    })
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        rows = list(s.exec(
            select(AgentMessage).where(AgentMessage.session_id == sid)
        ).all())
    decision = [m for m in rows if "【方案修改】" in m.content]
    assert len(decision) == 1
    assert "改成两段,动漫画风" in decision[0].content
    stored = _pending_status(engine, sid)
    assert stored["status"] == "modified" and stored["note"] == "改成两段,动漫画风"


def test_resume_reject(route_ctx, monkeypatch):
    c, token, engine = route_ctx
    sid, prop = _chat_with_proposal(c, token, monkeypatch)
    _mock_llm(monkeypatch, [{"content": "好的,我们重新讨论方向"}])
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": prop["proposal_id"], "action": "reject",
    })
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        rows = list(s.exec(
            select(AgentMessage).where(AgentMessage.session_id == sid)
        ).all())
    assert any("【方案拒绝】" in m.content and "重新讨论" in m.content for m in rows)
    assert _pending_status(engine, sid)["status"] == "rejected"


def test_resume_boundaries(route_ctx, monkeypatch):
    c, token, engine = route_ctx
    sid, prop = _chat_with_proposal(c, token, monkeypatch)
    # 无提案会话 404
    _mock_llm(monkeypatch, [{"content": "答"}])
    sid2 = c.post("/api/agent/chat", headers=_auth(token),
                  json={"messages": [{"role": "user", "content": "你好"}]}).headers[
        "x-agent-session-id"]
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid2, "proposal_id": "x", "action": "approve"})
    assert r.status_code == 404
    # proposal_id 不匹配 404
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": "nope", "action": "approve"})
    assert r.status_code == 404
    # 非法 action 422
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": prop["proposal_id"], "action": "meh"})
    assert r.status_code == 422
    # 重复处理 409
    _mock_llm(monkeypatch, [{"content": "开始"}])
    assert c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": prop["proposal_id"], "action": "approve",
    }).status_code == 200
    r = c.post("/api/agent/chat/resume", headers=_auth(token), json={
        "conversation_id": sid, "proposal_id": prop["proposal_id"], "action": "approve"})
    assert r.status_code == 409


def test_resume_requires_auth(route_ctx):
    c, *_ = route_ctx
    assert c.post("/api/agent/chat/resume", json={
        "conversation_id": "s", "proposal_id": "p", "action": "approve",
    }).status_code == 401
