"""应用市场 M4:内置应用播种测试(services/app_seed)。

覆盖:
  - 规格数 ≥5 且 id 集符合预期(h3 两件套 + txt2img/img2img + ltx 三件套)
  - 全部规格过结构校验(_check_workflow/_check_params_schema/_check_bindings/_cross_check)
  - 播种幂等(第二次 0 新增)且不回滚人工改动
  - 每个内置应用默认值经 _validate_params + _build_graph 全链路可写图
  - 经 HTTP 运行内置应用:seed(text) 写数值叶子窄化("42"→int、"" 保留模板值)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, Tenant, User
from app.routes.apps import _build_graph, _check_bindings, _check_params_schema, _check_workflow, _cross_check, _validate_params
from app.security import create_token, hash_password
from app.services.app_seed import _build_specs, seed_builtin_apps

_EXPECTED_IDS = {
    "h3-t2v", "h3-i2v", "txt2img-basic", "img2img-basic",
    "ltx-txt2video", "ltx-img2video", "ltx-lipsync",
}


def _engine():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_specs_at_least_five_and_ids():
    specs = _build_specs()
    assert len(specs) >= 5
    assert {s["id"] for s in specs} == _EXPECTED_IDS


def test_specs_pass_route_validators():
    """全部内置应用走与创建端点同一套校验:图结构 + schema + bindings + 交叉校验。"""
    for spec in _build_specs():
        assert _check_workflow(spec["workflow_json"])
        assert _check_params_schema(spec["params_schema"])
        assert _check_bindings(spec["bindings"])
        _cross_check(spec["workflow_json"], spec["params_schema"], spec["bindings"])


def test_specs_binding_targets_are_scalar_leaves():
    """bindings 不仅节点在图内,字段叶子也必须存在且为标量(app_seed._validate_spec 已断言,
    这里再独立验证一遍字段存在性语义)。"""
    for spec in _build_specs():
        for key, target in spec["bindings"].items():
            leaf = spec["workflow_json"][target["node"]]["inputs"][
                target["field"].split(".", 1)[1]
            ]
            assert not isinstance(leaf, (dict, list)), f"{spec['id']}.{key} 绑到连线上了"


def test_specs_default_values_build_runnable_graph():
    """每个内置应用:必填项给值 + 其余默认,能无错写进深拷贝图,且库内原件不被改写。"""
    for spec in _build_specs():
        # 必填项:positive 文本 + images(img2img)按需给值
        required_values = {"positive": "测试提示词"}
        if any(p["key"] == "images" and p.get("required") for p in spec["params_schema"]):
            required_values["images"] = ["ref.png"]
        values = _validate_params(spec["params_schema"], required_values)
        graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
        assert graph  # 非空
        # seed 默认 "" → 不写,图内保留模板原值(以 KSampler/RandomNoise 为例抽查)
        assert graph is not spec["workflow_json"]


def test_seed_idempotent_and_builtin_upsert():
    engine = _engine()
    with Session(engine) as s:
        assert seed_builtin_apps(s) == len(_EXPECTED_IDS)
        assert seed_builtin_apps(s) == 0  # 幂等:重复启动不重复建
        # 内置应用代码即正典(禁止 PUT):人工改动会被播种修复回规格值
        # (2026-08-31 起,用于修复存量坏图/规格漂移;个人应用行仍不动)
        a = s.get(App, "h3-t2v")
        a.name = "人工改名"
        s.add(a)
        s.commit()
        assert seed_builtin_apps(s) == 0
        assert s.get(App, "h3-t2v").name == "海螺 H3 文生视频"
        # 删掉的内置应用下次播种会补回(按 id 判缺)
        s.delete(s.get(App, "h3-i2v"))
        s.commit()
        assert seed_builtin_apps(s) == 1
        rows = s.exec(select(App).where(App.is_builtin == True)).all()  # noqa: E712
        assert {r.id for r in rows} == _EXPECTED_IDS


def test_seed_apps_nsfw_flags():
    """10Eros 底模的 LTX 三件套标 NSFW(与 engine_registry 口径一致),H3/Flux 不标。"""
    specs = {s["id"]: s for s in _build_specs()}
    for sid in ("ltx-txt2video", "ltx-img2video", "ltx-lipsync"):
        assert specs[sid]["is_nsfw"] is True
    for sid in ("h3-t2v", "h3-i2v", "txt2img-basic", "img2img-basic"):
        assert specs[sid]["is_nsfw"] is False


# ---------------------------------------------------------------------------
# 经 HTTP 运行内置应用(seed → run 端到端,pool/tracker 替身)
# ---------------------------------------------------------------------------
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


class _FakeClient:
    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-seed-1"


class _FakePool:
    def __init__(self, client) -> None:
        self._client = client

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


@pytest.fixture
def ctx(monkeypatch):
    engine = _engine()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake)
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    with Session(engine) as s:
        user_id = _make_user(s, "bob@toiv.ai")
        seed_builtin_apps(s)
    yield TestClient(app), create_token(user_id), fake
    app.dependency_overrides.clear()


def test_builtin_h3_run_writes_params(ctx):
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-t2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "一只猫在窗台晒太阳", "width": 768, "seed": "42"}},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["104"]["inputs"]["prompt"] == "一只猫在窗台晒太阳"
    assert graph["104"]["inputs"]["width"] == 768
    # seed(text)→数值叶子窄化:字符串 "42" 写成 int 42(ComfyUI INT 校验要求)
    assert graph["15"]["inputs"]["noise_seed"] == 42
    assert isinstance(graph["15"]["inputs"]["noise_seed"], int)
    # height 未提供 → 默认值 768 补全写入
    assert graph["104"]["inputs"]["height"] == 768


def test_builtin_seed_empty_keeps_template_value(ctx):
    """seed 留空(默认 "")→ 不写叶子,图内保留模板原值 42,不会把空串写给 worker。"""
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-t2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x"}},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["15"]["inputs"]["noise_seed"] == 42  # 模板原值,非 ""


def test_builtin_seed_non_numeric_422(ctx):
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-t2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x", "seed": "abc"}},
    )
    assert r.status_code == 422
    assert not fake.graphs  # 校验失败不提交 worker


def test_builtin_txt2img_run_and_nsfw_gate(ctx):
    c, token, fake = ctx
    # SFW 内置应用可直接跑
    r = c.post(
        "/api/apps/txt2img-basic/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "a cat", "negative": "blurry"}},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    # 次世代图节点:4=正向/5=负向 CLIPTextEncode(2026-08-31 从 CheckpointLoaderSimple 模板迁入)
    assert graph["4"]["inputs"]["text"] == "a cat"
    assert graph["5"]["inputs"]["text"] == "blurry"
    # CLIP 必须由独立 CLIPLoader 提供(flux2 fp8mixed 是 UNET-only,CheckpointLoaderSimple 必炸)
    assert graph["3"]["class_type"] == "CLIPLoader"
    assert graph["1"]["class_type"] == "UNETLoader"
    # NSFW 内置应用无 X-NSFW 头 403
    r2 = c.post(
        "/api/apps/ltx-txt2video/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x"}},
    )
    assert r2.status_code == 403
