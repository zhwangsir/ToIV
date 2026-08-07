"""LongCat-Video 工作室 —— 图构建 / 参数校验 / 端点提交链路 测试。

覆盖:
  · 图构建器:节点类型与连线(照搬 longcat_smoke.py)、rope_function="comfy"、
    scheduler=longcat_distill_euler、cfg=1.0/shift=12.0、模型文件名、参数注入、
    蒸馏 LoRA 置空 → 无 LoraSelect 节点且 ModelLoader.lora=None、两次构建互不影响
  · 请求校验:num_frames 越界(16/962)422;宽高超界 422;宽高非 16 对齐自动向下取整
  · POST /api/longcat/t2v:成功提交(Job kind=longcat_t2v、seed 落快照);
    实例不可达 → 503;缺 WanVideoModelLoader 节点 → 503;TOIV_LONGCAT_ENABLED=false → 503
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.longcat as longcat_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.longcat_video import (
    DEFAULT_DISTILL_LORA,
    DEFAULT_MODEL,
    DEFAULT_T5,
    DEFAULT_VAE,
    LongCatT2VParams,
    build_longcat_t2v_graph,
)


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


class _FakeLongCatClient:
    """LongCat 实例替身:object_info/queue_prompt 可控,不联网。"""

    def __init__(self, *, reachable: bool = True, has_node: bool = True) -> None:
        self.base_url = "http://fake-longcat"
        self._reachable = reachable
        self._has_node = has_node
        self.graphs: list[dict] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")  # 无 status_code = 网络层失败
        if not self._has_node:
            raise ComfyUIError(f"unknown node {node}", status_code=404)
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-longcat-1"


def _install_longcat(monkeypatch, fake: _FakeLongCatClient) -> None:
    monkeypatch.setattr(longcat_service, "get_longcat_client", lambda: fake)
    monkeypatch.setattr(longcat_service, "spawn_tracker", lambda client, prompt_id: None)


# --------------------------------------------------------------------------- #
# 图构建器
# --------------------------------------------------------------------------- #


def test_builder_graph_structure_and_critical_inputs():
    """节点类型/连线照搬 longcat_smoke.py;关键输入(rope/scheduler/cfg/shift)锁定。"""
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="雪山湖泊", seed=42))

    assert g["1"]["class_type"] == "WanVideoLoraSelect"
    assert g["1"]["inputs"]["lora"] == DEFAULT_DISTILL_LORA
    assert g["2"]["class_type"] == "WanVideoBlockSwap"
    assert g["2"]["inputs"]["blocks_to_swap"] == 10
    assert g["3"]["class_type"] == "WanVideoModelLoader"
    assert g["3"]["inputs"]["model"] == DEFAULT_MODEL
    assert g["3"]["inputs"]["lora"] == ["1", 0]
    assert g["3"]["inputs"]["block_swap_args"] == ["2", 0]
    assert g["3"]["inputs"]["base_precision"] == "bf16"
    assert g["3"]["inputs"]["load_device"] == "offload_device"
    assert g["3"]["inputs"]["attention_mode"] == "sdpa"
    assert g["4"]["class_type"] == "LoadWanVideoT5TextEncoder"
    assert g["4"]["inputs"]["model_name"] == DEFAULT_T5
    assert g["5"]["class_type"] == "WanVideoTextEncode"
    assert g["5"]["inputs"]["t5"] == ["4", 0]
    assert g["6"]["class_type"] == "WanVideoEmptyEmbeds"
    assert g["8"]["class_type"] == "WanVideoVAELoader"
    assert g["8"]["inputs"]["model_name"] == DEFAULT_VAE
    assert g["9"]["class_type"] == "WanVideoDecode"
    assert g["9"]["inputs"]["vae"] == ["8", 0]
    assert g["9"]["inputs"]["samples"] == ["7", 0]
    assert g["10"]["class_type"] == "VHS_VideoCombine"
    assert g["10"]["inputs"]["images"] == ["9", 0]

    # 采样器:真机踩坑约束(rope_function 必须 comfy,否则 4096 vs 128 维度错)
    s = g["7"]["inputs"]
    assert s["rope_function"] == "comfy"
    assert s["scheduler"] == "longcat_distill_euler"
    assert s["cfg"] == 1.0 and s["shift"] == 12.0
    assert s["model"] == ["3", 0] and s["image_embeds"] == ["6", 0] and s["text_embeds"] == ["5", 0]


def test_builder_injects_params():
    g = build_longcat_t2v_graph(LongCatT2VParams(
        positive="一只猫", negative="模糊", width=480, height=832,
        num_frames=49, steps=8, fps=24, seed=7,
    ))
    assert g["5"]["inputs"]["positive_prompt"] == "一只猫"
    assert g["5"]["inputs"]["negative_prompt"] == "模糊"
    assert g["6"]["inputs"] == {"width": 480, "height": 832, "num_frames": 49}
    assert g["7"]["inputs"]["steps"] == 8
    assert g["7"]["inputs"]["seed"] == 7
    assert g["10"]["inputs"]["frame_rate"] == 24
    assert g["10"]["inputs"]["filename_prefix"] == "ToIV_longcat/t2v"


def test_builder_without_distill_lora():
    """distill_lora 置空:无 WanVideoLoraSelect 节点,ModelLoader.lora=None。"""
    g = build_longcat_t2v_graph(LongCatT2VParams(positive="x", distill_lora="", seed=1))
    assert "1" not in g
    assert g["3"]["inputs"]["lora"] is None


def test_builder_two_builds_independent():
    g1 = build_longcat_t2v_graph(LongCatT2VParams(positive="first", seed=1))
    g2 = build_longcat_t2v_graph(LongCatT2VParams(positive="second", seed=2))
    assert g1["5"]["inputs"]["positive_prompt"] == "first"
    assert g2["5"]["inputs"]["positive_prompt"] == "second"
    assert g1["7"]["inputs"]["seed"] == 1


def test_builder_default_seed_random():
    p1 = LongCatT2VParams(positive="x")
    p2 = LongCatT2VParams(positive="x")
    assert p1.seed >= 0 and p2.seed >= 0  # 随机种子(极低概率相等,不断言不等)


# --------------------------------------------------------------------------- #
# 请求校验(422 / 对齐取整)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("num_frames", [16, 962, 0])
def test_t2v_rejects_out_of_range_frames(client, num_frames):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"lcframes-{num_frames}")
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "num_frames": num_frames},
    )
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [("width", 319), ("height", 1281)])
def test_t2v_rejects_out_of_range_size(client, field, value):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"lcsize-{field}")
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", field: value},
    )
    assert r.status_code == 422


def test_t2v_snaps_non_aligned_size(client, monkeypatch):
    """宽高非 16 对齐:向下取整进图(833→832、485→480),而非 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lcsnap")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "width": 833, "height": 485},
    )
    assert r.status_code == 200, r.text
    embeds = fake.graphs[0]["6"]["inputs"]
    assert embeds["width"] == 832 and embeds["height"] == 480


# --------------------------------------------------------------------------- #
# POST /api/longcat/t2v
# --------------------------------------------------------------------------- #


def test_t2v_ok_submits_graph_and_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vok")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "楼道里的中年女人", "num_frames": 121, "seed": 42},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-longcat-1"
    assert body["worker"] == "http://fake-longcat"
    assert body["seed"] == 42

    graph = fake.graphs[0]
    assert graph["5"]["inputs"]["positive_prompt"] == "楼道里的中年女人"
    assert graph["6"]["inputs"]["num_frames"] == 121
    assert graph["7"]["inputs"]["seed"] == 42

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "longcat_t2v"
        assert job.nsfw is False
        assert job.seed == 42
        assert job.worker == "http://fake-longcat"


def test_t2v_default_seed_randomized(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vseed")
    fake = _FakeLongCatClient()
    _install_longcat(monkeypatch, fake)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["seed"], int)
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job.seed == r.json()["seed"]  # 快照与返回值一致,可复现


def test_t2v_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vdown")
    _install_longcat(monkeypatch, _FakeLongCatClient(reachable=False))
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


def test_t2v_missing_wanvideo_node_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lct2vnonode")
    _install_longcat(monkeypatch, _FakeLongCatClient(has_node=False))
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "WanVideoModelLoader" in r.json()["detail"]


def test_t2v_disabled_returns_503(client, monkeypatch):
    """TOIV_LONGCAT_ENABLED=false 时返回 503,不触碰实例。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "lcdisabled")
    from types import SimpleNamespace

    monkeypatch.setattr(
        longcat_service, "get_settings", lambda: SimpleNamespace(longcat_enabled=False)
    )

    def _no_client():
        raise AssertionError("LongCat 已禁用,不应创建实例客户端")

    monkeypatch.setattr(longcat_service, "get_longcat_client", _no_client)
    r = c.post(
        "/api/longcat/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 503
    assert "已禁用" in r.json()["detail"]


def test_t2v_requires_auth(client):
    c, _ = client
    assert c.post("/api/longcat/t2v", json={"positive": "x"}).status_code == 401
