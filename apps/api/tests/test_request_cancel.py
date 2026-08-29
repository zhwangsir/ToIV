"""客户端断开 → 取消出站 task / 标 Job canceled。"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Job, Tenant, User
from app.request_cancel import ClientAborted, await_or_disconnect, mark_prompt_canceled
from app.security import hash_password


class _FakeRequest:
    def __init__(self, disconnected: bool = False):
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


@pytest.mark.asyncio
async def test_await_or_disconnect_none_runs_coro():
    async def _ok() -> int:
        return 7

    assert await await_or_disconnect(None, _ok()) == 7


@pytest.mark.asyncio
async def test_await_or_disconnect_cancels_when_client_gone():
    async def _hang() -> None:
        await asyncio.sleep(30)

    req = _FakeRequest(disconnected=True)
    with pytest.raises(ClientAborted):
        await await_or_disconnect(req, _hang())  # type: ignore[arg-type]


def test_mark_prompt_canceled_skips_terminal():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="rc")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="rc@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        running = Job(
            tenant_id=tenant.id,
            user_id=user.id,
            prompt_id="pid-run",
            worker="w",
            kind="h3_t2v",
            status="running",
            prompt="p",
        )
        done = Job(
            tenant_id=tenant.id,
            user_id=user.id,
            prompt_id="pid-done",
            worker="w",
            kind="h3_t2v",
            status="done",
            prompt="p",
        )
        s.add(running)
        s.add(done)
        s.commit()
    with patch("app.request_cancel.engine", engine):
        mark_prompt_canceled("pid-run")
        mark_prompt_canceled("pid-done")
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.prompt_id == "pid-run")).first().status == "canceled"
        assert s.exec(select(Job).where(Job.prompt_id == "pid-done")).first().status == "done"
