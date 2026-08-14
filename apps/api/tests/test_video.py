"""NSFW 视频主链端点级测试 —— routes/video.py。

覆盖端点:
  · POST /api/generate/video        —— Wan 2.2 图生视频(worker 锁定模式)
  · POST /api/generate/ltx-t2v      —— LTX2.3 文生视频(NSFW 专区,pool 选 worker)
  · POST /api/generate/ltx-i2v      —— LTX2.3 图生视频(NSFW 专区,worker 锁定)
  · POST /api/generate/ltx-lipsync  —— LTX2.3 口型同步(NSFW 专区,worker 锁定)

断言维度(每类至少一例):
  · 认证缺失 401
  · LTX 三端点 NSFW 门槛:无 X-NSFW 头 → 403
  · 参数校验 422(空提示词 / 越界步数 / 缺必填图)
  · 正常提交:mock pool/resolve_worker 返回 prompt_id,Job 落库(kind/nsfw/user_id)
  · 能力门控:pool 无具备 LTX 模型的 worker(pick 返回 None)→ 503
  · 上游 ComfyUI 错误透传:4xx 原样、无状态码 → 502

既有覆盖不重复:WanI2VRequest 数值钳位见 test_video_clamp.py;
/api/ltx2/* 工作室(另一路由)见 test_ltx_studio.py。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.video as video_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes(与 test_ltx25_studio.py 同一模式)
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

    def __init__(self, *, error: ComfyUIError | None = None) -> None:
        self.base_url = "http://fake-worker"
        self._error = error
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        if self._error is not None:
            raise self._error
        self.graphs.append(graph)
        return "prompt-video-1"


class _FakePool:
    """WorkerPool 替身:pick 可控(返回 client 或 None 模拟无可用 worker)。"""

    def __init__(self, picked) -> None:  # noqa: ANN001
        self._picked = picked

    @property
    def clients(self) -> list:
        return [self._picked] if self._picked is not None else []

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._picked


def _install_tracker_noop(monkeypatch) -> None:
    """不触发真实后台追踪(不联 worker)。"""
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)


_NSFW = {"X-NSFW": "1"}  # /nsfw 专页标记(中间件据此放行 R18)


# --------------------------------------------------------------------------- #
# POST /api/generate/video(Wan 2.2 i2v)
# --------------------------------------------------------------------------- #


def test_wan_i2v_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/video",
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 401


def test_wan_i2v_rejects_empty_positive(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wan-empty")
    r = c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


def test_wan_i2v_ok_submits_and_creates_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wan-ok")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "海浪拍打礁石",
            "image": "in.png",
            "worker": "http://fake-worker",
            "seed": 7,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-video-1"
    assert body["worker"] == "http://fake-worker"
    assert body["seed"] == 7

    with Session(engine) as s:
        user = s.get(User, uid)
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "wan_i2v"
        assert job.status == "queued"
        assert job.tenant_id == user.tenant_id
        assert job.prompt_id == "prompt-video-1"
        assert job.nsfw is False  # Wan i2v 主链不打 R18 标


def test_wan_i2v_comfy_4xx_passthrough(client, monkeypatch):
    """上游 4xx(参数/模型问题)原样透传,便于前端定位。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wan-4xx")
    fake = _FakeClient(error=ComfyUIError("bad node", status_code=400, detail="bad node"))
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 400
    assert "bad node" in r.json()["detail"]


def test_wan_i2v_comfy_network_error_becomes_502(client, monkeypatch):
    """网络层失败(无 status_code)不透传 5xx,统一 502。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "wan-502")
    fake = _FakeClient(error=ComfyUIError("connection refused"))
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 502


# --------------------------------------------------------------------------- #
# POST /api/generate/ltx-t2v(pool 选 worker)
# --------------------------------------------------------------------------- #


def test_ltx_t2v_requires_auth(client):
    c, _ = client
    r = c.post("/api/generate/ltx-t2v", json={"positive": "a"})
    assert r.status_code == 401


def test_ltx_t2v_blocked_without_nsfw_header(client):
    """LTX 视频仅限 /nsfw 专区:主站(无 X-NSFW 头)一律 403。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-gate")
    r = c.post(
        "/api/generate/ltx-t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a"},
    )
    assert r.status_code == 403


def test_ltx_t2v_rejects_out_of_range_params(client):
    """length>241 / steps<1 越界 → 422(数值校验在门槛之前,带专区头也拦)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-422")
    H = {"Authorization": f"Bearer {create_token(uid)}", **_NSFW}
    r = c.post("/api/generate/ltx-t2v", headers=H, json={"positive": "a", "length": 1000})
    assert r.status_code == 422
    r = c.post("/api/generate/ltx-t2v", headers=H, json={"positive": "a", "steps": 0})
    assert r.status_code == 422


def test_ltx_t2v_ok_submits_and_creates_nsfw_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-ok")
    fake = _FakeClient()
    monkeypatch.setattr("app.deps.get_pool", lambda: _FakePool(fake))
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/ltx-t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={"positive": "月光下的独舞", "seed": 11},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-video-1"
    assert body["seed"] == 11

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ltx_t2v"
        assert job.nsfw is True  # LTX 视频建档一律打 R18 标


def test_ltx_t2v_no_capable_worker_503(client, monkeypatch):
    """能力门控:pool 里无具备 LTX 模型/节点的 worker(pick 返回 None)→ 503。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-503")
    monkeypatch.setattr("app.deps.get_pool", lambda: _FakePool(None))
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/ltx-t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={"positive": "a"},
    )
    assert r.status_code == 503
    assert "无可用 worker" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# POST /api/generate/ltx-i2v(worker 锁定)
# --------------------------------------------------------------------------- #


def test_ltx_i2v_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/ltx-i2v",
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 401


def test_ltx_i2v_blocked_without_nsfw_header(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-i2v-gate")
    r = c.post(
        "/api/generate/ltx-i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a", "image": "in.png", "worker": "http://fake-worker"},
    )
    assert r.status_code == 403


def test_ltx_i2v_rejects_missing_image(client):
    """image 为必填(无默认),缺省 → 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-i2v-422")
    r = c.post(
        "/api/generate/ltx-i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={"positive": "a", "worker": "http://fake-worker"},
    )
    assert r.status_code == 422


def test_ltx_i2v_ok_submits_and_creates_nsfw_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-i2v-ok")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/ltx-i2v",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={
            "positive": "角色转身微笑",
            "image": "in.png",
            "worker": "http://fake-worker",
            "seed": 13,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "prompt-video-1"

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ltx_i2v"
        assert job.nsfw is True


# --------------------------------------------------------------------------- #
# POST /api/generate/ltx-lipsync(worker 锁定,图+音频)
# --------------------------------------------------------------------------- #


def test_ltx_lipsync_requires_auth(client):
    c, _ = client
    r = c.post(
        "/api/generate/ltx-lipsync",
        json={
            "positive": "a",
            "image": "in.png",
            "audio": "a.wav",
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 401


def test_ltx_lipsync_blocked_without_nsfw_header(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-lip-gate")
    r = c.post(
        "/api/generate/ltx-lipsync",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a",
            "image": "in.png",
            "audio": "a.wav",
            "worker": "http://fake-worker",
        },
    )
    assert r.status_code == 403


def test_ltx_lipsync_ok_submits_and_creates_nsfw_job(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ltx-lip-ok")
    fake = _FakeClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    _install_tracker_noop(monkeypatch)
    r = c.post(
        "/api/generate/ltx-lipsync",
        headers={"Authorization": f"Bearer {create_token(uid)}", **_NSFW},
        json={
            "positive": "角色开口说话",
            "image": "in.png",
            "audio": "a.wav",
            "worker": "http://fake-worker",
            "seed": 17,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "prompt-video-1"

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "ltx_lipsync"
        assert job.nsfw is True
