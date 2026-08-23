"""资源预算二期 hold 排队(services/hold_queue)单测 + 提交链转 hold 接线回归。

背景:一期预检(RAM/VRAM)不足直接 503 错峰,用户只能手工重试;GPU2 已成日常
瓶颈。二期把预检失败改为 hold:作业落库(status=held + HeldJob 票,graph/原因/
所需资源快照随票入库,api 重启不丢),调度循环周期复查,资源够按 FIFO 自动放行。

覆盖:
  · H3/LongCat/Wan 三链预检不足 → 200 + held(Job 可见、票入库、未提交)
  · 资源恢复 → run_release_round 自动放行(换真实 prompt_id/转 queued/挂追踪/删票)
  · 严格 FIFO:单轮上限 1 先放先 hold 的;队首资源不够后面的不插队(防雪崩)
  · 超时兜底:票龄超 hold_timeout_sec → 作业 error + 超时说明,票删除
  · 取消:软删除(回收站)不放行不丢票;物理删除票作废
  · 开关关闭(TOIV_HOLD_QUEUE_ENABLED=false)→ 维持一期 503
  · tracker.wait_for_jobs / vgen._wait_files 跟随 held 放行后的 prompt_id 换名
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as app_db
import app.routes.wan_studio as wan_route
import app.services.h3 as h3_service
import app.services.hold_queue as hold_queue
import app.services.longcat as longcat_service
import app.services.resource_budget as rb
import app.services.video_generators as vgen
from app.comfy import tracker
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import HeldJob, Job, Tenant, User
from app.security import create_token, hash_password

_GIB = 1 << 30


@pytest.fixture(autouse=True)
def _fast_settle(monkeypatch):
    """驱逐后的落定等待压到 0(生产 5s),同 test_resource_budget。"""
    monkeypatch.setattr(rb, "_SETTLE_SEC", 0.0)
    monkeypatch.setattr(h3_service, "_VRAM_SETTLE_SEC", 0.0)


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def client(engine, monkeypatch):
    """TestClient + hold_queue 的 DB/追踪收口接到测试库;spawn_tracker 记录放行挂链。"""

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setattr(hold_queue, "engine", engine)
    spawned: list[str] = []
    monkeypatch.setattr(
        hold_queue, "spawn_tracker", lambda client_, pid: spawned.append(pid)
    )
    yield TestClient(app), engine, spawned
    app.dependency_overrides.clear()


class _FakeClient:
    """ComfyUI 实例替身:system_stats(显存/内存)/queue 可控,queue_prompt 记图。"""

    def __init__(
        self,
        base_url: str = "http://fake-h3",
        *,
        free_vram_gib: float = 96.0,
        free_ram_gib: float = 128.0,
        queue: int = 0,
    ) -> None:
        self.base_url = base_url
        self.free_vram = free_vram_gib
        self.free_ram = free_ram_gib
        self._queue = queue
        self.free_calls = 0
        self.graphs: list[dict] = []
        self._seq = 0

    async def object_info(self, node: str) -> dict:
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self._seq += 1
        self.graphs.append(graph)
        return f"real-pid-{self._seq}"

    async def upload_image(self, content: bytes, filename: str) -> str:
        return f"hold-{filename}"

    async def queue_len(self) -> int:
        return self._queue

    async def queue_counts(self) -> tuple[int, int]:
        return self._queue, 0

    async def free_memory(self) -> None:
        self.free_calls += 1

    async def get_system_stats(self) -> dict:
        return {
            "devices": [{
                "name": "cuda:0 FakeGPU", "type": "cuda",
                "vram_free": int(self.free_vram * _GIB), "vram_total": 96 * _GIB,
            }],
            "system": {"ram_free": int(self.free_ram * _GIB), "ram_total": 183 * _GIB},
        }


class _FakeSourceWorker:
    """上传落点 pool worker 替身(wan 接线用)。"""

    base_url = "http://fake-worker"

    async def get_image_bytes(self, filename, subfolder, type_):
        return b"media-bytes", "application/octet-stream"


def _auth(uid: str) -> dict:
    return {"Authorization": f"Bearer {create_token(uid)}"}


def _post_h3_t2v(c: TestClient, uid: str):
    return c.post("/api/h3/t2v", headers=_auth(uid), json={"positive": "a cat"})


def _job_by_any_pid(eng, pid: str) -> Job:
    """按 prompt_id 或其对应 Job(id 经票)查作业;放行后占位符换名,走票反查。"""
    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
        if job is not None:
            return job
        ticket = s.exec(select(HeldJob)).first()
        raise AssertionError(f"作业 {pid} 不存在(在库票: {ticket})")


def _job_by_id(eng, job_id: str) -> Job:
    with Session(eng) as s:
        job = s.get(Job, job_id)
        assert job is not None
        return job


def _tickets(eng) -> list[HeldJob]:
    with Session(eng) as s:
        return list(s.exec(select(HeldJob).order_by(HeldJob.created_at)).all())


# --------------------------------------------------------------------------- #
# 预检失败 → hold(三链接线)
# --------------------------------------------------------------------------- #


def test_h3_precheck_failure_holds_instead_of_503(client, monkeypatch):
    """H3 RAM 不足:不再 503,返回 held 结果;Job 可见(status=held+原因)、票入库、未提交。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-h3")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)

    r = _post_h3_t2v(c, uid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["held"] is True
    assert "内存不足" in body["hold_reason"]
    assert body["prompt_id"].startswith("hold-")
    assert fake.graphs == []  # 未提交

    with Session(eng) as s:
        job = s.exec(select(Job).where(Job.prompt_id == body["prompt_id"])).first()
        assert job is not None
        assert job.status == "held"
        assert "内存不足" in job.hold_reason
        ticket = s.exec(select(HeldJob).where(HeldJob.job_id == job.id)).first()
        assert ticket is not None
        assert ticket.engine == "h3"
        assert ticket.worker == fake.base_url
        needs = json.loads(ticket.needs)
        assert needs["ram_gb"] == get_settings().h3_min_free_ram_gb
        assert needs["vram_gb"] == get_settings().h3_min_free_vram_gb
        assert json.loads(ticket.graph)  # graph 快照入库(重启后可放行)
        assert ticket.reason == job.hold_reason

    # /api/jobs 可见:status=held + hold_reason(前端不炸,增量键)
    r2 = c.get("/api/jobs?status=held", headers=_auth(uid))
    assert r2.status_code == 200
    items = r2.json()
    assert any(
        i["prompt_id"] == body["prompt_id"] and "内存不足" in i["hold_reason"]
        for i in items
    )


def test_longcat_precheck_failure_holds(client, monkeypatch):
    """LongCat 显存不足(非 prechecked 路径):转 hold,票 engine=longcat。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-lc")
    fake = _FakeClient("http://fake-lc", free_vram_gib=10.0, queue=1)  # 队列忙不驱逐
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)

    r = c.post("/api/longcat/t2v", headers=_auth(uid), json={"positive": "a cat"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["held"] is True
    assert "显存不足" in body["hold_reason"]
    assert fake.graphs == []
    tickets = _tickets(eng)
    assert len(tickets) == 1
    assert tickets[0].engine == "longcat"
    needs = json.loads(tickets[0].needs)
    assert needs["vram_gb"] == get_settings().longcat_min_free_vram_gb


def test_wan_precheck_failure_holds(client, monkeypatch):
    """Wan 路由预检(ensure_wan_vram)失败:经 hold_exc 转 hold,票 engine=wan。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-wan")
    fake = _FakeClient("http://fake-lc", free_ram_gib=3.0)
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(wan_route, "resolve_worker", lambda worker: _FakeSourceWorker())

    r = c.post(
        "/api/wan/animate",
        headers=_auth(uid),
        json={"positive": "a", "image": "in.png", "video": "d.mp4",
              "worker": "http://fake-worker"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["held"] is True
    assert "内存不足" in body["hold_reason"]
    assert fake.graphs == []
    tickets = _tickets(eng)
    assert len(tickets) == 1
    assert tickets[0].engine == "wan"
    needs = json.loads(tickets[0].needs)
    assert needs["ram_gb"] == get_settings().wan_min_free_ram_gb


def test_hold_disabled_keeps_503(client, monkeypatch):
    """开关关闭(TOIV_HOLD_QUEUE_ENABLED=false):维持一期 503 语义。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-off")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(get_settings(), "hold_queue_enabled", False)

    r = _post_h3_t2v(c, uid)
    assert r.status_code == 503, r.text
    assert "内存不足" in r.json()["detail"]
    assert fake.graphs == []
    assert _tickets(eng) == []


# --------------------------------------------------------------------------- #
# 调度轮:放行 / FIFO / 超时 / 取消
# --------------------------------------------------------------------------- #


async def test_release_round_submits_when_resources_recover(client, monkeypatch):
    """资源恢复后一轮调度:预检通过 → 提交 → Job 换真实 prompt_id 转 queued → 挂追踪 → 删票。"""
    c, eng, spawned = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-rel")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    r = _post_h3_t2v(c, uid)
    assert r.json()["held"] is True
    job_id = _job_by_any_pid(eng, r.json()["prompt_id"]).id

    fake.free_ram = 128.0  # 资源恢复
    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: fake)
    stats = await hold_queue.run_release_round()
    assert stats == {"released": 1, "timed_out": 0, "dropped": 0}

    job = _job_by_id(eng, job_id)
    assert job.status == "queued"
    assert job.prompt_id == "real-pid-1"  # 占位符已换真实值
    assert job.hold_reason == ""
    assert fake.graphs and len(fake.graphs) == 1
    assert spawned == ["real-pid-1"]  # 放行即挂 tracker
    assert _tickets(eng) == []  # 票已删


async def test_release_round_keeps_hold_when_still_short(client, monkeypatch):
    """资源仍不足:不放行不判死,票与 held 状态原样保留(等下一轮)。"""
    c, eng, spawned = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-wait")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    r = _post_h3_t2v(c, uid)
    pid = r.json()["prompt_id"]

    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: fake)
    stats = await hold_queue.run_release_round()
    assert stats == {"released": 0, "timed_out": 0, "dropped": 0}
    job = _job_by_any_pid(eng, pid)
    assert job.status == "held"
    assert len(_tickets(eng)) == 1
    assert fake.graphs == []
    assert spawned == []


async def test_fifo_release_order_with_round_cap(client, monkeypatch):
    """单轮上限 1:先 hold 的先放行,后 hold 的留到下一轮(严格 FIFO)。"""
    c, eng, spawned = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-fifo")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    first = _post_h3_t2v(c, uid).json()["prompt_id"]
    second = _post_h3_t2v(c, uid).json()["prompt_id"]
    first_id = _job_by_any_pid(eng, first).id
    second_id = _job_by_any_pid(eng, second).id

    fake.free_ram = 128.0
    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: fake)
    monkeypatch.setattr(get_settings(), "hold_release_max_per_round", 1)
    stats = await hold_queue.run_release_round()
    assert stats["released"] == 1

    assert _job_by_id(eng, first_id).status == "queued"  # 先 hold 先放行
    assert _job_by_id(eng, second_id).status == "held"   # 名额用完,下轮再说
    assert len(fake.graphs) == 1
    assert len(_tickets(eng)) == 1

    # 下一轮放行剩余票
    stats = await hold_queue.run_release_round()
    assert stats["released"] == 1
    assert _job_by_id(eng, second_id).status == "queued"


async def test_fifo_head_blocked_no_overtake(client, monkeypatch):
    """队首(h3)资源仍不够时,后面的票(longcat,资源已够)不得插队 —— 防雪崩。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-head")
    fake_h3 = _FakeClient("http://fake-h3", free_ram_gib=3.0)
    fake_lc = _FakeClient("http://fake-lc", free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake_h3)
    assert _post_h3_t2v(c, uid).json()["held"] is True  # 先 hold(队首)
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake_lc)
    r = c.post("/api/longcat/t2v", headers=_auth(uid), json={"positive": "a cat"})
    assert r.json()["held"] is True  # 后 hold

    fake_lc.free_ram = 128.0  # 仅 longcat 侧资源恢复;队首 h3 仍不足
    clients = {"http://fake-h3": fake_h3, "http://fake-lc": fake_lc}
    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: clients[worker])
    stats = await hold_queue.run_release_round()
    assert stats["released"] == 0  # 队首阻塞即停,longcat 不插队
    assert fake_h3.graphs == [] and fake_lc.graphs == []
    assert len(_tickets(eng)) == 2


async def test_hold_timeout_marks_error(client, monkeypatch):
    """票龄超 TOIV_HOLD_TIMEOUT_SEC:作业标 error + 超时说明,票删除,不再等。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-timeout")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    pid = _post_h3_t2v(c, uid).json()["prompt_id"]
    job_id = _job_by_any_pid(eng, pid).id
    reason = _job_by_id(eng, job_id).hold_reason

    with Session(eng) as s:
        ticket = s.exec(select(HeldJob)).first()
        # SQLite 存 naive datetime(写入侧即 UTC 口径,同 tracker.reconcile)
        ticket.created_at = (datetime.now(timezone.utc) - timedelta(seconds=7200)).replace(tzinfo=None)
        s.add(ticket)
        s.commit()

    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: fake)
    stats = await hold_queue.run_release_round()
    assert stats == {"released": 0, "timed_out": 1, "dropped": 0}

    job = _job_by_id(eng, job_id)
    assert job.status == "error"
    assert "资源等待超时" in job.hold_reason
    assert reason in job.hold_reason  # 原始资源原因保留在说明里
    assert _tickets(eng) == []
    assert fake.graphs == []


async def test_soft_deleted_hold_skipped_ticket_kept(client, monkeypatch):
    """软删除(回收站)的 held 作业:不放行、不丢票(恢复后可继续);物理删除票作废。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-del")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    pid = _post_h3_t2v(c, uid).json()["prompt_id"]
    job_id = _job_by_any_pid(eng, pid).id

    fake.free_ram = 128.0  # 资源已够,但作业进了回收站
    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: fake)
    with Session(eng) as s:
        job = s.get(Job, job_id)
        job.deleted_at = datetime.now(timezone.utc)
        s.add(job)
        s.commit()
    stats = await hold_queue.run_release_round()
    assert stats == {"released": 0, "timed_out": 0, "dropped": 0}
    assert _job_by_id(eng, job_id).status == "held"
    assert len(_tickets(eng)) == 1  # 票保留:72h 内恢复可继续放行
    assert fake.graphs == []

    # 恢复(清 deleted_at)→ 下轮正常放行
    with Session(eng) as s:
        job = s.get(Job, job_id)
        job.deleted_at = None
        s.add(job)
        s.commit()
    stats = await hold_queue.run_release_round()
    assert stats["released"] == 1
    assert _job_by_id(eng, job_id).status == "queued"


async def test_orphan_ticket_dropped(client, monkeypatch):
    """Job 物理删除(回收站 purge)后票成孤儿:下一轮作废清理。"""
    c, eng, _ = client
    with Session(eng) as s:
        uid = _seed_user(s, "hold-orphan")
    fake = _FakeClient(free_ram_gib=3.0)
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    pid = _post_h3_t2v(c, uid).json()["prompt_id"]
    job_id = _job_by_any_pid(eng, pid).id

    with Session(eng) as s:
        s.delete(s.get(Job, job_id))
        s.commit()
    monkeypatch.setattr(hold_queue, "_make_client", lambda worker: fake)
    stats = await hold_queue.run_release_round()
    assert stats["dropped"] == 1
    assert _tickets(eng) == []
    assert fake.graphs == []


# --------------------------------------------------------------------------- #
# 下游等待方跟随 held 放行(prompt_id 换名)
# --------------------------------------------------------------------------- #


async def test_wait_for_jobs_follows_held_release(engine):
    """tracker.wait_for_jobs:held 作业放行后 prompt_id 换名,仍按原占位符返回结果。"""
    with Session(engine) as s:
        s.add(
            Job(tenant_id="t", user_id="u", prompt_id="hold-abc", worker="http://w",
                kind="h3_t2v", status="held", prompt="x", seed=1)
        )
        s.commit()

    async def _release():
        await asyncio.sleep(0.2)
        with Session(engine) as s2:
            job = s2.exec(select(Job).where(Job.prompt_id == "hold-abc")).first()
            job.prompt_id = "real-1"  # 放行:换真实 prompt_id
            job.status = "done"
            job.result = '["u1"]'
            s2.add(job)
            s2.commit()

    asyncio.create_task(_release())
    with Session(engine) as s:
        result = await tracker.wait_for_jobs(
            s, ["hold-abc"], timeout=5.0, poll_interval=0.05
        )
    assert result == {"hold-abc": ["u1"]}


async def test_wait_files_follows_held_release(engine, monkeypatch):
    """时长链 _wait_files:held 首段不空等 history,放行后换真实 prompt_id 取到产物。"""
    monkeypatch.setattr(app_db, "engine", engine)  # _wait_files 内惰性 import app.db.engine
    with Session(engine) as s:
        s.add(
            Job(tenant_id="t", user_id="u", prompt_id="hold-xyz", worker="http://w",
                kind="h3_t2v", status="held", prompt="x", seed=1)
        )
        s.commit()

    class _HistClient:
        base_url = "http://w"

        async def get_history(self, pid: str) -> dict:
            if pid == "real-9":
                return {
                    "real-9": {
                        "outputs": {"9": {"gifs": [{"filename": "v.mp4"}]}},
                        "status": {"status_str": "success"},
                    }
                }
            return {}

    async def _release():
        await asyncio.sleep(0.2)
        with Session(engine) as s2:
            job = s2.exec(select(Job).where(Job.prompt_id == "hold-xyz")).first()
            job.prompt_id = "real-9"
            job.status = "running"
            s2.add(job)
            s2.commit()

    asyncio.create_task(_release())
    files = await vgen._wait_files(_HistClient(), "hold-xyz", timeout=5.0, poll=0.05)
    assert files[0]["filename"] == "v.mp4"


async def test_wait_files_held_timeout_raises(engine, monkeypatch):
    """held 作业超时被调度轮标 error 后,_wait_files 抛错(链回落原始产物)。"""
    monkeypatch.setattr(app_db, "engine", engine)
    with Session(engine) as s:
        s.add(
            Job(tenant_id="t", user_id="u", prompt_id="hold-to", worker="http://w",
                kind="h3_t2v", status="held", prompt="x", seed=1)
        )
        s.commit()

    async def _timeout():
        await asyncio.sleep(0.2)
        with Session(engine) as s2:
            job = s2.exec(select(Job).where(Job.prompt_id == "hold-to")).first()
            job.status = "error"
            s2.add(job)
            s2.commit()

    asyncio.create_task(_timeout())

    class _EmptyClient:
        base_url = "http://w"

        async def get_history(self, pid: str) -> dict:
            return {}

    with pytest.raises(RuntimeError, match="执行失败"):
        await vgen._wait_files(_EmptyClient(), "hold-to", timeout=5.0, poll=0.05)
