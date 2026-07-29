import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.ratelimit import _MAX_PER_WINDOW, _hits, enforce_generation_rate_limit
# 深化后:_hits key 从 user.id 变为 (user.id, scope) 元组
_RATE_SCOPE = "generation"
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
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

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="j@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="p1",
                worker="http://w",
                prompt="hello",
                seed=1,
            )
        )
        s.commit()
        uid = user.id

    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def test_jobs_requires_auth(ctx):
    client, _ = ctx
    assert client.get("/api/jobs").status_code == 401


def test_jobs_lists_user_jobs(ctx):
    client, token = ctx
    r = client.get("/api/jobs", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    jobs = r.json()
    assert len(jobs) == 1
    assert jobs[0]["prompt"] == "hello"
    assert jobs[0]["status"] == "queued"


def test_jobs_limit_param(ctx):
    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    # 显式 limit=1 正常返回
    r = client.get("/api/jobs?limit=1", headers=H)
    assert r.status_code == 200
    assert len(r.json()) == 1
    # 越界 limit 被 422 拒绝(上限 200,下限 1)
    assert client.get("/api/jobs?limit=0", headers=H).status_code == 422
    assert client.get("/api/jobs?limit=201", headers=H).status_code == 422


def test_jobs_status_filter(ctx):
    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    # fixture 里的 job 是 queued:按 status=queued 应命中,done 应为空
    r = client.get("/api/jobs?status=queued", headers=H)
    assert r.status_code == 200
    assert len(r.json()) == 1
    r = client.get("/api/jobs?status=done", headers=H)
    assert r.status_code == 200
    assert r.json() == []


def test_delete_job_removes_from_library(ctx):
    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    job_id = client.get("/api/jobs", headers=H).json()[0]["id"]
    r = client.delete(f"/api/jobs/{job_id}", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    # 删后作品库为空
    assert client.get("/api/jobs", headers=H).json() == []


def test_delete_missing_job_404(ctx):
    client, token = ctx
    r = client.delete("/api/jobs/does-not-exist", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 404


def test_delete_requires_auth(ctx):
    client, _ = ctx
    assert client.delete("/api/jobs/whatever").status_code == 401


def test_rate_limit_blocks_after_max():
    class _U:
        id = "ratelimit-test-user"

    user = _U()
    _hits.pop((user.id, _RATE_SCOPE), None)
    for _ in range(_MAX_PER_WINDOW):
        enforce_generation_rate_limit(user)  # 不应抛
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user)
    assert exc.value.status_code == 429
