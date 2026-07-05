"""服务端作业追踪器单测 —— 验证结果落库幂等 + history 轮询三种结局。

不依赖 pytest-asyncio:异步函数用 asyncio.run() 在同步测试里跑。
不连真 ComfyUI:用假 client 返回可控 history。
"""
import asyncio
import json

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.comfy.tracker as tracker
from app.models import Job


@pytest.fixture
def db(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(tracker, "engine", engine)
    with Session(engine) as s:
        s.add(
            Job(
                tenant_id="t",
                user_id="u",
                prompt_id="p1",
                worker="http://w",
                kind="txt2img",
                status="queued",
                prompt="x",
                seed=1,
            )
        )
        s.commit()
    return engine


def _job(engine, pid="p1") -> Job:
    with Session(engine) as s:
        return s.exec(select(Job).where(Job.prompt_id == pid)).first()


class _FakeClient:
    base_url = "http://w"

    def __init__(self, history: dict):
        self._h = history

    async def get_history(self, prompt_id: str) -> dict:
        return self._h


def test_mark_done_records_results(db):
    tracker.mark_done("p1", ["/api/images?filename=a.png"])
    j = _job(db)
    assert j.status == "done"
    assert json.loads(j.result) == ["/api/images?filename=a.png"]


def test_mark_done_is_idempotent(db):
    tracker.mark_done("p1", ["/api/images?filename=a.png"])
    tracker.mark_done("p1", ["/api/images?filename=OVERWRITE.png"])  # 不应覆盖
    assert json.loads(_job(db).result) == ["/api/images?filename=a.png"]


def test_mark_status_does_not_downgrade_done(db):
    tracker.mark_done("p1", [])
    tracker.mark_status("p1", "error")  # 已 done,不回退
    assert _job(db).status == "done"


def test_poll_once_done_with_files(db):
    hist = {
        "p1": {
            "outputs": {"9": {"images": [{"filename": "a.png", "subfolder": "", "type": "output"}]}},
            "status": {"completed": True, "status_str": "success"},
        }
    }
    out = asyncio.run(tracker._poll_once(_FakeClient(hist), "p1"))
    assert out == "done"
    j = _job(db)
    assert j.status == "done"
    assert json.loads(j.result)[0].endswith("filename=a.png&subfolder=&type=output&worker=http://w") or "a.png" in j.result


def test_poll_once_error(db):
    hist = {"p1": {"outputs": {}, "status": {"completed": False, "status_str": "error"}}}
    out = asyncio.run(tracker._poll_once(_FakeClient(hist), "p1"))
    assert out == "error"
    assert _job(db).status == "error"


def test_poll_once_pending_returns_none(db):
    out = asyncio.run(tracker._poll_once(_FakeClient({}), "p1"))  # history 还没该 prompt
    assert out is None
    assert _job(db).status == "queued"


def test_reconcile_respawns_pending_not_done(db, monkeypatch):
    """reconcile 为 queued/running 作业重挂追踪;已 done 的不重挂。"""
    called: list[str] = []
    monkeypatch.setattr(tracker, "spawn", lambda client, pid: called.append(pid))
    with Session(db) as s:
        s.add(Job(tenant_id="t", user_id="u", prompt_id="pdone", worker="http://w",
                  kind="txt2img", status="done", prompt="x", seed=1))
        s.add(Job(tenant_id="t", user_id="u", prompt_id="prun", worker="http://w",
                  kind="i2v", status="running", prompt="x", seed=2))
        s.commit()
    n = tracker.reconcile_pending()
    assert "p1" in called and "prun" in called  # queued/running 重挂
    assert "pdone" not in called                 # done 不重挂
    assert n == len(called)


def test_reconcile_skips_already_tracked(db, monkeypatch):
    """已在追踪的 prompt_id 不被 reconcile 重复挂。"""
    tracker._tracked.add("p1")
    try:
        called: list[str] = []
        monkeypatch.setattr(tracker, "spawn", lambda client, pid: called.append(pid))
        tracker.reconcile_pending()
        assert "p1" not in called
    finally:
        tracker._tracked.discard("p1")

async def test_wait_for_jobs_returns_urls(db):
    """wait_for_jobs 等待多个 done 作业并返回 URL 列表。"""
    with Session(db) as s:
        s.add(
            Job(
                tenant_id="t",
                user_id="u",
                prompt_id="w1",
                worker="http://w",
                kind="txt2img",
                status="done",
                prompt="x",
                seed=1,
                result='["url1"]',
            )
        )
        s.add(
            Job(
                tenant_id="t",
                user_id="u",
                prompt_id="w2",
                worker="http://w",
                kind="txt2img",
                status="done",
                prompt="x",
                seed=1,
                result='["url2"]',
            )
        )
        s.commit()
    with Session(db) as s:
        result = await tracker.wait_for_jobs(
            s, ["w1", "w2"], timeout=1.0, poll_interval=0.1
        )
    assert result == {"w1": ["url1"], "w2": ["url2"]}


async def test_wait_for_jobs_raises_on_error(db):
    """wait_for_jobs 遇 error 作业立即抛异常。"""
    with Session(db) as s:
        s.add(
            Job(
                tenant_id="t",
                user_id="u",
                prompt_id="w1",
                worker="http://w",
                kind="txt2img",
                status="done",
                prompt="x",
                seed=1,
                result='["url1"]',
            )
        )
        s.add(
            Job(
                tenant_id="t",
                user_id="u",
                prompt_id="w2",
                worker="http://w",
                kind="txt2img",
                status="error",
                prompt="x",
                seed=1,
            )
        )
        s.commit()
    with Session(db) as s:
        with pytest.raises(RuntimeError):
            await tracker.wait_for_jobs(
                s, ["w1", "w2"], timeout=1.0, poll_interval=0.1
            )
