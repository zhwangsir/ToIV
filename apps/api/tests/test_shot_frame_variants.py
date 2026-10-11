"""W2.2(2026-10-11):多视角分镜扩展——异步 Job/轮询/错误透出(核心生成打桩)。"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.studio as studio_rt
from app.db import get_session
from app.main import app
from app.models import StudioCharacter, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    sid = ""
    with Session(engine) as s:
        t = Tenant(name="fv"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="f@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.commit()
        p = StudioProject(tenant_id=t.id, user_id="u1", title="fv"); s.add(p); s.commit(); s.refresh(p)
        pid = str(p.id)
        c = StudioCharacter(project_id=pid, name="小周", visual_prompt="clerk",
                            reference_images='["/api/studio/files/fake_ref.png"]')
        s.add(c); s.commit()
        sh = StudioShot(project_id=pid, idx=0, scene="便利店取牛奶", characters='["小周"]', status="draft")
        s.add(sh); s.commit(); s.refresh(sh)
        sid = str(sh.id)
    import app.db as db_mod
    from unittest.mock import patch as _patch
    with _patch.object(db_mod, "engine", engine):
        yield TestClient(app), sid, pid, {"Authorization": "Bearer " + create_token("u1")}
    app.dependency_overrides.clear()


def _wait_terminal(client, sid, job_id, h, timeout=5.0):
    dl = time.time() + timeout
    while time.time() < dl:
        r = client.get(f"/api/studio/shots/{sid}/frame-variants/{job_id}", headers=h)
        body = r.json()
        if body.get("status") in ("done", "error"):
            return body
        time.sleep(0.05)
    raise AssertionError("frame job 未限时完成")


def test_frame_variants_roundtrip(ctx, monkeypatch):
    client, sid, _, h = ctx

    async def fake_gen(session, shot, *, style="anime"):
        return [{"scale": sc, "url": f"/api/studio/files/fv_{sc}.png"} for sc in ("wide", "medium", "closeup")]

    monkeypatch.setattr("app.services.studio.shot_frame.generate_frame_variants", fake_gen)
    # 路由内部 import 的引用也打掉
    monkeypatch.setattr(studio_rt, "_run_frame_variants_job",
                        studio_rt.__dict__["_run_frame_variants_job"])
    r = client.post(f"/api/studio/shots/{sid}/frame-variants", headers=h, json={"style": "anime"})
    assert r.status_code == 200
    body = _wait_terminal(client, sid, r.json()["job_id"], h)
    assert body["status"] == "done"
    assert [v["scale"] for v in body["variants"]] == ["wide", "medium", "closeup"]


def test_frame_variants_no_ref_error(ctx, monkeypatch):
    """角色无参考图 → 前置错误经 Job error 透出。"""
    client, sid, _, h = ctx
    from app.services.studio.shot_frame import FrameVariantError

    async def boom(session, shot, *, style="anime"):
        raise FrameVariantError("镜头角色无定妆参考图(先在资产段生成设定卡并采用)")

    monkeypatch.setattr("app.services.studio.shot_frame.generate_frame_variants", boom)
    r = client.post(f"/api/studio/shots/{sid}/frame-variants", headers=h, json={})
    body = _wait_terminal(client, sid, r.json()["job_id"], h)
    assert body["status"] == "error"
    assert "定妆参考图" in body["error"]


def test_frame_variants_wrong_job_404(ctx):
    client, sid, _, h = ctx
    r = client.get(f"/api/studio/shots/{sid}/frame-variants/nonexistent", headers=h)
    assert r.status_code == 404
