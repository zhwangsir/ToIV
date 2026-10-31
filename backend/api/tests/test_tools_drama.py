"""漫剧线 agent 工具(A1)——exec_* 执行器:拆镜建板/板详情/单镜/一键成片/查成片。"""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.agent.tools_drama as tools_drama
from app.models import Board, BoardItem, Entity, Job, Tenant, User
from app.security import hash_password


@pytest.fixture
def ctx_factory():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        u1 = User(email="d1@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        u2 = User(email="d2@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id)
        s.add(u1); s.add(u2)
        s.commit()
        s.refresh(u1); s.refresh(u2)
        ids = (u1.id, u2.id)
    return engine, ids


def _ctx(engine, user_id):
    with Session(engine) as s:
        user = s.get(User, user_id)
    session = Session(engine)
    return {"user": user, "session": session, "pool": None}


def _run(coro):
    return asyncio.run(coro)


def test_create_storyboard_happy_and_errors(ctx_factory, monkeypatch):
    engine, (u1, _) = ctx_factory
    c = _ctx(engine, u1)

    async def fake_create(session, user, script, num_shots, style, name):
        b = Board(tenant_id=user.tenant_id, user_id=user.id, name="测试剧")
        session.add(b)
        session.commit()
        session.refresh(b)
        return b, 4, 2

    monkeypatch.setattr(tools_drama, "create_board_from_script", fake_create)
    text, events = _run(tools_drama.exec_create_storyboard(
        {"script": "雨夜破庙,少年避雨遇少女", "num_shots": 4}, c))
    assert "board_id=" in text and "4 个分镜行" in text and "2 个角色" in text
    # A1 画板卡:ok 事件带 board_id/行列数 payload(打开画板深链用)
    assert len(events) == 1 and events[0]["type"] == "tool_event"
    payload = events[0]["data"]["payload"]
    assert payload["board_id"] and payload["item_count"] == 4 and payload["cast_count"] == 2
    c["session"].close()

    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_create_storyboard({"script": "  "}, c))
    assert "script 为空" in text and events and events[0]["type"] == "tool_event"
    c["session"].close()

    async def boom(*a, **k):
        raise RuntimeError("LLM down")

    monkeypatch.setattr(tools_drama, "create_board_from_script", boom)
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_create_storyboard({"script": "x"}, c))
    assert "拆镜失败" in text and events[0]["type"] == "tool_event"
    c["session"].close()


def test_get_storyboard_ownership_and_lines(ctx_factory):
    engine, (u1, u2) = ctx_factory
    with Session(engine) as s:
        u1o = s.get(User, u1)
        b = Board(tenant_id=u1o.tenant_id, user_id=u1, name="我的板")
        s.add(b)
        s.commit()
        s.refresh(b)
        j = Job(id=uuid.uuid4().hex, prompt_id=uuid.uuid4().hex, tenant_id=u1o.tenant_id,
                user_id=u1, worker="w", kind="h3_t2v", status="done", prompt="p", seed=1,
                result='["/api/images?filename=v.mp4&worker=w"]')
        s.add(j)
        s.add(BoardItem(board_id=b.id, job_id="", sort_order=0, shot_text="镜一文本"))
        s.add(BoardItem(board_id=b.id, job_id=j.id, sort_order=1, shot_text="镜二文本"))
        s.commit()
        bid = b.id

    c = _ctx(engine, u1)
    text, _ = _run(tools_drama.exec_get_storyboard({"board_id": bid}, c))
    assert "待生成" in text and "done" in text and "镜一文本" in text and "item_id=" in text
    c["session"].close()

    c2 = _ctx(engine, u2)
    text, events = _run(tools_drama.exec_get_storyboard({"board_id": bid}, c2))
    assert "不存在" in text and events[0]["type"] == "tool_event"
    c2["session"].close()


def test_generate_shot_flow(ctx_factory, monkeypatch):
    engine, (u1, _) = ctx_factory
    with Session(engine) as s:
        u1o = s.get(User, u1)
        b = Board(tenant_id=u1o.tenant_id, user_id=u1, name="板")
        s.add(b)
        s.commit()
        s.refresh(b)
        it = BoardItem(board_id=b.id, job_id="", sort_order=0, shot_text="手动行",
                       shot_meta='{"prompt":"p"}')
        s.add(it)
        s.commit()
        s.refresh(it)
        bid, item_id = b.id, it.id

    async def fake_submit(session, pool, user, meta, engine, seed=None, fps=16):
        assert meta["prompt"] == "p"
        return {"prompt_id": "eng-9", "kind": "h3_t2v", "engine": engine}

    monkeypatch.setattr(tools_drama, "submit_shot_generation", fake_submit)
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_generate_shot(
        {"board_id": bid, "item_id": item_id, "engine": "h3-t2v"}, c))
    assert "eng-9" in text and events[0]["type"] == "job" and events[0]["data"]["status"] == "queued"
    c["session"].close()

    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_generate_shot({"board_id": bid, "item_id": 9999}, c))
    assert "分镜行不存在" in text and events[0]["type"] == "tool_event"
    c["session"].close()


def test_assemble_and_check_film(ctx_factory, monkeypatch):
    engine, (u1, _) = ctx_factory
    with Session(engine) as s:
        u1o = s.get(User, u1)
        b = Board(tenant_id=u1o.tenant_id, user_id=u1, name="成片板")
        s.add(b)
        s.commit()
        s.refresh(b)
        bid = b.id

    def fake_start(session, user, board, engine, fps, reuse_existing=True, burn_subtitles=True):
        j = Job(id=uuid.uuid4().hex, prompt_id=f"film-{uuid.uuid4().hex[:12]}",
                tenant_id=user.tenant_id, user_id=user.id, worker="", kind="board_film",
                status="queued", prompt=board.name, seed=0,
                params=json.dumps({"board_id": board.id, "shots": []}))
        session.add(j)
        session.commit()
        return j

    monkeypatch.setattr(tools_drama, "start_board_film", fake_start)
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_assemble_storyboard(
        {"board_id": bid, "engine": "h3-t2v"}, c))
    assert "film-" in text and events[0]["type"] == "job"
    assert events[0]["data"]["kind"] == "board_film"
    c["session"].close()

    # check_film:queued 无事件;done 出 job 事件
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_check_film({"board_id": bid}, c))
    assert "queued" in text and events == []
    c["session"].close()

    with Session(engine) as s:
        j = s.exec(select(Job).where(Job.kind == "board_film")).first()
        j.status = "done"
        j.result = '["/api/boards/film/board-film-' + "a" * 32 + '.mp4"]'
        j.progress = '{"stage":"done","done":1,"total":1,"detail":"ok"}'
        s.add(j)
        s.commit()
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_check_film({"board_id": bid}, c))
    assert "done" in text and "已展示" in text
    assert events and events[0]["type"] == "job" and events[0]["data"]["status"] == "done"
    assert events[0]["data"]["results"][0].endswith(".mp4")
    c["session"].close()


def test_assemble_conflict_text(ctx_factory, monkeypatch):
    from fastapi import HTTPException

    engine, (u1, _) = ctx_factory
    with Session(engine) as s:
        u1o = s.get(User, u1)
        b = Board(tenant_id=u1o.tenant_id, user_id=u1, name="冲突板")
        s.add(b)
        s.commit()
        s.refresh(b)
        bid = b.id

    def conflict(*a, **k):
        raise HTTPException(status_code=409, detail="已有在跑的成片作业: film-x")

    monkeypatch.setattr(tools_drama, "start_board_film", conflict)
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_assemble_storyboard({"board_id": bid}, c))
    assert "409" not in text and "已有在跑" in text and events[0]["type"] == "tool_event"
    c["session"].close()


def test_remix_storyboard_tool(ctx_factory, monkeypatch):
    engine, (u1, _) = ctx_factory
    with Session(engine) as s:
        u1o = s.get(User, u1)
        b = Board(tenant_id=u1o.tenant_id, user_id=u1, name="原板")
        s.add(b)
        s.commit()
        s.refresh(b)
        e = Entity(tenant_id=u1o.tenant_id, user_id=u1, kind="character", name="雪衣",
                   prompt_hint="1girl, silver hair")
        s.add(e)
        it = BoardItem(board_id=b.id, job_id="", sort_order=0, shot_text="镜一",
                       shot_meta='{"prompt":"林凡 runs","characters":["林凡"],"entity_ids":[]}')
        s.add(it)
        s.commit()
        s.refresh(e)
        bid, eid = b.id, e.id

    def fake_start(session, user, board, engine, fps, reuse_existing=True, burn_subtitles=True):
        j = Job(id=uuid.uuid4().hex, prompt_id=f"film-{uuid.uuid4().hex[:12]}",
                tenant_id=user.tenant_id, user_id=user.id, worker="", kind="board_film",
                status="queued", prompt=board.name, seed=0,
                params=json.dumps({"board_id": board.id, "shots": []}))
        session.add(j)
        session.commit()
        return j

    monkeypatch.setattr("app.services.board_film.start_board_film", fake_start)
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_remix_storyboard(
        {"board_id": bid, "kind": "protagonist", "engine": "h3-t2v",
         "character_map": {"林凡": eid}}, c))
    assert "换主角" in text and "remix换主角" in text and "board_id=" in text
    assert "film-" in text and events and events[0]["type"] == "job"
    c["session"].close()

    # 缺 map → 错误文案;他人板 → 不存在
    c = _ctx(engine, u1)
    text, events = _run(tools_drama.exec_remix_storyboard(
        {"board_id": bid, "kind": "protagonist"}, c))
    assert "character_map" in text and events[0]["type"] == "tool_event"
    c["session"].close()

    c2_session = Session(engine)
    with Session(engine) as s:
        u2 = s.exec(select(User).where(User.email == "d2@t.io")).first()
    c2 = {"user": u2, "session": c2_session, "pool": None}
    text, events = _run(tools_drama.exec_remix_storyboard(
        {"board_id": bid, "kind": "words", "dialogue_overrides": {"1": {"dialogue": "x"}}}, c2))
    assert "不存在" in text and events[0]["type"] == "tool_event"
    c2_session.close()
