"""漫剧工作台 P1 数据底座 CRUD 测试:项目 / 资产 / 镜头 + 鉴权。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="m")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="m@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_project_crud_flow(ctx):
    client, token = ctx
    H = _h(token)
    # 创建
    r = client.post("/api/manju/projects", headers=H, json={"title": "前列仙", "premise": "修仙", "ckpt_name": "noobaiXL_vpred10.safetensors"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    # 列表
    assert len(client.get("/api/manju/projects", headers=H).json()) == 1
    # 改
    r = client.patch(f"/api/manju/projects/{pid}", headers=H, json={"style": "anime web-comic"})
    assert r.json()["style"] == "anime web-comic"
    # 取详情(含空 assets/shots)
    detail = client.get(f"/api/manju/projects/{pid}", headers=H).json()
    assert detail["title"] == "前列仙" and detail["assets"] == [] and detail["shots"] == []


def test_asset_reusable_library(ctx):
    client, token = ctx
    H = _h(token)
    pid = client.post("/api/manju/projects", headers=H, json={"title": "x"}).json()["id"]
    r = client.post(
        f"/api/manju/projects/{pid}/assets",
        headers=H,
        json={"kind": "character", "name": "楚生", "description": "1boy, short black hair", "ref_image": "/api/images?x"},
    )
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    assert r.json()["kind"] == "character"
    # 改资产(改一处)
    client.patch(f"/api/manju/assets/{aid}", headers=H, json={"description": "1boy, red hair"})
    detail = client.get(f"/api/manju/projects/{pid}", headers=H).json()
    assert detail["assets"][0]["description"] == "1boy, red hair"
    # 删资产
    assert client.delete(f"/api/manju/assets/{aid}", headers=H).status_code == 200
    assert client.get(f"/api/manju/projects/{pid}", headers=H).json()["assets"] == []


def test_shots_save_and_track(ctx):
    client, token = ctx
    H = _h(token)
    pid = client.post("/api/manju/projects", headers=H, json={"title": "x"}).json()["id"]
    # 批量保存分镜
    r = client.put(
        f"/api/manju/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "开场", "prompt": "1boy, alley", "characters": ["楚生"]},
            {"scene": "打斗", "prompt": "1boy, punching"},
        ]},
    )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 2 and shots[0]["idx"] == 0 and shots[0]["characters"] == ["楚生"]
    # 单镜回写作业 id + 状态(可追踪)
    sid = shots[0]["id"]
    r = client.patch(f"/api/manju/shots/{sid}", headers=H, json={"image_job_id": "job123", "status": "image_done"})
    assert r.json()["image_job_id"] == "job123" and r.json()["status"] == "image_done"
    # 再次保存覆盖(替换)
    r = client.put(f"/api/manju/projects/{pid}/shots", headers=H, json={"shots": [{"scene": "新", "prompt": "1girl"}]})
    assert len(r.json()["shots"]) == 1


def test_ownership_and_delete(ctx):
    client, token = ctx
    H = _h(token)
    pid = client.post("/api/manju/projects", headers=H, json={"title": "x"}).json()["id"]
    # 别人的 token 拿不到(无 token → 401)
    assert client.get(f"/api/manju/projects/{pid}").status_code == 401
    # 不存在 → 404
    assert client.get("/api/manju/projects/nope", headers=H).status_code == 404
    # 删项目(连带 assets/shots)
    client.post(f"/api/manju/projects/{pid}/assets", headers=H, json={"name": "a"})
    assert client.delete(f"/api/manju/projects/{pid}", headers=H).status_code == 200
    assert client.get(f"/api/manju/projects/{pid}", headers=H).status_code == 404
