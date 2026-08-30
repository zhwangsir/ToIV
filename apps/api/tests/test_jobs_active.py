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
            # alice/bob 为同租户两账号(回归 2026-08-30 P2:任务中心按租户过滤
            # 导致同租户互相串台);eve 是另一租户的 admin(跨租户边界验证)
            tenant = Tenant(name="acme", slug="t-acme")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            alice_id = _make_user(s, "alice@toiv.ai", tenant=tenant, role="admin")
            bob_id = _make_user(s, "bob@toiv.ai", tenant=tenant, role="user")
            eve_id = _make_user(s, "eve@toiv.ai", role="admin")
        yield (
            TestClient(app),
            create_token(alice_id),
            create_token(bob_id),
            create_token(eve_id),
            engine,
        )
    app.dependency_overrides.clear()


def _make_user(
    s: Session, email: str, tenant: Tenant | None = None, role: str = "admin"
) -> str:
    import uuid as _uuid

    if tenant is None:
        tenant = Tenant(name=email.split("@")[0], slug=f"t-{_uuid.uuid4().hex[:8]}")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
    user = User(
        tenant_id=tenant.id,
        email=email,
        hashed_password=hash_password("x"),
        role=role,
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
    *_, engine = ctx
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
    *_, engine = ctx
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
    client, token, *_rest = ctx
    engine = ctx[-1]
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
    client, token, *_rest = ctx
    engine = ctx[-1]
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "q1", kind="h3_i2v", status="queued")
    write_progress("q1", queue_pos=2)

    r = client.get("/api/jobs/active", headers=_h(token))
    item = r.json()["items"][0]
    assert item["progress"]["queue_pos"] == 2
    assert item["eta_sec"] == 1800


def test_jobs_active_held_no_eta(ctx):
    """held 作业:ETA 为 None,带 hold_reason。"""
    client, token, *_rest = ctx
    engine = ctx[-1]
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


def test_jobs_active_user_isolation_same_tenant(ctx):
    """2026-08-30 P2 回归:同租户他人作业不可见(此前按 tenant_id 过滤,
    admin 能看到另一 admin 的任务——生产串台);admin ?all=1 显式看全部。"""
    client, token_alice, token_bob, token_eve, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "alice-job")  # 同租户另一账号
        _mk_job(s, "bob@toiv.ai", "bob-job")
        _mk_job(s, "eve@toiv.ai", "eve-job")  # 另一租户

    # 同租户普通用户:仅见自己
    r = client.get("/api/jobs/active", headers=_h(token_bob))
    assert r.status_code == 200
    assert [i["prompt_id"] for i in r.json()["items"]] == ["bob-job"]

    # 同租户 admin(默认):同样仅见自己 —— 这是本次修复的核心回归断言
    r = client.get("/api/jobs/active", headers=_h(token_alice))
    assert [i["prompt_id"] for i in r.json()["items"]] == ["alice-job"]

    # admin 显式 ?all=1:可见全局(含其他租户,观测用途)
    r = client.get("/api/jobs/active?all=1", headers=_h(token_alice))
    assert sorted(i["prompt_id"] for i in r.json()["items"]) == [
        "alice-job", "bob-job", "eve-job",
    ]

    # 普通用户带 all=1 无效:仍仅见自己(不越权)
    r = client.get("/api/jobs/active?all=1", headers=_h(token_bob))
    assert [i["prompt_id"] for i in r.json()["items"]] == ["bob-job"]


def test_jobs_list_user_isolation_and_admin_all(ctx):
    """GET /api/jobs 同口径:默认仅本人;admin ?all=1 看全部,普通用户 all=1 不越权。"""
    client, token_alice, token_bob, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "alice-done", status="done")
        _mk_job(s, "bob@toiv.ai", "bob-done", status="done")

    r = client.get("/api/jobs", headers=_h(token_bob))
    assert [i["prompt_id"] for i in r.json()] == ["bob-done"]

    r = client.get("/api/jobs", headers=_h(token_alice))
    assert [i["prompt_id"] for i in r.json()] == ["alice-done"]

    r = client.get("/api/jobs?all=1", headers=_h(token_alice))
    assert sorted(i["prompt_id"] for i in r.json()) == ["alice-done", "bob-done"]

    r = client.get("/api/jobs?all=1", headers=_h(token_bob))
    assert [i["prompt_id"] for i in r.json()] == ["bob-done"]


def test_job_events_owner_or_admin_only(ctx):
    """SSE 进度端点:非属主 404(不泄露存在性);admin 可旁观他人作业。"""
    client, token_alice, token_bob, _, engine = ctx
    with Session(engine) as s:
        _mk_job(s, "alice@toiv.ai", "evt-job", status="running")

    # 同租户非属主:404(此前仅按 tenant 校验 → 同租户可订阅他人进度流)
    r = client.get(
        "/api/jobs/evt-job/events?client_id=c&worker=w", headers=_h(token_bob)
    )
    assert r.status_code == 404
    # 不存在的作业:不拦截(SSE 端容忍,等作业建档/放行)
    r = client.get(
        "/api/jobs/ghost-job/events?client_id=c&worker=w", headers=_h(token_bob)
    )
    assert r.status_code != 404


# ---------------------------------------------------------------------------
# POST /api/jobs/{id}/cancel(2026-08-29 任务中心「中止」按钮)
# ---------------------------------------------------------------------------
def test_cancel_job_marks_canceled_and_skips_worker_for_hold(ctx):
    """held 占位作业(hold-* 从未提交 worker):落 canceled,worker_action=skipped。"""
    client, token, *_rest = ctx
    engine = ctx[-1]
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
    client, token, *_rest = ctx
    engine = ctx[-1]
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "t1", status="done")
    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token))
    assert r.status_code == 409
    assert "终态" in r.json()["detail"]


def test_cancel_job_owner_only_404(ctx):
    """非本人作业 404(不泄露存在性)。"""
    client, token, token2, _token_eve, engine = ctx
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

    client, token, *_rest = ctx
    engine = ctx[-1]
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

    client, token, *_rest = ctx
    engine = ctx[-1]
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

    *_, engine = ctx
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

    *_, engine = ctx
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
    client, token, *_rest = ctx
    engine = ctx[-1]
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "hold-pid-gen", status="held")
        jid = j.id
    r = client.post("/api/jobs/hold-pid-gen/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "canceled"
    with Session(engine) as s:
        assert s.get(Job, jid).status == "canceled"


# ---------------------------------------------------------------------------
# P0-3/P1-1(2026-08-30):取消落 reason + 链式作业传播取消 + error 字段透出
# ---------------------------------------------------------------------------
def test_cancel_job_writes_reason_and_api_exposes_error(ctx):
    """cancel 落「已被用户取消」原因;/jobs/lookup 与 /jobs 列表透出 error 字段。"""
    client, token, *_rest = ctx
    engine = ctx[-1]
    with Session(engine) as s:
        j = _mk_job(s, "alice@toiv.ai", "cancel-reason-1", status="queued")

    r = client.post(f"/api/jobs/{j.id}/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        assert s.get(Job, j.id).error == "已被用户取消"

    r2 = client.get("/api/jobs/lookup?prompt_id=cancel-reason-1", headers=_h(token))
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "canceled"
    assert r2.json()["error"] == "已被用户取消"

    r3 = client.get("/api/jobs?status=canceled", headers=_h(token))
    hit = [x for x in r3.json() if x["prompt_id"] == "cancel-reason-1"]
    assert hit and hit[0]["error"] == "已被用户取消"


def test_cancel_chain_job_propagates_to_segments(ctx, monkeypatch):
    """chain-* 合并作业取消:params.segment_prompt_ids 的成员段一并落 canceled +
    尽力 worker 清场;已终态段不动;响应带 canceled_segments。"""
    import app.routes.jobs as jobs_route

    calls: list[str] = []

    class _FakeClient:
        def __init__(self, base_url: str, timeout: float = 0.0):
            self.base_url = base_url

        async def cancel_prompt(self, prompt_id: str) -> str:
            calls.append(prompt_id)
            return "dequeued"

    monkeypatch.setattr(jobs_route, "ComfyUIClient", _FakeClient)

    client, token, *_rest = ctx
    engine = ctx[-1]
    with Session(engine) as s:
        seg1 = _mk_job(s, "alice@toiv.ai", "seg-1", kind="transition", status="queued")
        seg2 = _mk_job(s, "alice@toiv.ai", "seg-2", kind="transition", status="running")
        done_seg = _mk_job(s, "alice@toiv.ai", "seg-0", kind="transition", status="done")
        seg1_id, seg2_id, done_seg_id = seg1.id, seg2.id, done_seg.id
        merged = _mk_job(
            s, "alice@toiv.ai", "chain-abc123", kind="keyframe_chain", status="queued",
        )
        merged.params = json.dumps(
            {"segment_prompt_ids": ["seg-0", "seg-1", "seg-2"], "total_duration": 10}
        )
        s.add(merged)
        s.commit()
        s.refresh(merged)
        merged_id = merged.id  # commit 后实例过期,取值须在会话内

    r = client.post(f"/api/jobs/{merged_id}/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["worker_action"] == "skipped"  # chain-* 占位从未提交 worker
    assert body["canceled_segments"] == 2  # done 段不动
    assert sorted(calls) == ["seg-1", "seg-2"]  # 段各自尽力清场
    with Session(engine) as s:
        for jid, want in ((seg1_id, "canceled"), (seg2_id, "canceled"), (done_seg_id, "done")):
            j2 = s.get(Job, jid)
            assert j2.status == want, f"{j2.prompt_id} 应 {want}"
        assert s.get(Job, seg1_id).error == "链式作业已被用户取消"


def test_cancel_first_segment_propagates_to_extend_segments(ctx, monkeypatch):
    """extend 续写链:首段 params.extend_segment_ids 登记的续段随取消一并落 canceled。"""
    import app.routes.jobs as jobs_route

    class _FakeClient:
        def __init__(self, base_url: str, timeout: float = 0.0):
            self.base_url = base_url

        async def cancel_prompt(self, prompt_id: str) -> str:
            return "interrupted"

    monkeypatch.setattr(jobs_route, "ComfyUIClient", _FakeClient)

    client, token, *_rest = ctx
    engine = ctx[-1]
    with Session(engine) as s:
        first = _mk_job(s, "alice@toiv.ai", "h3-first", kind="h3_t2v", status="running")
        first.params = json.dumps({"extend_segment_ids": ["h3-ext-1"]})
        s.add(first)
        _mk_job(s, "alice@toiv.ai", "h3-ext-1", kind="h3_extend_i2v", status="queued")
        s.commit()
        s.refresh(first)
        first_id = first.id  # commit 后实例过期,取值须在会话内

    r = client.post(f"/api/jobs/{first_id}/cancel", headers=_h(token))
    assert r.status_code == 200, r.text
    assert r.json()["canceled_segments"] == 1
    with Session(engine) as s:
        seg = s.exec(select(Job).where(Job.prompt_id == "h3-ext-1")).first()
        assert seg.status == "canceled"
