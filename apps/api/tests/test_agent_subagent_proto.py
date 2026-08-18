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
