"""Wan 系视频工作流 LightX2V Seko turbo LoRA + EasyCache 加速档测试(2026-08-27 Phase 2)。

档位语义(builder 参数 accel,与 AceStep15Params.quality 同风格):
  · off         —— 满血(现状):不挂加速 LoRA,20 步,cfg 3.5/3.0
  · turbo       —— 草稿高速:Seko 4 步蒸馏 LoRA 成对挂(高噪模型→high_noise LoRA,
                  低噪模型→low_noise LoRA),steps=4,cfg=1.0(蒸馏无 CFG)
  · turbo_cache —— 成片平衡:同 turbo 双 LoRA,steps=8,cfg=1.0 + EasyCache 节点
                  (ComfyUI 原生,串在 ModelSamplingSD3 之后、KSamplerAdvanced 之前,
                  双专家各一;reuse_threshold 保守 0.15 + 0.15/0.95 区段保护)

accel=None 保持旧行为(use_accel_lora 开关),路由层映射:
  /api/generate/video      —— full_quality=True→off;默认→turbo_cache
  /api/generate/txt2video  —— 默认 None(off 等价满血);显式档位才加速
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.generate as generate_route
import app.routes.video as video_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.workflows.wan_i2v import (
    SEKO_I2V_HIGH_LORA,
    SEKO_I2V_LOW_LORA,
    WanI2VParams,
    build_wan_i2v_graph,
)
from app.workflows.wan_t2v import (
    SEKO_T2V_HIGH_LORA,
    SEKO_T2V_LOW_LORA,
    WanT2VParams,
    build_wan_t2v_graph,
)

# --------------------------------------------------------------------------- #
# i2v builder 档位
# --------------------------------------------------------------------------- #


def _easycache_nodes(g: dict) -> dict[str, dict]:
    return {nid: n for nid, n in g.items() if n["class_type"] == "EasyCache"}


def test_i2v_legacy_default_without_accel():
    """accel=None 保持旧默认:8 步加速档,无 EasyCache;LoRA 默认已换 Seko 资产。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png"))
    assert g["3"]["inputs"]["lora_name"] == SEKO_I2V_HIGH_LORA
    assert g["4"]["inputs"]["lora_name"] == SEKO_I2V_LOW_LORA
    assert g["11"]["inputs"]["steps"] == 8
    assert g["11"]["inputs"]["cfg"] == 3.0
    assert g["12"]["inputs"]["cfg"] == 1.0
    assert _easycache_nodes(g) == {}


def test_i2v_accel_off_is_full_quality():
    """off 档:不挂加速 LoRA,ModelSamplingSD3 直连 UNET,20 步 cfg 3.5/3.0,无 EasyCache。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", accel="off"))
    assert "3" not in g and "4" not in g
    assert g["15"]["inputs"]["model"] == ["1", 0]
    assert g["16"]["inputs"]["model"] == ["2", 0]
    assert g["11"]["inputs"]["steps"] == 20
    assert g["11"]["inputs"]["cfg"] == 3.5
    assert g["12"]["inputs"]["cfg"] == 3.0
    assert _easycache_nodes(g) == {}


def test_i2v_accel_turbo_dual_seko_lora_4_steps():
    """turbo 草稿档:双 LoRA 成对挂(高噪→high_noise、低噪→low_noise),4 步 cfg 1.0。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", accel="turbo"))
    assert g["3"]["class_type"] == "LoraLoaderModelOnly"
    assert g["3"]["inputs"]["model"] == ["1", 0]  # 高噪模型 → high_noise LoRA
    assert g["3"]["inputs"]["lora_name"] == SEKO_I2V_HIGH_LORA
    assert "high_noise" in g["3"]["inputs"]["lora_name"]
    assert g["4"]["inputs"]["model"] == ["2", 0]  # 低噪模型 → low_noise LoRA
    assert g["4"]["inputs"]["lora_name"] == SEKO_I2V_LOW_LORA
    assert "low_noise" in g["4"]["inputs"]["lora_name"]
    hi, lo = g["11"]["inputs"], g["12"]["inputs"]
    assert hi["steps"] == 4 and lo["steps"] == 4
    assert hi["cfg"] == 1.0 and lo["cfg"] == 1.0  # 蒸馏无 CFG
    assert hi["start_at_step"] == 0 and hi["end_at_step"] == 2
    assert lo["start_at_step"] == 2 and lo["end_at_step"] == 4
    assert _easycache_nodes(g) == {}


def test_i2v_accel_turbo_cache_adds_easycache_between_shift_and_sampler():
    """turbo_cache 成片档:8 步 cfg 1.0 + EasyCache×2(shift 之后、采样器之前)。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", accel="turbo_cache"))
    assert g["11"]["inputs"]["steps"] == 8
    assert g["11"]["inputs"]["cfg"] == 1.0 and g["12"]["inputs"]["cfg"] == 1.0
    ec = _easycache_nodes(g)
    assert set(ec) == {"17", "18"}  # 双专家各一
    assert ec["17"]["inputs"]["model"] == ["15", 0]  # 高噪:ModelSamplingSD3 之后
    assert ec["18"]["inputs"]["model"] == ["16", 0]
    assert g["11"]["inputs"]["model"] == ["17", 0]  # 采样器之前
    assert g["12"]["inputs"]["model"] == ["18", 0]
    # 保守起步:阈值 0.15,首尾区段保护
    assert ec["17"]["inputs"]["reuse_threshold"] == 0.15
    assert ec["17"]["inputs"]["start_percent"] == 0.15
    assert ec["17"]["inputs"]["end_percent"] == 0.95


def test_i2v_accel_turbo_nsfw_loras_still_chain_after_accel():
    """turbo 档 + NSFW 叠加链:仍在加速 LoRA 之后、shift 之前(节点 id 不被 EasyCache 占用)。"""
    g = build_wan_i2v_graph(WanI2VParams(
        positive="x", image="a.png", accel="turbo",
        high_loras=(("NSFW-22-H-e8.safetensors", 0.8),),
    ))
    assert g["20"]["inputs"]["model"] == ["3", 0]
    assert g["20"]["inputs"]["lora_name"] == "NSFW-22-H-e8.safetensors"
    assert g["15"]["inputs"]["model"] == ["20", 0]


def test_i2v_accel_explicit_steps_override():
    """显式 steps/cfg 覆盖档位默认(与 AceStep15Params 同一约定)。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", accel="turbo", steps=6))
    assert g["11"]["inputs"]["steps"] == 6
    assert g["11"]["inputs"]["end_at_step"] == 3


def test_i2v_accel_invalid_raises():
    with pytest.raises(ValueError, match="加速档"):
        build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", accel="ludicrous"))


# --------------------------------------------------------------------------- #
# t2v builder 档位
# --------------------------------------------------------------------------- #


def test_t2v_default_uses_t2v_unets():
    """T2V 双专家权重已在库,默认不再复用 i2v UNET(错配修复落地)。"""
    p = WanT2VParams(positive="x")
    assert p.high_unet == "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors"
    assert p.low_unet == "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"


def test_t2v_legacy_default_is_full_quality():
    """accel=None 保持旧默认:满血 20 步 cfg 3.5/3.0,不挂 LoRA,无 EasyCache。"""
    g = build_wan_t2v_graph(WanT2VParams(positive="x"))
    assert "3" not in g and "4" not in g
    assert g["11"]["inputs"]["steps"] == 20
    assert g["11"]["inputs"]["cfg"] == 3.5
    assert g["12"]["inputs"]["cfg"] == 3.0
    assert _easycache_nodes(g) == {}


def test_t2v_accel_turbo_dual_seko_lora_4_steps():
    g = build_wan_t2v_graph(WanT2VParams(positive="x", accel="turbo"))
    assert g["3"]["inputs"]["model"] == ["1", 0]
    assert g["3"]["inputs"]["lora_name"] == SEKO_T2V_HIGH_LORA
    assert "seko_v20_high_noise" in g["3"]["inputs"]["lora_name"]
    assert g["4"]["inputs"]["model"] == ["2", 0]
    assert g["4"]["inputs"]["lora_name"] == SEKO_T2V_LOW_LORA
    assert g["11"]["inputs"]["steps"] == 4
    assert g["11"]["inputs"]["cfg"] == 1.0 and g["12"]["inputs"]["cfg"] == 1.0
    assert _easycache_nodes(g) == {}


def test_t2v_accel_turbo_cache_adds_easycache():
    g = build_wan_t2v_graph(WanT2VParams(positive="x", accel="turbo_cache"))
    assert g["11"]["inputs"]["steps"] == 8
    ec = _easycache_nodes(g)
    assert set(ec) == {"17", "18"}
    assert ec["17"]["inputs"]["model"] == ["15", 0]
    assert ec["18"]["inputs"]["model"] == ["16", 0]
    assert g["11"]["inputs"]["model"] == ["17", 0]
    assert g["12"]["inputs"]["model"] == ["18", 0]


def test_t2v_accel_invalid_raises():
    with pytest.raises(ValueError, match="加速档"):
        build_wan_t2v_graph(WanT2VParams(positive="x", accel="ludicrous"))


# --------------------------------------------------------------------------- #
# 路由层:参数透传与非法值 422
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"), tenant_id=tenant.id)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
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
    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-accel-1"


class _FakePool:
    def __init__(self, client: _FakeClient) -> None:
        self._client = client

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


def _post_i2v(c, uid: str, **extra):
    return c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker", **extra},
    )


def test_route_i2v_default_is_turbo_cache(client, monkeypatch):
    """默认(不带 full_quality/accel)= 成片平衡档:8 步 + Seko LoRA + EasyCache。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "wan-accel-default")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)
    r = _post_i2v(c, uid)
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    assert g["11"]["inputs"]["steps"] == 8
    assert g["11"]["inputs"]["cfg"] == 1.0
    assert g["3"]["inputs"]["lora_name"] == SEKO_I2V_HIGH_LORA
    assert set(_easycache_nodes(g)) == {"17", "18"}


def test_route_i2v_accel_turbo_passthrough(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "wan-accel-turbo")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)
    r = _post_i2v(c, uid, accel="turbo")
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    assert g["11"]["inputs"]["steps"] == 4
    assert g["11"]["inputs"]["cfg"] == 1.0
    assert _easycache_nodes(g) == {}


def test_route_i2v_accel_invalid_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "wan-accel-422")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    r = _post_i2v(c, uid, accel="ludicrous")
    assert r.status_code == 422
    assert fake.graphs == []  # 未提交上游


def test_route_i2v_full_quality_still_maps_to_off(client, monkeypatch):
    """旧字段 full_quality=True 兼容:等价 off 档(20 步无 LoRA 无 EasyCache)。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "wan-accel-fq")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)
    r = _post_i2v(c, uid, full_quality=True)
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    assert "3" not in g and "4" not in g
    assert g["11"]["inputs"]["steps"] == 20
    assert _easycache_nodes(g) == {}


def _post_t2v(c, uid: str, **extra):
    return c.post(
        "/api/generate/txt2video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", **extra},
    )


def test_route_t2v_default_stays_full_quality(client, monkeypatch):
    """txt2video 默认不变:满血 20 步无 LoRA(现状);显式 accel 才加速。"""
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "t2v-accel-default")
    fake = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake)
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    try:
        r = _post_t2v(c, uid)
    finally:
        app.dependency_overrides.pop(get_pool, None)
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    assert "3" not in g and "4" not in g
    assert g["11"]["inputs"]["steps"] == 20
    assert _easycache_nodes(g) == {}


def test_route_t2v_accel_turbo_passthrough(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "t2v-accel-turbo")
    fake = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake)
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)
    try:
        r = _post_t2v(c, uid, accel="turbo")
    finally:
        app.dependency_overrides.pop(get_pool, None)
    assert r.status_code == 200, r.text
    g = fake.graphs[0]
    assert g["3"]["inputs"]["lora_name"] == SEKO_T2V_HIGH_LORA
    assert g["11"]["inputs"]["steps"] == 4
    assert g["11"]["inputs"]["cfg"] == 1.0


def test_route_t2v_accel_invalid_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "t2v-accel-422")
    fake = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake)
    try:
        r = _post_t2v(c, uid, accel="ludicrous")
    finally:
        app.dependency_overrides.pop(get_pool, None)
    assert r.status_code == 422
    assert fake.graphs == []


# --------------------------------------------------------------------------- #
# 引擎注册表:wan-nsfw-i2v 透出 accel 档位参数
# --------------------------------------------------------------------------- #


def test_engine_registry_wan_nsfw_i2v_exposes_accel_param():
    from app.services.engine_registry import _wan_nsfw_i2v_params

    params = {p["key"]: p for p in _wan_nsfw_i2v_params()}
    accel = params.get("accel")
    assert accel is not None, "wan-nsfw-i2v 引擎参数缺 accel 档位"
    assert accel["type"] == "select"
    assert {o["value"] for o in accel["options"]} == {"off", "turbo", "turbo_cache"}
