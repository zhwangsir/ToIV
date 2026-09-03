"""应用市场 M2(POST /api/apps/{id}/run 运行器)测试。

覆盖:
  - 鉴权 401 / 应用不存在 404 / 他人个人应用 404
  - 表单校验 422:未知参数 / 类型错误 / min/max 越界 / 枚举外值 / 缺 required
  - binding 写图正确(inputs 叶子替换;库内原图不被改写;缺省值补默认)
  - 拓扑注入拒绝:绑定指向连线(list)/不存在节点/写入复合值 一律 422
  - widgets_values 叶子写入
  - 提交建档:Job(kind=app_run, params 存 app_id+表单快照)+ 审计 app.run;
    usage_count 提交时不变,仅 Job 到 done 时 +1(tracker.mark_done,2026-08-30 P2)
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
    """复合值不能写入图叶子:多元素 list/dict 422;单元素媒体文件名数组允许窄化为字符串
    (LoadImage/LoadVideo 单文件绑定,2026-08-31 起)。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(
            s, id="evil4",
            params_schema=[{"key": "x", "label": "x", "type": "loras", "default": None}],
            bindings={"x": {"node": "3", "field": "inputs.text"}},
        )
    # 多元素 list 仍拒绝
    r = c.post("/api/apps/evil4/run", headers=_h(tokens), json={"values": {"x": ["a", "b"]}})
    assert r.status_code == 422
    # dict 拒绝
    r = c.post("/api/apps/evil4/run", headers=_h(tokens), json={"values": {"x": {"a": 1}}})
    assert r.status_code == 422


def test_run_images_list_binding_fan_out(ctx):
    """images 列表绑定:两张图写入 110/111,未占用的 112 从提交图省略。"""
    c, tokens, _, engine, fake, _ = ctx
    graph = {
        "110": {"class_type": "LoadImage", "inputs": {"image": "d1.png"}},
        "111": {"class_type": "LoadImage", "inputs": {"image": "d2.png"}},
        "112": {"class_type": "LoadImage", "inputs": {"image": "d3.png"}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
        "104": {
            "class_type": "FakeRef",
            "inputs": {
                "ref_image_1": ["110", 0],
                "ref_image_2": ["111", 0],
                "ref_image_3": ["112", 0],
            },
        },
    }
    with Session(engine) as s:
        _seed_app(
            s, id="multi-ref",
            workflow_json=graph,
            params_schema=[
                {"key": "images", "label": "参考图", "type": "images", "max": 3, "required": True},
            ],
            bindings={"images": [
                {"node": "110", "field": "inputs.image"},
                {"node": "111", "field": "inputs.image"},
                {"node": "112", "field": "inputs.image"},
            ]},
        )
    r = c.post(
        "/api/apps/multi-ref/run", headers=_h(tokens),
        json={"values": {"images": ["a.png", "b.png"]}},
    )
    assert r.status_code == 200, r.text
    submitted = fake.graphs[0]
    assert submitted["110"]["inputs"]["image"] == "a.png"
    assert submitted["111"]["inputs"]["image"] == "b.png"
    assert "112" not in submitted
    assert submitted["104"]["inputs"]["ref_image_1"] == ["110", 0]
    assert submitted["104"]["inputs"]["ref_image_2"] == ["111", 0]
    assert "ref_image_3" not in submitted["104"]["inputs"]


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


def test_run_usage_count_not_incremented_on_submit(ctx):
    """2026-08-30 P2:提交即 +1 是误计(失败也计)——run 不再动 usage_count,仅审计。"""
    c, tokens, _, engine, _, _ = ctx
    for _ in range(2):
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 200
    assert r.json()["usage_count"] == 0  # 提交后未 done,不计数
    with Session(engine) as s:
        a = s.get(App, "t2i-basic")
        assert a.usage_count == 0
        logs = s.exec(select(AuditLog).where(AuditLog.action == "app.run")).all()
        assert len(logs) == 2
        assert logs[0].target_type == "app" and logs[0].target_id == "t2i-basic"


def test_run_usage_count_incremented_on_done(ctx):
    """Job 到 done 时 tracker.mark_done 按 params.app_id +1;幂等不重复计;
    失败/取消不 +1;应用被删时 done 不炸。"""
    from unittest.mock import patch

    import app.comfy.tracker as tracker_mod

    c, tokens, _, engine, _, _ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
    )
    assert r.status_code == 200
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 0

    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_done("prompt-app-1", ["/api/images?filename=a.png"])
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 1
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        assert job.status == "done"

        # 幂等:重复 mark_done 不重复计数
    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_done("prompt-app-1", ["/api/images?filename=a.png"])
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 1

    # 失败作业不计数(第二条作业直接落库,prompt_id 与第一条不同)
    with Session(engine) as s:
        s.add(Job(
            tenant_id=job.tenant_id, user_id=job.user_id, prompt_id="prompt-app-2",
            worker="http://fake-worker", kind="app_run", status="queued",
            prompt="y", params=json.dumps({"app_id": "t2i-basic", "values": {}}),
        ))
        s.commit()
    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_status("prompt-app-2", "error", "worker 执行失败")
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 1

    # 应用已删除:done 回写不炸、不阻塞落库
    with Session(engine) as s:
        s.add(Job(
            tenant_id=job.tenant_id, user_id=job.user_id, prompt_id="prompt-app-3",
            worker="http://fake-worker", kind="app_run", status="queued",
            prompt="z", params=json.dumps({"app_id": "deleted-app", "values": {}}),
        ))
        s.commit()
    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_done("prompt-app-3", ["/api/images?filename=b.png"])
    with Session(engine) as s:
        job3 = s.exec(select(Job).where(Job.prompt_id == "prompt-app-3")).first()
        assert job3.status == "done"


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

def test_run_h3_graph_uses_dedicated_client_not_pool(ctx, monkeypatch):
    """海螺图含 MiniMaxH3* 时走 pick_h3_client,不进通用 WorkerPool。"""
    from unittest.mock import AsyncMock

    c, tokens, _, engine, _, pool = ctx
    graph = {
        "6": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3.safetensors"}},
        "104": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"prompt": "hi"}},
        "9": {"class_type": "SaveVideo", "inputs": {}},
    }
    with Session(engine) as s:
        _seed_app(
            s, id="h3-i2v-app",
            workflow_json=graph,
            params_schema=[{"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True}],
            bindings={"prompt": {"node": "104", "field": "inputs.prompt"}},
        )

    fake = pool.client if hasattr(pool, "client") else None
    # 复用 pool 里那台假 client 的 queue_prompt,但 pick 不应被调用
    h3_client = pool._client if hasattr(pool, "_client") else None

    class _H3:
        def __init__(self, inner):
            self.inner = inner
            self.base_url = "http://192.168.71.127:8195"
        async def queue_prompt(self, graph, client_id):  # noqa: ANN001
            return await self.inner.queue_prompt(graph, client_id)

    inner = pool
    # ctx pool 是 _RecordingPool,本身 queue_prompt 在其 client 上
    rec = pool

    async def _pick_h3():
        # 借用 recording pool 的 queue: 直接返回一个带 queue_prompt 的对象
        class C:
            base_url = "http://192.168.71.127:8195"
            async def queue_prompt(self, graph, client_id):  # noqa: ANN001
                return "h3-prompt-id"
        return C()

    monkeypatch.setattr("app.services.h3.pick_h3_client", _pick_h3)
    monkeypatch.setattr("app.services.h3.ensure_h3_enabled", lambda: None)

    async def _ready(client, node="MiniMaxH3ImageToVideo"):  # noqa: ANN001
        return None
    monkeypatch.setattr("app.services.h3.ensure_h3_ready", _ready)

    async def _vram(client):  # noqa: ANN001
        return None
    monkeypatch.setattr("app.services.h3.ensure_h3_vram", _vram)

    r = c.post(
        "/api/apps/h3-i2v-app/run",
        headers=_h(tokens),
        json={"values": {"prompt": "一只猫"}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "h3-prompt-id"
    assert pool.calls == []

