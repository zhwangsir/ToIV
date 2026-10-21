"""F1：关键帧驱动默认 + adopt-keyframe + render 软闸。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio.keyframe_drive import (
    DEFAULT_DRIVE_MODE,
    KEYFRAME_REQUIRED_CODE,
    is_studio_file_url,
    keyframe_gate_blocks,
    normalize_drive_mode,
    shot_has_keyframe,
)


def test_normalize_and_default():
    assert DEFAULT_DRIVE_MODE == "keyframe"
    assert normalize_drive_mode(None) == "keyframe"
    assert normalize_drive_mode("direct") == "direct"
    assert normalize_drive_mode("weird") == "keyframe"


def test_gate_blocks_without_keyframe():
    shot = SimpleNamespace(image_url="", status="draft", video_url="", render_mode="video")
    blocked = keyframe_gate_blocks(drive_mode="keyframe", shot=shot)
    assert blocked is not None
    assert blocked["code"] == KEYFRAME_REQUIRED_CODE


def test_gate_allows_with_keyframe_or_direct_or_force():
    shot = SimpleNamespace(image_url="/api/studio/files/a.png", status="draft", video_url="", render_mode="video")
    assert shot_has_keyframe(shot)
    assert keyframe_gate_blocks(drive_mode="keyframe", shot=shot) is None
    empty = SimpleNamespace(image_url="", status="draft", video_url="", render_mode="video")
    assert keyframe_gate_blocks(drive_mode="direct", shot=empty) is None
    assert keyframe_gate_blocks(drive_mode="keyframe", shot=empty, force_direct=True) is None
    rendered = SimpleNamespace(image_url="", status="rendered", video_url="/v.mp4", render_mode="video")
    assert keyframe_gate_blocks(drive_mode="keyframe", shot=rendered) is None


def test_is_studio_file_url():
    assert is_studio_file_url("/api/studio/files/x.png")
    assert is_studio_file_url("https://host/api/studio/files/x.png")
    assert not is_studio_file_url("https://evil.example/x.png")
    assert not is_studio_file_url("")


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="kf-drive")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            email="kf@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        p = StudioProject(tenant_id=t.id, user_id=u.id, title="雨夜", preferred_drive_mode="keyframe")
        s.add(p)
        s.commit()
        s.refresh(p)
        shot = StudioShot(project_id=p.id, idx=0, scene="便利店", prompt="rain", status="draft")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        uid, pid, sid = u.id, p.id, shot.id
    with TestClient(app) as client:
        yield client, create_token(uid), engine, pid, sid
    app.dependency_overrides.clear()


def test_adopt_keyframe_and_patch_drive(ctx):
    client, token, engine, pid, sid = ctx
    h = {"Authorization": f"Bearer {token}"}
    bad = client.post(f"/api/studio/shots/{sid}/adopt-keyframe", headers=h, json={"url": "https://evil/x.png"})
    assert bad.status_code == 422
    ok = client.post(
        f"/api/studio/shots/{sid}/adopt-keyframe",
        headers=h,
        json={"url": "/api/studio/files/frame_var_demo.png"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["image_url"].endswith("frame_var_demo.png")
    patch = client.patch(
        f"/api/studio/projects/{pid}",
        headers=h,
        json={"preferred_drive_mode": "direct"},
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["preferred_drive_mode"] == "direct"


def test_render_blocked_without_keyframe(ctx, monkeypatch):
    client, token, engine, pid, sid = ctx
    h = {"Authorization": f"Bearer {token}"}
    # 确保项目为 keyframe
    client.patch(f"/api/studio/projects/{pid}", headers=h, json={"preferred_drive_mode": "keyframe"})
    r = client.post(f"/api/studio/shots/{sid}/render", headers=h, json={"wait": False, "num_candidates": 1})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, dict)
    assert detail["code"] == KEYFRAME_REQUIRED_CODE
    # force_direct 旁路：需 mock orchestrator 以免真跑
    from app.services.studio import orchestrator as orch

    async def fake_render(session, shot, **kw):
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render)
    r2 = client.post(
        f"/api/studio/shots/{sid}/render",
        headers=h,
        json={"wait": True, "num_candidates": 1, "force_direct": True},
    )
    assert r2.status_code == 200, r2.text
