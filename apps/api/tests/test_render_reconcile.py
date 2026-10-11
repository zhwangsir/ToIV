"""S5(2026-10-11):异步渲染回写——Job 终态 → 镜状态/candidates(生产缺陷场景复现)。

缺陷:Job done 且产出 mp4,镜永久 rendering、candidates 空(c9ba6609 实证)。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio.render_reconcile import reconcile_project_renders


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    pid = ""
    with Session(engine) as s:
        t = Tenant(name="rr"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="r@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.commit()
        p = StudioProject(tenant_id=t.id, user_id="u1", title="rr"); s.add(p); s.commit(); s.refresh(p)
        pid = str(p.id)
    yield engine, pid, {"Authorization": "Bearer " + create_token("u1")}
    app.dependency_overrides.clear()


def _mk_shot(s, pid, status="rendering", cands=None):
    sh = StudioShot(project_id=pid, idx=0, scene="x", status=status,
                    candidates_json=json.dumps(cands or [], ensure_ascii=False))
    s.add(sh); s.commit(); s.refresh(sh)
    return sh


def _mk_job(s, status, results=None, error=""):
    j = Job(tenant_id="t", user_id="u1", prompt_id=f"p-{status}-{results}", worker="", kind="studio_pipeline_c",
            status=status, prompt="t", result=json.dumps(results or []), error=error)
    s.add(j); s.commit()
    return j


def test_done_job_writes_back_rendered(ctx):
    """生产缺陷场景:Job done+产物,镜 rendering+空候选 → 回写 rendered+url+is_picked。"""
    engine, pid, _ = ctx
    with Session(engine) as s:
        j = _mk_job(s, "done", results=["/api/images?filename=x.mp4"])
        cands = [{"id": "c1", "url": "", "seed": 1, "status": "queued", "is_picked": False,
                  "error": "", "db_job_id": j.id, "job_id": "prompt-x"}]
        sh = _mk_shot(s, pid, cands=cands)
        n = reconcile_project_renders(s, pid)
        s.refresh(sh)
        out = json.loads(sh.candidates_json)
        assert n == 1
        assert sh.status == "rendered"
        assert sh.video_url == "/api/images?filename=x.mp4"
        assert out[0]["status"] == "done" and out[0]["is_picked"] is True and out[0]["url"]


def test_error_job_marks_shot_error(ctx):
    engine, pid, _ = ctx
    with Session(engine) as s:
        j = _mk_job(s, "error", error="提交失败:xx")
        cands = [{"id": "c1", "url": "", "status": "queued", "is_picked": False, "db_job_id": j.id}]
        sh = _mk_shot(s, pid, cands=cands)
        reconcile_project_renders(s, pid)
        s.refresh(sh)
        assert sh.status == "error"
        assert "提交失败" in sh.error
        assert json.loads(sh.candidates_json)[0]["status"] == "error"


def test_running_job_untouched(ctx):
    engine, pid, _ = ctx
    with Session(engine) as s:
        j = _mk_job(s, "running")
        cands = [{"id": "c1", "url": "", "status": "queued", "db_job_id": j.id}]
        sh = _mk_shot(s, pid, cands=cands)
        n = reconcile_project_renders(s, pid)
        s.refresh(sh)
        assert n == 0 and sh.status == "rendering"
        assert json.loads(sh.candidates_json)[0]["status"] == "queued"


def test_multi_candidate_partial(ctx):
    engine, pid, _ = ctx
    with Session(engine) as s:
        jd = _mk_job(s, "done", results=["/api/images?filename=a.mp4"])
        jr = _mk_job(s, "running")
        cands = [
            {"id": "c1", "url": "", "status": "queued", "is_picked": False, "db_job_id": jd.id},
            {"id": "c2", "url": "", "status": "queued", "is_picked": False, "db_job_id": jr.id},
        ]
        sh = _mk_shot(s, pid, cands=cands)
        reconcile_project_renders(s, pid)
        s.refresh(sh)
        out = json.loads(sh.candidates_json)
        assert sh.status == "rendered" and sh.video_url.endswith("a.mp4")
        assert out[0]["status"] == "done" and out[0]["is_picked"] is True
        assert out[1]["status"] == "queued"  # 第二候选仍在跑


def test_done_without_results_untouched(ctx):
    """done 但 result 空(产物回填滞后)不误标,等下一轮。"""
    engine, pid, _ = ctx
    with Session(engine) as s:
        j = _mk_job(s, "done", results=[])
        cands = [{"id": "c1", "url": "", "status": "queued", "db_job_id": j.id}]
        sh = _mk_shot(s, pid, cands=cands)
        n = reconcile_project_renders(s, pid)
        s.refresh(sh)
        assert n == 0 and sh.status == "rendering"


def test_detail_endpoint_lazy_reconcile(ctx):
    """GET /studio/projects/{pid} 触发惰性回写(UI 10s 轮询即自愈通道)。"""
    engine, pid, h = ctx
    with Session(engine) as s:
        j = _mk_job(s, "done", results=["/api/images?filename=lazy.mp4"])
        _mk_shot(s, pid, cands=[{"id": "c1", "url": "", "status": "queued", "db_job_id": j.id}])
    client = TestClient(app)
    r = client.get(f"/api/studio/projects/{pid}", headers=h)
    assert r.status_code == 200
    shot = r.json()["shots"][0]
    assert shot["status"] == "rendered"
    assert shot["video_url"].endswith("lazy.mp4")
    assert shot["candidates"][0]["is_picked"] is True


def test_async_multicand_writes_queued_candidates(ctx, monkeypatch):
    """S5:wait=false + num_candidates=2 → 两条 queued 候选落库(各带 db_job_id),镜保持 rendering。"""
    import types

    from app.services.studio import orchestrator as orch

    engine, pid, _ = ctx

    class _R:
        kind = "video"
        url = ""
        _n = 0

        def __init__(self):
            type(self)._n += 1

        pipeline_meta = {
            "waited": False,
            "db_job_id": f"job-{__import__('uuid').uuid4().hex[:8]}",
            "job_id": "prompt-x",
            "seed": 42,
            "worker": "http://w",
            "pipeline": "ref2va",
            "context_latent": "ctx.bin",
        }

    async def fake_render(shot, cast, pool, **kw):
        return _R()

    monkeypatch.setattr(
        orch, "get_renderer", lambda shot: types.SimpleNamespace(render=fake_render)
    )
    with Session(engine) as s:
        sh = _mk_shot(s, pid, status="draft", cands=[])
        import asyncio

        out = asyncio.run(
            orch.render_shot(s, sh, None, num_candidates=2, pipeline="ref2va", wait=False)
        )
        s.refresh(sh)
        cands = json.loads(sh.candidates_json)
        assert sh.status == "rendering"
        assert len(cands) == 2
        assert all(c["status"] == "queued" and c["db_job_id"] for c in cands)
        assert not any(c.get("is_picked") for c in cands)
        assert out is sh
