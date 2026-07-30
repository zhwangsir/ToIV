"""LTX-2.3 工作室 —— 白名单校验 / NSFW 门槛 / LoRA 图注入 测试。

覆盖:
  · GET /api/ltx2/models:白名单底模 available 标记 + loras/ltx2.3/ 目录枚举
  · POST /api/ltx2/t2v:unet 白名单 422 / LoRA 沙箱与上限 422
  · NSFW 门槛:10eros 无 X-NSFW 头 → 403;带头 → 200 且 Job.nsfw=True
  · SFW 底模无门槛 → 200 且 Job.nsfw=False
  · LoRA 注入:图含 LoraLoader 链、KSampler.model/CLIP.clip 接链末端、pool.pick required 含 LoRA
  · POST /api/ltx2/i2v:图片 worker 缺模型 → 503;齐全 → 200
  · 图构建器:loras 为空时图与旧版一致(向后兼容)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.ltx_studio as ltx_studio_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.lora import LoraSpec
from app.workflows.ltx_video import (
    LtxI2VParams,
    LtxT2VParams,
    build_ltx_i2v_graph,
    build_ltx_t2v_graph,
)

_GEMMA = "gemma3_12b_it_bf16/model.safetensors"
_VAE = "LTX23_video_vae_bf16.safetensors"


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


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
    """最小化 ComfyUIClient 替身:model_names 返回固定集合,queue_prompt 记录图。"""

    def __init__(self, models: set[str] | None = None) -> None:
        self.base_url = "http://fake-worker"
        self._models = set(models or set())
        self.graphs: list[dict] = []

    async def model_names(self) -> set[str]:
        return set(self._models)

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-ltx2-1"


class _FakePool:
    def __init__(self, client: _FakeClient) -> None:
        self._client = client
        self.last_required: set[str] = set()
        self.last_required_nodes: set[str] = set()

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        self.last_required = set(required)
        self.last_required_nodes = set(required_nodes)
        return self._client


def _install_pool(pool: _FakePool) -> None:
    app.dependency_overrides[get_pool] = lambda: pool


def _ltx_models(*extra: str) -> set[str]:
    """一套完整的 LTX 依赖模型集合(供 fake worker 持有)。"""
    return {"ltx-2.3-distilled.safetensors", _GEMMA, _VAE, *extra}


# --------------------------------------------------------------------------- #
# GET /api/ltx2/models
# --------------------------------------------------------------------------- #


def test_models_endpoint_marks_availability(client):
    """白名单底模按 worker 持有标 available;10eros 标 nsfw;ltx2.3/ LoRA 被枚举。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2models")
    fake = _FakeClient(
        {
            "ltx-2.3-distilled.safetensors",
            "ltx2.3/camera_pan.safetensors",
            "ltx2.3/style_glow.safetensors",
            "other_dir/not_listed.safetensors",
        }
    )
    _install_pool(_FakePool(fake))
    r = c.get("/api/ltx2/models", headers={"Authorization": f"Bearer {create_token(uid)}"})
    assert r.status_code == 200, r.text
    body = r.json()

    unets = {u["name"]: u for u in body["unets"]}
    assert set(unets) == {
        "ltx-2.3-distilled.safetensors",
        "ltx-2.3-22b-distilled-1.1.safetensors",
        "ltx-2.3-22b-dev.safetensors",
        "10eros_v14.safetensors",
    }
    assert unets["ltx-2.3-distilled.safetensors"]["available"] is True
    assert unets["ltx-2.3-distilled.safetensors"]["nsfw"] is False
    assert unets["10eros_v14.safetensors"]["available"] is False
    assert unets["10eros_v14.safetensors"]["nsfw"] is True

    # 仅 loras/ltx2.3/ 目录,其它目录不混入
    assert body["loras"] == [
        {"name": "ltx2.3/camera_pan.safetensors", "available": True},
        {"name": "ltx2.3/style_glow.safetensors", "available": True},
    ]


def test_models_endpoint_requires_auth(client):
    c, _ = client
    assert c.get("/api/ltx2/models").status_code == 401


# --------------------------------------------------------------------------- #
# 白名单 / LoRA 校验
# --------------------------------------------------------------------------- #


def test_t2v_rejects_unknown_unet(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2badunet")
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "unet_name": "evil_ckpt.safetensors"},
    )
    assert r.status_code == 422


def test_t2v_rejects_over_three_loras(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2manylora")
    loras = [{"name": f"ltx2.3/l{i}.safetensors"} for i in range(4)]
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "loras": loras},
    )
    assert r.status_code == 422


@pytest.mark.parametrize(
    "bad_name",
    ["../secret.safetensors", "ltx2.3/../../etc.safetensors", "other/x.safetensors", "x.safetensors"],
)
def test_t2v_rejects_lora_outside_sandbox(client, bad_name):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"ltx2sandbox-{abs(hash(bad_name))}")
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "loras": [{"name": bad_name}]},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# NSFW 门槛:10eros 需 X-NSFW 头,其余底模无门槛
# --------------------------------------------------------------------------- #


def test_t2v_10eros_gated_without_nsfw_header(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2gate")
    _install_pool(_FakePool(_FakeClient(_ltx_models("10eros_v14.safetensors"))))
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "unet_name": "10eros_v14.safetensors"},
    )
    assert r.status_code == 403


def test_t2v_10eros_allowed_with_header_and_tagged(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2nsfwok")
    _install_pool(_FakePool(_FakeClient(_ltx_models("10eros_v14.safetensors"))))
    monkeypatch.setattr(ltx_studio_route, "spawn_tracker", lambda client, prompt_id: None)
    token = create_token(uid)
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
        json={"positive": "a cat", "unet_name": "10eros_v14.safetensors"},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.nsfw is True
        assert job.kind == "ltx2_t2v"


def test_t2v_sfw_unet_no_gate_and_not_tagged(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2sfw")
    _install_pool(_FakePool(_FakeClient(_ltx_models())))
    monkeypatch.setattr(ltx_studio_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "prompt-ltx2-1"
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.nsfw is False
        assert job.kind == "ltx2_t2v"


# --------------------------------------------------------------------------- #
# LoRA 注入:图结构 + pool.pick 模型要求
# --------------------------------------------------------------------------- #


def test_t2v_loras_injected_into_graph(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2lorainj")
    fake = _FakeClient(_ltx_models("ltx2.3/cam.safetensors", "ltx2.3/style.safetensors"))
    pool = _FakePool(fake)
    _install_pool(pool)
    monkeypatch.setattr(ltx_studio_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/ltx2/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a cat",
            "loras": [
                {"name": "ltx2.3/cam.safetensors", "strength": 0.8},
                {"name": "ltx2.3/style.safetensors"},  # 默认强度 1.0
            ],
        },
    )
    assert r.status_code == 200, r.text

    # 图:LoraLoader 链 100→101,KSampler.model / CLIP.clip 接链末端
    graph = fake.graphs[0]
    assert graph["100"]["class_type"] == "LoraLoader"
    assert graph["100"]["inputs"]["model"] == ["1", 0]
    assert graph["100"]["inputs"]["clip"] == ["2", 0]
    assert graph["100"]["inputs"]["lora_name"] == "ltx2.3/cam.safetensors"
    assert graph["100"]["inputs"]["strength_model"] == 0.8
    assert graph["101"]["inputs"]["model"] == ["100", 0]
    assert graph["101"]["inputs"]["clip"] == ["100", 1]
    assert graph["101"]["inputs"]["strength_model"] == 1.0
    assert graph["12"]["inputs"]["model"] == ["101", 0]
    assert graph["7"]["inputs"]["clip"] == ["101", 1]
    assert graph["8"]["inputs"]["clip"] == ["101", 1]

    # pool.pick required 含 unet + gemma + vae + 各 LoRA;required_nodes 含 LoraLoader
    assert pool.last_required == {
        "ltx-2.3-distilled.safetensors",
        _GEMMA,
        _VAE,
        "ltx2.3/cam.safetensors",
        "ltx2.3/style.safetensors",
    }
    assert "LoraLoader" in pool.last_required_nodes


# --------------------------------------------------------------------------- #
# i2v:worker 模型校验
# --------------------------------------------------------------------------- #


def test_i2v_missing_model_on_image_worker_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2i2vmiss")
    # 图片 worker 缺所选 LoRA → 503(而非 ComfyUI 执行期 400)
    fake = _FakeClient(_ltx_models())
    monkeypatch.setattr(ltx_studio_route, "resolve_worker", lambda worker: fake)
    r = c.post(
        "/api/ltx2/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a cat",
            "image": "in.png",
            "worker": "http://fake-worker",
            "loras": [{"name": "ltx2.3/cam.safetensors"}],
        },
    )
    assert r.status_code == 503
    assert "ltx2.3/cam.safetensors" in r.json()["detail"]


def test_i2v_ok_uses_image_worker(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx2i2vok")
    fake = _FakeClient(_ltx_models("ltx2.3/cam.safetensors"))
    monkeypatch.setattr(ltx_studio_route, "resolve_worker", lambda worker: fake)
    monkeypatch.setattr(ltx_studio_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/ltx2/i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a cat",
            "image": "in.png",
            "worker": "http://fake-worker",
            "loras": [{"name": "ltx2.3/cam.safetensors"}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["worker"] == "http://fake-worker"
    graph = fake.graphs[0]
    assert graph["9"]["class_type"] == "LoadImage"
    assert graph["9"]["inputs"]["image"] == "in.png"
    assert graph["12"]["inputs"]["model"] == ["100", 0]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "ltx2_i2v" and job.nsfw is False


# --------------------------------------------------------------------------- #
# 图构建器:向后兼容(空 loras 图不变)+ LoRA 链结构
# --------------------------------------------------------------------------- #


def test_builder_no_loras_keeps_legacy_graph():
    """空 loras:KSampler.model 直引 UNET、CLIP 直引 Gemma,无 LoraLoader 节点。"""
    g = build_ltx_t2v_graph(LtxT2VParams(positive="a cat"))
    assert g["12"]["inputs"]["model"] == ["1", 0]
    assert g["7"]["inputs"]["clip"] == ["2", 0]
    assert g["8"]["inputs"]["clip"] == ["2", 0]
    assert not any(n["class_type"] == "LoraLoader" for n in g.values())


def test_builder_lora_chain_structure():
    loras = (LoraSpec("ltx2.3/a.safetensors", 0.5), LoraSpec("ltx2.3/b.safetensors", 1.5))
    g = build_ltx_t2v_graph(LtxT2VParams(positive="a cat", loras=loras))
    assert g["100"] == {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["2", 0],
            "lora_name": "ltx2.3/a.safetensors",
            "strength_model": 0.5,
            "strength_clip": 0.5,
        },
    }
    assert g["101"]["inputs"]["model"] == ["100", 0]
    assert g["12"]["inputs"]["model"] == ["101", 0]
    assert g["7"]["inputs"]["clip"] == ["101", 1]


def test_builder_i2v_lora_chain():
    g = build_ltx_i2v_graph(
        LtxI2VParams(positive="a cat", image="x.png", loras=(LoraSpec("ltx2.3/a.safetensors"),))
    )
    assert g["100"]["inputs"]["model"] == ["1", 0]
    assert g["12"]["inputs"]["model"] == ["100", 0]
    assert g["9"]["class_type"] == "LoadImage"
