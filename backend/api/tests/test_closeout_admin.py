"""Admin wave6: closeout-summary + bulk-public."""
from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine
from fastapi.testclient import TestClient

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, Tenant, User
from app.security import create_token, hash_password


class _FakePool:
    def stats(self):
        return []

    async def sum_queue_depth(self, force: bool = False) -> int:
        return 0


def _client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _sess():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _sess
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    with Session(engine) as s:
        t = Tenant(id="t1", name="t")
        s.add(t)
        admin = User(
            email="admin-closeout@test",
            hashed_password=hash_password("x"),
            tenant_id="t1",
            role="admin",
        )
        s.add(admin)
        for spec in (
            ("app-pass", True, "pass"),
            ("app-fail", True, "fail"),
            ("app-hidden", False, ""),
        ):
            aid, pub, smoke = spec
            s.add(
                App(
                    id=aid,
                    name=aid,
                    is_builtin=True,
                    is_public=pub,
                    smoke_status=smoke,
                    workflow_json={},
                    params_schema=[],
                    bindings={},
                )
            )
        s.commit()
        token = create_token(admin.id)
    client = TestClient(app)
    return client, token


def test_closeout_summary_and_bulk_public():
    client, token = _client()
    h = {"Authorization": f"Bearer {token}"}
    try:
        r = client.get("/api/admin/closeout-summary", headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["public_total"] == 2
        assert body["soft_hidden_builtin"] == 1
        assert body["smoke"]["pass"] == 1
        assert body["smoke"]["fail"] == 1
        assert "cover_gate" in body
        assert "autorefire_enabled" in body["cover_gate"]

        r2 = client.post(
            "/api/admin/apps/bulk-public",
            headers=h,
            json={"ids": ["app-pass", "missing-x"], "is_public": False},
        )
        assert r2.status_code == 200, r2.text
        out = r2.json()
        assert out["done"] == 1
        assert out["missing"] == 1
        assert out["is_public"] is False

        r3 = client.get("/api/admin/closeout-summary", headers=h)
        assert r3.json()["public_total"] == 1
        assert r3.json()["soft_hidden_builtin"] == 2
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_pool, None)
