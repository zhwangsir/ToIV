"""Wave P1.5 + P2 残余:fleet brief / deps-status / preferred_pipeline / lipsync skip."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override

    async def fake_snapshot():
        return {
            "generated_at": "2026-10-22T00:00:00+08:00",
            "cache_ttl_sec": 15,
            "devices": [
                {
                    "id": "workstation",
                    "name": "工作站",
                    "role": "core",
                    "online": True,
                    "services_up": 3,
                    "services_total": 4,
                    "headline": "3/4 服务在线",
                    "services": [{"name": "h3", "port": 8264, "status": "up"}],
                }
            ],
        }

    monkeypatch.setattr("app.services.fleet.get_snapshot", fake_snapshot)

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="p15@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="hold-1",
                worker="",
                kind="h3_t2v",
                status="held",
                hold_reason="VRAM 不足",
            )
        )
        proj = StudioProject(
            tenant_id=tenant.id,
            user_id=user.id,
            title="测管线",
            preferred_pipeline="ref2va",
        )
        s.add(proj)
        s.commit()
        s.refresh(proj)
        shot = StudioShot(
            project_id=proj.id,
            idx=0,
            status="voiced",
            video_url="/api/studio/files/v.mp4",
            voice_url="/api/studio/files/a.wav",
            dialogue="你好",
        )
        s.add(shot)
        s.commit()
        uid, pid, sid = user.id, proj.id, shot.id

    client = TestClient(app)
    headers = {"Authorization": f"Bearer {create_token(uid)}"}
    yield {
        "client": client,
        "headers": headers,
        "engine": engine,
        "pid": pid,
        "sid": sid,
        "uid": uid,
    }
    app.dependency_overrides.clear()


def test_fleet_brief_for_regular_user_hides_ports(ctx):
    r = ctx["client"].get("/api/fleet/brief", headers=ctx["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["level"] == "held"
    assert "端口" not in body["summary"]
    assert ":8264" not in body["summary"]
    assert body["mine"]["held"] == 1
    # devices 可有 headline,但 brief 契约不强制吐 services 明细端口给 UI
    assert "services" not in (body.get("devices") or [{}])[0]


def test_deps_status_shape(ctx, monkeypatch):
    import app.routes.studio as studio_routes

    async def fake_probe(url: str, path: str = "") -> str:
        if "9200" in url or path == "/health":
            return "reachable"
        if "8264" in url:
            return "unreachable"
        return "reachable"

    # monkeypatch the inner probe by patching httpx would be heavy; call endpoint and
    # accept whatever — shape is what we assert. Soft probe may be unreachable in CI.
    r = ctx["client"].get("/api/studio/deps-status", headers=ctx["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall"] in ("reachable", "degraded", "unreachable")
    ids = {d["id"] for d in body["deps"]}
    assert ids == {"api", "tts", "h3"}
    for d in body["deps"]:
        assert d["state"] in ("reachable", "degraded", "unreachable")
        assert ":" not in d["summary"] or "http" not in d["summary"].lower()
        assert "8264" not in d["summary"]
        assert "9200" not in d["summary"]


def test_patch_preferred_pipeline(ctx):
    pid = ctx["pid"]
    r = ctx["client"].patch(
        f"/api/studio/projects/{pid}",
        headers=ctx["headers"],
        json={"preferred_pipeline": "c_hybrid"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["preferred_pipeline"] == "c_hybrid"
    bad = ctx["client"].patch(
        f"/api/studio/projects/{pid}",
        headers=ctx["headers"],
        json={"preferred_pipeline": "nope"},
    )
    assert bad.status_code == 422


def test_skip_lipsync_endpoint(ctx, monkeypatch):
    async def fake_skip(session, shot):
        shot.final_clip_url = "/api/studio/files/skipped.mp4"
        shot.status = "lipsynced"
        shot.lipsync_skipped = True
        session.add(shot)
        session.commit()
        session.refresh(shot)
        return shot.final_clip_url

    monkeypatch.setattr(
        "app.services.studio.lipsync.skip_lipsync_for_shot", fake_skip
    )
    sid = ctx["sid"]
    r = ctx["client"].post(
        f"/api/studio/shots/{sid}/lipsync/skip",
        headers=ctx["headers"],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "lipsynced"
    assert body.get("lipsync_skipped") is True
    assert body.get("final_clip_url")
