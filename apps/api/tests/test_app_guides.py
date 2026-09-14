"""AppGuide 权限与 PUT/GET 契约(P1)。"""
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
from app.services import app_guide_gen


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


def _seed_app(session: Session, aid: str = "demo-app", *, is_public: bool = True) -> None:
    session.add(
        App(
            id=aid,
            name="演示应用",
            description="测试",
            category="image",
            workflow_json={"1": {"class_type": "Stub", "inputs": {}}},
            params_schema=[],
            bindings={},
            required_nodes=[],
            is_builtin=False,
            is_public=is_public,
            user_id="",
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
        _seed_app(s, "demo-app")
        _seed_app(s, "demo-app-2")
        _seed_app(s, "demo-app-3")
    yield TestClient(app), create_token(admin_id), create_token(user_id)
    app.dependency_overrides.clear()


def test_regular_user_forbidden_on_admin_guides(ctx):
    client, _, user_token = ctx
    h = {"Authorization": f"Bearer {user_token}"}
    assert client.get("/api/admin/app-guides", headers=h).status_code == 403
    assert client.get("/api/admin/apps/demo-app/guide", headers=h).status_code == 403
    put = client.put(
        "/api/admin/apps/demo-app/guide",
        headers=h,
        json={"purpose": "x", "status": "published"},
    )
    assert put.status_code == 403


def test_admin_put_get_and_list(ctx):
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    # 尚无记录 → 空壳
    empty = client.get("/api/admin/apps/demo-app/guide", headers=h)
    assert empty.status_code == 200, empty.text
    assert empty.json()["status"] == "draft"
    assert empty.json()["purpose"] == ""

    body = {
        "purpose": "快速出图",
        "when_to_use": "需要一张基础文生图时",
        "steps": ["填写提示词", "点运行"],
        "inputs": ["提示词"],
        "outputs": ["图片"],
        "tips": ["种子可复现"],
        "related_app_ids": ["img2img-basic"],
        "status": "draft",
    }
    put = client.put("/api/admin/apps/demo-app/guide", headers=h, json=body)
    assert put.status_code == 200, put.text
    data = put.json()
    assert data["purpose"] == "快速出图"
    assert data["steps"] == ["填写提示词", "点运行"]
    assert data["status"] == "draft"
    assert data["updated_at"]

    listed = client.get("/api/admin/app-guides", headers=h)
    assert listed.status_code == 200
    assert any(g["app_id"] == "demo-app" for g in listed.json())


def test_public_get_published_only(ctx):
    client, admin_token, user_token = ctx
    ah = {"Authorization": f"Bearer {admin_token}"}
    uh = {"Authorization": f"Bearer {user_token}"}

    # 草稿对普通用户不可见
    client.put(
        "/api/admin/apps/demo-app/guide",
        headers=ah,
        json={"purpose": "草稿用途", "status": "draft"},
    )
    assert client.get("/api/apps/demo-app/guide", headers=uh).status_code == 404

    # 发布后可读
    client.put(
        "/api/admin/apps/demo-app/guide",
        headers=ah,
        json={
            "purpose": "已发布用途",
            "when_to_use": "日常",
            "steps": ["一步"],
            "inputs": [],
            "outputs": [],
            "tips": [],
            "related_app_ids": [],
            "status": "published",
        },
    )
    r = client.get("/api/apps/demo-app/guide", headers=uh)
    assert r.status_code == 200, r.text
    assert r.json()["purpose"] == "已发布用途"
    assert r.json()["status"] == "published"

    # 未登录 401
    assert client.get("/api/apps/demo-app/guide").status_code == 401


def test_admin_put_unknown_app_404(ctx):
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.put(
        "/api/admin/apps/no-such-app/guide",
        headers=h,
        json={"purpose": "x", "status": "draft"},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# LLM 生成草稿(generate)+ 批量发布(publish-all)+ AppOut 摘要
# ---------------------------------------------------------------------------

_GUIDE_PAYLOAD = {
    "purpose": "把文字描述变成图片的应用",
    "when_to_use": "需要快速出一张配图时",
    "steps": ["填写提示词", "点击运行", "下载图片"],
    "inputs": "一段中文或英文提示词",
    "outputs": "一张图片,约 1 分钟",
    "tips": "提示词越具体效果越好",
}


def _mock_chat_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """打桩 LLM(禁真实触达生产 LLM):返回合法说明卡 JSON。"""

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4,
                        enable_thinking=None):
        return {"content": json.dumps(_GUIDE_PAYLOAD, ensure_ascii=False)}

    monkeypatch.setattr(app_guide_gen, "chat", fake_chat)


def test_generate_forbidden_for_regular_user(ctx):
    client, _, user_token = ctx
    h = {"Authorization": f"Bearer {user_token}"}
    r = client.post("/api/admin/apps/demo-app/guide/generate", headers=h)
    assert r.status_code == 403


def test_generate_draft_saved_but_not_public(ctx, monkeypatch):
    _mock_chat_ok(monkeypatch)
    client, admin_token, user_token = ctx
    ah = {"Authorization": f"Bearer {admin_token}"}
    uh = {"Authorization": f"Bearer {user_token}"}

    r = client.post("/api/admin/apps/demo-app/guide/generate", headers=ah)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "draft"
    assert data["purpose"] == _GUIDE_PAYLOAD["purpose"]
    assert data["steps"] == _GUIDE_PAYLOAD["steps"]
    # 字符串字段按 AppGuide list 列语义落库
    assert data["inputs"] == [_GUIDE_PAYLOAD["inputs"]]
    assert data["tips"] == [_GUIDE_PAYLOAD["tips"]]

    # admin 可读草稿
    g = client.get("/api/admin/apps/demo-app/guide", headers=ah)
    assert g.status_code == 200
    assert g.json()["status"] == "draft"
    assert g.json()["purpose"] == _GUIDE_PAYLOAD["purpose"]

    # 草稿不公开
    assert client.get("/api/apps/demo-app/guide", headers=uh).status_code == 404


def test_generate_unknown_app_404(ctx, monkeypatch):
    _mock_chat_ok(monkeypatch)
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/no-such-app/guide/generate", headers=h)
    assert r.status_code == 404


def test_generate_bad_llm_json_503(ctx, monkeypatch):
    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4,
                        enable_thinking=None):
        return {"content": "这不是 JSON"}

    monkeypatch.setattr(app_guide_gen, "chat", fake_chat)
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/demo-app/guide/generate", headers=h)
    assert r.status_code == 503, r.text


def test_generate_bad_llm_structure_503(ctx, monkeypatch):
    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4,
                        enable_thinking=None):
        return {"content": json.dumps({"steps": "应为数组", "purpose": ""})}

    monkeypatch.setattr(app_guide_gen, "chat", fake_chat)
    client, admin_token, _ = ctx
    h = {"Authorization": f"Bearer {admin_token}"}
    r = client.post("/api/admin/apps/demo-app/guide/generate", headers=h)
    assert r.status_code == 503, r.text


def test_publish_all(ctx):
    client, admin_token, user_token = ctx
    ah = {"Authorization": f"Bearer {admin_token}"}
    uh = {"Authorization": f"Bearer {user_token}"}

    # 2 draft + 1 published
    for aid in ("demo-app", "demo-app-2"):
        r = client.put(
            f"/api/admin/apps/{aid}/guide", headers=ah,
            json={"purpose": f"{aid} 草稿", "status": "draft"},
        )
        assert r.status_code == 200, r.text
    r = client.put(
        "/api/admin/apps/demo-app-3/guide", headers=ah,
        json={"purpose": "已发布用途", "status": "published"},
    )
    assert r.status_code == 200, r.text

    # 非 admin 403
    assert client.post("/api/admin/app-guides/publish-all", headers=uh).status_code == 403

    r = client.post("/api/admin/app-guides/publish-all", headers=ah)
    assert r.status_code == 200, r.text
    assert r.json() == {"published": 2}

    # draft 全变 published 且公开可读;原 published 内容未动
    for aid in ("demo-app", "demo-app-2"):
        g = client.get(f"/api/apps/{aid}/guide", headers=uh)
        assert g.status_code == 200, g.text
        assert g.json()["status"] == "published"
        assert g.json()["purpose"] == f"{aid} 草稿"
    g3 = client.get("/api/apps/demo-app-3/guide", headers=uh)
    assert g3.status_code == 200
    assert g3.json()["purpose"] == "已发布用途"

    # 幂等:再无 draft
    r = client.post("/api/admin/app-guides/publish-all", headers=ah)
    assert r.json() == {"published": 0}


def test_app_out_guide_summary(ctx):
    client, admin_token, user_token = ctx
    ah = {"Authorization": f"Bearer {admin_token}"}
    uh = {"Authorization": f"Bearer {user_token}"}

    client.put(
        "/api/admin/apps/demo-app/guide", headers=ah,
        json={"purpose": "已发布用途", "status": "published"},
    )
    client.put(
        "/api/admin/apps/demo-app-2/guide", headers=ah,
        json={"purpose": "草稿用途", "status": "draft"},
    )

    # 详情:published 带摘要,draft 不带
    d = client.get("/api/apps/demo-app", headers=uh)
    assert d.status_code == 200, d.text
    assert d.json()["has_guide"] is True
    assert d.json()["guide_purpose"] == "已发布用途"
    d2 = client.get("/api/apps/demo-app-2", headers=uh)
    assert d2.json()["has_guide"] is False
    assert d2.json()["guide_purpose"] is None
    d3 = client.get("/api/apps/demo-app-3", headers=uh)
    assert d3.json()["has_guide"] is False

    # 列表:同样只透 published
    lst = client.get("/api/apps", headers=uh)
    assert lst.status_code == 200, lst.text
    by_id = {a["id"]: a for a in lst.json()}
    assert by_id["demo-app"]["has_guide"] is True
    assert by_id["demo-app"]["guide_purpose"] == "已发布用途"
    assert by_id["demo-app-2"]["has_guide"] is False
    assert by_id["demo-app-2"]["guide_purpose"] is None
