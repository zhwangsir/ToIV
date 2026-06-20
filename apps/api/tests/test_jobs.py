import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.ratelimit import _MAX_PER_WINDOW, _hits, enforce_generation_rate_limit
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


def test_rate_limit_blocks_after_max():
    class _U:
        id = "ratelimit-test-user"

    user = _U()
    _hits.pop(user.id, None)
    for _ in range(_MAX_PER_WINDOW):
        enforce_generation_rate_limit(user)  # 不应抛
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user)
    assert exc.value.status_code == 429
