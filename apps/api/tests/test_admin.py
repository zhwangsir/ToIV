import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


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
        admin_id = _make_user(s, "admin@toiv.ai", role="admin")
        user_id = _make_user(s, "bob@toiv.ai", role="user")
    yield TestClient(app), create_token(admin_id), create_token(user_id), user_id
    app.dependency_overrides.clear()


def test_regular_user_forbidden(ctx):
    client, _, user_token, _ = ctx
    r = client.get("/api/admin/users", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 403


def test_admin_lists_all_users(ctx):
    client, admin_token, _, _ = ctx
    r = client.get("/api/admin/users", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    emails = {u["email"] for u in r.json()}
    assert emails == {"admin@toiv.ai", "bob@toiv.ai"}
    assert all("usage" in u for u in r.json())


def test_admin_deletes_user(ctx):
    client, admin_token, _, user_id = ctx
    r = client.delete(
        f"/api/admin/users/{user_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert r.status_code == 200
    remaining = client.get(
        "/api/admin/users", headers={"Authorization": f"Bearer {admin_token}"}
    ).json()
    assert {u["email"] for u in remaining} == {"admin@toiv.ai"}


def test_admin_creates_account(ctx):
    client, admin_token, _, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/users", headers=h, json={"email": "newbie", "password": "password1", "role": "user"})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "newbie"
    # 重复账号 409
    dup = client.post("/api/admin/users", headers=h, json={"email": "newbie", "password": "password1"})
    assert dup.status_code == 409
    # 新账号可登录
    login = client.post("/api/auth/login", json={"email": "newbie", "password": "password1"})
    assert login.status_code == 200


def test_regular_user_cannot_create_account(ctx):
    client, _, user_token, _ = ctx
    r = client.post(
        "/api/admin/users",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"email": "hacker", "password": "password1"},
    )
    assert r.status_code == 403


def test_admin_cannot_delete_self(ctx):
    client, admin_token, _, _ = ctx
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {admin_token}"}).json()
    r = client.delete(
        f"/api/admin/users/{me['user']['id']}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 400
