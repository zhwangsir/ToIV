"""自愈闭环延伸工具(A3)——exec_*:失败清单/失败详解/现场重测/提案回滚(含 admin 门)。"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.agent.tools_selfheal as tools_selfheal
from app.models import App, Board, SelfhealProposal, Tenant, User
from app.security import hash_password


@pytest.fixture
def fx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        admin = User(email="adm@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id, role="admin")
        plain = User(email="usr@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id, role="user")
        s.add(admin); s.add(plain)
        s.commit()
        s.refresh(admin); s.refresh(plain)
        ids = (admin.id, plain.id)
    return engine, ids


def _ctx(engine, user_id):
    with Session(engine) as s:
        user = s.get(User, user_id)
    return {"user": user, "session": Session(engine), "pool": None}


def _run(coro):
    return asyncio.run(coro)


def _seed_apps(engine, uid: str) -> tuple[str, str]:
    with Session(engine) as s:
        u = s.get(User, uid)
        a1 = App(id=uuid.uuid4().hex, tenant_id=u.tenant_id, user_id=uid, name="坏应用甲",
                 smoke_status="fail", smoke_cls="missing_model",
                 smoke_error="model not found: foo.safetensors")
        a2 = App(id=uuid.uuid4().hex, tenant_id=u.tenant_id, user_id=uid, name="超时应用乙",
                 smoke_status="timeout", smoke_cls="timeout", smoke_error="poll timeout")
        a3 = App(id=uuid.uuid4().hex, tenant_id=u.tenant_id, user_id=uid, name="好应用丙",
                 smoke_status="pass", smoke_cls="", smoke_error="")
        s.add(a1); s.add(a2); s.add(a3)
        s.commit()
        s.refresh(a1); s.refresh(a2)
        return a1.id, a2.id


def test_list_smoke_failures_and_gate(fx):
    engine, (admin, plain) = fx
    a1, a2 = _seed_apps(engine, admin)

    c = _ctx(engine, plain)
    text, events = _run(tools_selfheal.exec_list_smoke_failures({}, c))
    assert "仅管理员" in text and events and events[0]["type"] == "tool_event"
    c["session"].close()

    c = _ctx(engine, admin)
    text, events = _run(tools_selfheal.exec_list_smoke_failures({"limit": 10}, c))
    assert "坏应用甲" in text and "超时应用乙" in text and "好应用丙" not in text
    assert "missing_model" in text and "缺模型权重" in text
    assert events == []
    c["session"].close()


def test_explain_app_failure_with_proposal(fx):
    engine, (admin, _) = fx
    a1, _ = _seed_apps(engine, admin)
    with Session(engine) as s:
        p = SelfhealProposal(id=uuid.uuid4().hex, app_id=a1, failure_cls="missing_model",
                             patch_json="[]", original_workflow_json="{}", status="applied",
                             note="试提交仍失败")
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id

    c = _ctx(engine, admin)
    text, _ = _run(tools_selfheal.exec_explain_app_failure({"app_id": a1}, c))
    assert "missing_model" in text and "缺模型权重" in text and pid in text and "试提交仍失败" in text
    c["session"].close()

    c = _ctx(engine, admin)
    text, events = _run(tools_selfheal.exec_explain_app_failure({"app_id": "nope"}, c))
    assert "不存在" in text and events[0]["type"] == "tool_event"
    c["session"].close()


def test_run_app_smoke_delegates(fx, monkeypatch):
    engine, (admin, _) = fx
    a1, _ = _seed_apps(engine, admin)
    seen = {}

    async def fake_smoke(pool, session, app, **kw):
        seen["app_id"] = app.id
        return {"status": "pass", "cls": "", "fixes": ["combo 校准 x→y"]}

    monkeypatch.setattr("app.services.app_smoke.run_app_smoke", fake_smoke)
    c = _ctx(engine, admin)
    text, _ = _run(tools_selfheal.exec_run_app_smoke({"app_id": a1}, c))
    assert "pass" in text and "combo 校准" in text and seen["app_id"] == a1
    c["session"].close()

    async def fake_fail(pool, session, app, **kw):
        return {"status": "fail", "cls": "missing_node", "fixes": []}

    monkeypatch.setattr("app.services.app_smoke.run_app_smoke", fake_fail)
    c = _ctx(engine, admin)
    text, _ = _run(tools_selfheal.exec_run_app_smoke({"app_id": a1}, c))
    assert "fail" in text and "缺节点包" in text
    c["session"].close()


def test_reject_app_fix(fx, monkeypatch):
    engine, (admin, plain) = fx
    monkeypatch.setattr("app.services.selfheal_llm.reject_proposal",
                        lambda session, pid: {"id": pid, "status": "rejected"})
    c = _ctx(engine, admin)
    text, _ = _run(tools_selfheal.exec_reject_app_fix({"proposal_id": "p-1"}, c))
    assert "已回滚" in text and "p-1" in text
    c["session"].close()

    monkeypatch.setattr("app.services.selfheal_llm.reject_proposal",
                        lambda session, pid: (_ for _ in ()).throw(ValueError("找不到提案")))
    c = _ctx(engine, admin)
    text, events = _run(tools_selfheal.exec_reject_app_fix({"proposal_id": "bad"}, c))
    assert "回滚失败" in text and events[0]["type"] == "tool_event"
    c["session"].close()

    c = _ctx(engine, plain)
    text, _ = _run(tools_selfheal.exec_reject_app_fix({"proposal_id": "p-1"}, c))
    assert "仅管理员" in text
    c["session"].close()


def test_success_texts_avoid_runner_error_hints(fx):
    """runner._looks_like_error 按首 60 字 hint 词粗判——成功文案须避开
    (2026-09-21 实证:「烟测失败/超时应用 N 个」被误判 error)。"""
    from app.agent.runner import _looks_like_error

    engine, (admin, _) = fx
    _seed_apps(engine, admin)
    c = _ctx(engine, admin)
    text, _ = _run(tools_selfheal.exec_list_smoke_failures({}, c))
    assert not _looks_like_error(text), f"成功文案被 runner 误判为错误: {text[:60]}"
    c["session"].close()

    c = _ctx(engine, admin)
    text, _ = _run(tools_selfheal.exec_list_smoke_failures({"limit": 0}, c))
    assert not _looks_like_error(text), f"空态文案被误判: {text[:60]}"
    c["session"].close()

    # drama 工具成功路径同样守此约束
    import app.agent.tools_drama as tools_drama

    async def fake_create(session, user, script, num_shots, style, name):
        b = Board(tenant_id=user.tenant_id, user_id=user.id, name="x")
        session.add(b)
        session.commit()
        session.refresh(b)
        return b, 2, 1

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(tools_drama, "create_board_from_script", fake_create)
    c = _ctx(engine, admin)
    text, _ = _run(tools_drama.exec_create_storyboard({"script": "y"}, c))
    assert not _looks_like_error(text), f"drama 成功文案被误判: {text[:60]}"
    c["session"].close()
    monkeypatch.undo()
