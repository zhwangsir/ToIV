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


# ---------------------------------------------------------------------------
# POST /api/jobs/{id}/cancel(2026-08-29 任务中心「中止」按钮)
# ---------------------------------------------------------------------------
def test_cancel_job_marks_canceled_and_skips_worker_for_hold(ctx):
    """held 占位作业(hold-* 从未提交 worker):落 canceled,worker_action=skipped。"""
    client, token, _, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "hold-x1", status="held")

    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "canceled"
    assert body["worker_action"] == "skipped"

    with Session(engine) as s:
        assert s.get(Job, j.id).status == "canceled"

    # 取消后不再出现在任务中心
    r2 = client.get("/api/jobs/active", headers=_h(token))
    assert r2.json()["items"] == []


def test_cancel_job_terminal_409(ctx):
    """已终态(done/error/canceled)的作业:409,不重复取消。"""
    client, token, _, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "t1", status="done")
    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token))
    assert r.status_code == 409
    assert "终态" in r.json()["detail"]


def test_cancel_job_owner_only_404(ctx):
    """非本人作业 404(不泄露存在性)。"""
    client, token, token2, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "other1", status="running")
    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token2))
    assert r.status_code == 404
    with Session(engine) as s:
        assert s.get(Job, j.id).status == "running"  # 未被改动


def test_cancel_job_worker_dequeued(ctx, monkeypatch):
    """queued 作业:DB 落 canceled + 尽力清场走 ComfyUIClient.cancel_prompt。"""
    import app.routes.jobs as jobs_route

    calls: list[str] = []

    class _FakeClient:
        def __init__(self, base_url: str, timeout: float = 0.0):
            self.base_url = base_url

        async def cancel_prompt(self, prompt_id: str) -> str:
            calls.append(prompt_id)
            return "dequeued"

    monkeypatch.setattr(jobs_route, "ComfyUIClient", _FakeClient)

    client, token, _, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "w1", status="queued")

    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    assert r.json()["worker_action"] == "dequeued"
    assert calls == ["w1"]
    with Session(engine) as s:
        assert s.get(Job, j.id).status == "canceled"


def test_cancel_job_worker_unreachable_still_canceled(ctx, monkeypatch):
    """worker 不可达:清场失败不回滚,DB 仍落 canceled(worker_action=worker_unreachable)。"""
    import app.routes.jobs as jobs_route

    class _DeadClient:
        def __init__(self, base_url: str, timeout: float = 0.0):
            pass

        async def cancel_prompt(self, prompt_id: str) -> str:
            raise TimeoutError("worker 不可达")

    monkeypatch.setattr(jobs_route, "ComfyUIClient", _DeadClient)

    client, token, _, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "w2", status="running")

    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    assert r.json()["worker_action"] == "worker_unreachable"
    with Session(engine) as s:
        assert s.get(Job, j.id).status == "canceled"


def test_tracker_respects_canceled(ctx):
    """canceled 是终态:mark_status 不回退、write_progress 不再写入。"""
    from app.comfy.tracker import mark_status

    _, _, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "c1", status="running")

    mark_status("c1", "canceled")
    mark_status("c1", "running")  # 不应回退
    write_progress("c1", pct=42)  # 不应写入
    with Session(engine) as s:
        j = s.exec(select(Job).where(Job.prompt_id == "c1")).first()
        assert j.status == "canceled"
        assert j.progress == ""


@pytest.mark.asyncio
async def test_wait_for_jobs_raises_on_canceled(ctx):
    """wait_for_jobs:作业被取消立即抛「已被用户取消」(三视图回写据此标 error 允许重试)。"""
    from app.comfy.tracker import wait_for_jobs

    _, _, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "c2", status="queued")

    # 先取消再等待:第一轮查询即抛
    from app.comfy.tracker import mark_status

    mark_status("c2", "canceled")
    with Session(engine) as s3:
        with pytest.raises(RuntimeError, match="已被用户取消"):
            await wait_for_jobs(s3, ["c2"], timeout=5, poll_interval=0.1)


def test_cancel_job_accepts_prompt_id(ctx):
    """Generate page only has prompt_id: cancel lookup accepts Job.id or prompt_id."""
    client, token, _, engine = ctx
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "hold-pid-gen", status="held")
        jid = j.id
    r = client.post("/api/jobs/hold-pid-gen/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "canceled"
    with Session(engine) as s:
        assert s.get(Job, jid).status == "canceled"
