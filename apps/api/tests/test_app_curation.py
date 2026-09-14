"""市场策展层(2026-09-12):use_case 打标 / curation PUT / summary / 列表过滤契约。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import App, Tenant, User
from app.security import create_token, hash_password
from app.services import app_use_case_gen


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


def _seed_app(session: Session, aid: str, **kw) -> None:
    session.add(
        App(
            id=aid,
            name=kw.pop("name", f"应用 {aid}"),
            description=kw.pop("description", "测试"),
            category=kw.pop("category", "image"),
            workflow_json={"1": {"class_type": "Stub", "inputs": {}}},
            params_schema=[],
            bindings={},
            required_nodes=[],
            is_builtin=False,
            is_public=kw.pop("is_public", True),
            is_nsfw=kw.pop("is_nsfw", False),
            user_id="",
            **kw,
        )
    )
    session.commit()


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
        _seed_app(s, "app-drama", use_case="drama")
        _seed_app(s, "app-drama-2", use_case="drama", featured=True)
        _seed_app(s, "app-face", use_case="face")
        _seed_app(s, "app-nsfw", use_case="drama", is_nsfw=True)
        _seed_app(s, "app-hidden", use_case="drama", is_public=False)
        _seed_app(s, "app-untagged")  # use_case 空
    yield TestClient(app), create_token(admin_id), create_token(user_id)
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# POST /api/admin/apps/{aid}/use-case/generate
# ---------------------------------------------------------------------------

def _mock_chat(monkeypatch: pytest.MonkeyPatch, content: str) -> None:
    """打桩 LLM(禁真实触达生产 LLM)。"""

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4,
                        enable_thinking=None):
        return {"content": content}

    monkeypatch.setattr(app_use_case_gen, "chat", fake_chat)


def test_generate_forbidden_for_regular_user(ctx):
    client, _, user_token = ctx
    h = {"Authorization": f"Bearer {user_token}"}
    r = client.post("/api/admin/apps/app-face/use-case/generate", headers=h)
    assert r.status_code == 403


def test_generate_unknown_app_404(ctx, monkeypatch):
    _mock_chat(monkeypatch, json.dumps({"use_case": "drama"}))
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/no-such-app/use-case/generate", headers=h)
    assert r.status_code == 404


def test_generate_valid_enum_written(ctx, monkeypatch):
    _mock_chat(monkeypatch, json.dumps({"use_case": "avatar"}))
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/app-untagged/use-case/generate", headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {"app_id": "app-untagged", "use_case": "avatar", "fallback": False}
    # 详情透出
    d = client.get("/api/apps/app-untagged", headers=h)
    assert d.json()["use_case"] == "avatar"


def test_generate_out_of_enum_falls_back_to_other(ctx, monkeypatch):
    _mock_chat(monkeypatch, json.dumps({"use_case": "not-a-real-use-case"}))
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/app-untagged/use-case/generate", headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {"app_id": "app-untagged", "use_case": "other", "fallback": True}


def test_generate_bad_llm_json_503(ctx, monkeypatch):
    _mock_chat(monkeypatch, "这不是 JSON")
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/app-untagged/use-case/generate", headers=h)
    assert r.status_code == 503, r.text


# ---------------------------------------------------------------------------
# PUT /api/admin/apps/{aid}/curation
# ---------------------------------------------------------------------------

def test_curation_put_updates_columns(ctx):
    client, admin_token, user_token = ctx
    ah = {"Authorization": f"Bearer {admin_token}"}
    uh = {"Authorization": f"Bearer {user_token}"}

    # 非 admin 403
    r = client.put(
        "/api/admin/apps/app-face/curation", headers=uh,
        json={"use_case": "anime"},
    )
    assert r.status_code == 403

    r = client.put(
        "/api/admin/apps/app-face/curation", headers=ah,
        json={"use_case": "anime", "featured": True},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"app_id": "app-face", "use_case": "anime", "featured": True}

    # 部分字段:只改 featured
    r = client.put(
        "/api/admin/apps/app-face/curation", headers=ah,
        json={"featured": False},
    )
    assert r.status_code == 200, r.text
    assert r.json()["use_case"] == "anime"  # 未被清空
    assert r.json()["featured"] is False

    # 详情透出
    d = client.get("/api/apps/app-face", headers=uh)
    assert d.json()["use_case"] == "anime"
    assert d.json()["featured"] is False


def test_curation_put_invalid_use_case_422(ctx):
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.put(
        "/api/admin/apps/app-face/curation", headers=h,
        json={"use_case": "nonsense"},
    )
    assert r.status_code == 422


def test_curation_put_unknown_app_404(ctx):
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.put(
        "/api/admin/apps/no-such-app/curation", headers=h,
        json={"featured": True},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/apps/use-cases/summary
# ---------------------------------------------------------------------------

def test_summary_counts_and_nsfw_gating(ctx):
    client, admin_token, user_token = ctx
    ah = {"Authorization": f"Bearer {admin_token}"}
    uh = {"Authorization": f"Bearer {user_token}"}

    # 普通用户无 X-NSFW 头:drama = app-drama + app-drama-2(nsfw/hidden 均不计)
    r = client.get("/api/apps/use-cases/summary", headers=uh)
    assert r.status_code == 200, r.text
    rows = {x["id"]: x for x in r.json()}
    assert len(rows) == 12
    assert rows["drama"] == {"id": "drama", "label": "短剧剧情", "count": 2}
    assert rows["face"]["count"] == 1
    assert rows["other"]["count"] == 0

    # 带 X-NSFW 头:nsfw 应用计入
    r = client.get("/api/apps/use-cases/summary",
                   headers={**uh, "X-NSFW": "1"})
    rows = {x["id"]: x for x in r.json()}
    assert rows["drama"]["count"] == 3

    # admin 可见 soft-hide:hidden 计入
    r = client.get("/api/apps/use-cases/summary", headers=ah)
    rows = {x["id"]: x for x in r.json()}
    assert rows["drama"]["count"] == 3

    # 未登录 401
    assert client.get("/api/apps/use-cases/summary").status_code == 401


# ---------------------------------------------------------------------------
# 列表过滤参数 + AppOut 透出
# ---------------------------------------------------------------------------

def test_list_use_case_and_featured_filters(ctx):
    client, _, user_token = ctx
    uh = {"Authorization": f"Bearer {user_token}"}

    # AppOut 透出
    lst = client.get("/api/apps", headers=uh)
    assert lst.status_code == 200, lst.text
    by_id = {a["id"]: a for a in lst.json()}
    assert by_id["app-drama"]["use_case"] == "drama"
    assert by_id["app-drama"]["featured"] is False
    assert by_id["app-drama-2"]["featured"] is True
    assert by_id["app-untagged"]["use_case"] == ""
    # nsfw/hidden 按列表口径不进列表
    assert "app-nsfw" not in by_id
    assert "app-hidden" not in by_id

    # use_case 过滤
    lst = client.get("/api/apps?use_case=drama", headers=uh)
    ids = {a["id"] for a in lst.json()}
    assert ids == {"app-drama", "app-drama-2"}

    # featured 过滤
    lst = client.get("/api/apps?featured=true", headers=uh)
    ids = {a["id"] for a in lst.json()}
    assert ids == {"app-drama-2"}

    # 组合过滤
    lst = client.get("/api/apps?use_case=drama&featured=true", headers=uh)
    ids = {a["id"] for a in lst.json()}
    assert ids == {"app-drama-2"}

    # 不传不过滤(原有行为):use_case 为空的也在
    lst = client.get("/api/apps?use_case=", headers=uh)
    ids = {a["id"] for a in lst.json()}
    assert "app-untagged" in ids
