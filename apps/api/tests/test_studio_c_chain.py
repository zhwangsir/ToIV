"""管线 C 阶段 B：c-chains 异步 Job（不真跑 H3）。"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, StudioCharacter, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import c_chain as c_chain_svc
from app.services.studio.renderers.base import RenderError


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _session():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _session

    import app.db as dbmod
    import app.services.studio.c_chain as cc

    monkeypatch.setattr(dbmod, "engine", engine)
    monkeypatch.setattr(cc, "engine", engine)

    with Session(engine) as s:
        s.add(Tenant(id="ten-c", name="t"))
        s.add(
            User(
                id="user-c",
                tenant_id="ten-c",
                email="cchain@test.local",
                hashed_password=hash_password("x"),
                role="user",
            )
        )
        s.commit()

    token = create_token("user-c")
    client = TestClient(app)
    yield {
        "client": client,
        "engine": engine,
        "headers": {"Authorization": f"Bearer {token}"},
    }
    app.dependency_overrides.clear()


def _seed_project(engine):
    with Session(engine) as s:
        p = StudioProject(
            id="proj-chain-1",
            tenant_id="ten-c",
            user_id="user-c",
            title="chain",
            style="anime",
            width=768,
            height=1344,
        )
        s.add(p)
        s.add(
            StudioCharacter(
                id="char-1",
                project_id=p.id,
                name="林夏",
                visual_prompt="young woman",
                reference_images=json.dumps(
                    ["/api/studio/files/sample_linxia_full.png"]
                ),
            )
        )
        s.commit()
        return p.id


def test_create_c_chain_returns_db_job_id_immediately(ctx, monkeypatch):
    """HTTP 202：job_id === DB Job.id；不是 Comfy prompt_id。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)

    async def _fake_run(job_id: str):
        return None

    monkeypatch.setattr(c_chain_svc, "run_c_chain", _fake_run)

    body = {
        "pipeline": "c_hybrid",
        "project_id": pid,
        "start": {"type": "makeup"},
        "style": "anime",
        "num_candidates": 1,
        "auto_assemble": False,
        "segments": [
            {
                "prompt": "Lin Xia enters the store",
                "duration_sec": 6,
                "characters": ["林夏"],
            }
        ],
    }
    r = ctx["client"].post(
        "/api/studio/c-chains", json=body, headers=ctx["headers"]
    )
    assert r.status_code == 202, r.text
    data = r.json()
    assert data["status"] == "queued"
    assert data["chain_id"] == pid
    assert data["job_id"]
    assert data["prompt_id"] == f"chain-{data['job_id']}"
    assert data["job_id"] != data["prompt_id"]
    assert not str(data["job_id"]).startswith("pid-")

    with Session(engine) as s:
        job = s.get(Job, data["job_id"])
        assert job is not None
        assert job.kind == "studio_c_chain"
        assert job.id == data["job_id"]
        assert job.prompt_id == f"chain-{job.id}"
        assert job.worker == ""
        snap = json.loads(job.params)
        assert snap["chain_id"] == pid
        assert snap["segment_prompt_ids"] == []


def test_run_c_chain_stops_on_cancel(ctx, monkeypatch):
    """canceled 后不再跑下一段；segment_prompt_ids 已登记。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)

    with Session(engine) as s:
        user = s.get(User, "user-c")
        body = c_chain_svc.CChainCreateBody(
            pipeline="c",
            project_id=pid,
            num_candidates=1,
            auto_assemble=False,
            segments=[
                c_chain_svc.CChainSegmentIn(prompt="seg0", characters=["林夏"]),
                c_chain_svc.CChainSegmentIn(prompt="seg1", characters=["林夏"]),
            ],
        )
        out = c_chain_svc.create_c_chain(s, user, body)
        job_id = out["job_id"]

    calls: list[str] = []

    async def _fake_render(session, shot, **kw):
        calls.append(shot.id)
        assert kw.get("parent_chain_job_id") == job_id
        pid_comfy = f"comfy-{len(calls)}"
        c_chain_svc.append_segment_prompt_id(job_id, pid_comfy)
        if len(calls) == 1:
            with Session(engine) as s:
                job = s.get(Job, job_id)
                job.status = "canceled"
                job.error = "已被用户取消"
                s.add(job)
                s.commit()
            raise RenderError("已中止")
        shot.status = "rendered"
        shot.video_url = f"/api/studio/files/{shot.id}.mp4"
        shot.final_clip_url = shot.video_url
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr("app.services.studio.orchestrator.render_shot", _fake_render)
    asyncio.run(c_chain_svc.run_c_chain(job_id))
    assert len(calls) == 1
    with Session(engine) as s:
        job = s.get(Job, job_id)
        assert job.status == "canceled"
        assert "comfy-1" in json.loads(job.params).get("segment_prompt_ids", [])


def test_cancel_job_propagates_segment_prompts(ctx, monkeypatch):
    engine = ctx["engine"]
    with Session(engine) as s:
        job = Job(
            tenant_id="ten-c",
            user_id="user-c",
            prompt_id="tmp",
            worker="",
            kind="studio_c_chain",
            status="running",
            params=json.dumps(
                {"chain_id": "proj-x", "segment_prompt_ids": ["comfy-a", "comfy-b"]}
            ),
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        job.prompt_id = f"chain-{job.id}"
        s.add(
            Job(
                tenant_id="ten-c",
                user_id="user-c",
                prompt_id="comfy-a",
                worker="http://fake:8195",
                kind="studio_pipeline_c",
                status="running",
            )
        )
        s.add(
            Job(
                tenant_id="ten-c",
                user_id="user-c",
                prompt_id="comfy-b",
                worker="http://fake:8195",
                kind="studio_pipeline_c",
                status="queued",
            )
        )
        s.add(job)
        s.commit()
        chain_id = job.id

    canceled: list[str] = []

    class _FakeClient:
        def __init__(self, base, timeout=8.0):
            self.base = base

        async def cancel_prompt(self, prompt_id):
            canceled.append(prompt_id)
            return "interrupted"

    monkeypatch.setattr("app.routes.jobs.ComfyUIClient", _FakeClient)
    r = ctx["client"].post(f"/api/jobs/{chain_id}/cancel", headers=ctx["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "canceled"
    assert r.json()["canceled_segments"] == 2
    assert set(canceled) == {"comfy-a", "comfy-b"}


def test_jobs_lookup_chain_extra(ctx):
    engine = ctx["engine"]
    with Session(engine) as s:
        job = Job(
            tenant_id="ten-c",
            user_id="user-c",
            prompt_id="tmp",
            worker="",
            kind="studio_c_chain",
            status="running",
            params=json.dumps(
                {
                    "chain_id": "proj-z",
                    "pipeline": "c_hybrid",
                    "segments": [{"index": 0, "segment_id": "s1", "status": "rendering"}],
                }
            ),
            progress=json.dumps(
                {"pct": 10, "segments_total": 2, "segments_done": 0, "current_segment": 0}
            ),
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        job.prompt_id = f"chain-{job.id}"
        s.add(job)
        s.commit()
        jid = job.id

    r = ctx["client"].get(f"/api/jobs/lookup?job_id={jid}", headers=ctx["headers"])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["id"] == jid
    assert data["chain"]["chain_id"] == "proj-z"
    assert data["chain"]["pipeline"] == "c_hybrid"


def test_get_c_chain_details(ctx):
    engine = ctx["engine"]
    pid = _seed_project(engine)
    with Session(engine) as s:
        s.add(
            StudioShot(
                id="shot-a",
                project_id=pid,
                idx=0,
                prompt="p",
                status="rendered",
                video_url="/api/studio/files/a.mp4",
                final_clip_url="/api/studio/files/a.mp4",
                candidates_json=json.dumps(
                    [{"id": "c1", "is_picked": True, "url": "/api/studio/files/a.mp4"}]
                ),
            )
        )
        s.commit()
    r = ctx["client"].get(f"/api/studio/c-chains/{pid}", headers=ctx["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["chain_id"] == pid
    assert r.json()["segments"][0]["status"] == "done"


def test_wait_false_path_still_present():
    """回归：wait=false 合入行为仍在 RenderShotBody / render_pipeline_c 上。"""
    from app.routes.studio import RenderShotBody
    from app.services.studio.pipeline_c_render import render_pipeline_c
    import inspect

    assert "wait" in RenderShotBody.model_fields
    assert RenderShotBody.model_fields["wait"].default is True
    sig = inspect.signature(render_pipeline_c)
    assert sig.parameters["wait"].default is True



# ── 失败 / 边界 ─────────────────────────────────────────────────────────────


async def _noop_run(_job_id: str):
    return None


def test_create_rejects_non_makeup_start(ctx, monkeypatch):
    """首版硬限制：start.type 非 makeup → 422，文案明确。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)
    monkeypatch.setattr(c_chain_svc, "run_c_chain", _noop_run)

    for bad in ("video", "job"):
        r = ctx["client"].post(
            "/api/studio/c-chains",
            headers=ctx["headers"],
            json={
                "pipeline": "c_hybrid",
                "project_id": pid,
                "start": {"type": bad},
                "segments": [{"prompt": "x", "duration_sec": 6}],
            },
        )
        assert r.status_code == 422, (bad, r.text)
        detail = str(r.json().get("detail") or r.text)
        assert "makeup" in detail.lower() or "首版" in detail


def test_create_rejects_empty_segments(ctx, monkeypatch):
    """空 segments → 参数错 422。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)
    monkeypatch.setattr(c_chain_svc, "run_c_chain", _noop_run)

    r = ctx["client"].post(
        "/api/studio/c-chains",
        headers=ctx["headers"],
        json={
            "pipeline": "c",
            "project_id": pid,
            "start": {"type": "makeup"},
            "segments": [],
        },
    )
    assert r.status_code == 422, r.text


def test_create_rejects_missing_prompt(ctx, monkeypatch):
    """缺 prompt / 空 prompt → 参数错 422。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)
    monkeypatch.setattr(c_chain_svc, "run_c_chain", _noop_run)

    # 缺 prompt 字段
    r = ctx["client"].post(
        "/api/studio/c-chains",
        headers=ctx["headers"],
        json={
            "pipeline": "c",
            "project_id": pid,
            "start": {"type": "makeup"},
            "segments": [{"duration_sec": 6, "characters": ["林夏"]}],
        },
    )
    assert r.status_code == 422, r.text

    # 空字符串 prompt（min_length=1）
    r = ctx["client"].post(
        "/api/studio/c-chains",
        headers=ctx["headers"],
        json={
            "pipeline": "c",
            "project_id": pid,
            "start": {"type": "makeup"},
            "segments": [{"prompt": "", "duration_sec": 6}],
        },
    )
    assert r.status_code == 422, r.text


def test_create_then_immediate_cancel_stops_background(ctx, monkeypatch):
    """创建后立即 cancel：Job=canceled；后台若再跑也不得继续重提/渲染。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)
    monkeypatch.setattr(c_chain_svc, "run_c_chain", _noop_run)

    r = ctx["client"].post(
        "/api/studio/c-chains",
        headers=ctx["headers"],
        json={
            "pipeline": "c",
            "project_id": pid,
            "start": {"type": "makeup"},
            "num_candidates": 1,
            "auto_assemble": False,
            "segments": [
                {"prompt": "seg0", "duration_sec": 6, "characters": ["林夏"]},
                {"prompt": "seg1", "duration_sec": 6, "characters": ["林夏"]},
            ],
        },
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]

    with Session(engine) as s:
        job = s.get(Job, job_id)
        assert job is not None
        assert job.id == job_id
        assert job.status in ("queued", "running")

    cr = ctx["client"].post(f"/api/jobs/{job_id}/cancel", headers=ctx["headers"])
    assert cr.status_code == 200, cr.text
    assert cr.json()["status"] == "canceled"

    with Session(engine) as s:
        assert s.get(Job, job_id).status == "canceled"

    renders: list[str] = []

    async def _boom_render(session, shot, **kw):
        renders.append(shot.id)
        raise AssertionError("canceled 后不得继续 render_shot")

    monkeypatch.setattr("app.services.studio.orchestrator.render_shot", _boom_render)
    asyncio.run(c_chain_svc.run_c_chain(job_id))
    assert renders == []

    with Session(engine) as s:
        assert s.get(Job, job_id).status == "canceled"


def test_response_job_id_equals_db_job_id_regression(ctx, monkeypatch):
    """回归：202 响应 job_id 必须等于 DB Job.id，且不等于 prompt_id。"""
    engine = ctx["engine"]
    pid = _seed_project(engine)
    monkeypatch.setattr(c_chain_svc, "run_c_chain", _noop_run)

    r = ctx["client"].post(
        "/api/studio/c-chains",
        headers=ctx["headers"],
        json={
            "pipeline": "c_hybrid",
            "project_id": pid,
            "start": {"type": "makeup"},
            "auto_assemble": False,
            "segments": [{"prompt": "hello world", "duration_sec": 6}],
        },
    )
    assert r.status_code == 202, r.text
    data = r.json()
    jid = data["job_id"]
    with Session(engine) as s:
        row = s.get(Job, jid)
        assert row is not None
        assert row.id == jid
        assert row.kind == "studio_c_chain"
        assert data["prompt_id"] == f"chain-{row.id}"
        assert data["job_id"] == row.id
        assert data["job_id"] != data["prompt_id"]
        assert not jid.startswith("pid-")
        assert not jid.startswith("comfy-")
