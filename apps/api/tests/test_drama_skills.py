"""M5: Skill 市场雏形 smoke 测试。

覆盖:
  · GET /api/drama/skills 列表(4 个内置)
  · ?category=action 过滤
  · GET /api/drama/skills/{id} 详情
  · 不存在 id → 404
  · POST /api/drama/skills/{id}/apply 一键应用 → 创建 project + characters
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="d")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="d@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_list_skills(ctx):
    """GET /api/drama/skills 返回 4 个内置 Skill。"""
    client, token = ctx
    H = _h(token)
    r = client.get("/api/drama/skills", headers=H)
    assert r.status_code == 200, r.text
    skills = r.json()["skills"]
    assert len(skills) == 4
    ids = {s["id"] for s in skills}
    assert ids == {"skill-wuxia", "skill-romance", "skill-scifi", "skill-comedy"}


def test_list_skills_filter(ctx):
    """?category=action 只返回武侠对决。"""
    client, token = ctx
    H = _h(token)
    r = client.get("/api/drama/skills?category=action", headers=H)
    assert r.status_code == 200, r.text
    skills = r.json()["skills"]
    assert len(skills) == 1
    assert skills[0]["id"] == "skill-wuxia"
    assert skills[0]["name"] == "武侠对决"


def test_get_skill(ctx):
    """GET /api/drama/skills/skill-wuxia 返回详情。"""
    client, token = ctx
    H = _h(token)
    r = client.get("/api/drama/skills/skill-wuxia", headers=H)
    assert r.status_code == 200, r.text
    skill = r.json()
    assert skill["id"] == "skill-wuxia"
    assert skill["default_num_shots"] == 9
    assert len(skill["character_templates"]) == 2
    assert skill["style_hint"] == "wuxia, ancient chinese, cinematic, film grain, martial arts"


def test_get_skill_not_found(ctx):
    """GET /api/drama/skills/xxx 返回 404。"""
    client, token = ctx
    H = _h(token)
    r = client.get("/api/drama/skills/xxx-not-exist", headers=H)
    assert r.status_code == 404
    assert "Skill" in r.json()["detail"]


def test_apply_skill(ctx):
    """POST /api/drama/skills/skill-wuxia/apply 创建 project + 2 characters。"""
    client, token = ctx
    H = _h(token)
    r = client.post("/api/drama/skills/skill-wuxia/apply", headers=H)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["title"] == "武侠对决"
    assert data["style"] == "wuxia, ancient chinese, cinematic, film grain, martial arts"
    assert data["script"]  # 非空(模板剧本)
    assert data["width"] == 768
    assert data["height"] == 384
    assert data["fps"] == 16
    assert "characters" in data
    assert len(data["characters"]) == 2
    names = {c["name"] for c in data["characters"]}
    assert names == {"主角", "对手"}
    # 每个角色应有 visual_prompt
    for c in data["characters"]:
        assert c["visual_prompt"]
    # process_data 应记录 skill_apply
    steps = [s["step"] for s in data["process_data"]]
    assert "skill_apply" in steps


def test_apply_skill_not_found(ctx):
    """POST apply 不存在的 skill → 404。"""
    client, token = ctx
    H = _h(token)
    r = client.post("/api/drama/skills/xxx-not-exist/apply", headers=H)
    assert r.status_code == 404


def test_skills_require_auth(ctx):
    """无鉴权访问 skills → 401。"""
    client, _ = ctx
    assert client.get("/api/drama/skills").status_code == 401
