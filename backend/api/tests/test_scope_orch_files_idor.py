"""P-1 IDOR: /api/scope/files 与 /api/audio/orch/files 必须 Job 属主或 sig。

对齐 studio_file_access:鉴权≠授权;跨用户统一 404(不泄露存在性);
属主/admin/合法 HMAC sig → 200。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override

    scope_dir = tmp_path / "scope"
    scope_dir.mkdir(parents=True)
    nas_audio = tmp_path / "nas_audio"
    nas_audio.mkdir(parents=True)
    local_audio = tmp_path / "audio"
    local_audio.mkdir(parents=True)

    monkeypatch.setattr(
        "app.routes.scope.content_subdir", lambda sub: tmp_path / sub
    )
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.audio_output_root", lambda: nas_audio
    )
    monkeypatch.setattr(
        "app.routes.audio_orchestrate.content_subdir", lambda sub: tmp_path / sub
    )

    with Session(engine) as s:
        t = Tenant(name="scope-orch-idor")
        s.add(t)
        s.commit()
        s.refresh(t)
        a = User(
            id="user-a",
            email="a@scope-orch.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="user",
        )
        b = User(
            id="user-b",
            email="b@scope-orch.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="user",
        )
        admin = User(
            id="user-admin",
            email="admin@scope-orch.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="admin",
        )
        s.add(a)
        s.add(b)
        s.add(admin)
        s.commit()
        tenant_id = t.id

    yield {
        "client": TestClient(app),
        "engine": engine,
        "scope_dir": scope_dir,
        "nas_audio": nas_audio,
        "ha": {"Authorization": "Bearer " + create_token("user-a")},
        "hb": {"Authorization": "Bearer " + create_token("user-b")},
        "hadmin": {"Authorization": "Bearer " + create_token("user-admin")},
        "tenant_id": tenant_id,
    }
    app.dependency_overrides.clear()


def _link_job(engine, *, user_id: str, tenant_id: str, kind: str, url: str) -> None:
    with Session(engine) as s:
        s.add(
            Job(
                tenant_id=tenant_id,
                user_id=user_id,
                prompt_id=f"idor-{kind}-{user_id}",
                worker="local",
                kind=kind,
                status="done",
                prompt="idor",
                seed=0,
                result=json.dumps([url], ensure_ascii=False),
            )
        )
        s.commit()


def test_scope_file_other_user_404(ctx):
    name = "scope-" + "a" * 32 + ".mp4"
    (ctx["scope_dir"] / name).write_bytes(b"scope-secret")
    _link_job(
        ctx["engine"],
        user_id="user-a",
        tenant_id=ctx["tenant_id"],
        kind="scope_camera",
        url=f"/api/scope/files/{name}",
    )
    client = ctx["client"]
    r_ok = client.get(f"/api/scope/files/{name}", headers=ctx["ha"])
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.content == b"scope-secret"
    r_deny = client.get(f"/api/scope/files/{name}", headers=ctx["hb"])
    assert r_deny.status_code == 404, (r_deny.status_code, r_deny.text)
    assert "不存在" in r_deny.json().get("detail", "")


def test_scope_file_orphan_denied_admin_ok(ctx):
    name = "scope-" + "b" * 32 + ".mp4"
    (ctx["scope_dir"] / name).write_bytes(b"orphan-scope")
    client = ctx["client"]
    assert client.get(f"/api/scope/files/{name}", headers=ctx["ha"]).status_code == 404
    r = client.get(f"/api/scope/files/{name}", headers=ctx["hadmin"])
    assert r.status_code == 200
    assert r.content == b"orphan-scope"


def test_scope_file_sig_grants_access(ctx):
    from app.services.studio_file_access import studio_file_sig

    name = "scope-" + "c" * 32 + ".mp4"
    (ctx["scope_dir"] / name).write_bytes(b"via-sig-scope")
    sig = studio_file_sig(name)
    client = ctx["client"]
    assert client.get(f"/api/scope/files/{name}", headers=ctx["hb"]).status_code == 404
    assert (
        client.get(f"/api/scope/files/{name}?sig=deadbeef", headers=ctx["hb"]).status_code
        == 404
    )
    r = client.get(f"/api/scope/files/{name}?sig={sig}", headers=ctx["hb"])
    assert r.status_code == 200, r.text
    assert r.content == b"via-sig-scope"


def test_orch_file_other_user_404(ctx):
    name = "audioorch-" + "a" * 32 + ".wav"
    (ctx["nas_audio"] / name).write_bytes(b"orch-secret")
    _link_job(
        ctx["engine"],
        user_id="user-a",
        tenant_id=ctx["tenant_id"],
        kind="audio_orchestrate",
        url=f"/api/audio/orch/files/{name}",
    )
    client = ctx["client"]
    r_ok = client.get(f"/api/audio/orch/files/{name}", headers=ctx["ha"])
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.content == b"orch-secret"
    r_deny = client.get(f"/api/audio/orch/files/{name}", headers=ctx["hb"])
    assert r_deny.status_code == 404, (r_deny.status_code, r_deny.text)
    assert "不存在" in r_deny.json().get("detail", "")


def test_orch_file_orphan_denied_admin_ok(ctx):
    name = "audioorch-" + "b" * 32 + ".wav"
    (ctx["nas_audio"] / name).write_bytes(b"orphan-orch")
    client = ctx["client"]
    assert (
        client.get(f"/api/audio/orch/files/{name}", headers=ctx["ha"]).status_code == 404
    )
    r = client.get(f"/api/audio/orch/files/{name}", headers=ctx["hadmin"])
    assert r.status_code == 200
    assert r.content == b"orphan-orch"


def test_orch_file_sig_grants_access(ctx):
    from app.services.studio_file_access import studio_file_sig

    name = "audioorch-" + "c" * 32 + ".wav"
    (ctx["nas_audio"] / name).write_bytes(b"via-sig-orch")
    sig = studio_file_sig(name)
    client = ctx["client"]
    assert client.get(f"/api/audio/orch/files/{name}", headers=ctx["hb"]).status_code == 404
    r = client.get(f"/api/audio/orch/files/{name}?sig={sig}", headers=ctx["hb"])
    assert r.status_code == 200, r.text
    assert r.content == b"via-sig-orch"


def test_scope_and_orch_still_require_auth(ctx):
    scope_name = "scope-" + "d" * 32 + ".mp4"
    orch_name = "audioorch-" + "d" * 32 + ".wav"
    (ctx["scope_dir"] / scope_name).write_bytes(b"x")
    (ctx["nas_audio"] / orch_name).write_bytes(b"y")
    assert ctx["client"].get(f"/api/scope/files/{scope_name}").status_code == 401
    assert ctx["client"].get(f"/api/audio/orch/files/{orch_name}").status_code == 401
