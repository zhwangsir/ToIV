# ---------------------------------------------------------------------------
# 全量进度体系(2026-08-29):write_progress + GET /api/jobs/active
# ---------------------------------------------------------------------------
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from app.comfy.tracker import mark_done, write_progress
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # tracker 的 write_progress/mark_done 用模块级 engine 开独立 Session,
    # 需 patch app.comfy.tracker.engine 指向测试 engine,否则看不到内存表
    import app.comfy.tracker as tracker_mod

    with __import__("unittest.mock", fromlist=["patch"]).patch.object(
        tracker_mod, "engine", engine
    ):
        with Session(engine) as s:
            alice_id = _make_user(s, "alice@toiv.ai")
            bob_id = _make_user(s, "bob@toiv.ai")
        yield TestClient(app), create_token(alice_id), create_token(bob_id), engine
    app.dependency_overrides.clear()


def _make_user(s: Session, email: str) -> str:
    import uuid as _uuid

    tenant = Tenant(name=email.split("@")[0], slug=f"t-{_uuid.uuid4().hex[:8]}")
    s.add(tenant)
    s.commit()
    s.refresh(tenant)
    user = User(
        tenant_id=tenant.id,
        email=email,
        hashed_password=hash_password("x"),
        role="admin",
    )
    s.add(user)
    s.commit()
    s.refresh(user)
    return user.id


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_job(
    s: Session, token_user_email: str, prompt_id: str, *,
    kind: str = "h3_t2v", status: str = "queued", deleted: bool = False,
) -> Job:
    user = s.exec(select(User).where(User.email == token_user_email)).first()
    j = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        worker="http://worker",
        kind=kind,
        status=status,
        prompt="a cat walking in rain",
    )
    if deleted:
        from app.models import _now

        j.deleted_at = _now()
    s.add(j)
    s.commit()
    s.refresh(j)
    return j


# ---------------------------------------------------------------------------
# write_progress 合并语义
# ---------------------------------------------------------------------------
def test_write_progress_merge_and_terminal_skip(ctx):
    """write_progress:合并更新指定键;终态(done)后不再写入。"""
    _, _, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "p1")

    write_progress("p1", queue_pos=2)
    write_progress("p1", pct=40, step=8, total=20)

    with Session(engine) as s:
        j = s.exec(select(Job).where(Job.prompt_id == "p1")).first()
        snap = json.loads(j.progress)
        assert snap["queue_pos"] == 2  # 首次写入的键保留(合并语义)
        assert snap["pct"] == 40
        assert snap["step"] == 8
        assert snap["total"] == 20
        assert snap["updated_at"] > 0

    mark_done("p1", ["/api/images?filename=x.png"])
    write_progress("p1", pct=99)  # 终态后写入应被跳过
    with Session(engine) as s:
        j = s.exec(select(Job).where(Job.prompt_id == "p1")).first()
        assert json.loads(j.progress)["pct"] == 40


def test_write_progress_throttle(ctx):
    """throttle=True:2s 内重复写同一 prompt_id 被丢弃。"""
    _, _, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "p2")

    write_progress("p2", pct=10, throttle=True)
    write_progress("p2", pct=20, throttle=True)  # 2s 内第二次 → 丢弃
    with Session(engine) as s:
        j = s.exec(select(Job).where(Job.prompt_id == "p2")).first()
        assert json.loads(j.progress)["pct"] == 10


# ---------------------------------------------------------------------------
# GET /api/jobs/active
# ---------------------------------------------------------------------------
def test_jobs_active_returns_progress_and_eta(ctx):
    """active 端点:返回非终态作业 + 进度快照 + ETA;终态/回收站排除。"""
    client, token, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "a1", kind="h3_t2v", status="running")
        _mk_job(s, "alice@toiv.ai", "a2", kind="txt2img", status="queued")
        _mk_job(s, "alice@toiv.ai", "a3", status="done")  # 终态 → 不出现
        _mk_job(s, "alice@toiv.ai", "a4", status="queued", deleted=True)  # 回收站 → 不出现
    write_progress("a1", pct=50, step=10, total=20)

    r = client.get("/api/jobs/active", headers=_h(token))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    pids = [i["prompt_id"] for i in items]
    assert pids == ["a1", "a2"]  # created_at 升序;done/deleted 排除

    a1 = items[0]
    assert a1["progress"]["pct"] == 50
    assert a1["progress"]["step"] == 10
    assert a1["progress"]["total"] == 20
    # h3 均耗 900s,pct=50 → ETA ≈ 450s
    assert a1["eta_sec"] == 450
    assert a1["wait_sec"] >= 0

    a2 = items[1]
    assert a2["eta_sec"] == 60  # txt2img 均耗,无进度快照 → 全量


def test_jobs_active_queue_pos_eta(ctx):
    """排队位 ETA:queue_pos=2 × h3 均耗 900 = 1800s。"""
    client, token, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "q1", kind="h3_i2v", status="queued")
    write_progress("q1", queue_pos=2)

    r = client.get("/api/jobs/active", headers=_h(token))
    item = r.json()["items"][0]
    assert item["progress"]["queue_pos"] == 2
    assert item["eta_sec"] == 1800


def test_jobs_active_held_no_eta(ctx):
    """held 作业:ETA 为 None,带 hold_reason。"""
    client, token, _, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "h1", status="held")
        j.hold_reason = "显存不足,排队等资源释放"
        s.add(j)
        s.commit()

    r = client.get("/api/jobs/active", headers=_h(token))
    item = r.json()["items"][0]
    assert item["status"] == "held"
    assert item["eta_sec"] is None
    assert "显存" in item["hold_reason"]


def test_jobs_active_tenant_isolation(ctx):
    """他人作业不可见。"""
    client, token, token2, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "mine")

    r = client.get("/api/jobs/active", headers=_h(token2))
    assert r.status_code == 200
    assert r.json()["items"] == []
