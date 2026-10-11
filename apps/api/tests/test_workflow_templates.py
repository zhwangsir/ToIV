"""W2.4(2026-10-11):工作流模板库——清单/激活切换/node_mapping 对真实图核验。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="wt"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="w@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.add(User(id="a1", email="a@d.iv", hashed_password=hash_password("x"), tenant_id=t.id, role="admin"))
        s.commit()
    yield TestClient(app), {"Authorization": "Bearer " + create_token("u1")}, {"Authorization": "Bearer " + create_token("a1")}
    app.dependency_overrides.clear()


def test_list_and_detail(ctx):
    client, h, _ = ctx
    r = client.get("/api/studio/workflow-templates", headers=h)
    assert r.status_code == 200
    items = r.json()
    ids = {t["id"] for t in items}
    assert {"h3_ref2va_single", "h3_ref2va_first_last", "h3_ref2va_kf3", "h3_fl2va_t2v"} <= ids
    # 默认激活语义
    single = next(t for t in items if t["id"] == "h3_ref2va_single")
    assert single["is_active"] is True
    r2 = client.get("/api/studio/workflow-templates/h3_fl2va_i2v", headers=h)
    assert r2.status_code == 200 and r2.json()["node_mapping"]["first_frame"] == "100"
    assert client.get("/api/studio/workflow-templates/nope", headers=h).status_code == 404


def test_activate_admin_only_and_singleton(ctx):
    client, h, ah = ctx
    # 非管理员 403
    assert client.put("/api/studio/workflow-templates/h3_ref2va_kf2/activate", headers=h).status_code in (403, 401)
    # 管理员切换 → 同 (engine,mode) 单激活
    r = client.put("/api/studio/workflow-templates/h3_ref2va_kf2/activate", headers=ah)
    assert r.status_code == 200 and r.json()["is_active"] is True
    # kf2 与 kf3 同 mode 族不同键——单激活只在同 (engine,mode) 内;跨 mode 互不影响
    items = client.get("/api/studio/workflow-templates", headers=h).json()
    kf2 = next(t for t in items if t["id"] == "h3_ref2va_kf2")
    kf3 = next(t for t in items if t["id"] == "h3_ref2va_kf3")
    assert kf2["is_active"] is True and kf3["is_active"] is True  # kf3 是自己 mode 的默认


def test_node_mapping_matches_real_graph():
    """契约核心断言:node_mapping 的注入点必须在真实构建图里存在(防漂移)。"""
    from app.workflows.h3_pipeline_c import H3PipelineCParams, build_h3_pipeline_c_graph
    from app.services.studio.workflow_templates import TEMPLATES

    g = build_h3_pipeline_c_graph(H3PipelineCParams(
        positive="p", images=("a.png", "b.png"),
    ))
    nm = TEMPLATES["h3_ref2va_single"]["node_mapping"]
    for key in ("prompt", "seed", "sampler", "save_prefix", "ref_image_1", "ref_image_2"):
        assert nm[key] in g, f"{nm[key]} 不在真实图(key={key})"
    # fl2va 模板图核验
    import json as _json
    from pathlib import Path as _P
    t2v = _json.loads((_P("app/workflows/h3/t2v_prompt.json")).read_text())["prompt"]
    nm2 = TEMPLATES["h3_fl2va_t2v"]["node_mapping"]
    for key in ("prompt", "seed", "unet", "save_prefix"):
        assert nm2[key] in t2v, f"{nm2[key]} 不在 t2v 图(key={key})"
