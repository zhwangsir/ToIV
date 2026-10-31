"""generate.py 主链端点级测试 —— txt2img / img2img / upscale / raw。

覆盖:
  · 认证缺失 401(四端点各一例)
  · 限流 429(txt2img:预填窗口配额后第 21 次被拒,带 Retry-After)
  · 正常提交 → 200 + prompt_id,Job 落库(user_id/tenant_id/kind/status 正确)
  · 参数校验 422(upscale 非法模型 / raw 空图;均在认证后触发)

既有覆盖不重复:txt2img 的 R18 门槛与 nextgen 分支见 test_r18.py;
raw 工作流的 R18 图扫描见 test_raw_workflow.py / test_r18.py;
各 builder 图结构见 test_*_builder.py。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.generate as generate_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Job, Tenant, User
from app.ratelimit import _MAX_PER_WINDOW, enforce_generation_rate_limit
from app.security import create_token, hash_password

_SFW_CKPT = "DreamShaper_8.safetensors"  # 传统族 SFW 底模(避开 R18 门槛与 nextgen 分支)


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
    """最小化 ComfyUIClient 替身:queue_prompt 记录图并返回固定 prompt_id。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-gen-1"


class _FakePool:
    def __init__(self, client: _FakeClient) -> None:
        self._client = client

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


def _install_pool(client: _FakeClient) -> None:
    app.dependency_overrides[get_pool] = lambda: _FakePool(client)


def _install_tracker_noop(monkeypatch) -> None:
    """不触发真实后台追踪(不联 worker)。"""
    monkeypatch.setattr(generate_route, "spawn_tracker", lambda client, prompt_id: None)


def _job_of(engine, uid: str) -> Job | None:
    with Session(engine) as s:
        return s.exec(select(Job).where(Job.user_id == uid)).first()


# --------------------------------------------------------------------------- #
# 认证 401(四端点)
# --------------------------------------------------------------------------- #


def test_txt2img_requires_auth(client):
    c, _ = client
    assert c.post("/api/generate/txt2img", json={"positive": "a"}).status_code == 401


def test_img2img_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/img2img",
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 401


def test_upscale_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/upscale",
        json={"image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 401


def test_raw_requires_auth(client):
    c, _ = client
    r = c.post("/api/generate/raw", json={"graph": {"1": {"class_type": "SaveImage", "inputs": {}}}})
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# 限流 429(txt2img 代表:生成类 scope 全端点共用同一配额桶)
# --------------------------------------------------------------------------- #


def test_txt2img_rate_limited_429(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-429")
    # 预填窗口配额(进程内存桶,conftest 已禁 Redis 并逐用例清空)
    for _ in range(_MAX_PER_WINDOW):
        enforce_generation_rate_limit(SimpleNamespace(id=uid))
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "ckpt_name": _SFW_CKPT},
    )
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.user_id == uid)).first() is None  # 未建档


# --------------------------------------------------------------------------- #
# P2-7(2026-08-30):ComfyUI 错误码统一 —— worker 4xx 透传、5xx/无状态 → 502
# (与 routes/video.py 的 _raise_from_comfy_error 同一语义,消除同场景 4xx/502 漂移)
# --------------------------------------------------------------------------- #


class _ErrClient(_FakeClient):
    """queue_prompt 抛带状态码的 ComfyUIError 的替身。"""

    def __init__(self, status_code: int | None) -> None:
        super().__init__()
        self._status = status_code

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        from app.comfy.client import ComfyUIError

        raise ComfyUIError("worker 拒绝", status_code=self._status, detail="bad prompt")


@pytest.mark.parametrize(
    "worker_status, want",
    [
        (400, 400),   # worker 4xx(参数/图非法)透传,前端据此区分「用户输入问题」
        (422, 422),
        (500, 502),   # worker 内部错误不外泄,统一 502
        (503, 503),   # 网关类状态码透传
        (None, 502),  # 网络错误(无响应)→ 502
    ],
)
def test_txt2img_comfy_error_status_unified(client, monkeypatch, worker_status, want):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, f"gen-err-{worker_status}")
    _install_pool(_ErrClient(worker_status))
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "ckpt_name": _SFW_CKPT, "seed": 42},
    )
    assert r.status_code == want, r.text
    # 失败不建档
    assert _job_of(engine, uid) is None


# --------------------------------------------------------------------------- #
# txt2img 正常建档
# --------------------------------------------------------------------------- #


def test_txt2img_ok_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-t2i")
    fake = _FakeClient()
    _install_pool(fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/txt2img",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫", "ckpt_name": _SFW_CKPT, "seed": 42},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-gen-1"
    assert body["seed"] == 42

    job = _job_of(engine, uid)
    assert job is not None
    assert job.kind == "txt2img"
    assert job.status == "queued"
    assert job.worker == "http://fake-worker"
    assert job.prompt == "一只猫"
    with Session(engine) as s:
        assert job.tenant_id == s.get(User, uid).tenant_id


# --------------------------------------------------------------------------- #
# img2img 正常建档(worker 锁定模式:resolve_worker 替身)
# --------------------------------------------------------------------------- #


def test_img2img_ok_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-i2i")
    fake = _FakeClient()
    monkeypatch.setattr(generate_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/img2img",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "油画风",
            "image": "in.png",
            "worker": "http://fake-worker",
            "ckpt_name": _SFW_CKPT,
            "seed": 5,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "prompt-gen-1"

    job = _job_of(engine, uid)
    assert job is not None
    assert job.kind == "img2img"
    assert job.status == "queued"
    assert job.seed == 5


# --------------------------------------------------------------------------- #
# upscale:非法模型 422 + 正常建档
# --------------------------------------------------------------------------- #


def test_upscale_rejects_unknown_model_422(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-up-422")
    r = c.post(
        "/api/generate/upscale",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"image": "in.png", "worker": "http://fake-worker", "model_name": "not-a-model.pth"},
    )
    assert r.status_code == 422


def test_upscale_ok_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-up-ok")
    fake = _FakeClient()
    monkeypatch.setattr(generate_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/upscale",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"image": "in.png", "worker": "http://fake-worker", "model_name": "4x-UltraSharp.pth"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-gen-1"
    assert body["model_name"] == "4x-UltraSharp.pth"

    job = _job_of(engine, uid)
    assert job is not None
    assert job.kind == "upscale"
    assert job.status == "queued"


# --------------------------------------------------------------------------- #
# raw:空图 422 + 正常建档(pool.pick 自动选 worker)
# --------------------------------------------------------------------------- #


def test_raw_rejects_empty_graph_422(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-raw-422")
    r = c.post(
        "/api/generate/raw",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"graph": {}},
    )
    assert r.status_code == 422


def test_raw_ok_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "gen-raw-ok")
    fake = _FakeClient()
    _install_pool(fake)
    _install_tracker_noop(monkeypatch)
    graph = {
        "1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
    }
    r = c.post(
        "/api/generate/raw",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"graph": graph},
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "prompt-gen-1"
    assert fake.graphs == [graph]  # 任意工作流原样透传给 worker

    job = _job_of(engine, uid)
    assert job is not None
    assert job.kind == "raw"
    assert job.status == "queued"
    assert job.nsfw is False  # SFW 图不打 R18 标
