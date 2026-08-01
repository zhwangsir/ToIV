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


async def test_wait_for_jobs_sees_cross_session_commit(db):
    """回归:wait_for_jobs 在 with Session 内 await,期间另一个 session 把
    Job 从 queued 改为 done,wait_for_jobs 必须看到这个变化并返回。

    旧实现:Session 在第一次 SELECT 时开启事务,后续 SELECT 在同一事务快照内,
    看不到其他 session 的 commit → 永远读到旧 status → 超时抛 RuntimeError。
    修复:每次循环前 commit() 结束当前事务,刷新快照。
    """
    with Session(db) as s:
        s.add(
            Job(
                tenant_id="t",
                user_id="u",
                prompt_id="cx1",
                worker="http://w",
                kind="txt2img",
                status="queued",
                prompt="x",
                seed=1,
            )
        )
        s.commit()

    async def _mark_done_after_delay():
        await asyncio.sleep(0.3)
        with Session(db) as s2:
            tracker.mark_done("cx1", ["/api/images?filename=cx1.png"])

    asyncio.create_task(_mark_done_after_delay())

    with Session(db) as s:
        result = await tracker.wait_for_jobs(
            s, ["cx1"], timeout=5.0, poll_interval=0.1
        )
    assert result == {"cx1": ["/api/images?filename=cx1.png"]}


async def test_wait_for_jobs_single_query_per_round(db, monkeypatch):
    """P1-4:wait_for_jobs 每轮只发一条 IN 查询,session.exec 调用次数
    不随候选数线性增长(3 个候选也只有 1 次查询)。"""
    with Session(db) as s:
        for i in range(3):
            s.add(
                Job(
                    tenant_id="t",
                    user_id="u",
                    prompt_id=f"b{i}",
                    worker="http://w",
                    kind="txt2img",
                    status="done",
                    prompt="x",
                    seed=1,
                    result=f'["u{i}"]',
                )
            )
        s.commit()
    with Session(db) as s:
        calls = 0
        orig_exec = s.exec

        def counting_exec(stmt, *args, **kwargs):
            nonlocal calls
            calls += 1
            return orig_exec(stmt, *args, **kwargs)

        monkeypatch.setattr(s, "exec", counting_exec)
        result = await tracker.wait_for_jobs(
            s, ["b0", "b1", "b2"], timeout=1.0, poll_interval=0.1
        )
    assert result == {"b0": ["u0"], "b1": ["u1"], "b2": ["u2"]}
    assert calls == 1


def test_poll_once_done_with_gifs_field(db):
    """回归:VHS_VideoCombine 视频产物在 'gifs' 字段(不是 'images'),
    _poll_once 必须从 gifs 提取 filename。"""
    hist = {
        "p1": {
            "outputs": {
                "14": {
                    "gifs": [{
                        "filename": "ToIV_drama_shot0_00001.mp4",
                        "subfolder": "",
                        "type": "output",
                        "format": "video/h264-mp4",
                        "frame_rate": 16.0,
                    }]
                }
            },
            "status": {"completed": True, "status_str": "success"},
        }
    }
    out = asyncio.run(tracker._poll_once(_FakeClient(hist), "p1"))
    assert out == "done"
    j = _job(db)
    assert j.status == "done"
    assert "ToIV_drama_shot0_00001.mp4" in (j.result or "")
