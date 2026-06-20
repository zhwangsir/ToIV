import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import (
    create_token,
    decode_token,
    hash_password,
    verify_password,
)


@pytest.fixture
def client():
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
    # 直接播种一个账号(无自助注册)
    with Session(engine) as s:
        tenant = Tenant(name="tester")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        s.add(
            User(
                email="tester",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
        )
        s.commit()
    yield TestClient(app)
    app.dependency_overrides.clear()


# ---------- 单元:哈希 / JWT ----------
def test_password_hash_roundtrip():
    h = hash_password("s3cret-pw")
    assert h != "s3cret-pw"
    assert verify_password("s3cret-pw", h)
    assert not verify_password("wrong", h)


def test_password_hash_is_salted():
    assert hash_password("same") != hash_password("same")


def test_jwt_roundtrip():
    token = create_token("user-123")
    assert decode_token(token) == "user-123"


def test_jwt_tampered_rejected():
    assert decode_token("not.a.jwt") is None


# ---------- 集成:登录 / me ----------
def test_no_public_register(client):
    # 自助注册端点已移除
    assert client.post("/api/auth/register", json={"email": "x", "password": "y"}).status_code == 404


def test_login_success_and_wrong_password(client):
    ok = client.post("/api/auth/login", json={"email": "tester", "password": "password1"})
    assert ok.status_code == 200 and ok.json()["token"]
    bad = client.post("/api/auth/login", json={"email": "tester", "password": "nope"})
    assert bad.status_code == 401


def test_login_account_case_insensitive(client):
    r = client.post("/api/auth/login", json={"email": "TESTER", "password": "password1"})
    assert r.status_code == 200


def test_me_requires_auth(client):
    assert client.get("/api/auth/me").status_code == 401


def test_me_returns_profile_and_usage(client):
    token = client.post(
        "/api/auth/login", json={"email": "tester", "password": "password1"}
    ).json()["token"]
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["email"] == "tester"
    assert body["user"]["role"] == "user"
    assert body["usage"]["total"] == 0
