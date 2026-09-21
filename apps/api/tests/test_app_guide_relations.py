"""说明书知识图谱(P2)——确定性关系计算/回填/关联端点。"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import App, AppGuide, Tenant, User
from app.security import create_token, hash_password
from app.services.app_guide_relations import backfill_relations, compute_relations


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
        admin = User(email="gadm@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id, role="admin")
        plain = User(email="gusr@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id, role="user")
        s.add(admin); s.add(plain)
        s.commit()
        s.refresh(admin); s.refresh(plain)
        wf_a = json.dumps({
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "a.safetensors"}},
            "2": {"class_type": "KSampler", "inputs": {}},
        })
        wf_b = json.dumps({
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "a.safetensors"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
        })
        wf_c = json.dumps({
            "1": {"class_type": "WanVideoModelLoader", "inputs": {"model": "w.safetensors"}},
        })
        apps = [
            App(id="rh-h3-app1-aaaa", tenant_id=tenant.id, user_id="", name="A1", is_public=True,
                use_case="art", output_kind="image", workflow_json=wf_a),
            App(id="rh-h3-app2-bbbb", tenant_id=tenant.id, user_id="", name="A2 高相似", is_public=True,
                use_case="art", output_kind="image", workflow_json=wf_b, cover_url="/api/images?filename=c.png&worker=w"),
            App(id="rh-h3-app3-cccc", tenant_id=tenant.id, user_id="", name="A3 同用例无模型", is_public=True,
                use_case="art", output_kind="image", workflow_json="{}"),
            App(id="rh-wan-app4-dddd", tenant_id=tenant.id, user_id="", name="A4 视频", is_public=True,
                use_case="drama", output_kind="video", workflow_json=wf_c),
        ]
        for a in apps:
            s.add(a)
        s.add(AppGuide(app_id="rh-h3-app1-aaaa", purpose="p", status="published",
                       steps=[], inputs=[], outputs=[], tips=[], related_app_ids=[]))
        s.add(AppGuide(app_id="rh-h3-app2-bbbb", purpose="p2", status="published",
                       steps=[], inputs=[], outputs=[], tips=[], related_app_ids=["preset-keep"])),
        s.commit()
        t_admin = create_token(admin.id)
        t_plain = create_token(plain.id)
    client = TestClient(app)
    yield client, t_admin, t_plain, engine
    app.dependency_overrides.pop(get_session, None)


def test_compute_relations_scoring(ctx):
    _, _, _, engine = ctx
    with Session(engine) as s:
        apps = s.exec(select(App).where(App.is_public == True)).all()
        a1 = next(a for a in apps if a.id == "rh-h3-app1-aaaa")
    rel = compute_relations(a1, apps)
    # A2:同 use_case(3)+同模型 a.safetensors(2)+同 output_kind(1)+同家族 rh-h3(1)=7 居首
    assert rel[0] == "rh-h3-app2-bbbb"
    # A3:同 use_case+同 kind+同家族=5 第二;A4=0 出局
    assert rel[1] == "rh-h3-app3-cccc"
    assert "rh-wan-app4-dddd" not in rel
    assert "rh-h3-app1-aaaa" not in rel


def test_backfill_only_empty(ctx):
    _, _, _, engine = ctx
    with Session(engine) as s:
        out = backfill_relations(s, only_empty=True)
        assert out["done"] == 1 and out["skipped"] == 1  # app1 回填;app2 已有值跳过
        g1 = s.get(AppGuide, "rh-h3-app1-aaaa")
        g2 = s.get(AppGuide, "rh-h3-app2-bbbb")
    assert g1.related_app_ids[0] == "rh-h3-app2-bbbb"
    assert g2.related_app_ids == ["preset-keep"]


def test_relations_endpoint(ctx):
    c, t_admin, t_plain, _ = ctx
    H = {"Authorization": f"Bearer {t_plain}"}
    # 先回填
    r = c.post("/api/admin/app-guides/relations/backfill",
               headers={"Authorization": f"Bearer {t_admin}"})
    assert r.status_code == 200 and r.json()["done"] == 1
    # 非 admin 打回填 → 403
    assert c.post("/api/admin/app-guides/relations/backfill", headers=H).status_code == 403

    rs = c.get("/api/apps/rh-h3-app1-aaaa/relations", headers=H).json()
    assert rs and rs[0]["id"] == "rh-h3-app2-bbbb"
    assert rs[0]["name"] == "A2 高相似"
    assert rs[0]["cover_url"].startswith("/api/images")
    assert rs[0]["use_case"] == "art"
    # 无说明书/无回填 → 空数组;不存在 → 404
    assert c.get("/api/apps/rh-wan-app4-dddd/relations", headers=H).json() == []
    assert c.get("/api/apps/nope/relations", headers=H).status_code == 404
