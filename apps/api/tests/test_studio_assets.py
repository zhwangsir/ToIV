"""S6(2026-10-11):资产下沉——共享资产库只读+选用为项目角色(同名去重)。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import DramaAsset, StudioCharacter, StudioProject, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    ids = {}
    with Session(engine) as s:
        t = Tenant(name="sa"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="s@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.commit()
        p = StudioProject(tenant_id=t.id, user_id="u1", title="sa"); s.add(p); s.commit(); s.refresh(p)
        ids["pid"] = str(p.id)
        a = DramaAsset(tenant_id=t.id, user_id="u1", kind="character", name="林夏",
                       description="雨夜少女", visual_prompt="lin xia", ref_image="/r/f.png")
        s.add(a); s.commit(); s.refresh(a)
        ids["aid"] = str(a.id)
        s.add(DramaAsset(tenant_id=t.id, user_id="u1", kind="scene", name="便利店"))
        s.commit()
    yield TestClient(app), ids, {"Authorization": "Bearer " + create_token("u1")}
    app.dependency_overrides.clear()


def test_list_and_filter(ctx):
    client, ids, h = ctx
    r = client.get("/api/studio/assets", headers=h)
    assert r.status_code == 200 and len(r.json()) == 2
    r2 = client.get("/api/studio/assets?kind=character", headers=h)
    assert [x["name"] for x in r2.json()] == ["林夏"]


def test_apply_creates_character_with_refs(ctx):
    client, ids, h = ctx
    r = client.post(f"/api/studio/assets/{ids['aid']}/apply-to-project/{ids['pid']}", headers=h)
    assert r.status_code == 200
    c = r.json()
    assert c["name"] == "林夏" and c["visual_prompt"] == "lin xia"
    assert c["reference_images"] == ["/r/f.png"]


def test_apply_dedup_and_kind_guard(ctx):
    client, ids, h = ctx
    r1 = client.post(f"/api/studio/assets/{ids['aid']}/apply-to-project/{ids['pid']}", headers=h)
    r2 = client.post(f"/api/studio/assets/{ids['aid']}/apply-to-project/{ids['pid']}", headers=h)
    assert r1.json()["id"] == r2.json()["id"]  # 同名去重返回既有
    # scene 类 422
    with Session(create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)):
        pass
    scene_id = None
    from sqlmodel import select as _sel
    engine2 = None
    # 用 API 拿 scene 资产 id
    scene_id = next(x["id"] for x in client.get("/api/studio/assets?kind=scene", headers=h).json())
    r3 = client.post(f"/api/studio/assets/{scene_id}/apply-to-project/{ids['pid']}", headers=h)
    assert r3.status_code == 422
