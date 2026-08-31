"""W3 UI 驱动工具(navigate_view / prefill_generate / open_asset)单测。

事件走 msg 包络 type=ui_action;open_asset 做用户归属校验,其余零服务端副作用。
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel

from app.agent import tools_gen
from app.models import Job, User


@pytest.fixture()
def session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.fixture()
def admin_user() -> User:
    return User(
        id="admin-1", email="admin@toiv.ai", hashed_password="x",
        tenant_id="t-1", role="admin",
    )


@pytest.fixture()
def normal_user() -> User:
    return User(id="u-1", email="user@toiv.ai", hashed_password="x", tenant_id="t-1")


def _ctx(session, user):
    return {"session": session, "user": user}


def _make_job(session, user: User, kind: str = "txt2img") -> Job:
    job = Job(
        user_id=user.id, tenant_id=user.tenant_id, kind=kind, status="done",
        prompt_id=f"p-{user.id}", worker="w1",
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


@pytest.mark.asyncio
async def test_navigate_view_ok(session, admin_user):
    text, events = await tools_gen.exec_navigate_view(
        {"view": "dub", "reason": "去译制"}, _ctx(session, admin_user)
    )
    assert "打开" in text
    assert events[0]["type"] == "ui_action"
    assert events[0]["action"] == "navigate_view"
    assert events[0]["view"] == "dub"


@pytest.mark.asyncio
async def test_navigate_view_rejects_unknown_and_gated(session, admin_user):
    for bad in ("nope", "admin", "observability"):
        text, events = await tools_gen.exec_navigate_view(
            {"view": bad}, _ctx(session, admin_user)
        )
        assert "不存在" in text
        assert events[0]["type"] == "tool_event"
        assert events[0]["data"]["status"] == "error"


@pytest.mark.asyncio
async def test_prefill_generate_ok(session, admin_user):
    text, events = await tools_gen.exec_prefill_generate(
        {"kind": "video", "prompt": "a cat"}, _ctx(session, admin_user)
    )
    assert "视频" in text
    assert events[0]["action"] == "prefill_generate"
    assert events[0]["kind"] == "video"
    assert events[0]["prompt"] == "a cat"


@pytest.mark.asyncio
async def test_prefill_generate_validates(session, admin_user):
    text, _ = await tools_gen.exec_prefill_generate(
        {"kind": "audio", "prompt": "x"}, _ctx(session, admin_user)
    )
    assert "仅支持" in text
    text, _ = await tools_gen.exec_prefill_generate(
        {"kind": "image", "prompt": "  "}, _ctx(session, admin_user)
    )
    assert "不能为空" in text


@pytest.mark.asyncio
async def test_open_asset_owner_ok(session, normal_user):
    job = _make_job(session, normal_user)
    text, events = await tools_gen.exec_open_asset(
        {"job_id": job.id}, _ctx(session, normal_user)
    )
    assert "作品库" in text
    assert events[0]["action"] == "open_asset"
    assert events[0]["job_id"] == job.id


@pytest.mark.asyncio
async def test_open_asset_not_found_and_cross_user(session, normal_user):
    # 不存在
    text, events = await tools_gen.exec_open_asset(
        {"job_id": "job_missing"}, _ctx(session, normal_user)
    )
    assert "未找到" in text
    assert events[0]["data"]["status"] == "error"
    # 他人 job:非 admin 不可见
    other = User(id="u-2", email="bob@toiv.ai", hashed_password="x", tenant_id="t-2")
    job = _make_job(session, other)
    text, events = await tools_gen.exec_open_asset(
        {"job_id": job.id}, _ctx(session, normal_user)
    )
    assert "未找到" in text
