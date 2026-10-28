from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.services.job_health import project_job_health

NOW = 1_800_000_000.0


def _runtime(status: str, *, progress=None, created_at=None, hold_reason=""):
    return project_job_health(
        status=status,
        progress=progress,
        created_at=created_at,
        hold_reason=hold_reason,
        now=NOW,
    )


@pytest.mark.parametrize(
    ("age", "state"),
    [(0, "fresh"), (120, "fresh"), (120.1, "watch"), (300, "watch"), (300.1, "stalled")],
)
def test_progress_evidence_thresholds(age, state):
    out = _runtime(
        "running",
        progress={"pct": 25, "step": 2, "total": 8, "updated_at": NOW - age},
        created_at=datetime.fromtimestamp(NOW - 1000, tz=timezone.utc),
    )
    assert out["runtime"]["state"] == state
    assert out["runtime"]["evidence"] == "progress_snapshot"
    assert out["runtime"]["last_evidence_at"] == NOW - age
    assert out["runtime"]["age_seconds"] == pytest.approx(max(0, age))
    assert out["progress"] == {
        "pct": 25,
        "step": 2,
        "total": 8,
        "queue_pos": None,
        "updated_at": NOW - age,
        "phase": "generating",
        "phase_label": "生成中",
    }


@pytest.mark.parametrize("status", ["done", "error", "canceled"])
def test_terminal_preserves_progress_evidence_without_becoming_active(status):
    out = _runtime(status, progress={"updated_at": NOW - 9999})
    assert out["runtime"] == {
        "state": "terminal",
        "label": "已结束",
        "reason": f"作业状态为 {status}",
        "last_evidence_at": NOW - 9999,
        "age_seconds": 9999,
        "evidence": "progress_snapshot",
    }


@pytest.mark.parametrize("status", ["done", "error", "canceled"])
def test_terminal_without_progress_keeps_legacy_null_evidence(status):
    out = _runtime(status)
    assert out["runtime"]["state"] == "terminal"
    assert out["runtime"]["last_evidence_at"] is None
    assert out["runtime"]["age_seconds"] is None
    assert out["runtime"]["evidence"] == "terminal"


def test_held_uses_hold_reason_without_claiming_submission():
    out = _runtime("held", hold_reason="等待显存释放")
    assert out["runtime"]["state"] == "waiting"
    assert out["runtime"]["reason"] == "等待显存释放"
    assert out["runtime"]["evidence"] == "none"
    assert out["runtime"]["last_evidence_at"] is None


def test_held_preserves_progress_evidence_and_waiting_semantics():
    out = _runtime(
        "held", progress={"updated_at": NOW - 45}, hold_reason="等待显存释放"
    )
    assert out["runtime"] == {
        "state": "waiting",
        "label": "等待中",
        "reason": "等待显存释放",
        "last_evidence_at": NOW - 45,
        "age_seconds": 45,
        "evidence": "progress_snapshot",
    }


def test_missing_progress_running_waits_then_becomes_stalled():
    created = datetime.fromtimestamp(NOW - 200, tz=timezone.utc)
    waiting = _runtime("running", created_at=created)
    assert waiting["runtime"]["state"] == "unknown"
    assert waiting["runtime"]["evidence"] == "created_at"
    assert waiting["runtime"]["age_seconds"] == 200

    created = datetime.fromtimestamp(NOW - 301, tz=timezone.utc)
    stalled = _runtime("running", created_at=created)
    assert stalled["runtime"]["state"] == "stalled"
    assert stalled["runtime"]["evidence"] == "created_at"
    assert stalled["runtime"]["last_evidence_at"] == NOW - 301


def test_old_queued_without_progress_is_not_stalled():
    created = datetime.fromtimestamp(NOW - 10000, tz=timezone.utc)
    out = _runtime("queued", created_at=created)
    assert out["runtime"]["state"] == "unknown"
    assert out["runtime"]["reason"] == "排队中，健康未知"
    assert out["runtime"]["age_seconds"] == 10000


@pytest.mark.parametrize("updated_at", [None, "bad", True, float("nan"), float("inf"), -1])
def test_invalid_progress_time_is_unknown(updated_at):
    out = _runtime(
        "running",
        progress={"updated_at": updated_at},
        created_at=datetime.fromtimestamp(NOW - 10, tz=timezone.utc),
    )
    assert out["runtime"]["state"] == "unknown"
    assert out["runtime"]["evidence"] == "created_at"
    assert out["progress"]["updated_at"] is None


def test_future_progress_time_is_unknown_not_fresh():
    out = _runtime(
        "running",
        progress={"updated_at": NOW + 301},
        created_at=datetime.fromtimestamp(NOW - 10, tz=timezone.utc),
    )
    assert out["runtime"]["state"] == "unknown"
    assert out["runtime"]["evidence"] == "created_at"
    assert out["progress"]["updated_at"] is None


def test_naive_created_at_is_utc():
    naive_utc = datetime.fromtimestamp(NOW - 60, tz=timezone.utc).replace(tzinfo=None)
    out = _runtime("queued", created_at=naive_utc)
    assert out["runtime"]["last_evidence_at"] == NOW - 60
    assert out["runtime"]["age_seconds"] == 60


def test_progress_json_is_normalized_and_enriched():
    out = _runtime(
        "queued",
        progress=json.dumps({"pct": 0, "queue_pos": 3, "updated_at": NOW, "extra": "kept-out"}),
    )
    assert out["progress"]["queue_pos"] == 3
    assert out["progress"]["phase"] == "queued"
    assert set(out["progress"]) == {
        "pct", "step", "total", "queue_pos", "updated_at", "phase", "phase_label"
    }


@pytest.fixture
def client_ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="runtime-health")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        users = []
        for email in ("owner@toiv.ai", "other@toiv.ai"):
            user = User(
                email=email,
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            users.append(user)
        s.commit()
        for user in users:
            s.refresh(user)
        owner, other = users
        now = time.time()
        s.add(Job(
            tenant_id=tenant.id,
            user_id=owner.id,
            prompt_id="owned-running",
            worker="http://w",
            status="running",
            progress=json.dumps({"pct": 40, "step": 4, "total": 10, "updated_at": now}),
            created_at=datetime.now(timezone.utc) - timedelta(seconds=10),
        ))
        s.add(Job(
            tenant_id=tenant.id,
            user_id=other.id,
            prompt_id="other-running",
            worker="http://w",
            status="running",
            progress=json.dumps({"updated_at": now}),
        ))
        s.add(Job(
            tenant_id=tenant.id,
            user_id=owner.id,
            prompt_id="hidden-nsfw",
            worker="http://w",
            nsfw=True,
        ))
        s.commit()
        owner_id = owner.id
        other_id = other.id
    with TestClient(app) as client:
        yield client, create_token(owner_id), create_token(other_id)
    app.dependency_overrides.clear()


def test_jobs_and_lookup_expose_health_with_owner_isolation(client_ctx):
    client, token, other_token = client_ctx
    headers = {"Authorization": f"Bearer {token}"}
    response = client.get("/api/jobs", headers=headers)
    assert response.status_code == 200, response.text
    items = response.json()
    assert [item["prompt_id"] for item in items] == ["owned-running"]
    item = items[0]
    assert item["progress"]["pct"] == 40
    assert item["progress"]["phase"] == "generating"
    assert item["runtime"]["state"] == "fresh"
    assert item["runtime"]["evidence"] == "progress_snapshot"
    assert isinstance(item["runtime"]["last_evidence_at"], (int, float))
    assert 0 <= item["runtime"]["age_seconds"] < 120

    lookup = client.get(
        "/api/jobs/lookup", headers=headers, params={"prompt_id": "owned-running"}
    )
    assert lookup.status_code == 200, lookup.text
    assert lookup.json()["progress"] == item["progress"]
    assert lookup.json()["runtime"]["state"] == "fresh"

    assert client.get(
        "/api/jobs/lookup", headers=headers, params={"prompt_id": "other-running"}
    ).status_code == 404
    assert client.get(
        "/api/jobs/lookup",
        headers={"Authorization": f"Bearer {other_token}"},
        params={"prompt_id": "owned-running"},
    ).status_code == 404
    assert client.get(
        "/api/jobs/lookup", headers=headers, params={"prompt_id": "hidden-nsfw"}
    ).status_code == 404
