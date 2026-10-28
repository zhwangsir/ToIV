"""待办 #2: POST /studio/projects/{pid}/render 不得因客户端断连杀死回写。

锁定:
  (a) wait=false → 立即返回 job_id(202),不等整批出片;
  (b) 回写挂在 Job 生命周期(create_task),与请求协程脱钩——早返回后仍落 status/candidates;
  (c) 轮询可观察进度/完成。
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # 后台 _run_batch_render / wait 轮询走 app.db.engine —— 指到测试库
    import app.db as db_mod

    monkeypatch.setattr(db_mod, "engine", engine)
    with Session(engine) as s:
        t = Tenant(name="batch-async")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            email="batch@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        uid = u.id
    # with 客户端:共享 lifespan loop,create_task 跨请求不被取消(对齐生产 uvicorn)
    with TestClient(app) as client:
        yield client, create_token(uid), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _gate_stages_for_batch(client, H, pid):
    """C1c 门禁:批量渲染前显式完成 storyboard 阶段(测试夹具,非放宽生产门禁)。
    空项目(无分镜)不设防——生产门禁对空批次/空项目本就不拦。"""
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    if not detail.get("shots"):
        return
    states = detail["stage_states"]
    script_action = "confirm" if states["script"]["ready"] else "skip"
    for stage, action in (("script", script_action), ("assets", "skip"), ("storyboard", "confirm")):
        r = client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H,
                        json={"stage": stage, "action": action, "note": "测试夹具"})
        assert r.status_code == 200, r.text


def _gate_stages_for_assemble(client, H, pid):
    """C1c 门禁:合成前显式完成 storyboard/generate/voice 阶段。"""
    _gate_stages_for_batch(client, H, pid)
    for stage in ("generate", "voice"):
        r = client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H,
                        json={"stage": stage, "action": "skip", "note": "测试夹具"})
        assert r.status_code == 200, r.text


def _mk(client, H):
    pid = client.post(
        "/api/studio/projects", headers=H, json={"title": "断连", "premise": "x"}
    ).json()["id"]
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={
            "shots": [
                {"scene": "A", "prompt": "a", "duration_sec": 4},
                {"scene": "B", "prompt": "b", "duration_sec": 4},
            ]
        },
    )
    assert r.status_code == 200, r.text
    direct = client.patch(f"/api/studio/projects/{pid}", headers=H,
                          json={"preferred_drive_mode": "direct"})
    assert direct.status_code == 200, direct.text
    _gate_stages_for_batch(client, H, pid)
    return pid, r.json()["shots"]


async def _wait_flag(flag: dict, key: str = "go") -> None:
    while not flag.get(key):
        await asyncio.sleep(0.02)


def test_batch_render_wait_false_returns_job_immediately(ctx, monkeypatch):
    """(a) wait=false: POST 必须快速返回 job_id,不得等慢渲染结束。"""
    client, token, _engine = ctx
    H = _h(token)
    pid, _shots = _mk(client, H)
    gate = {"go": False}

    async def slow_render(session, shot, pool=None, request=None, **kw):
        await _wait_flag(gate)
        shot.status = "rendered"
        shot.candidates_json = json.dumps(
            [{"id": "c1", "url": "/api/studio/files/x.mp4", "status": "done", "is_picked": True}]
        )
        shot.video_url = "/api/studio/files/x.mp4"
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", slow_render)

    t0 = time.monotonic()
    r = client.post(
        f"/api/studio/projects/{pid}/render",
        headers=H,
        json={"wait": False, "accel": "off"},
    )
    elapsed = time.monotonic() - t0
    assert r.status_code == 202, r.text
    body = r.json()
    assert body.get("job_id"), body
    assert body.get("status") == "queued"
    assert elapsed < 1.5, f"应立即返回,实际 {elapsed:.2f}s"
    assert gate["go"] is False
    gate["go"] = True
    job_id = body["job_id"]
    deadline = time.monotonic() + 5
    final = None
    while time.monotonic() < deadline:
        lr = client.get("/api/jobs/lookup", headers=H, params={"job_id": job_id})
        assert lr.status_code == 200, lr.text
        final = lr.json()
        if final["status"] in ("done", "error", "canceled"):
            break
        time.sleep(0.05)
    assert final and final["status"] == "done", final


def test_batch_render_writeback_survives_early_return(ctx, monkeypatch):
    """(b) 请求早返回后后台仍回写镜 candidates/status。"""
    client, token, engine = ctx
    H = _h(token)
    pid, _shots = _mk(client, H)
    gate = {"go": False}

    async def gated_render(session, shot, pool=None, request=None, **kw):
        await _wait_flag(gate)
        shot.status = "rendered"
        shot.video_url = f"/api/studio/files/{shot.id}.mp4"
        shot.candidates_json = json.dumps(
            [{
                "id": f"c-{shot.id[:8]}",
                "url": shot.video_url,
                "status": "done",
                "is_picked": True,
            }]
        )
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", gated_render)

    r = client.post(
        f"/api/studio/projects/{pid}/render",
        headers=H,
        json={"wait": False},
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    gate["go"] = True
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if client.get("/api/jobs/lookup", headers=H, params={"job_id": job_id}).json()["status"] == "done":
            break
        time.sleep(0.05)
    assert client.get("/api/jobs/lookup", headers=H, params={"job_id": job_id}).json()["status"] == "done"

    with Session(engine) as s:
        rows = s.exec(select(StudioShot).where(StudioShot.project_id == pid)).all()
        assert len(rows) == 2
        for sh in rows:
            assert sh.status == "rendered", (sh.id, sh.status, sh.error)
            cands = json.loads(sh.candidates_json or "[]")
            assert cands and cands[0].get("url"), cands


def test_batch_render_poll_observes_progress(ctx, monkeypatch):
    """(c) 专用 status 轮询可见 running→done 与 rendered/failed。"""
    client, token, _engine = ctx
    H = _h(token)
    pid, _shots = _mk(client, H)
    order: list[str] = []
    # 每镜独立闸:列表长度=已放行数
    released = {"n": 0}

    async def stepping_render(session, shot, pool=None, request=None, **kw):
        order.append(shot.id)
        my = len(order)
        while released["n"] < my:
            await asyncio.sleep(0.02)
        shot.status = "rendered"
        shot.video_url = f"/api/studio/files/{shot.id}.mp4"
        shot.candidates_json = json.dumps(
            [{"id": "c", "url": shot.video_url, "status": "done", "is_picked": True}]
        )
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", stepping_render)

    r = client.post(
        f"/api/studio/projects/{pid}/render",
        headers=H,
        json={"wait": False},
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    def _status():
        sr = client.get(f"/api/studio/projects/{pid}/render/{job_id}", headers=H)
        assert sr.status_code == 200, sr.text
        return sr.json()

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not order:
        time.sleep(0.02)
    assert order, "后台应已开始第一镜"
    released["n"] = 1
    deadline = time.monotonic() + 3
    saw = False
    while time.monotonic() < deadline:
        st = _status()
        if int(st.get("rendered") or 0) >= 1 or st.get("status") == "done":
            saw = True
            break
        time.sleep(0.05)
    released["n"] = 2
    deadline = time.monotonic() + 3
    final = None
    while time.monotonic() < deadline:
        final = _status()
        if final.get("status") == "done":
            break
        time.sleep(0.05)
    assert final and final["status"] == "done", final
    assert int(final.get("rendered") or 0) == 2
    assert int(final.get("failed") or 0) == 0
    assert saw


def test_batch_render_wait_true_compat_counts(ctx, monkeypatch):
    """默认 wait=true:仍 200 + rendered/failed(兼容 canvas),并带 job_id。"""
    client, token, _engine = ctx
    H = _h(token)
    pid, _shots = _mk(client, H)

    async def ok(session, shot, pool=None, request=None, **kw):
        shot.status = "rendered"
        shot.video_url = f"/api/studio/files/{shot.id}.mp4"
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", ok)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rendered"] == 2 and body["failed"] == 0
    assert body.get("job_id"), "兼容响应也应带 job_id"


def test_batch_progress_has_real_timestamp_and_terminal_does_not_refresh_it(ctx, monkeypatch):
    client, token, _engine = ctx
    H = _h(token)
    pid, _shots = _mk(client, H)

    async def ok(session, shot, pool=None, request=None, **kw):
        shot.status = "rendered"
        shot.video_url = f"/api/studio/files/{shot.id}.mp4"
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", ok)
    before = time.time()
    r = client.post(
        f"/api/studio/projects/{pid}/render",
        headers=H,
        json={"wait": False},
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    final = None
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        final = client.get(
            "/api/jobs/lookup", headers=H, params={"job_id": job_id}
        ).json()
        if final["status"] == "done":
            break
        time.sleep(0.05)
    assert final and final["status"] == "done", final
    progress = final["progress"]
    assert before <= progress["updated_at"] <= time.time()
    assert progress["phase"] == "queued"
    first_updated_at = progress["updated_at"]
    time.sleep(0.02)
    status = client.get(f"/api/studio/projects/{pid}/render/{job_id}", headers=H)
    assert status.status_code == 200, status.text
    again = client.get("/api/jobs/lookup", headers=H, params={"job_id": job_id}).json()
    assert again["runtime"]["state"] == "terminal"
    assert again["progress"]["updated_at"] == first_updated_at
