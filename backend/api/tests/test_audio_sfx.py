"""S10(2026-10-11):音效素材库(sfx 501→ffmpeg lavfi 合成)+BGM 混音增益/ducking。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes.audio_orchestrate import _SFX_LIBRARY


def test_sfx_library_entries():
    assert {"rain", "wind", "thunder", "doorbell", "beep"} <= set(_SFX_LIBRARY)
    for name, e in _SFX_LIBRARY.items():
        assert "gen" in e and "desc" in e


def test_sfx_unknown_422(ctx_orch):
    client, h = ctx_orch
    r = client.post("/api/audio/orchestrate", headers=h, json={"steps": [{"type": "sfx", "effect": "不存在"}]})
    assert r.status_code == 422
    assert "未知音效" in r.text


def test_sfx_list_mode(ctx_orch):
    client, h = ctx_orch
    r = client.post("/api/audio/orchestrate", headers=h, json={"steps": [{"type": "sfx"}]})
    assert r.status_code == 200
    body = r.json()
    sfx_list = [a for a in body.get("artifacts", []) if a.get("type") == "sfx_list"]
    assert sfx_list and "rain" in sfx_list[0]["effects"]


@pytest.fixture
def ctx_orch():
    from sqlalchemy.pool import StaticPool
    from sqlmodel import Session, SQLModel, create_engine

    from app.db import get_session
    from app.models import Tenant, User
    from app.security import create_token, hash_password

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="sx"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="x@t.iv", hashed_password=hash_password("p"), tenant_id=t.id))
        s.commit()
    yield TestClient(app), {"Authorization": "Bearer " + create_token("u1")}
    app.dependency_overrides.clear()
