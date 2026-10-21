"""F3：声床纯函数 + 项目字段 patch 白名单。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, Tenant, User
from app.security import create_token, hash_password
from app.services.studio.bgm_bed import (
    DEFAULT_BGM_VOLUME,
    bgm_active,
    is_allowed_bgm_url,
    normalize_bgm_duck,
    normalize_bgm_url,
    normalize_bgm_volume,
    to_relative_bgm_url,
)


def test_normalize_volume_and_duck():
    assert normalize_bgm_volume(None) == DEFAULT_BGM_VOLUME
    assert normalize_bgm_volume(2) == 1.0
    assert normalize_bgm_volume(-1) == 0.0
    assert normalize_bgm_volume(0.5) == 0.5
    assert normalize_bgm_duck(None) is True
    assert normalize_bgm_duck("off") is False
    assert normalize_bgm_duck(True) is True


def test_bgm_url_allowlist():
    assert is_allowed_bgm_url("")
    assert is_allowed_bgm_url("/api/studio/files/bgm-abc.mp3")
    assert not is_allowed_bgm_url("https://evil.example/x.mp3")
    assert not is_allowed_bgm_url("ftp://x")
    assert to_relative_bgm_url("http://127.0.0.1:8000/api/studio/files/a.mp3") == "/api/studio/files/a.mp3"
    assert bgm_active("/api/studio/files/a.mp3")
    assert not bgm_active("  ")


@pytest.fixture()
def ctx():
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
    with Session(engine) as s:
        t = Tenant(name="t")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            email=f"f3-{t.id[:8]}@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        token = create_token(u.id)
        p = StudioProject(tenant_id=t.id, user_id=u.id, title="雨夜")
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id
    client = TestClient(app)
    yield client, {"Authorization": f"Bearer {token}"}, pid
    app.dependency_overrides.clear()


def test_patch_bgm_and_reject_external(ctx):
    client, h, pid = ctx
    r = client.patch(
        f"/api/studio/projects/{pid}",
        headers=h,
        json={"bgm_url": "/api/studio/files/bed.mp3", "bgm_volume": 0.2, "bgm_duck": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bgm_url"] == "/api/studio/files/bed.mp3"
    assert body["bgm_volume"] == 0.2
    assert body["bgm_duck"] is False

    bad = client.patch(
        f"/api/studio/projects/{pid}",
        headers=h,
        json={"bgm_url": "https://evil.example/a.mp3"},
    )
    assert bad.status_code == 422
