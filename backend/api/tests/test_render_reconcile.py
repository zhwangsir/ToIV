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


def test_zombie_reconcile_skips_job_backed_shots(ctx):
    """S5:僵尸收口不得误杀「queued 候选(Job 在身)」的镜——归 render_reconcile 管。"""
    from sqlmodel import select

    from app.routes.studio import reconcile_stuck_renders

    engine, pid, _ = ctx
    with Session(engine) as s:
        j = _mk_job(s, "running")
        _mk_shot(s, pid, status="rendering",
                 cands=[{"id": "c1", "url": "", "status": "queued", "db_job_id": j.id}])
        _mk_shot(s, pid, status="rendering", cands=[])  # 真孤儿
        import app.db as db_mod
        from unittest.mock import patch as _patch
        with _patch.object(db_mod, "engine", engine):
            n = reconcile_stuck_renders()
        rows = s.exec(select(StudioShot)).all()
        assert n == 1  # 只收孤儿
        assert {r.status for r in rows} == {"error", "rendering"}


def test_reconcile_fills_remaining_candidate_after_rendered(ctx):
    """S5 追修:首候选已自愈置 rendered 后,剩余 queued 候选仍须继续回写(不扰动已选)。"""
    engine, pid, _ = ctx
    with Session(engine) as s:
        jd = _mk_job(s, "done", results=["/api/images?filename=first.mp4"])
        j2 = _mk_job(s, "done", results=["/api/images?filename=second.mp4"])
        cands = [
            {"id": "c1", "url": "/api/images?filename=first.mp4", "status": "done",
             "is_picked": True, "db_job_id": jd.id},
            {"id": "c2", "url": "", "status": "queued", "is_picked": False, "db_job_id": j2.id},
        ]
        sh = _mk_shot(s, pid, status="rendered", cands=cands)
        sh.video_url = "/api/images?filename=first.mp4"
        s.add(sh); s.commit()
        n = reconcile_project_renders(s, pid)
        s.refresh(sh)
        out = json.loads(sh.candidates_json)
        assert n == 1
        assert out[1]["status"] == "done" and out[1]["url"].endswith("second.mp4")
        # 已选不扰动
        assert out[0]["is_picked"] is True and out[1]["is_picked"] is False
        assert sh.status == "rendered" and sh.video_url.endswith("first.mp4")


def test_seam_continue_selects_c_pipeline(ctx, monkeypatch):
    """W2.5:上一镜 seam_to_next=continue → 本镜未显式指定管线时自动走 c(续写)。"""
    import types

    from app.services.studio import orchestrator as orch

    engine, pid, _ = ctx
    captured: dict = {}

    class _R:
        kind = "video"
        url = "/x.mp4"
        pipeline_meta = {}

    async def fake_render(shot, cast, pool, **kw):
        captured.update(kw)
        return _R()

    monkeypatch.setattr(orch, "get_renderer", lambda shot: types.SimpleNamespace(render=fake_render))
    with Session(engine) as s:
        from app.models import StudioShot as SH

        a = SH(project_id=pid, idx=0, scene="镜A", status="rendered", seam_to_next="continue")
        b = SH(project_id=pid, idx=1, scene="镜B", status="draft")
        s.add(a); s.add(b); s.commit(); s.refresh(b)
        import asyncio

        asyncio.run(orch.render_shot(s, b, None))  # 未显式 pipeline
        assert captured.get("pipeline") == "c"
        # 对照:seam 硬切(默认空)的下一镜仍走 ref2va
        captured.clear()
        a.seam_to_next = ""
        s.add(a); s.commit()
        c2 = SH(project_id=pid, idx=2, scene="镜C", status="draft")
        s.add(c2); s.commit(); s.refresh(c2)
        asyncio.run(orch.render_shot(s, c2, None))
        assert captured.get("pipeline") == "ref2va"


def test_rerender_preserves_done_candidates(ctx, monkeypatch):
    """W2.7:重渲染保留既有 done+url 候选,只为缺口生成;全保留时零新提交。"""
    import types

    from app.services.studio import orchestrator as orch

    engine, pid, _ = ctx
    calls: list[int] = []

    class _R:
        kind = "video"
        url = "/new.mp4"
        pipeline_meta = {}

    async def fake_render(shot, cast, pool, **kw):
        calls.append(kw.get("seed") or 0)
        return _R()

    monkeypatch.setattr(orch, "get_renderer", lambda shot: types.SimpleNamespace(render=fake_render))
    with Session(engine) as s:
        from app.models import StudioShot as SH

        # 已有 2 done 候选(其一 picked) → n=2 重渲染应零提交
        sh = SH(project_id=pid, idx=0, scene="镜", status="error",
                candidates_json=json.dumps([
                    {"id": "c1", "url": "/a.mp4", "status": "done", "is_picked": True, "seed": 1},
                    {"id": "c2", "url": "/b.mp4", "status": "done", "is_picked": False, "seed": 2},
                ]))
        s.add(sh); s.commit(); s.refresh(sh)
        import asyncio

        asyncio.run(orch.render_shot(s, sh, None, num_candidates=2, auto_pick=False))
        s.refresh(sh)
        assert calls == []  # 零新提交
        out = json.loads(sh.candidates_json)
        assert len(out) == 2 and out[0]["is_picked"] is True  # 保留原样

        # 已有 1 done + n=3 → 只补 2
        calls.clear()
        sh2 = SH(project_id=pid, idx=1, scene="镜2", status="error",
                 candidates_json=json.dumps([
                     {"id": "d1", "url": "/c.mp4", "status": "done", "is_picked": True, "seed": 9},
                 ]))
        s.add(sh2); s.commit(); s.refresh(sh2)
        asyncio.run(orch.render_shot(s, sh2, None, num_candidates=3, auto_pick=False))
        s.refresh(sh2)
        out2 = json.loads(sh2.candidates_json)
        assert len(calls) == 2  # 只补缺口 2 个
        assert len(out2) == 3
        kept = [c for c in out2 if c["url"] == "/c.mp4"]
        assert kept and kept[0]["is_picked"] is True
        news = [c for c in out2 if c["url"] == "/new.mp4"]
        assert len(news) == 2 and all(c.get("fingerprint") for c in news)  # 指纹写入
