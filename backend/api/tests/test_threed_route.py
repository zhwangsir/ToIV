"""POST /api/generate/3d(Hunyuan3D 图生3D)端点回归测试。

覆盖:
  · 认证缺失 401
  · 正常提交 → 200 + Job 落库(kind=hunyuan3d, status=queued)
  · spawn_tracker 必须被调用(2026-08 修复前漏挂,作业永远停 queued)
  · capabilities:hunyuan3d kind 的模型/节点要求(上传路由选 worker 依据)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.threed as threed_route
from app.capabilities import required_models, required_nodes
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def client(engine):
    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), engine
    app.dependency_overrides.clear()


class _FakeClient:
    """最小化 ComfyUIClient 替身:queue_prompt 记录图并返回固定 prompt_id。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-3d-1"


def test_threed_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/3d",
        json={"image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 401


def test_threed_ok_creates_job_and_spawns_tracker(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-3d")
    fake = _FakeClient()
    monkeypatch.setattr(threed_route, "resolve_worker", lambda worker: fake)
    spawned: list[tuple[object, str]] = []
    monkeypatch.setattr(
        threed_route, "spawn_tracker", lambda client_, prompt_id: spawned.append((client_, prompt_id))
    )
    r = c.post(
        "/api/generate/3d",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "image": "in.png",
            "worker": "http://fake-worker",
            "steps": 40,
            "octree_resolution": 384,
            "seed": 7,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-3d-1"
    assert body["seed"] == 7

    # tracker 必须挂上,否则作业永远停 queued(回归点)
    assert spawned == [(fake, "prompt-3d-1")]

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
    assert job is not None
    assert job.kind == "hunyuan3d"
    assert job.status == "queued"
    assert job.worker == "http://fake-worker"
    assert job.seed == 7

    # 图结构:步数/octree 透传到采样与网格化节点
    graph = fake.graphs[0]
    assert graph["6"]["inputs"]["steps"] == 40
    assert graph["7"]["inputs"]["octree_resolution"] == 384


def test_threed_param_validation_422(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-3d-422")
    headers = {"Authorization": f"Bearer {create_token(uid)}"}
    base = {"image": "in.png", "worker": "http://fake-worker"}
    assert c.post("/api/generate/3d", headers=headers, json={**base, "steps": 5}).status_code == 422
    assert (
        c.post("/api/generate/3d", headers=headers, json={**base, "octree_resolution": 32}).status_code == 422
    )


def test_capabilities_hunyuan3d_kind():
    models = required_models("hunyuan3d")
    assert models == {"hunyuan3d-dit-v2-0-fp16.safetensors"}
    assert models == required_models("threed")
    nodes = required_nodes("hunyuan3d")
    assert {"Hunyuan3Dv2Conditioning", "VAEDecodeHunyuan3D", "VoxelToMeshBasic", "SaveGLB"} <= nodes
    assert nodes == required_nodes("threed")
