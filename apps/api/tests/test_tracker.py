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
