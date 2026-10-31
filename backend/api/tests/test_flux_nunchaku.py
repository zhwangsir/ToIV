"""Phase 4D:Nunchaku SVDQuant fp4 FLUX.1-dev 引擎(flux1-nunchaku)。

builder 图结构断言(节点/文件名/采样档/边连接)+ 路由端点级测试
(认证 401 / 限流 429 / 参数 422 / 建档与 pool.pick 双约束)。
节点 schema 依 pc01 :8188 /object_info 2026-08-28 实测(见 workflows 头注)。

路由尚未挂进 main.py(主控统一收口),本测试模块自行挂载后测端点。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.flux_nunchaku as flux_nunchaku_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Job, Tenant, User
from app.ratelimit import _MAX_PER_WINDOW, enforce_generation_rate_limit
from app.security import create_token, hash_password
from app.workflows.flux_nunchaku import (
    NUNCHAKU_CLIP_L,
    NUNCHAKU_DIT,
    NUNCHAKU_REQUIRED_NODES,
    NUNCHAKU_T5,
    NUNCHAKU_VAE,
    FluxNunchakuParams,
    build_flux_nunchaku_graph,
    required_models,
)

# main.py 统一收口前的测试挂载(幂等:模块只 import 一次)
app.include_router(flux_nunchaku_route.router, prefix="/api")


def _by_type(graph: dict, ctype: str) -> dict:
    for node in graph.values():
        if node["class_type"] == ctype:
            return node["inputs"]
    raise KeyError(ctype)


# --------------------------------------------------------------------------- #
# builder 图结构
# --------------------------------------------------------------------------- #


def test_graph_loaders_and_filenames():
    g = build_flux_nunchaku_graph(FluxNunchakuParams(positive="a fox", seed=42))
    assert len(g) == 10
    dit = _by_type(g, "NunchakuFluxDiTLoader")
    assert dit["model_path"] == NUNCHAKU_DIT == "svdq-fp4_r32-flux.1-dev.safetensors"
    # 插件字段名以 object_info 实测为准(勿凭直觉改名)
    assert dit["attention"] == "nunchaku-fp16"
    assert dit["cpu_offload"] == "auto"
    assert dit["device_id"] == 0
    assert dit["data_type"] == "bfloat16"
    assert dit["cache_threshold"] == 0.0  # 默认关缓存,质量优先
    te = _by_type(g, "NunchakuTextEncoderLoaderV2")
    assert te["model_type"] == "flux.1"
    assert te["text_encoder1"] == NUNCHAKU_T5 == "t5xxl_fp8_e4m3fn.safetensors"
    assert te["text_encoder2"] == NUNCHAKU_CLIP_L == "clip_l.safetensors"
    assert te["t5_min_length"] == 512
    vae = _by_type(g, "VAELoader")
    assert vae["vae_name"] == NUNCHAKU_VAE == "ae.safetensors"


def test_sampler_config_flux_dev():
    """FLUX.1-dev 采样档:真实 cfg=1.0 + FluxGuidance 3.5 + euler/simple + 负向空。"""
    g = build_flux_nunchaku_graph(
        FluxNunchakuParams(positive="a fox", seed=42, steps=20, guidance=3.5)
    )
    ks = _by_type(g, "KSampler")
    assert ks["cfg"] == 1.0  # 引导强度全走 FluxGuidance,cfg 恒 1
    assert ks["steps"] == 20
    assert ks["sampler_name"] == "euler"
    assert ks["scheduler"] == "simple"
    assert ks["denoise"] == 1.0
    assert ks["seed"] == 42
    fg = _by_type(g, "FluxGuidance")
    assert fg["guidance"] == 3.5
    # 负向节点存在但为空(cfg=1 下失效,与官方示例一致)
    encs = [n["inputs"] for n in g.values() if n["class_type"] == "CLIPTextEncode"]
    assert len(encs) == 2
    assert any(e["text"] == "a fox" for e in encs)
    assert any(e["text"] == "" for e in encs)


def test_graph_edges():
    """边连接:DiT→KSampler;TE→两个 Encode;正向 Encode→FluxGuidance→KSampler。"""
    g = build_flux_nunchaku_graph(FluxNunchakuParams(positive="x", seed=1))
    dit_id = next(k for k, n in g.items() if n["class_type"] == "NunchakuFluxDiTLoader")
    te_id = next(k for k, n in g.items() if n["class_type"] == "NunchakuTextEncoderLoaderV2")
    ks = _by_type(g, "KSampler")
    assert ks["model"] == [dit_id, 0]
    fg_id = next(k for k, n in g.items() if n["class_type"] == "FluxGuidance")
    assert ks["positive"] == [fg_id, 0]
    pos_enc_id = next(
        k for k, n in g.items()
        if n["class_type"] == "CLIPTextEncode" and n["inputs"]["text"] == "x"
    )
    assert g[fg_id]["inputs"]["conditioning"] == [pos_enc_id, 0]
    assert g[pos_enc_id]["inputs"]["clip"] == [te_id, 0]
    latent = _by_type(g, "EmptyLatentImage")
    assert (latent["width"], latent["height"], latent["batch_size"]) == (1024, 1024, 1)
    dec = _by_type(g, "VAEDecode")
    save = _by_type(g, "SaveImage")
    assert save["images"] == [next(k for k, n in g.items() if n["class_type"] == "VAEDecode"), 0]
    assert dec["samples"] == [next(k for k, n in g.items() if n["class_type"] == "KSampler"), 0]


def test_overrides_batch_cache_seed():
    g = build_flux_nunchaku_graph(
        FluxNunchakuParams(
            positive="x", width=832, height=1216, batch_size=3,
            cache_threshold=0.12, guidance=5.0, t5_min_length=768, seed=7,
        )
    )
    latent = _by_type(g, "EmptyLatentImage")
    assert (latent["width"], latent["height"], latent["batch_size"]) == (832, 1216, 3)
    assert _by_type(g, "NunchakuFluxDiTLoader")["cache_threshold"] == 0.12
    assert _by_type(g, "FluxGuidance")["guidance"] == 5.0
    assert _by_type(g, "NunchakuTextEncoderLoaderV2")["t5_min_length"] == 768
    assert _by_type(g, "KSampler")["seed"] == 7


def test_seed_default_random_and_reproducible():
    a = build_flux_nunchaku_graph(FluxNunchakuParams(positive="x"))
    b = build_flux_nunchaku_graph(FluxNunchakuParams(positive="x"))
    assert _by_type(a, "KSampler")["seed"] != _by_type(b, "KSampler")["seed"]
    s1 = build_flux_nunchaku_graph(FluxNunchakuParams(positive="x", seed=123))
    s2 = build_flux_nunchaku_graph(FluxNunchakuParams(positive="x", seed=123))
    assert s1 == s2


def test_required_models_and_nodes():
    models = required_models()
    assert models == {NUNCHAKU_DIT, NUNCHAKU_T5, NUNCHAKU_CLIP_L, NUNCHAKU_VAE}
    assert "svdq-fp4_r32-flux.1-dev.safetensors" in models
    assert NUNCHAKU_REQUIRED_NODES == frozenset(
        {"NunchakuFluxDiTLoader", "NunchakuTextEncoderLoaderV2"}
    )


# --------------------------------------------------------------------------- #
# 路由端点级
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
    """最小化 ComfyUIClient 替身:queue_prompt 记录图并返回固定 prompt_id。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-nunchaku-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-nunchaku-1"


class _FakePool:
    """记录 pick 收到的双约束,返回固定 worker。"""

    def __init__(self, client: _FakeClient, fail: bool = False) -> None:
        self._client = client
        self._fail = fail
        self.calls: list[tuple[set, set]] = []

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        self.calls.append((set(required), set(required_nodes)))
        if self._fail:
            raise ComfyUIError("没有具备所需模型且可用的 worker")
        return self._client


def _install_pool(pool: _FakePool) -> None:
    app.dependency_overrides[get_pool] = lambda: pool


def _install_tracker_noop(monkeypatch) -> None:
    monkeypatch.setattr(flux_nunchaku_route, "spawn_tracker", lambda client, prompt_id: None)


def _auth(engine, email: str) -> dict:
    with Session(engine) as s:
        uid = _seed_user(s, email)
    return {"Authorization": f"Bearer {create_token(uid)}"}


def test_route_requires_auth(client):
    c, _ = client
    r = c.post("/api/generate/flux-nunchaku", json={"positive": "a"})
    assert r.status_code == 401


def test_route_rate_limited_429(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "nunchaku-429")
    for _ in range(_MAX_PER_WINDOW):
        enforce_generation_rate_limit(SimpleNamespace(id=uid))
    r = c.post(
        "/api/generate/flux-nunchaku",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.user_id == uid)).first() is None


@pytest.mark.parametrize(
    "payload",
    [
        {"positive": ""},  # 空正向
        {"positive": "x", "guidance": 0.5},  # guidance 越界(<1)
        {"positive": "x", "guidance": 11.0},  # guidance 越界(>10)
        {"positive": "x", "steps": 0},
        {"positive": "x", "batch_size": 9},  # 超 le=4
        {"positive": "x", "cache_threshold": 1.5},  # 超 le=1
        {"positive": "x", "width": 32},  # 超 ge=64
    ],
)
def test_route_validation_422(client, payload):
    c, _ = client
    r = c.post("/api/generate/flux-nunchaku", headers=_auth(engine=client[1], email=f"v422-{payload}"), json=payload)
    assert r.status_code == 422, r.text


def test_route_ok_creates_job_and_pick_constraints(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "nunchaku-ok")
    fake = _FakeClient()
    pool = _FakePool(fake)
    _install_pool(pool)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/flux-nunchaku",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只狐狸", "seed": 42, "steps": 20, "guidance": 4.0},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-nunchaku-1"
    assert body["seed"] == 42
    assert body["worker"] == "http://fake-nunchaku-worker"

    # pool.pick 双约束:所需权重集 + 插件节点集(worker pinning 语义)
    assert len(pool.calls) == 1
    req_models, req_nodes = pool.calls[0]
    assert req_models == required_models()
    assert {"NunchakuFluxDiTLoader", "NunchakuTextEncoderLoaderV2"} <= req_nodes

    # 提交给 worker 的图由 builder 产出(采样档正确)
    graph = fake.graphs[0]
    ks = _by_type(graph, "KSampler")
    assert ks["cfg"] == 1.0 and ks["steps"] == 20 and ks["seed"] == 42
    assert _by_type(graph, "FluxGuidance")["guidance"] == 4.0

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "flux_nunchaku"
        assert job.status == "queued"
        assert job.worker == "http://fake-nunchaku-worker"
        assert job.nsfw is False  # 固定 SFW 权重引擎
        assert job.seed == 42
        assert job.tenant_id == s.get(User, uid).tenant_id


def test_route_pool_exhausted_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "nunchaku-503")
    _install_pool(_FakePool(_FakeClient(), fail=True))
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/flux-nunchaku",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.user_id == uid)).first() is None  # 未建档
