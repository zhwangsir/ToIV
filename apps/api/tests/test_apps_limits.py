"""市场应用 params_schema 与引擎 limits 同源(apps.run 生产链)测试。

覆盖(B1c 第二切片):
  - _to_out(GET /api/apps/{id})在 enrich 之后映射已知引擎 limits:
    positive/prompt → max_chars,negative → max_chars,images/audio/video → max_bytes
    (max 仍是数量),loras → max_items(limits 未声明 None 不伪造)
  - 精确 engine id 优先;h3-* 市场变体回退 H3 家族 limits;未知自定义/rh-* 不猜测
  - run_app 与 _to_out 复用同一有效 schema:提交侧 max_chars/max_items 超限 422,
    界面不再能下发限制而提交绕过
  - 既有行为不破:未知应用长文本原样通过;txt2img 引擎 lora_max_items=None 不下发
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.apps as apps_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, Tenant, User
from app.security import create_token, hash_password

_MiB = 1024 * 1024

# 图:3=提示词叶子,4=Checkpoint(模型依赖),9=SaveImage
_GRAPH = {
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "default prompt", "clip": ["4", 1]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "8": {"class_type": "KSampler", "inputs": {"steps": 20, "seed": 0}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
}

_H3_SCHEMA = [
    {"key": "positive", "label": "提示词", "type": "textarea", "default": "", "required": True},
    {"key": "negative", "label": "负向", "type": "textarea", "default": ""},
    {"key": "images", "label": "参考图", "type": "images", "max": 9, "default": None},
    {"key": "audio", "label": "参考音频", "type": "audio", "max": 3, "default": None},
    {"key": "video", "label": "参考视频", "type": "video", "max": 3, "default": None},
    {"key": "loras", "label": "LoRA 叠加", "type": "loras", "default": []},
]
_H3_BINDINGS = {
    "positive": {"node": "3", "field": "inputs.text"},
    "images": {"node": "100", "field": "inputs.image"},
}


def _schema_by_key(schema: list[dict]) -> dict[str, dict]:
    return {p["key"]: p for p in schema}


class _FakeClient:
    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-app-1"


class _FakePool:
    def __init__(self, client) -> None:
        self._client = client
        self.clients = [client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


@pytest.fixture
def ctx(monkeypatch):
    from app.services import apps_list_cache as _alc
    _alc.bump()
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
    fake_client = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake_client)
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    with Session(engine) as s:
        tenant = Tenant(name="limits")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="limits@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        token = create_token(user.id)
    yield TestClient(app), {"Authorization": f"Bearer {token}"}, engine, fake_client
    app.dependency_overrides.clear()


def _seed(session: Session, aid: str, schema=None, bindings=None) -> None:
    a = App(
        id=aid,
        name=aid,
        workflow_json=json.loads(json.dumps(_GRAPH)),
        params_schema=schema if schema is not None else json.loads(json.dumps(_H3_SCHEMA)),
        bindings=bindings if bindings is not None else dict(_H3_BINDINGS),
        output_kind="video" if aid.startswith("h3-") else "image",
    )
    session.add(a)
    session.commit()


# --------------------------------------------------------------------------- #
# _to_out 声明(GET /api/apps/{id})
# --------------------------------------------------------------------------- #

def test_h3_app_detail_declares_engine_limits(ctx):
    """精确 engine id(h3-t2v):positive max_chars=4000、negative 2000、媒体 max_bytes、
    loras max_items=3;媒体 max 仍是数量(9/3/3)不被覆盖。"""
    c, h, engine, _ = ctx
    with Session(engine) as s:
        _seed(s, "h3-t2v")
    r = c.get("/api/apps/h3-t2v", headers=h)
    assert r.status_code == 200, r.text
    p = _schema_by_key(r.json()["params_schema"])
    assert p["positive"]["max_chars"] == 4000
    assert p["negative"]["max_chars"] == 2000
    assert p["images"]["max_bytes"] == 20 * _MiB
    assert p["audio"]["max_bytes"] == 20 * _MiB
    assert p["video"]["max_bytes"] == 200 * _MiB
    assert (p["images"]["max"], p["audio"]["max"], p["video"]["max"]) == (9, 3, 3)
    assert p["loras"]["max_items"] == 3


def test_h3_variant_app_uses_h3_family_limits(ctx):
    """h3-* 市场变体(非 engine id)回退 H3 家族 limits(4000),不误套缺省 2000。"""
    c, h, engine, _ = ctx
    with Session(engine) as s:
        _seed(s, "h3-t2v-15s-fast")
    r = c.get("/api/apps/h3-t2v-15s-fast", headers=h)
    assert r.status_code == 200, r.text
    p = _schema_by_key(r.json()["params_schema"])
    assert p["positive"]["max_chars"] == 4000
    assert p["loras"]["max_items"] == 3


def test_unknown_and_rh_apps_not_guessed(ctx):
    """未知自定义应用与 rh-* 应用:不注入任何 max_chars/max_bytes/max_items。"""
    c, h, engine, _ = ctx
    with Session(engine) as s:
        _seed(s, "my-custom-app")
        _seed(s, "rh-h3-t2v-copy")
    for aid in ("my-custom-app", "rh-h3-t2v-copy"):
        r = c.get(f"/api/apps/{aid}", headers=h)
        assert r.status_code == 200, r.text
        for p in r.json()["params_schema"]:
            assert "max_chars" not in p, (aid, p["key"])
            assert "max_bytes" not in p, (aid, p["key"])
            assert "max_items" not in p, (aid, p["key"])


def test_txt2img_engine_lora_none_not_faked(ctx):
    """txt2img 引擎 spec lora_max_items=None(普通 generate 路由上限 8,语义不改):
    loras 项不得伪造 max_items;positive 仍按缺省语义给 2000。"""
    c, h, engine, _ = ctx
    schema = [
        {"key": "positive", "label": "提示词", "type": "textarea", "default": "", "required": True},
        {"key": "loras", "label": "LoRA 叠加", "type": "loras", "default": []},
    ]
    with Session(engine) as s:
        _seed(s, "txt2img", schema=schema)
    r = c.get("/api/apps/txt2img", headers=h)
    assert r.status_code == 200, r.text
    p = _schema_by_key(r.json()["params_schema"])
    assert p["positive"]["max_chars"] == 2000
    assert "max_items" not in p["loras"]


# --------------------------------------------------------------------------- #
# run_app 与 _to_out 同一有效 schema:超限 422,未声明不拦
# --------------------------------------------------------------------------- #

def test_run_h3_prompt_over_max_chars_422(ctx):
    """提交侧与界面同一 schema:positive 4001 → 422(界面下发 4000 限制后提交不可绕过)。"""
    c, h, engine, _ = ctx
    with Session(engine) as s:
        _seed(s, "h3-t2v")
    r = c.post(
        "/api/apps/h3-t2v/run", headers=h,
        json={"values": {"positive": "x" * 4001}},
    )
    assert r.status_code == 422
    assert "max_chars" in r.json()["detail"] or "4000" in r.json()["detail"]


def test_run_h3_prompt_negative_over_max_chars_422(ctx):
    c, h, engine, _ = ctx
    with Session(engine) as s:
        _seed(s, "h3-t2v")
    r = c.post(
        "/api/apps/h3-t2v/run", headers=h,
        json={"values": {"positive": "ok", "negative": "x" * 2001}},
    )
    assert r.status_code == 422


def test_run_h3_prompt_boundary_4000_accepted(ctx):
    """边界:恰好 4000 通过校验并提交(替身 worker → 200)。"""
    c, h, engine, fake = ctx
    with Session(engine) as s:
        _seed(s, "h3-t2v")
    r = c.post(
        "/api/apps/h3-t2v/run", headers=h,
        json={"values": {"positive": "x" * 4000}},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["3"]["inputs"]["text"] == "x" * 4000


def test_run_h3_loras_over_max_items_422(ctx):
    """钉选 LoRA 4 个(声明上限 3)→ 422;恰好 3 个通过。"""
    c, h, engine, _ = ctx
    with Session(engine) as s:
        _seed(s, "h3-t2v")
    loras4 = [{"name": f"l{i}.safetensors", "strength": 0.6} for i in range(4)]
    r = c.post(
        "/api/apps/h3-t2v/run", headers=h,
        json={"values": {"positive": "ok", "loras": loras4}},
    )
    assert r.status_code == 422
    loras3 = loras4[:3]
    r = c.post(
        "/api/apps/h3-t2v/run", headers=h,
        json={"values": {"positive": "ok", "loras": loras3}},
    )
    assert r.status_code == 200, r.text


def test_run_unknown_app_long_prompt_unchanged(ctx):
    """未声明 limits 的应用(自定义):5000 字提示词保持原行为(不被新门禁拦截)。"""
    c, h, engine, _ = ctx
    schema = [
        {"key": "positive", "label": "提示词", "type": "textarea", "default": "", "required": True},
    ]
    with Session(engine) as s:
        _seed(s, "my-custom-app", schema=schema)
    r = c.post(
        "/api/apps/my-custom-app/run", headers=h,
        json={"values": {"positive": "x" * 5000}},
    )
    assert r.status_code == 200, r.text


def test_run_rh_app_not_limited(ctx):
    """rh-* 应用不误套 H3 limits:长提示词保持原行为。"""
    c, h, engine, _ = ctx
    schema = [
        {"key": "positive", "label": "提示词", "type": "textarea", "default": "", "required": True},
    ]
    with Session(engine) as s:
        _seed(s, "rh-h3-t2v-copy", schema=schema, bindings={"positive": {"node": "3", "field": "inputs.text"}})
    r = c.post(
        "/api/apps/rh-h3-t2v-copy/run", headers=h,
        json={"values": {"positive": "x" * 5000}},
    )
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- #
# LoRA 上限按真实作用域共享常量(普通 generate=8 / 市场=3 / H3=3),防声明/实际漂移
# --------------------------------------------------------------------------- #

def test_lora_caps_scoped_shared_constants():
    """三个作用域各有共享常量:generate.py=8、app_deep_knobs=3、H3=3;不强行统一。"""
    from app.limits import GENERATE_MAX_LORAS, H3_MAX_LORAS, MARKET_MAX_LORAS
    from app.routes import generate as gen_route
    from app.services import app_deep_knobs

    assert gen_route._MAX_LORAS == GENERATE_MAX_LORAS == 8
    assert app_deep_knobs._MAX_LORAS == MARKET_MAX_LORAS == 3
    assert H3_MAX_LORAS == 3


def test_h3_market_lora_cap_no_drift():
    """H3 spec 声明的 lora_max_items 与市场 parse_loras_value 实际拒绝面一致:
    两者共用 3;若 H3 改 4 本测试失败,强制同步决策(而非 _validate_params 放行 4、
    parse 拒 3 的悄悄漂移)。"""
    from app.limits import H3_MAX_LORAS, MARKET_MAX_LORAS

    assert H3_MAX_LORAS == MARKET_MAX_LORAS


def test_parse_loras_value_boundary_matches_shared_cap():
    """市场 parse:恰好 MARKET_MAX_LORAS 个通过,+1 拒绝(与声明上限同一常量)。"""
    import pytest

    from app.limits import MARKET_MAX_LORAS
    from app.services.app_deep_knobs import parse_loras_value

    ok = [{"name": f"l{i}.safetensors", "strength": 0.6} for i in range(MARKET_MAX_LORAS)]
    assert len(parse_loras_value(ok)) == MARKET_MAX_LORAS
    with pytest.raises(ValueError, match="最多叠加"):
        parse_loras_value(ok + [{"name": "x.safetensors", "strength": 0.6}])


def test_generate_loras_boundary_8_unchanged():
    """普通 generate 图片链路 LoRA=8 语义不变:恰好 8 通过、9 拒绝。"""
    import pytest
    from pydantic import ValidationError

    from app.limits import GENERATE_MAX_LORAS
    from app.routes.generate import Txt2ImgRequest

    ok = [{"name": f"l{i}.safetensors", "weight": 0.6} for i in range(GENERATE_MAX_LORAS)]
    Txt2ImgRequest(positive="ok", loras=ok)
    with pytest.raises(ValidationError):
        Txt2ImgRequest(positive="ok", loras=ok + [{"name": "x.safetensors", "weight": 0.6}])
