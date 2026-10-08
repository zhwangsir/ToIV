"""受限服务令牌(scope)与令牌吊销清单。"""
import json
import time

import jwt as pyjwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app import token_policy
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, decode_token_claims, hash_password, token_sha256

PW = "service-pass-1"


@pytest.fixture
def env(monkeypatch, tmp_path):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    ids = {}
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        for email, role in (("svc_canvas_h3", "user"), ("boss", "admin"), ("tester", "user")):
            u = User(email=email, hashed_password=hash_password(PW), tenant_id=tenant.id, role=role)
            s.add(u)
            s.commit()
            s.refresh(u)
            ids[email] = u.id
    settings = get_settings()
    monkeypatch.setattr(settings, "service_accounts", "svc_canvas_h3, boss")
    monkeypatch.setattr(settings, "service_token_expire_minutes", 60)
    revoked = tmp_path / "revoked.json"
    monkeypatch.setattr(settings, "revoked_tokens_file", str(revoked))
    token_policy.reset_cache_for_tests()
    yield TestClient(app), ids, revoked
    app.dependency_overrides.clear()
    token_policy.reset_cache_for_tests()


def mint(client, email="svc_canvas_h3", scope="h3", password=PW):
    return client.post("/api/auth/service-token", json={"email": email, "password": password, "scope": scope})


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_endpoint_closed_without_service_accounts(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setattr(get_settings(), "service_accounts", "")
    assert mint(client).status_code == 404


def test_issue_rules(env):
    client, ids, _ = env
    r = mint(client)
    assert r.status_code == 200, r.text
    body = r.json()
    claims = decode_token_claims(body["token"])
    assert claims["scope"] == "h3" and claims["typ"] == "service" and claims["sub"] == ids["svc_canvas_h3"]
    assert 0 < claims["exp"] - claims["iat"] <= 3600
    assert mint(client, password="wrong").status_code == 401
    assert mint(client, email="tester").status_code == 403  # not a listed service account
    assert mint(client, email="boss").status_code == 403  # listed, but admins never get service tokens
    assert mint(client, scope="admin").status_code == 400


def test_h3_scope_allows_only_h3_endpoints(env):
    client, _, _ = env
    tok = mint(client).json()["token"]
    h = bearer(tok)
    # allowed: authentication passes (the route then validates its own input)
    for method, path, kw in (
        ("POST", "/api/h3/t2v", {"json": {}}),
        ("POST", "/api/h3/i2v", {"json": {}}),
        ("POST", "/api/h3/fl2v", {"json": {}}),
        ("POST", "/api/h3/r2v", {"json": {}}),
        ("POST", "/api/upload?kind=h3_i2v", {}),
    ):
        st = client.request(method, path, headers=h, **kw).status_code
        assert st not in (401, 403), (method, path, st)
    # everything else: 403 before the route runs
    for method, path, kw in (
        ("GET", "/api/auth/me", {}),
        ("GET", "/api/jobs", {}),
        ("GET", "/api/jobs/counts", {}),
        ("POST", "/api/jobs/bulk-delete", {"json": {}}),
        ("GET", "/api/admin/users", {}),
        ("POST", "/api/upload?kind=img2img", {}),
        ("POST", "/api/upload", {}),
        ("POST", "/api/h3/multishot", {"json": {}}),
        ("POST", "/api/llm/v1/chat/completions", {"json": {}}),
        ("GET", "/api/h3/t2v", {}),
    ):
        st = client.request(method, path, headers=h, **kw).status_code
        assert st in (403, 405), (method, path, st)
        if st == 405:
            continue
        assert client.request(method, path, headers=h, **kw).json()["detail"] == "服务令牌无权访问该接口"
    # same scope via ?token= query is enforced identically
    assert client.get(f"/api/auth/me?token={tok}").status_code == 403


def test_llm_scope(env):
    client, _, _ = env
    h = bearer(mint(client, scope="llm").json()["token"])
    assert client.get("/api/auth/me", headers=h).status_code == 403
    assert client.post("/api/h3/t2v", headers=h, json={}).status_code == 403
    assert client.get("/api/llm/v1/models", headers=h).status_code not in (401, 403)


def test_unknown_or_forged_scope_tokens(env):
    client, ids, _ = env
    unknown = create_token(ids["svc_canvas_h3"], scope="everything")
    assert client.get("/api/auth/me", headers=bearer(unknown)).status_code == 403
    forged = pyjwt.encode({"sub": ids["boss"], "exp": int(time.time()) + 600, "scope": "h3"}, "attacker-key-attacker-key-attacker-key", algorithm="HS256")
    assert client.post("/api/h3/t2v", headers=bearer(forged), json={}).status_code == 401
    # a correctly signed scoped token for an admin account is still refused
    admin_scoped = create_token(ids["boss"], scope="h3")
    assert client.post("/api/h3/t2v", headers=bearer(admin_scoped), json={}).status_code == 403


def test_full_login_tokens_unaffected(env):
    client, _, _ = env
    tok = client.post("/api/auth/login", json={"email": "tester", "password": PW}).json()["token"]
    assert client.get("/api/auth/me", headers=bearer(tok)).status_code == 200


def test_revocation_by_fingerprint_and_by_user(env):
    client, ids, revoked = env
    admin_old = create_token(ids["boss"])
    other = create_token(ids["tester"])
    assert client.get("/api/auth/me", headers=bearer(admin_old)).status_code == 200
    revoked.write_text(json.dumps({"tokens": [token_sha256(admin_old)]}))
    r = client.get("/api/auth/me", headers=bearer(admin_old))
    assert r.status_code == 401 and r.json()["detail"] == "令牌已吊销"
    assert client.get("/api/auth/me", headers=bearer(other)).status_code == 200
    # per-user cut-off: every token issued before the cut-off (incl. legacy tokens without iat) dies
    legacy = pyjwt.encode({"sub": ids["tester"], "exp": int(time.time()) + 600}, get_settings().jwt_secret, algorithm="HS256")
    time.sleep(0.01)
    revoked.write_text(json.dumps({"tokens": [], "users": {ids["tester"]: int(time.time()) + 1}}))
    assert client.get("/api/auth/me", headers=bearer(other)).status_code == 401
    assert client.get("/api/auth/me", headers=bearer(legacy)).status_code == 401
    # a corrupt file keeps the last good list instead of reopening revoked tokens
    revoked.write_text("{not json")
    assert client.get("/api/auth/me", headers=bearer(other)).status_code == 401
