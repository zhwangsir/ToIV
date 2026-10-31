"""应用市场 M5:智能导入路由测试(POST /api/apps/import + /import/confirm)。

LLM 全 mock(monkeypatch app.services.app_packager.chat_layered)。

覆盖:
  - 鉴权 401 / 垃圾工作流 422 / UI 格式自动嗅探转换
  - LLM 包装草稿:字段回读 / icon 白名单回落 / 悬空 binding 剔除进 warnings /
    绑到连线叶子的 binding 剔除 / 非法参数类型剔除 / bindings key 无 schema 对应剔除
  - LLM 失败:抛 LLMError → 503 固定文案;产出非 JSON → 503;产出结构缺 name → 503
  - 草稿:confirm 落库为个人应用(is_mine/is_public=False/is_builtin=False,图一致);
    一次性消费;他人草稿 404;过期 404;overrides 覆盖与非法覆盖 422
  - 限流:超 generation 配额 429
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.apps as apps_route
import app.services.app_packager as packager
from app import ratelimit
from app.agent.llm import LLMError
from app.db import get_session
from app.main import app
from app.models import App, Tenant, User
from app.security import create_token, hash_password

# ---------------------------------------------------------------------------
# fixtures / fakes
# ---------------------------------------------------------------------------

_API_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["1", 1]}},
    "3": {"class_type": "KSampler", "inputs": {
        "seed": 42, "steps": 20, "model": ["1", 0], "positive": ["2", 0],
    }},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
}

_UI_GRAPH = {
    "nodes": [
        {"id": 1, "type": "CheckpointLoaderSimple", "mode": 0, "inputs": [],
         "widgets_values": ["a.safetensors"]},
        {"id": 9, "type": "SaveImage", "mode": 0, "inputs": [], "widgets_values": ["x"]},
    ],
    "links": [],
}

_LLM_OK = {
    "name": "猫咪文生图",
    "description": "输入提示词出一张图",
    "icon": "image",
    "category": "image",
    "output_kind": "image",
    "is_nsfw_guess": False,
    "params_schema": [
        {"key": "positive", "label": "提示词", "type": "textarea", "required": True, "default": ""},
        {"key": "steps", "label": "步数", "type": "number", "default": 20, "min": 1, "max": 50},
    ],
    "bindings": {
        "positive": {"node": "2", "field": "inputs.text"},
        "steps": {"node": "3", "field": "inputs.steps"},
    },
}


def _mock_llm(monkeypatch, payload):
    """把 LLM 替换成固定产出(payload 为 dict 或 str;callable 则透传调用)。"""
    if callable(payload):
        monkeypatch.setattr(packager, "chat_layered", payload)
        return
    content = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)

    async def fake(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        return {"content": content}

    monkeypatch.setattr(packager, "chat_layered", fake)


def _make_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"),
                tenant_id=tenant.id, role="user")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    apps_route._IMPORT_DRAFTS.clear()
    with Session(engine) as s:
        user_id = _make_user(s, "bob@toiv.ai")
        other_id = _make_user(s, "carol@toiv.ai")
    yield (
        TestClient(app),
        {"user": create_token(user_id), "other": create_token(other_id)},
        {"user": user_id, "other": other_id},
        engine,
    )
    app.dependency_overrides.clear()
    apps_route._IMPORT_DRAFTS.clear()


def _h(tokens: dict, who: str = "user") -> dict:
    return {"Authorization": f"Bearer {tokens[who]}"}


def _import(ctx, monkeypatch, payload=_LLM_OK, workflow=None, who="user"):
    c, tokens, _, _ = ctx
    _mock_llm(monkeypatch, payload)
    return c.post(
        "/api/apps/import", headers=_h(tokens, who),
        json={"workflow": workflow if workflow is not None else _API_GRAPH},
    )


# ---------------------------------------------------------------------------
# 鉴权 / 入参 / 嗅探
# ---------------------------------------------------------------------------
def test_import_requires_auth(ctx):
    c, *_ = ctx
    assert c.post("/api/apps/import", json={"workflow": _API_GRAPH}).status_code == 401


def test_import_bad_workflow_422(ctx, monkeypatch):
    c, tokens, _, _ = ctx
    _mock_llm(monkeypatch, _LLM_OK)
    r = c.post("/api/apps/import", headers=_h(tokens), json={"workflow": {"foo": 1}})
    assert r.status_code == 422


def test_import_ui_format_sniffed_and_converted(ctx, monkeypatch):
    """UI nodes[] 格式先经 workflow_convert 转 API 图,再走分析/包装。"""
    r = _import(ctx, monkeypatch, workflow=_UI_GRAPH)
    assert r.status_code == 200, r.text
    assert r.json()["draft_id"]


# ---------------------------------------------------------------------------
# 草稿产出与消毒
# ---------------------------------------------------------------------------
def test_import_draft_roundtrip(ctx, monkeypatch):
    r = _import(ctx, monkeypatch)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["name"] == "猫咪文生图"
    assert d["icon"] == "image"
    assert d["bindings"]["positive"] == {"node": "2", "field": "inputs.text"}
    assert d["warnings"] == []


def test_import_icon_not_in_whitelist_falls_back(ctx, monkeypatch):
    payload = dict(_LLM_OK, icon="not-an-icon")
    r = _import(ctx, monkeypatch, payload=payload)
    d = r.json()
    assert d["icon"] == "sparkles"
    assert any("白名单" in w for w in d["warnings"])


def test_import_dangling_binding_dropped(ctx, monkeypatch):
    payload = dict(_LLM_OK, bindings={
        "positive": {"node": "99", "field": "inputs.text"},  # 节点不存在
        "steps": {"node": "3", "field": "inputs.steps"},
    })
    r = _import(ctx, monkeypatch, payload=payload)
    d = r.json()
    assert "positive" not in d["bindings"]
    assert d["bindings"]["steps"]["node"] == "3"
    assert any("99" in w for w in d["warnings"])


def test_import_binding_to_linked_leaf_dropped(ctx, monkeypatch):
    payload = dict(_LLM_OK, bindings={
        "positive": {"node": "3", "field": "inputs.positive"},  # 目标是连线(list)
        "steps": {"node": "3", "field": "inputs.steps"},
    })
    r = _import(ctx, monkeypatch, payload=payload)
    d = r.json()
    assert "positive" not in d["bindings"]
    assert any("连线" in w for w in d["warnings"])


def test_import_binding_without_schema_key_dropped(ctx, monkeypatch):
    payload = dict(_LLM_OK, bindings={
        "ghost": {"node": "2", "field": "inputs.text"},  # schema 无此 key
        "steps": {"node": "3", "field": "inputs.steps"},
    })
    r = _import(ctx, monkeypatch, payload=payload)
    d = r.json()
    assert "ghost" not in d["bindings"]
    assert any("无对应参数" in w for w in d["warnings"])


def test_import_bad_param_type_dropped(ctx, monkeypatch):
    payload = dict(_LLM_OK, params_schema=[
        {"key": "positive", "label": "提示词", "type": "magic"},  # 非法类型
        {"key": "steps", "label": "步数", "type": "number", "default": 20},
    ])
    r = _import(ctx, monkeypatch, payload=payload)
    d = r.json()
    assert [p["key"] for p in d["params_schema"]] == ["steps"]
    # positive 参数被剔除 → 其 binding 连带剔除
    assert "positive" not in d["bindings"]


# ---------------------------------------------------------------------------
# LLM 失败 → 503 固定文案
# ---------------------------------------------------------------------------
def test_import_llm_error_503(ctx, monkeypatch):
    async def boom(messages, **kw):
        raise LLMError("主备均不可用")

    r = _import(ctx, monkeypatch, payload=boom)
    assert r.status_code == 503
    assert r.json()["detail"] == apps_route._LLM_503_DETAIL


def test_import_llm_non_json_503(ctx, monkeypatch):
    r = _import(ctx, monkeypatch, payload="抱歉,我无法处理这个工作流。")
    assert r.status_code == 503


def test_import_llm_bad_schema_503(ctx, monkeypatch):
    r = _import(ctx, monkeypatch, payload={"description": "缺 name"})  # Pydantic 必填缺失
    assert r.status_code == 503


# ---------------------------------------------------------------------------
# confirm 落库
# ---------------------------------------------------------------------------
def test_confirm_persists_personal_app(ctx, monkeypatch):
    c, tokens, ids, engine = ctx
    draft = _import(ctx, monkeypatch).json()
    r = c.post("/api/apps/import/confirm", headers=_h(tokens),
               json={"draft_id": draft["draft_id"]})
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["is_mine"] is True
    assert a["is_public"] is False
    assert a["is_builtin"] is False
    assert a["workflow_json"]["2"]["class_type"] == "CLIPTextEncode"  # 归一化图落库
    with Session(engine) as s:
        row = s.get(App, a["id"])
        assert row is not None and row.user_id == ids["user"]
        assert row.bindings["positive"]["node"] == "2"


def test_confirm_overrides_applied(ctx, monkeypatch):
    c, tokens, *_ = ctx
    draft = _import(ctx, monkeypatch).json()
    r = c.post(
        "/api/apps/import/confirm", headers=_h(tokens),
        json={"draft_id": draft["draft_id"],
              "overrides": {"name": "我的猫图", "is_nsfw": True, "icon": "camera"}},
    )
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["name"] == "我的猫图"
    assert a["is_nsfw"] is True
    assert a["icon"] == "camera"


def test_confirm_bad_override_422(ctx, monkeypatch):
    c, tokens, *_ = ctx
    draft = _import(ctx, monkeypatch).json()
    r = c.post(
        "/api/apps/import/confirm", headers=_h(tokens),
        json={"draft_id": draft["draft_id"], "overrides": {"icon": "not-an-icon"}},
    )
    assert r.status_code == 422
    r2 = c.post(
        "/api/apps/import/confirm", headers=_h(tokens),
        json={"draft_id": draft["draft_id"], "overrides": {"workflow_json": {}}},
    )
    assert r2.status_code == 422  # 不支持的覆盖字段


def test_confirm_unknown_and_consumed_draft_404(ctx, monkeypatch):
    c, tokens, *_ = ctx
    assert c.post("/api/apps/import/confirm", headers=_h(tokens),
                  json={"draft_id": "nope"}).status_code == 404
    draft = _import(ctx, monkeypatch).json()
    assert c.post("/api/apps/import/confirm", headers=_h(tokens),
                  json={"draft_id": draft["draft_id"]}).status_code == 200
    # 草稿一次性消费:第二次 confirm 404
    assert c.post("/api/apps/import/confirm", headers=_h(tokens),
                  json={"draft_id": draft["draft_id"]}).status_code == 404


def test_confirm_other_users_draft_404(ctx, monkeypatch):
    c, tokens, *_ = ctx
    draft = _import(ctx, monkeypatch, who="user").json()
    r = c.post("/api/apps/import/confirm", headers=_h(tokens, "other"),
               json={"draft_id": draft["draft_id"]})
    assert r.status_code == 404  # 非本人草稿不泄露存在性


def test_confirm_expired_draft_404(ctx, monkeypatch):
    c, tokens, *_ = ctx
    draft = _import(ctx, monkeypatch).json()
    monkeypatch.setattr(apps_route, "_IMPORT_DRAFT_TTL_SEC", -1)  # 全部立过期
    r = c.post("/api/apps/import/confirm", headers=_h(tokens),
               json={"draft_id": draft["draft_id"]})
    assert r.status_code == 404
    assert "过期" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 限流
# ---------------------------------------------------------------------------
def test_import_rate_limited_429(ctx, monkeypatch):
    monkeypatch.setitem(ratelimit._DEFAULT_SCOPES, "generation", (60.0, 2))
    assert _import(ctx, monkeypatch).status_code == 200
    assert _import(ctx, monkeypatch).status_code == 200
    r = _import(ctx, monkeypatch)
    assert r.status_code == 429
