"""子 Agent 编排原型(M2 草案)测试:拆解解析 / DAG 调度 / 产物传递 / 失败传播 / 底座落库。"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent import subagent as sa
from app.models import AgentEvent, AgentRun, AgentTask, Tenant, User
from app.security import hash_password


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="subagent")
        s.add(tenant); s.commit(); s.refresh(tenant)
        user = User(email="sub@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user); s.commit(); s.refresh(user)
        yield s, user, engine


_PLAN_JSON = {
    "tasks": [
        {"kind": "research", "title": "调研水母生态", "instruction": "收集深海发光水母的习性要点",
         "depends_on": [], "persona": "海洋生物研究员", "tools": ["search_knowledge"]},
        {"kind": "draft", "title": "撰写解说词", "instruction": "基于调研写 200 字解说词",
         "depends_on": ["t1"], "persona": "纪录片文案", "tools": []},
        {"kind": "polish", "title": "汇总交付", "instruction": "合并全部产物", "depends_on": ["t1", "t2"]},
    ]
}


class _FakePlanLLM:
    """plan 调用:返回带 markdown 围栏的合法 JSON(测容错)。"""

    async def chat(self, msgs, tools=None):
        assert "任务规划器" in msgs[0]["content"]  # 规划器 system 正确路由
        return {"content": "```json\n" + json.dumps(_PLAN_JSON, ensure_ascii=False) + "\n```"}


class _FakeExecLLM:
    """执行阶段:plan 一次 + 子任务 N 次;记录每次 system 供断言产物传递。"""

    def __init__(self):
        self.systems: list[str] = []

    async def chat(self, msgs, tools=None):
        sys = msgs[0]["content"]
        self.systems.append(sys)
        if "任务规划器" in sys:
            return {"content": json.dumps(_PLAN_JSON, ensure_ascii=False)}
        if "调研水母生态" in sys:
            return {"content": "调研产物:水母发光机制三要点"}
        if "撰写解说词" in sys:
            return {"content": "解说词:幽暗深海中……"}
        if "汇总交付" in sys:
            return {"content": "最终汇总完成"}
        return {"content": "?"}


def _ctx(llm):
    fake = type("Ctx", (), {})()
    fake.service = lambda name: llm if name == "llm" else (_ for _ in ()).throw(KeyError(name))
    return fake


# --------------------------------------------------------------------------- #
# plan_subagents
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_plan_parses_fenced_json_and_defaults(db):
    with patch.object(sa, "get_ctx", lambda: _ctx(_FakePlanLLM())):
        tasks = await sa.plan_subagents("做一个深海水母科普短片", max_tasks=5)
    assert [t["_id"] for t in tasks] == ["t1", "t2", "t3"]
    assert tasks[2]["persona"] == "通用创作助手"  # 缺省补齐
    assert tasks[0]["depends_on"] == []


@pytest.mark.asyncio
async def test_plan_empty_tasks_raises(db):
    class _Empty:
        async def chat(self, msgs, tools=None):
            return {"content": "```json\n{\"tasks\": []}\n```"}

    with patch.object(sa, "get_ctx", lambda: _ctx(_Empty())):
        with pytest.raises(ValueError):
            await sa.plan_subagents("goal")


# --------------------------------------------------------------------------- #
# create_run + execute_run 全链路(DAG 调度/产物传递/落库/事件)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_full_run_dag_schedule_and_upstream_passing(db):
    s, user, engine = db
    llm = _FakeExecLLM()

    def factory():
        return Session(engine)

    with patch.object(sa, "get_ctx", lambda: _ctx(llm)):
        run = await sa.create_run(s, user, "深海水母科普短片")
        assert run.status == "running"
        tasks = list(s.exec(select(AgentTask).where(AgentTask.run_id == run.id)))
        assert len(tasks) == 3
        assert {t.kind for t in tasks} == {"research", "draft", "polish"}

        events = [ev async for ev in sa.execute_run(run.id, factory, user)]
        # 事件流:plan → 3×task_status(done) → done(顺序保证:plan 在前、done 在尾)
        assert events[0]["type"] == "plan"
        assert [e["type"] for e in events[-4:-1]] == ["task_status"] * 3
        assert events[-1]["type"] == "done"
        # 产物传递:t2 的 system 里含 t1 产物;t3 的 system 里含 t1+t2 产物
        t2_sys = next(x for x in llm.systems if "撰写解说词" in x)
        t3_sys = next(x for x in llm.systems if "汇总交付" in x)
        assert "水母发光机制三要点" in t2_sys
        assert "解说词:幽暗深海中" in t3_sys
        # 底座落库:run done + tasks done + output_json 有文本 + AgentEvent 流水
        s.expire_all()
        assert s.get(AgentRun, run.id).status == "done"
        rows = list(s.exec(select(AgentTask).where(AgentTask.run_id == run.id)))
        assert all(t.status == "done" for t in rows)
        assert "水母发光机制" in next(t.output_json for t in rows if t.title == "t1")
        evs = list(s.exec(select(AgentEvent).where(AgentEvent.run_id == run.id)))
        assert {e.type for e in evs} >= {"ack", "plan"}


@pytest.mark.asyncio
async def test_subagent_failure_marks_run_error(db):
    s, user, engine = db

    class _Boom:
        async def chat(self, msgs, tools=None):
            sys = msgs[0]["content"]
            if "任务规划器" in sys:
                return {"content": json.dumps(_PLAN_JSON, ensure_ascii=False)}
            if "调研水母生态" in sys:
                raise RuntimeError("llm down")
            return {"content": "ok"}

    def factory():
        return Session(engine)

    with patch.object(sa, "get_ctx", lambda: _ctx(_Boom())):
        run = await sa.create_run(s, user, "goal")
        events = [ev async for ev in sa.execute_run(run.id, factory, user)]

    assert any(e["type"] == "task_status" and e.get("status") == "error" for e in events)
    assert events[-1]["type"] == "error"
    s.expire_all()
    assert s.get(AgentRun, run.id).status == "error"


# --------------------------------------------------------------------------- #
# research 工具循环(联网调研):工具调用 → 结果回灌 → 综合产出
# --------------------------------------------------------------------------- #


class _FakeToolReg:
    def __init__(self):
        self.executed: list[tuple[str, dict]] = []

    def schemas(self):
        return [{"type": "function", "function": {"name": "web_search",
                 "description": "x", "parameters": {"type": "object", "properties": {}}}}]

    async def execute(self, name, args, ctx):
        self.executed.append((name, args))
        return "联网结果:FLUX.3 已发布,支持 4K 原生", []


class _ResearchLLM:
    """规划 1 次;research 子代理第 1 轮调 web_search,第 2 轮综合输出;其余直接答。"""

    def __init__(self):
        self.round = 0

    async def chat(self, msgs, tools=None):
        sys = msgs[0]["content"]
        if "任务规划器" in sys:
            return {"content": json.dumps({
                "tasks": [{"kind": "research", "title": "查最新文生图模型",
                           "instruction": "联网调研最新文生图模型动态", "depends_on": []},
                          {"kind": "polish", "title": "汇总", "instruction": "合并", "depends_on": ["t1"]}],
            }, ensure_ascii=False)}
        if "查最新文生图模型" in sys:
            assert tools, "research 子代理必须带工具 schema"
            self.round += 1
            if self.round == 1:
                return {"content": "", "tool_calls": [
                    {"id": "c1", "function": {"name": "web_search",
                                              "arguments": "{\"query\": \"FLUX.3 release\"}"}}]}
            # 第 2 轮:历史里应已有工具结果
            assert any(m.get("role") == "tool" and "FLUX.3" in (m.get("content") or "") for m in msgs)
            return {"content": "调研结论:FLUX.3 支持 4K 原生输出", "tool_calls": []}
        return {"content": "汇总完成"}


@pytest.mark.asyncio
async def test_research_subagent_runs_tool_loop(db):
    s, user, engine = db
    llm = _ResearchLLM()
    reg = _FakeToolReg()

    class _Ctx:
        def service(self, name):
            if name == "llm":
                return llm
            if name == "tools":
                return reg
            raise KeyError(name)

    def factory():
        return Session(engine)

    with patch.object(sa, "get_ctx", lambda: _Ctx()):
        run = await sa.create_run(s, user, "调研最新文生图模型")
        tool_ctx = {"pool": None, "user": user, "session": s}
        events = [ev async for ev in sa.execute_run(run.id, factory, user, tool_ctx=tool_ctx)]

    assert reg.executed == [("web_search", {"query": "FLUX.3 release"})]
    assert events[-1]["type"] == "done"
    assert "FLUX.3 支持 4K" in events[-1]["outputs"]["t1"]


# --------------------------------------------------------------------------- #
# distill_skills 学习沉淀
# --------------------------------------------------------------------------- #


class _DistillLLM:
    async def chat(self, msgs, tools=None):
        if "知识沉淀器" in msgs[0]["content"]:
            return {"content": "```json\n" + json.dumps({"skills": [
                {"name": "水母主题配方", "description": "深海 发光 水母 海洋",
                 "system_prompt": "画深海生物时:冷色调+生物发光点缀+悬浮粒子;" + "细节" * 30},
                {"name": "空壳", "description": "x", "system_prompt": "太短"},
            ]}, ensure_ascii=False) + "\n```"}
        return {"content": "{}"}


@pytest.mark.asyncio
async def test_distill_skills_creates_personal_cards(db):
    s, user, engine = db
    with patch.object(sa, "get_ctx", lambda: _ctx(_DistillLLM())):
        cards = await sa.distill_skills(
            s, user, "水母海报", {"t1": "调研产物", "t2": "配色方案"})

    assert len(cards) == 1  # 空壳卡被过滤
    card = cards[0]  # dict 快照(detach 安全)
    assert card["id"].startswith("learned_")
    from app.models import Agent as SkillModel
    row = s.get(SkillModel, card["id"])
    assert row is not None and row.name == "水母主题配方"
    assert row.user_id == user.id  # 个人技能(Skill 市场可见/可编辑)
    assert row.icon == "graduation-cap"


@pytest.mark.asyncio
async def test_learn_flag_emits_learn_event(db):
    s, user, engine = db

    class _LearnLLM(_FakeExecLLM):
        """执行 + 沉淀两阶段。"""

        async def chat(self, msgs, tools=None):
            sys = msgs[0]["content"]
            if "知识沉淀器" in sys:
                return {"content": json.dumps({"skills": [
                    {"name": "调研方法论", "description": "调研 搜索",
                     "system_prompt": "多轮换关键词搜索后交叉验证来源" + "x" * 30}]})}
            return await super().chat(msgs, tools)

    def factory():
        return Session(engine)

    with patch.object(sa, "get_ctx", lambda: _ctx(_LearnLLM())):
        run = await sa.create_run(s, user, "深海水母科普短片")
        events = [ev async for ev in sa.execute_run(run.id, factory, user, learn=True)]

    learn_evs = [e for e in events if e["type"] == "learn"]
    assert learn_evs and learn_evs[0]["status"] == "done"
    assert learn_evs[0]["skills"][0]["name"] == "调研方法论"


# --------------------------------------------------------------------------- #
# websearch 纯函数(不依赖网络)
# --------------------------------------------------------------------------- #


def test_websearch_url_unwrap_and_strip():
    from app.agent.websearch import _clean_url, _strip

    u = "/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=abc"
    assert _clean_url(u) == "https://example.com/a?b=1"
    assert _clean_url("https://plain.example/x") == "https://plain.example/x"
    assert _strip("<b>Hello &amp; 世界</b>") == "Hello & 世界"


@pytest.mark.asyncio
async def test_web_search_disabled_returns_friendly_text(db):
    from types import SimpleNamespace

    from app.agent import websearch as ws

    with patch.object(ws, "get_settings", lambda: SimpleNamespace(web_search_enabled=False)):
        text, evs = await ws.exec_web_search({"query": "x"}, None, None, None)
    assert "未启用" in text and evs == []


# --------------------------------------------------------------------------- #
# 路由集成:POST /api/agent/subagent → 202 + run_id + events_url
# --------------------------------------------------------------------------- #


def test_subagent_route_creates_run_and_returns_events_url():
    import time

    from fastapi.testclient import TestClient
    from sqlalchemy import event
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    from app.db import get_session
    from app.main import app
    from app.models import AgentRun, Tenant, User
    from app.security import create_token, hash_password

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        with Session(engine) as s:
            tenant = Tenant(name="route")
            s.add(tenant); s.commit(); s.refresh(tenant)
            u = User(email="route@toiv.ai", hashed_password=hash_password("password1"),
                     tenant_id=tenant.id)
            s.add(u); s.commit(); s.refresh(u)
            token = create_token(u.id)

        class _RouteCtx:
            """llm + tools 双服务(research 子任务后台走工具循环)。"""

            def __init__(self):
                self._llm = _FakeExecLLM()
                self._reg = _FakeToolReg()

            def service(self, name):
                if name == "llm":
                    return self._llm
                if name == "tools":
                    return self._reg
                raise KeyError(name)

        with patch.object(sa, "get_ctx", lambda: _RouteCtx()):
            client = TestClient(app)
            r = client.post(
                "/api/agent/subagent",
                json={"goal": "调研最新的文生视频模型生态并汇总", "max_tasks": 3},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["run_id"] and body["status"] == "running"
        assert body["events_url"].endswith(f"/agent-runs/{body['run_id']}/events")
        # 等 _drive 后台跑完(mock 毫秒级)
        time.sleep(0.5)
        with Session(engine) as s:
            run = s.get(AgentRun, body["run_id"])
            assert run is not None and run.user_id == u.id
            assert run.status in ("running", "done")
    finally:
        app.dependency_overrides.clear()


def test_subagent_route_rejects_short_goal():
    from fastapi.testclient import TestClient
    from sqlalchemy import event
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    from app.db import get_session
    from app.main import app
    from app.models import Tenant, User
    from app.security import create_token, hash_password

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        with Session(engine) as s:
            tenant = Tenant(name="route2")
            s.add(tenant); s.commit(); s.refresh(tenant)
            u = User(email="route2@toiv.ai", hashed_password=hash_password("password1"),
                     tenant_id=tenant.id)
            s.add(u); s.commit(); s.refresh(u)
            token = create_token(u.id)
        client = TestClient(app)
        r = client.post("/api/agent/subagent", json={"goal": "ab"},
                        headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 422  # min_length=4 校验
        r = client.post("/api/agent/subagent", json={"goal": "这是一个足够长的目标"})
        assert r.status_code == 401  # 未认证
    finally:
        app.dependency_overrides.clear()
