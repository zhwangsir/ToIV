import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
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
    # 不用 with：跳过 lifespan，避免在真实 SQLite 文件上建表
    yield TestClient(app)
    app.dependency_overrides.clear()


# ---------- 单元：哈希 / JWT ----------
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


# ---------- 集成：注册 / 登录 / me ----------
def test_register_grants_token_and_credits(client):
    r = client.post(
        "/api/auth/register",
        json={"email": "a@toiv.ai", "password": "password1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"]
    assert body["user"]["email"] == "a@toiv.ai"
    assert body["credits"] == 100


def test_register_duplicate_rejected(client):
    payload = {"email": "dup@toiv.ai", "password": "password1"}
    assert client.post("/api/auth/register", json=payload).status_code == 200
    assert client.post("/api/auth/register", json=payload).status_code == 409


def test_register_short_password_rejected(client):
    r = client.post("/api/auth/register", json={"email": "b@toiv.ai", "password": "123"})
    assert r.status_code == 422


def test_register_invalid_email_rejected(client):
    r = client.post("/api/auth/register", json={"email": "notanemail", "password": "password1"})
    assert r.status_code == 422


def test_login_success_and_wrong_password(client):
    client.post("/api/auth/register", json={"email": "c@toiv.ai", "password": "password1"})
    ok = client.post("/api/auth/login", json={"email": "c@toiv.ai", "password": "password1"})
    assert ok.status_code == 200 and ok.json()["token"]
    bad = client.post("/api/auth/login", json={"email": "c@toiv.ai", "password": "nope"})
    assert bad.status_code == 401


def test_me_requires_auth(client):
    assert client.get("/api/auth/me").status_code == 401


def test_me_returns_profile(client):
    reg = client.post(
        "/api/auth/register", json={"email": "d@toiv.ai", "password": "password1"}
    ).json()
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {reg['token']}"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "d@toiv.ai"
    assert r.json()["credits"] == 100


def test_email_normalized_case_insensitive(client):
    client.post("/api/auth/register", json={"email": "Mixed@ToIV.ai", "password": "password1"})
    r = client.post("/api/auth/login", json={"email": "mixed@toiv.ai", "password": "password1"})
    assert r.status_code == 200
