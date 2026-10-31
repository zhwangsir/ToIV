"""画板(/api/boards)——手动主题板 CRUD/成员整组替换/归属隔离/封面回填。"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        u1 = User(email="b1@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        u2 = User(email="b2@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id)
        s.add(u1); s.add(u2)
        s.commit()
        s.refresh(u1); s.refresh(u2)
        for uid, n in ((u1.id, 3), (u2.id, 1)):
            for i in range(n):
                s.add(Job(id=uuid.uuid4().hex, prompt_id=uuid.uuid4().hex,
                          tenant_id=tenant.id, user_id=uid, worker="w", kind="txt2img",
                          status="done", prompt=f"p{i}", seed=1,
                          result='["/api/images?filename=a.png&worker=w"]'))
        s.commit()
        t1 = create_token(u1.id)
        t2 = create_token(u2.id)
    client = TestClient(app)
    yield client, t1, t2, engine
    app.dependency_overrides.pop(get_session, None)


def _u1_jobs(ctx) -> list[str]:
    _, _, _, engine = ctx
    with Session(engine) as s:
        from sqlmodel import select
        from app.models import User
        u = s.exec(select(User).where(User.email == "b1@t.io")).first()
        return [j.id for j in s.exec(select(Job).where(Job.user_id == u.id)).all()]


def test_board_crud_and_items(ctx):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    r = c.post("/api/boards", json={"name": "电商套图"}, headers=H)
    assert r.status_code == 200, r.text
    bid = r.json()["id"]
    assert r.json()["item_count"] == 0

    ids = _u1_jobs(ctx)
    r = c.put(f"/api/boards/{bid}/items", json={"items": [{"job_id": ids[0]}, {"job_id": ids[1]}]}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["item_count"] == 2

    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    assert len(items) == 2
    assert items[0]["job"]["id"] == ids[0]  # sort_order 保持写入序
    assert "prompt" in items[0]["job"]

    # 整组替换:去掉第一个 → 只留一个
    r = c.put(f"/api/boards/{bid}/items", json={"items": [{"job_id": ids[1]}]}, headers=H)
    assert r.json()["item_count"] == 1

    # 越权作业 → 422
    r = c.put(f"/api/boards/{bid}/items", json={"items": [{"job_id": "not-mine"}]}, headers=H)
    assert r.status_code == 422

    # 板列表:成员数与封面回填
    boards = c.get("/api/boards", headers=H).json()
    assert boards[0]["item_count"] == 1
    assert boards[0]["cover_url"].startswith("/api/images?")

    # 改名 + 删板
    r = c.patch(f"/api/boards/{bid}", json={"name": "改名板"}, headers=H)
    assert r.json()["name"] == "改名板"
    r = c.delete(f"/api/boards/{bid}", headers=H)
    assert r.json()["deleted"] is True
    assert c.get("/api/boards", headers=H).json() == []


def test_board_ownership_isolated(ctx):
    c, t1, t2, _ = ctx
    H1, H2 = ({"Authorization": f"Bearer {t1}"}, {"Authorization": f"Bearer {t2}"})
    bid = c.post("/api/boards", json={"name": "mine"}, headers=H1).json()["id"]
    # u2 看不到/动不到 u1 的板
    assert c.get("/api/boards", headers=H2).json() == []
    assert c.get(f"/api/boards/{bid}/items", headers=H2).status_code == 404
    assert c.delete(f"/api/boards/{bid}", headers=H2).status_code == 404
