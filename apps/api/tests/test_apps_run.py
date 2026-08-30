"""应用市场 M2(POST /api/apps/{id}/run 运行器)测试。

覆盖:
  - 鉴权 401 / 应用不存在 404 / 他人个人应用 404
  - 表单校验 422:未知参数 / 类型错误 / min/max 越界 / 枚举外值 / 缺 required
  - binding 写图正确(inputs 叶子替换;库内原图不被改写;缺省值补默认)
  - 拓扑注入拒绝:绑定指向连线(list)/不存在节点/写入复合值 一律 422
  - widgets_values 叶子写入
  - 提交建档:Job(kind=app_run, params 存 app_id+表单快照)+ usage_count+1 + 审计 app.run
  - pool.pick 收到 _extract_required 模型依赖 + 图自动派生的 class_type 集
  - worker 不可达 503
  - NSFW 门控:is_nsfw 应用无 X-NSFW 头 403,带头放行且 Job.nsfw 打标
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, AuditLog, Job, Tenant, User
from app.security import create_token, hash_password

# --------------------------------------------------------------------------- #
# fixtures / fakes
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


# 图:3=提示词(含一条连线 inputs.clip —— 拓扑注入诱饵),4=Checkpoint(模型依赖),9=SaveImage
_GRAPH = {
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "default prompt", "clip": ["4", 1]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "8": {"class_type": "KSampler", "inputs": {"steps": 20, "seed": 0}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
}
_SCHEMA = [
    {"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True},
    {"key": "steps", "label": "步数", "type": "number", "default": 20, "min": 1, "max": 50},
    {"key": "res", "label": "分辨率", "type": "select", "default": "512",
     "options": [{"value": "512", "label": "512"}, {"value": "768", "label": "768"}]},
]
_BINDINGS = {
    "prompt": {"node": "3", "field": "inputs.text"},
    "steps": {"node": "8", "field": "inputs.steps"},
}


def _seed_app(session: Session, **over) -> App:
    a = App(
        id=over.pop("id", "t2i-basic"),
        name=over.pop("name", "文生图基础"),
        workflow_json=over.pop("workflow_json", json.loads(json.dumps(_GRAPH))),
        params_schema=over.pop("params_schema", _SCHEMA),
        bindings=over.pop("bindings", _BINDINGS),
        **over,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return a


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
        self.calls: list[dict] = []

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        self.calls.append({"required": set(required), "required_nodes": set(required_nodes)})
        return self._client


class _FailPool(_FakePool):
    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        raise ComfyUIError("没有具备所需模型且可用的 worker")


@pytest.fixture
def ctx(monkeypatch):
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
    pool = _FakePool(fake_client)
    app.dependency_overrides[get_pool] = lambda: pool
    # 不触发真实后台追踪(不联 worker)
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    with Session(engine) as s:
        user_id = _make_user(s, "bob@toiv.ai")
        other_id = _make_user(s, "carol@toiv.ai")
        _seed_app(s)
    yield (
        TestClient(app),
        {"user": create_token(user_id), "other": create_token(other_id)},
        {"user": user_id, "other": other_id},
        engine,
        fake_client,
        pool,
    )
    app.dependency_overrides.clear()


def _h(tokens: dict, who: str = "user", nsfw: bool = False) -> dict:
    headers = {"Authorization": f"Bearer {tokens[who]}"}
    if nsfw:
        headers["X-NSFW"] = "1"
    return headers


# --------------------------------------------------------------------------- #
# 鉴权 / 可见性
# --------------------------------------------------------------------------- #
def test_run_requires_auth(ctx):
    c, *_ = ctx
    assert c.post("/api/apps/t2i-basic/run", json={"values": {}}).status_code == 401


def test_run_404_unknown(ctx):
    c, tokens, *_ = ctx
    r = c.post("/api/apps/nope/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 404


def test_run_personal_app_hidden_from_other(ctx):
    c, tokens, ids, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=False)
    r = c.post("/api/apps/mine/run", headers=_h(tokens, "other"), json={"values": {"prompt": "x"}})
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 表单校验 422
# --------------------------------------------------------------------------- #
def test_run_unknown_value_key_422(ctx):
    c, tokens, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "a cat", "ghost": 1}},
    )
    assert r.status_code == 422


def test_run_type_mismatch_422(ctx):
    c, tokens, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "a cat", "steps": "twenty"}},
    )
    assert r.status_code == 422


def test_run_min_max_violation_422(ctx):
    c, tokens, *_ = ctx
    for bad in (0, 51):
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens),
            json={"values": {"prompt": "a cat", "steps": bad}},
        )
        assert r.status_code == 422, bad


def test_run_select_enum_violation_422(ctx):
    c, tokens, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "a cat", "res": "999"}},
    )
    assert r.status_code == 422


def test_run_required_missing_422(ctx):
    c, tokens, *_ = ctx
    r = c.post("/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {}})
    assert r.status_code == 422
    assert "prompt" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# 拓扑注入拒绝
# --------------------------------------------------------------------------- #
def test_run_binding_to_link_rejected(ctx):
    """绑定指向连线(list 节点引用)→ 422(禁改拓扑)。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        # 直接落库绕过创建期交叉校验(交叉校验只查节点存在,不查叶子形态)
        _seed_app(s, id="evil", bindings={"prompt": {"node": "3", "field": "inputs.clip"}})
    r = c.post("/api/apps/evil/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 422


def test_run_binding_to_missing_node_rejected(ctx):
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="evil2", bindings={"prompt": {"node": "99", "field": "inputs.text"}})
    r = c.post("/api/apps/evil2/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 422


def test_run_binding_to_missing_leaf_rejected(ctx):
    """目标 inputs 键不存在(=新增键改拓扑)→ 422。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="evil3", bindings={"prompt": {"node": "3", "field": "inputs.ghost"}})
    r = c.post("/api/apps/evil3/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 422


def test_run_composite_value_rejected(ctx):
    """复合值(list/dict)不能写入图叶子。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(
            s, id="evil4",
            params_schema=[{"key": "x", "label": "x", "type": "loras", "default": None}],
            bindings={"x": {"node": "3", "field": "inputs.text"}},
        )
    r = c.post("/api/apps/evil4/run", headers=_h(tokens), json={"values": {"x": ["a"]}})
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# 写图正确性 + 提交建档
# --------------------------------------------------------------------------- #
def test_run_ok_writes_graph_and_creates_job(ctx):
    c, tokens, ids, engine, fake, _ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "一只猫", "steps": 30, "res": "768"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-app-1"
    assert body["worker"] == "http://fake-worker"
    assert body["app_id"] == "t2i-basic"

    # binding 写进提交图:叶子替换,连线不动
    submitted = fake.graphs[0]
    assert submitted["3"]["inputs"]["text"] == "一只猫"
    assert submitted["3"]["inputs"]["clip"] == ["4", 1]  # 拓扑原样
    assert submitted["8"]["inputs"]["steps"] == 30
    # 库内原图不被改写
    with Session(engine) as s:
        a = s.get(App, "t2i-basic")
        assert a.workflow_json["3"]["inputs"]["text"] == "default prompt"

    # Job 建档:kind=app_run,params 存 app_id+表单快照,prompt 取首个文本参数
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        assert job is not None
        assert job.kind == "app_run"
        assert job.status == "queued"
        assert job.prompt == "一只猫"
        snap = json.loads(job.params)
        assert snap["app_id"] == "t2i-basic"
        assert snap["values"]["prompt"] == "一只猫"
        assert snap["values"]["res"] == "768"


def test_run_defaults_applied(ctx):
    """未提供的参数按 default 写图(steps 缺省 20)。"""
    c, tokens, _, _, fake, _ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "dog"}}
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["8"]["inputs"]["steps"] == 20


def test_run_usage_count_and_audit(ctx):
    c, tokens, _, engine, _, _ = ctx
    for _ in range(2):
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 200
    assert r.json()["usage_count"] == 2
    with Session(engine) as s:
        a = s.get(App, "t2i-basic")
        assert a.usage_count == 2
        logs = s.exec(select(AuditLog).where(AuditLog.action == "app.run")).all()
        assert len(logs) == 2
        assert logs[0].target_type == "app" and logs[0].target_id == "t2i-basic"


def test_run_pick_receives_models_and_nodes(ctx):
    """pool.pick 收到 _extract_required 的模型依赖 + 图自动派生的 class_type 集。"""
    c, tokens, _, _, _, pool = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
    )
    assert r.status_code == 200
    call = pool.calls[0]
    assert call["required"] == {"a.safetensors"}  # ckpt_name 提取
    assert call["required_nodes"] == {
        "CLIPTextEncode", "CheckpointLoaderSimple", "KSampler", "SaveImage"
    }


def test_run_explicit_required_nodes_used(ctx):
    """required_nodes 非空时用配置值(不从图派生)。"""
    c, tokens, _, engine, _, pool = ctx
    with Session(engine) as s:
        _seed_app(s, id="custom-nodes", required_nodes=["MyCustomNode"])
    r = c.post(
        "/api/apps/custom-nodes/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
    )
    assert r.status_code == 200
    assert pool.calls[-1]["required_nodes"] == {"MyCustomNode"}


def test_run_widgets_values_binding(ctx):
    """widgets_values 叶子(widgets_values.N)同样可写。"""
    c, tokens, _, engine, fake, _ = ctx
    g = json.loads(json.dumps(_GRAPH))
    g["8"]["widgets_values"] = [0, 20, "euler"]  # UI 导出形态
    with Session(engine) as s:
        _seed_app(
            s, id="wv", workflow_json=g,
            bindings={"steps": {"node": "8", "field": "widgets_values.1"}},
        )
    r = c.post(
        "/api/apps/wv/run", headers=_h(tokens),
        json={"values": {"prompt": "x", "steps": 42}},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["8"]["widgets_values"][1] == 42


def test_run_pool_unavailable_503(ctx):
    c, tokens, *_ = ctx
    app.dependency_overrides[get_pool] = lambda: _FailPool(_FakeClient())
    try:
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 503
    finally:
        app.dependency_overrides[get_pool] = lambda: ctx[5]


def test_run_worker_4xx_passthrough(ctx):
    """worker 拒绝(400)透传,不建档、不计数。"""

    class _RejectClient(_FakeClient):
        async def queue_prompt(self, graph, client_id):  # noqa: ANN001
            raise ComfyUIError("bad prompt", status_code=400, detail="bad prompt")

    c, tokens, _, engine, _, _ = ctx
    app.dependency_overrides[get_pool] = lambda: _FakePool(_RejectClient())
    try:
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 400
    finally:
        app.dependency_overrides[get_pool] = lambda: ctx[5]
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.kind == "app_run")).first() is None
        assert s.get(App, "t2i-basic").usage_count == 0


# --------------------------------------------------------------------------- #
# NSFW 门控
# --------------------------------------------------------------------------- #
def test_run_nsfw_app_requires_header(ctx):
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="nsfw-app", is_nsfw=True)
    r = c.post("/api/apps/nsfw-app/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 403


def test_run_nsfw_app_with_header_ok(ctx):
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="nsfw-app", is_nsfw=True)
    r = c.post(
        "/api/apps/nsfw-app/run", headers=_h(tokens, nsfw=True),
        json={"values": {"prompt": "x"}},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        assert job.nsfw is True  # NSFW 应用产物打 R18 标
