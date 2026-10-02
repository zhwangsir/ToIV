"""INTENT e:速度分档 speed_tier(fast|quality)+排队/失败字段。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, Job, Tenant, User
from app.security import create_token, hash_password
from app.services import speed_tier as speed_tier_svc


def _make_user(session: Session, email: str, role: str = "user") -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        role=role,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


_GRAPH = {
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "default prompt", "clip": ["4", 1]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "8": {"class_type": "KSampler", "inputs": {"steps": 20, "seed": 0}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
}
_SCHEMA = [
    {"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True},
    {"key": "steps", "label": "步数", "type": "number", "default": 20, "min": 1, "max": 50},
]
_BINDINGS = {
    "prompt": {"node": "3", "field": "inputs.text"},
    "steps": {"node": "8", "field": "inputs.steps"},
}


def _seed_app(session: Session, **over) -> App:
    a = App(
        id=over.pop("id", "t2i-basic"),
        name=over.pop("name", "文生图基础"),
        workflow_json=over.pop("workflow_json", json.loads(json.dumps(_GRAPH))),
        params_schema=over.pop("params_schema", _SCHEMA),
        bindings=over.pop("bindings", _BINDINGS),
        **over,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return a


class _FakeClient:
    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-speed-1"

    async def queue_counts(self) -> tuple[int, int]:
        return 1, 3


class _FakePool:
    def __init__(self, client) -> None:
        self._client = client

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake_client = _FakeClient()
    pool = _FakePool(fake_client)
    app.dependency_overrides[get_pool] = lambda: pool
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    with Session(engine) as s:
        user_id = _make_user(s, "speed@toiv.ai")
        _seed_app(s)
    yield (
        TestClient(app),
        create_token(user_id),
        engine,
        fake_client,
    )
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_validate_speed_tier_defaults_and_rejects():
    assert speed_tier_svc.validate_speed_tier(None) == "quality"
    assert speed_tier_svc.validate_speed_tier("") == "quality"
    assert speed_tier_svc.validate_speed_tier(" FAST ") == "fast"
    with pytest.raises(ValueError):
        speed_tier_svc.validate_speed_tier("turbo")


def test_resolve_h3_acceleration_mapping():
    assert speed_tier_svc.resolve_h3_acceleration("quality", "off") == "off"
    assert speed_tier_svc.resolve_h3_acceleration("fast", "off") == "balanced"
    assert speed_tier_svc.resolve_h3_acceleration("fast", "extreme") == "extreme"


def test_apply_fast_steps_halves_ksampler():
    g = json.loads(json.dumps(_GRAPH))
    out, applied, meta = speed_tier_svc.apply_fast_steps(g, "fast")
    assert applied is True
    assert out["8"]["inputs"]["steps"] == 10
    assert g["8"]["inputs"]["steps"] == 20
    out2, applied2, _ = speed_tier_svc.apply_fast_steps(g, "quality")
    assert applied2 is False
    assert out2["8"]["inputs"]["steps"] == 20


def test_run_unauthorized_401(ctx):
    c, *_ = ctx
    r = c.post("/api/apps/t2i-basic/run", json={"values": {"prompt": "x"}, "speed_tier": "fast"})
    assert r.status_code == 401


def test_run_rejects_bad_speed_tier(ctx):
    c, token, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run",
        headers=_h(token),
        json={"values": {"prompt": "一只猫"}, "speed_tier": "turbo"},
    )
    assert r.status_code == 422
    detail = r.json().get("detail")
    if isinstance(detail, list):
        detail = " ".join(
            (x.get("msg") if isinstance(x, dict) else str(x)) for x in detail
        )
    detail_s = str(detail)
    assert "速度档位只能选快速或精细" in detail_s
    assert "speed_tier" not in detail_s
    assert "fast" not in detail_s
    assert "quality" not in detail_s


def test_run_fast_persists_and_halves_steps(ctx):
    c, token, engine, fake = ctx
    r = c.post(
        "/api/apps/t2i-basic/run",
        headers=_h(token),
        json={"values": {"prompt": "一只猫", "steps": 20}, "speed_tier": "fast"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["speed_tier"] == "fast"
    assert body["speed_tier_steps_applied"] is True
    assert body["queued_behind"] == 3
    assert fake.graphs[-1]["8"]["inputs"]["steps"] == 10
    with Session(engine) as s:
        job = s.exec(select(Job)).first()
        assert job is not None
        snap = json.loads(job.params)
        assert snap["speed_tier"] == "fast"
        assert snap["speed_tier_steps_applied"] is True


def test_run_quality_default_no_step_patch(ctx):
    c, token, _engine, fake = ctx
    r = c.post(
        "/api/apps/t2i-basic/run",
        headers=_h(token),
        json={"values": {"prompt": "一只猫"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["speed_tier"] == "quality"
    assert body["speed_tier_steps_applied"] is False
    assert fake.graphs[-1]["8"]["inputs"]["steps"] == 20
