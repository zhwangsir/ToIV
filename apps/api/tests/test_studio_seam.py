"""S4(2026-10-11):seam 衔接策略下沉 Studio 域——PUT shots 写入/透出/幂等迁移。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioCharacter, StudioProject, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    pid = ""
    with Session(engine) as s:
        t = Tenant(name="seam"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="s@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.commit()
        p = StudioProject(tenant_id=t.id, user_id="u1", title="seam"); s.add(p); s.commit(); s.refresh(p)
        pid = str(p.id)
    yield TestClient(app), pid, {"Authorization": "Bearer " + create_token("u1")}
    app.dependency_overrides.clear()


def test_seam_roundtrip(ctx):
    client, pid, h = ctx
    r = client.put(f"/api/studio/projects/{pid}/shots", headers=h, json={"shots": [
        {"scene": "镜一", "seam_to_next": "continue"},
        {"scene": "镜二", "seam_to_next": "matchcut", "seam_anchor": "刀刃反光"},
    ]})
    assert r.status_code == 200
    shots = r.json()["shots"]
    assert shots[0]["seam_to_next"] == "continue"
    assert shots[1]["seam_to_next"] == "matchcut"
    assert shots[1]["seam_anchor"] == "刀刃反光"

    # 更新:None=不改,空串=清空
    sid1 = shots[0]["id"]; sid2 = shots[1]["id"]
    r2 = client.put(f"/api/studio/projects/{pid}/shots", headers=h, json={"shots": [
        {"id": sid1, "scene": "镜一改", "seam_to_next": "overlap"},
        {"id": sid2, "scene": "镜二改", "seam_anchor": ""},
    ]})
    assert r2.status_code == 200
    s2 = r2.json()["shots"]
    assert s2[0]["seam_to_next"] == "overlap"
    assert s2[1]["seam_to_next"] == "matchcut"  # None 未传 → 保留
    assert s2[1]["seam_anchor"] == ""            # 空串 → 清空
