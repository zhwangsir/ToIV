"""persist_job_to_db 不得覆盖用户 cancelJob 后的 canceled 终态。"""
from __future__ import annotations

from unittest.mock import patch

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.jobs_persist import db_job_is_canceled, persist_job_to_db
from app.models import Job, Tenant, User
from app.security import hash_password


def test_persist_skips_canceled_and_db_job_is_canceled():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="p@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id="ls-1",
            worker="",
            kind="dub_lipsync_long",
            status="canceled",
            prompt="长视频对口型",
        )
        s.add(job)
        s.commit()

    with patch("app.jobs_persist.engine", engine):
        persist_job_to_db("ls-1", "dub_lipsync_long", "done", {"status": "done", "url": "/x.mp4"})
        assert db_job_is_canceled("ls-1") is True

    with Session(engine) as s:
        row = s.exec(select(Job).where(Job.prompt_id == "ls-1")).first()
        assert row is not None
        assert row.status == "canceled"
