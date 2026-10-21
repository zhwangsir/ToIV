"""F3：北向 KPI 事件 + 汇总（诚实空→有）。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.product_kpi import empty_summary, summarize
from app.services import product_kpi as kpi


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
        u = User(email=f"kpi-{t.id[:8]}@toiv.ai", hashed_password=hash_password("password1"), tenant_id=t.id)
        s.add(u)
        s.commit()
        s.refresh(u)
        token = create_token(u.id)
        tenant_id, user_id = t.id, u.id
    client = TestClient(app)
    yield client, {"Authorization": f"Bearer {token}"}, tenant_id, user_id, engine
    app.dependency_overrides.clear()


def test_empty_summary_is_null_not_zero():
    s = empty_summary(30)
    assert s["metrics"]["first_episode_assemble_rate"] is None
    assert s["metrics"]["no_free_canvas_completion_rate"] is None
    assert s["metrics"]["consistency_rework_count"] is None
    assert s["metrics"]["local_queue_wait_p50_ms"] is None


def test_api_summary_empty_then_populated(ctx):
    client, h, tenant_id, user_id, engine = ctx
    r0 = client.get("/api/studio/kpi/summary?days=30", headers=h)
    assert r0.status_code == 200, r0.text
    m0 = r0.json()["metrics"]
    assert m0["first_episode_assemble_rate"] is None
    assert m0["local_queue_wait_p50_ms"] is None

    # 写事件
    assert client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "episode_assembled", "project_id": "p1", "payload": {"success": True, "surface": "drama_workspace"}},
    ).status_code == 200
    assert client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "episode_assembled", "project_id": "p2", "payload": {"success": False}},
    ).status_code == 200
    assert client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "path_touch", "project_id": "p1", "payload": {"surface": "drama_workspace"}},
    ).status_code == 200
    assert client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "path_touch", "project_id": "p2", "payload": {"surface": "free_canvas"}},
    ).status_code == 200
    # p2 失败合成不算成片项目；再给 p2 一次成功且触过画布
    assert client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "episode_assembled", "project_id": "p2", "payload": {"success": True}},
    ).status_code == 200
    assert client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "consistency_rework", "project_id": "p1", "payload": {"reason": "face"}},
    ).status_code == 200
    for ms in (100, 300, 500):
        assert client.post(
            "/api/studio/kpi/events",
            headers=h,
            json={"event_type": "queue_wait", "payload": {"wait_ms": ms}},
        ).status_code == 200

    r1 = client.get("/api/studio/kpi/summary?days=30", headers=h)
    assert r1.status_code == 200
    body = r1.json()
    # 3 attempts, 2 success → 2/3
    assert abs(body["metrics"]["first_episode_assemble_rate"] - (2 / 3)) < 1e-9
    # assembled projects p1,p2; p2 touched free_canvas → 1/2
    assert abs(body["metrics"]["no_free_canvas_completion_rate"] - 0.5) < 1e-9
    assert body["metrics"]["consistency_rework_count"] == 1
    assert body["metrics"]["local_queue_wait_p50_ms"] == 300.0

    bad = client.post(
        "/api/studio/kpi/events",
        headers=h,
        json={"event_type": "nope", "payload": {}},
    )
    assert bad.status_code == 422
