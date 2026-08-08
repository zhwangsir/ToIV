"""智能体系统(/api/agents CRUD + /api/optimize agent_id + /api/account/preferences)测试。

覆盖:
  - 内置种子幂等播种(seed_builtin_agents 重复调不覆盖用户改过的)
  - CRUD:list / get / create / update / delete(内置拒删)
  - NSFW 智能体对未授权用户不可见(列表 + 详情均不泄露)
  - kind 过滤(含 'all' 也返回)
  - optimize 带 agent_id:智能体 system_prompt 拼在 kind 系统提示前
  - optimize NSFW 智能体无 X-NSFW → 403;applies_to 不含 kind → 400;不存在 → 404
  - optimize 回退 user.default_agent_id
  - account/preferences 改默认智能体
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agents_seed import BUILTIN_AGENTS, seed_builtin_agents
from app.db import get_session
from app.main import app
from app.models import Agent, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
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
        # 播种内置智能体(模拟启动 lifespan 的 seed)
        seed_builtin_agents(s)
        admin_id = _make_user(s, "admin@toiv.ai", role="admin")
        user_id = _make_user(s, "bob@toiv.ai", role="user")
    yield TestClient(app), create_token(admin_id), create_token(user_id), engine
    app.dependency_overrides.clear()


# --------------------------------------------------------------------------- #
# 种子幂等
# --------------------------------------------------------------------------- #
def test_seed_is_idempotent():
    """重复调 seed_builtin_agents 不重复插入、不覆盖用户改过的。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        n1 = seed_builtin_agents(s)
        assert n1 == len(BUILTIN_AGENTS)
        # 改一个内置智能体的 system_prompt(模拟用户改过)
        a = s.get(Agent, "realist")
        a.system_prompt = "USER_CUSTOMIZED"
        s.add(a)
        s.commit()
        # 再 seed:应跳过所有(不覆盖用户改的)
        n2 = seed_builtin_agents(s)
        assert n2 == 0
        a2 = s.get(Agent, "realist")
        assert a2.system_prompt == "USER_CUSTOMIZED"


def test_builtin_agents_count():
    """设计文档表格定义的 15 个内置智能体(8 图像 + 配音 + 训练 + 5 NSFW)。"""
    assert len(BUILTIN_AGENTS) == 15
    ids = {a["id"] for a in BUILTIN_AGENTS}
    assert "realist" in ids and "nsfw_photographer" in ids and "voice_dub" in ids
    # 2026-08-08 P1-6 新增 3 个 NSFW 视频向智能体(运镜/短剧剧情/LongCat 长镜头)
    assert "nsfw_camera_director" in ids
    assert "nsfw_drama_writer" in ids
    assert "nsfw_longcat_shot" in ids


# --------------------------------------------------------------------------- #
# 列表 + NSFW 可见性 + kind 过滤
# --------------------------------------------------------------------------- #
def test_list_returns_all_sfw_for_normal_user(ctx):
    c, _, user_token, _ = ctx
    r = c.get("/api/agents", headers={"Authorization": f"Bearer {user_token}"})
    assert r.status_code == 200, r.text
    ids = {a["id"] for a in r.json()}
    # SFW 内置全在
    assert "realist" in ids and "anime" in ids and "voice_dub" in ids
    # NSFW 对未授权用户不可见
    assert "nsfw_photographer" not in ids
    assert "nsfw_anime" not in ids


def test_list_includes_nsfw_with_r18_header(ctx):
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents",
        headers={"Authorization": f"Bearer {user_token}", "X-NSFW": "1"},
    )
    assert r.status_code == 200
    ids = {a["id"] for a in r.json()}
    assert "nsfw_photographer" in ids and "nsfw_anime" in ids
    # 新增 NSFW 视频向智能体同样仅 R18 上下文可见
    assert "nsfw_camera_director" in ids
    assert "nsfw_drama_writer" in ids
    assert "nsfw_longcat_shot" in ids


def test_nsfw_video_agents_hidden_from_main_site(ctx):
    """新增 3 个 NSFW 视频智能体:主站(无 X-NSFW)列表不可见,详情 404。"""
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents?kind=video",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r.status_code == 200
    ids = {a["id"] for a in r.json()}
    assert "nsfw_camera_director" not in ids
    assert "nsfw_drama_writer" not in ids
    assert "nsfw_longcat_shot" not in ids

    # kind=video + X-NSFW:3 个新智能体按 applies_to=video 过滤命中
    r2 = c.get(
        "/api/agents?kind=video",
        headers={"Authorization": f"Bearer {user_token}", "X-NSFW": "1"},
    )
    ids2 = {a["id"] for a in r2.json()}
    assert "nsfw_camera_director" in ids2
    assert "nsfw_drama_writer" in ids2
    assert "nsfw_longcat_shot" in ids2

    # 详情:无头 404(不泄露存在性),带头 200
    r3 = c.get(
        "/api/agents/nsfw_camera_director",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r3.status_code == 404
    r4 = c.get(
        "/api/agents/nsfw_camera_director",
        headers={"Authorization": f"Bearer {user_token}", "X-NSFW": "1"},
    )
    assert r4.status_code == 200
    assert r4.json()["is_nsfw"] is True


def test_list_kind_filter(ctx):
    c, _, user_token, _ = ctx
    # kind=audio:只返回 applies_to 含 audio 或 all 的
    r = c.get(
        "/api/agents?kind=audio",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r.status_code == 200
    ids = {a["id"] for a in r.json()}
    # voice_dub(audio) + 所有 all 智能体
    assert "voice_dub" in ids
    assert "realist" in ids  # all
    # train_data(train)不在 audio 列表
    assert "train_data" not in ids


def test_list_kind_train_filter(ctx):
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents?kind=train",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    ids = {a["id"] for a in r.json()}
    assert "train_data" in ids
    assert "voice_dub" not in ids  # audio only


def test_list_sorted_by_sort(ctx):
    c, _, user_token, _ = ctx
    r = c.get("/api/agents", headers={"Authorization": f"Bearer {user_token}"})
    sorts = [a["sort"] for a in r.json()]
    assert sorts == sorted(sorts)


def test_list_requires_auth(ctx):
    c, *_ = ctx
    assert c.get("/api/agents").status_code == 401


# --------------------------------------------------------------------------- #
# 详情 + NSFW
# --------------------------------------------------------------------------- #
def test_get_detail(ctx):
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents/realist",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["id"] == "realist"
    assert a["is_builtin"] is True
    assert isinstance(a["applies_to"], list)
    assert "all" in a["applies_to"]


def test_get_nsfw_detail_hidden_for_unauthorized(ctx):
    """NSFW 智能体对未授权用户返 404(不泄露存在性)。"""
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents/nsfw_photographer",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r.status_code == 404


def test_get_nsfw_detail_visible_with_r18(ctx):
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents/nsfw_photographer",
        headers={"Authorization": f"Bearer {user_token}", "X-NSFW": "1"},
    )
    assert r.status_code == 200
    assert r.json()["is_nsfw"] is True


def test_get_nonexistent(ctx):
    c, _, user_token, _ = ctx
    r = c.get(
        "/api/agents/nope",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 创建 + 鉴权
# --------------------------------------------------------------------------- #
def test_create_custom_agent(ctx):
    c, admin_token, _, _ = ctx
    body = {
        "id": "my_agent",
        "name": "我的智能体",
        "system_prompt": "你是自定义风格师。",
        "applies_to": "image",
        "sort": 500,
    }
    r = c.post("/api/agents", headers={"Authorization": f"Bearer {admin_token}"}, json=body)
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["id"] == "my_agent"
    assert a["is_builtin"] is False  # API 创建永远自定义
    assert a["applies_to"] == ["image"]


def test_create_requires_admin(ctx):
    c, _, user_token, _ = ctx
    r = c.post(
        "/api/agents",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"id": "x", "name": "x", "system_prompt": "x"},
    )
    assert r.status_code == 403


def test_create_duplicate_id(ctx):
    c, admin_token, _, _ = ctx
    r = c.post(
        "/api/agents",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"id": "realist", "name": "dup", "system_prompt": "x"},  # 已存在内置
    )
    assert r.status_code == 409


# --------------------------------------------------------------------------- #
# 更新 + is_builtin 不可变
# --------------------------------------------------------------------------- #
def test_update_builtin_system_prompt(ctx):
    c, admin_token, _, _ = ctx
    r = c.put(
        "/api/agents/realist",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"system_prompt": "新的写实风格提示", "name": "超级写实"},
    )
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["system_prompt"] == "新的写实风格提示"
    assert a["name"] == "超级写实"
    # 内置的 is_builtin 不变
    assert a["is_builtin"] is True


def test_update_is_builtin_ignored(ctx):
    """尝试改 is_builtin 应被忽略(内置永为内置,自定义永为自定义)。"""
    c, admin_token, _, _ = ctx
    # 先建一个自定义
    c.post(
        "/api/agents",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"id": "custom1", "name": "c", "system_prompt": "x"},
    )
    # 尝试提升为内置
    r = c.put(
        "/api/agents/custom1",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"is_builtin": True},
    )
    assert r.status_code == 200
    assert r.json()["is_builtin"] is False  # 仍是自定义


def test_update_requires_admin(ctx):
    c, _, user_token, _ = ctx
    r = c.put(
        "/api/agents/realist",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"name": "hack"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# 删除 + 内置拒删
# --------------------------------------------------------------------------- #
def test_delete_builtin_forbidden(ctx):
    c, admin_token, _, _ = ctx
    r = c.delete(
        "/api/agents/realist",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 403


def test_delete_custom_ok(ctx):
    c, admin_token, _, _ = ctx
    c.post(
        "/api/agents",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"id": "tmp", "name": "t", "system_prompt": "x"},
    )
    r = c.delete(
        "/api/agents/tmp",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    # 确认已删
    assert c.get(
        "/api/agents/tmp", headers={"Authorization": f"Bearer {admin_token}"}
    ).status_code == 404


def test_delete_requires_admin(ctx):
    c, _, user_token, _ = ctx
    r = c.delete(
        "/api/agents/realist",
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# optimize 带 agent_id
# --------------------------------------------------------------------------- #
def _patch_llm(monkeypatch) -> dict:
    captured: dict = {}

    async def fake_chat(messages, tools=None, max_tokens=None, temperature=0.4):  # noqa: ANN001
        captured["system"] = messages[0]["content"]
        return {"content": '{"category": "portrait", "positive": "a girl", "negative": "bad"}'}

    monkeypatch.setattr("app.routes.optimize.llm.chat", fake_chat)
    return captured


def test_optimize_with_agent_id_prepends_persona(ctx, monkeypatch):
    """agent.system_prompt 必须拼在 kind 系统提示之前。"""
    c, _, user_token, _ = ctx
    captured = _patch_llm(monkeypatch)
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"prompt": "一个女孩", "kind": "image", "agent_id": "realist"},
    )
    assert r.status_code == 200, r.text
    sys_prompt = captured["system"]
    # realist 的人格词在前,kind 系统提示在后
    assert "摄影" in sys_prompt  # realist 人格词
    # realist 人格在前,kind 基底在后(含内容感知规则)
    assert sys_prompt.index("摄影") < sys_prompt.index("正向提示词")


def test_optimize_agent_not_found(ctx, monkeypatch):
    c, _, user_token, _ = ctx
    _patch_llm(monkeypatch)
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"prompt": "x", "kind": "image", "agent_id": "ghost"},
    )
    assert r.status_code == 404


def test_optimize_nsfw_agent_without_header_forbidden(ctx, monkeypatch):
    c, _, user_token, _ = ctx
    _patch_llm(monkeypatch)
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"prompt": "x", "kind": "image", "agent_id": "nsfw_photographer"},
    )
    assert r.status_code == 403


def test_optimize_nsfw_agent_with_header_ok(ctx, monkeypatch):
    c, _, user_token, _ = ctx
    captured = _patch_llm(monkeypatch)
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}", "X-NSFW": "1"},
        json={"prompt": "x", "kind": "image", "agent_id": "nsfw_photographer"},
    )
    assert r.status_code == 200, r.text
    assert "NSFW" in captured["system"] or "不拒绝" in captured["system"]


def test_optimize_agent_applies_to_mismatch(ctx, monkeypatch):
    """agent.applies_to 不含 kind 且不含 all → 400。"""
    c, _, user_token, _ = ctx
    _patch_llm(monkeypatch)
    # voice_dub 只适用于 audio,拿来优化 image 应 400
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"prompt": "x", "kind": "image", "agent_id": "voice_dub"},
    )
    assert r.status_code == 400


def test_optimize_falls_back_to_user_default_agent(ctx, monkeypatch):
    """agent_id 为空时读 user.default_agent_id。"""
    c, _, user_token, engine = ctx
    # 设默认智能体
    with Session(engine) as s:
        from sqlmodel import select

        u = s.exec(select(User).where(User.email == "bob@toiv.ai")).first()
        u.default_agent_id = "anime"
        s.add(u)
        s.commit()
    captured = _patch_llm(monkeypatch)
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"prompt": "x", "kind": "image"},  # 不传 agent_id
    )
    assert r.status_code == 200, r.text
    assert "danbooru" in captured["system"]  # anime 人格词


def test_optimize_no_agent_uses_kind_default(ctx, monkeypatch):
    """无 agent_id 且无默认 → 走原 kind 系统提示(不含人格前缀)。"""
    c, _, user_token, _ = ctx
    captured = _patch_llm(monkeypatch)
    r = c.post(
        "/api/optimize",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"prompt": "x", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    # 原始 kind 基底含「内容感知规则」但不含某个智能体的人格词
    assert "摄影" not in captured["system"]


# --------------------------------------------------------------------------- #
# account/preferences
# --------------------------------------------------------------------------- #
def test_set_preferences(ctx):
    c, _, user_token, engine = ctx
    r = c.put(
        "/api/account/preferences",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"default_agent_id": "cinematic"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["default_agent_id"] == "cinematic"
    # 落库:/auth/me 也应反映
    me = c.get("/api/auth/me", headers={"Authorization": f"Bearer {user_token}"}).json()
    assert me["user"]["default_agent_id"] == "cinematic"


def test_set_preferences_clear(ctx):
    c, _, user_token, _ = ctx
    # 先设
    c.put(
        "/api/account/preferences",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"default_agent_id": "realist"},
    )
    # 再清空
    r = c.put(
        "/api/account/preferences",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"default_agent_id": None},
    )
    assert r.status_code == 200
    assert r.json()["default_agent_id"] is None


def test_preferences_require_auth(ctx):
    c, *_ = ctx
    r = c.put("/api/account/preferences", json={"default_agent_id": "x"})
    assert r.status_code == 401
