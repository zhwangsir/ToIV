"""无限画布 REST API + SSE 测试(M1.1)。

覆盖:
  - 画布 CRUD(创建/列表/快照/更新/删除 + 级联删节点和边)
  - 节点 CRUD(创建/快照/更新位置/删除 + 级联删边)
  - 边 CRUD(创建/删除)
  - 节点执行骨架(POST /run 置 status=running)
  - 多租户隔离(用户 B 拿不到用户 A 的画布,直访/改/删/加节点均 404)
  - SSE 端点返回 200 且 content-type 为 text/event-stream

参考现有测试风格:用 TestClient + StaticPool 内存 SQLite 覆盖 get_session;
SSE 测试直接驱动 ASGI app(httpx ASGITransport 在流式响应上有兼容问题,
会等待 app 协程返回;SSE 是无限流,故用 ASGI app + receive/disconnect 模拟)。
"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import Canvas, CanvasEdge, CanvasNode, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def ctx():
    """构造两个用户(分属不同租户)的多租户测试场景。"""
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
        # 租户 A + 用户 A
        tenant_a = Tenant(name="tenant-a")
        s.add(tenant_a)
        s.commit()
        s.refresh(tenant_a)
        user_a = User(
            email="a@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant_a.id,
        )
        s.add(user_a)
        s.commit()
        s.refresh(user_a)
        # 租户 B + 用户 B(不同租户,做隔离测试)
        tenant_b = Tenant(name="tenant-b")
        s.add(tenant_b)
        s.commit()
        s.refresh(tenant_b)
        user_b = User(
            email="b@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant_b.id,
        )
        s.add(user_b)
        s.commit()
        s.refresh(user_b)
        uid_a, uid_b = user_a.id, user_b.id

    yield TestClient(app), create_token(uid_a), create_token(uid_b), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- #
# 画布 CRUD
# --------------------------------------------------------------------------- #
def test_create_and_list_canvas(ctx):
    """创建画布 → 列表能查到;字段对齐前端 types.ts。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    r = client.post("/api/canvas", headers=H, json={"name": "我的画布"})
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["name"] == "我的画布"
    assert c["voice_active"] is False
    assert c["default_ref_audio"] == ""
    # 字段集与前端 Canvas 接口对齐(不含 tenant_id / user_id,不泄露)
    assert set(c.keys()) == {
        "id", "name", "voice_active", "default_ref_audio",
        "created_at", "updated_at",
    }
    cid = c["id"]
    # 列表
    r = client.get("/api/canvas", headers=H)
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == cid


def test_get_canvas_snapshot(ctx):
    """GET /canvas/{id} 返回完整快照 {canvas, nodes, edges}。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "snap"}).json()["id"]
    # 加 2 节点 + 1 边
    n1 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0,
              "payload": {"text": "hello"}},
    ).json()
    n2 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "prompt", "position_x": 100, "position_y": 0},
    ).json()
    client.post(
        f"/api/canvas/{cid}/edges", headers=H,
        json={"source": n1["id"], "target": n2["id"], "label": "prompt"},
    )
    # 快照
    r = client.get(f"/api/canvas/{cid}", headers=H)
    assert r.status_code == 200, r.text
    snap = r.json()
    assert snap["canvas"]["id"] == cid
    assert len(snap["nodes"]) == 2
    assert len(snap["edges"]) == 1
    # payload 是 JSON 串(对齐前端 payload: string),前端按需 json.parse
    assert json.loads(snap["nodes"][0]["payload"]) == {"text": "hello"}
    # 空 payload 落库为 "{}"
    assert json.loads(snap["nodes"][1]["payload"]) == {}
    # 边字段对齐
    assert snap["edges"][0]["label"] == "prompt"


def test_update_canvas(ctx):
    """PATCH 画布:name/voice_active/default_ref_audio。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    r = client.patch(
        f"/api/canvas/{cid}", headers=H,
        json={"name": "新名", "voice_active": True, "default_ref_audio": "/audio/a.wav"},
    )
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["name"] == "新名"
    assert c["voice_active"] is True
    assert c["default_ref_audio"] == "/audio/a.wav"


def test_delete_canvas_cascades(ctx):
    """删画布应级联删节点和边(SQLite 不强制 FK,手动 DELETE)。"""
    client, token_a, _, engine = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    n1 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).json()
    n2 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 100, "position_y": 0},
    ).json()
    client.post(
        f"/api/canvas/{cid}/edges", headers=H,
        json={"source": n1["id"], "target": n2["id"]},
    )
    # 删画布
    r = client.delete(f"/api/canvas/{cid}", headers=H)
    assert r.status_code == 200, r.text
    # 验证数据库已清空
    with Session(engine) as s:
        canvas = s.get(Canvas, cid)
        nodes = s.exec(select(CanvasNode).where(CanvasNode.canvas_id == cid)).all()
        edges = s.exec(select(CanvasEdge).where(CanvasEdge.canvas_id == cid)).all()
    assert canvas is None
    assert nodes == []
    assert edges == []


# --------------------------------------------------------------------------- #
# 节点 CRUD
# --------------------------------------------------------------------------- #
def test_update_node_position(ctx):
    """PATCH 节点:更新位置 + 标题(前端拖拽后回写)。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    nid = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).json()["id"]
    r = client.patch(
        f"/api/canvas/{cid}/nodes/{nid}", headers=H,
        json={"position_x": 100.5, "position_y": -50, "title": "改名"},
    )
    assert r.status_code == 200, r.text
    n = r.json()
    assert n["position_x"] == 100.5
    assert n["position_y"] == -50
    assert n["title"] == "改名"


def test_update_node_payload_serialized(ctx):
    """PATCH 节点 payload(dict)→ 落库为 JSON 串。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    nid = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "llm", "position_x": 0, "position_y": 0,
              "payload": {"text": "你好"}},
    ).json()["id"]
    # 改 payload
    r = client.patch(
        f"/api/canvas/{cid}/nodes/{nid}", headers=H,
        json={"payload": {"text": "你好", "response": "你好啊"}, "status": "done"},
    )
    assert r.status_code == 200, r.text
    n = r.json()
    assert json.loads(n["payload"]) == {"text": "你好", "response": "你好啊"}
    assert n["status"] == "done"


def test_update_node_invalid_kind_400(ctx):
    """非法 kind/status → 400。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    # 非法 kind
    r = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "no_such_kind", "position_x": 0, "position_y": 0},
    )
    assert r.status_code == 400
    # 合法节点 + 非法 status
    nid = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).json()["id"]
    r = client.patch(
        f"/api/canvas/{cid}/nodes/{nid}", headers=H,
        json={"status": "running_away"},
    )
    assert r.status_code == 400


def test_delete_node_cascades_edges(ctx):
    """删节点应级联删相关边(source 或 target 匹配)。"""
    client, token_a, _, engine = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    n1 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).json()
    n2 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 100, "position_y": 0},
    ).json()
    # 两条边都涉及 n1(e1.source=n1, e2.target=n1)
    client.post(
        f"/api/canvas/{cid}/edges", headers=H,
        json={"source": n1["id"], "target": n2["id"]},
    )
    client.post(
        f"/api/canvas/{cid}/edges", headers=H,
        json={"source": n2["id"], "target": n1["id"]},
    )
    # 删 n1:e1 和 e2 都应被级联删
    r = client.delete(f"/api/canvas/{cid}/nodes/{n1['id']}", headers=H)
    assert r.status_code == 200, r.text
    # 验证数据库:只剩 n2,边全删
    with Session(engine) as s:
        nodes = s.exec(select(CanvasNode).where(CanvasNode.canvas_id == cid)).all()
        edges = s.exec(select(CanvasEdge).where(CanvasEdge.canvas_id == cid)).all()
    assert len(nodes) == 1
    assert nodes[0].id == n2["id"]
    assert edges == []


# --------------------------------------------------------------------------- #
# O3.2:REST 删除 → SSE 事件推送
# --------------------------------------------------------------------------- #
def _drain_queue(q: asyncio.Queue) -> list[dict]:
    """把队列里已到的事件全部取出(非阻塞)。"""
    out: list[dict] = []
    while True:
        try:
            out.append(q.get_nowait())
        except asyncio.QueueEmpty:
            return out


async def test_delete_node_publishes_deleted_events(ctx):
    """REST 删节点 → 推 node_deleted + 每条级联边的 edge_deleted(O3.2)。

    事件在响应返回前已 await publish 完成,故响应后直接 drain 队列即可。
    """
    from app.canvas_events import subscribe_queue, unsubscribe_queue

    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "del-ev"}).json()["id"]
    n1 = client.post(f"/api/canvas/{cid}/nodes", headers=H, json={"kind": "text"}).json()["id"]
    n2 = client.post(f"/api/canvas/{cid}/nodes", headers=H, json={"kind": "text"}).json()["id"]
    n3 = client.post(f"/api/canvas/{cid}/nodes", headers=H, json={"kind": "text"}).json()["id"]
    e1 = client.post(
        f"/api/canvas/{cid}/edges", headers=H, json={"source": n1, "target": n2},
    ).json()["id"]
    e2 = client.post(
        f"/api/canvas/{cid}/edges", headers=H, json={"source": n1, "target": n3},
    ).json()["id"]

    q = subscribe_queue(cid)
    try:
        r = client.delete(f"/api/canvas/{cid}/nodes/{n1}", headers=H)
        assert r.status_code == 200, r.text
        events = _drain_queue(q)
        pairs = [(e.get("type"), e.get("node_id") or e.get("edge_id")) for e in events]
        assert ("node_deleted", n1) in pairs
        assert ("edge_deleted", e1) in pairs
        assert ("edge_deleted", e2) in pairs
        # 所有事件都带 canvas_id
        assert all(e.get("canvas_id") == cid for e in events)

        # 再删无边节点 n2:只推 node_deleted,不再推 edge_deleted
        r = client.delete(f"/api/canvas/{cid}/nodes/{n2}", headers=H)
        assert r.status_code == 200, r.text
        events = _drain_queue(q)
        assert [(e.get("type"), e.get("node_id")) for e in events] == [("node_deleted", n2)]
    finally:
        unsubscribe_queue(cid, q)


async def test_delete_edge_publishes_deleted_event(ctx):
    """REST 删边 → 推 edge_deleted(O3.2)。"""
    from app.canvas_events import subscribe_queue, unsubscribe_queue

    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "del-edge-ev"}).json()["id"]
    n1 = client.post(f"/api/canvas/{cid}/nodes", headers=H, json={"kind": "text"}).json()["id"]
    n2 = client.post(f"/api/canvas/{cid}/nodes", headers=H, json={"kind": "text"}).json()["id"]
    e1 = client.post(
        f"/api/canvas/{cid}/edges", headers=H, json={"source": n1, "target": n2},
    ).json()["id"]

    q = subscribe_queue(cid)
    try:
        r = client.delete(f"/api/canvas/{cid}/edges/{e1}", headers=H)
        assert r.status_code == 200, r.text
        events = _drain_queue(q)
        assert [(e.get("type"), e.get("edge_id")) for e in events] == [("edge_deleted", e1)]
        assert events[0]["canvas_id"] == cid
    finally:
        unsubscribe_queue(cid, q)


# --------------------------------------------------------------------------- #
# 边 CRUD
# --------------------------------------------------------------------------- #
def test_add_edge_validates_node_in_canvas(ctx):
    """加边时 source/target 必须在当前画布内(防越权引用别人画布的节点)。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    n1 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).json()
    # source 不存在 → 400
    r = client.post(
        f"/api/canvas/{cid}/edges", headers=H,
        json={"source": "nonexistent", "target": n1["id"]},
    )
    assert r.status_code == 400
    # 正常加边
    n2 = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 100, "position_y": 0},
    ).json()
    r = client.post(
        f"/api/canvas/{cid}/edges", headers=H,
        json={"source": n1["id"], "target": n2["id"]},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    # 删边
    r = client.delete(f"/api/canvas/{cid}/edges/{eid}", headers=H)
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# 节点执行(M1.5a:复用 agent/tools.run_canvas_node 真执行器)
# --------------------------------------------------------------------------- #
def _override_pool(pool) -> None:
    """覆盖 get_pool 依赖,提供不连真实 ComfyUI 的 fake pool(用于 image 节点路径)。"""
    from app.deps import get_pool
    app.dependency_overrides[get_pool] = lambda: pool


class _FakeWorker:
    def __init__(self, base_url: str = "http://fake-worker:8002") -> None:
        self.base_url = base_url


class _FakePool:
    """最小 fake pool:text/prompt/llm 节点不会访问 pool.clients,只需能 pick/clients 不抛。"""

    def __init__(self, base_url: str = "http://fake-worker:8002") -> None:
        self._w = _FakeWorker(base_url)

    @property
    def clients(self) -> list:
        return [self._w]

    async def pick(self, required=()):  # noqa: ANN001
        return self._w


def test_run_node_text_kind_completes(ctx):
    """POST /run/{nodeId}:text 节点执行 → status=done(payload 保留原 text)。

    text kind 不调任何外部服务(无需 mock LLM/TTS/ComfyUI),最适合验证端点主链路。
    """
    client, token_a, _, _ = ctx
    H = _h(token_a)
    _override_pool(_FakePool())
    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    nid = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0,
              "payload": {"text": "你好"}},
    ).json()["id"]
    r = client.post(f"/api/canvas/{cid}/run/{nid}", headers=H)
    assert r.status_code == 200, r.text
    n = r.json()
    assert n["status"] == "done", n
    assert n["error"] == ""
    # payload 仍为 {"text":"你好"}(text 节点不改 payload)
    payload = json.loads(n["payload"])
    assert payload.get("text") == "你好"


def test_run_node_llm_kind_calls_chat_and_persists_response(ctx, monkeypatch):
    """POST /run/{nodeId}:llm 节点调 app.agent.llm.chat,response 落 payload。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    _override_pool(_FakePool())

    async def fake_chat(messages, tools=None, **kw):
        return {"content": "LLM 回复"}

    monkeypatch.setattr("app.agent.llm.chat", fake_chat)

    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    nid = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "llm", "position_x": 0, "position_y": 0,
              "payload": {"text": "你是谁?"}},
    ).json()["id"]
    r = client.post(f"/api/canvas/{cid}/run/{nid}", headers=H)
    assert r.status_code == 200, r.text
    n = r.json()
    assert n["status"] == "done", n
    payload = json.loads(n["payload"])
    assert payload.get("response") == "LLM 回复"
    assert payload.get("text") == "你是谁?"


def test_run_node_failure_sets_error_status(ctx, monkeypatch):
    """POST /run/{nodeId}:执行器抛异常 → status=error,error 字段含异常信息。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    _override_pool(_FakePool())

    async def boom(node, pool, user, session):
        raise RuntimeError("boom")

    # 注意:routes/canvas.py 用 ``from app.agent.tools import run_canvas_node``
    # 把函数绑定到了 routes.canvas 模块命名空间,monkeypatch 必须改 routes.canvas
    # 处的引用才能生效(monkeypatch app.agent.tools.run_canvas_node 不会影响已绑定的名字)。
    monkeypatch.setattr("app.routes.canvas.run_canvas_node", boom)

    cid = client.post("/api/canvas", headers=H, json={"name": "x"}).json()["id"]
    nid = client.post(
        f"/api/canvas/{cid}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0,
              "payload": {"text": "x"}},
    ).json()["id"]
    r = client.post(f"/api/canvas/{cid}/run/{nid}", headers=H)
    assert r.status_code == 200, r.text
    n = r.json()
    assert n["status"] == "error", n
    assert "boom" in n["error"]


# --------------------------------------------------------------------------- #
# 多租户隔离
# --------------------------------------------------------------------------- #
def test_tenant_isolation(ctx):
    """用户 B 不能访问用户 A 的画布(列表为空 + 直访/改/删/加节点均 404)。"""
    client, token_a, token_b, _ = ctx
    H_a = _h(token_a)
    H_b = _h(token_b)
    # A 建画布
    cid = client.post("/api/canvas", headers=H_a, json={"name": "A的画布"}).json()["id"]
    # B 列表看不到 A 的画布
    items_b = client.get("/api/canvas", headers=H_b).json()["items"]
    assert items_b == []
    # B 直访 A 的画布 → 404(不泄露存在性)
    assert client.get(f"/api/canvas/{cid}", headers=H_b).status_code == 404
    # B 改 A 的画布 → 404
    assert client.patch(
        f"/api/canvas/{cid}", headers=H_b, json={"name": "hack"}
    ).status_code == 404
    # B 删 A 的画布 → 404
    assert client.delete(f"/api/canvas/{cid}", headers=H_b).status_code == 404
    # B 在 A 的画布上加节点 → 404
    assert client.post(
        f"/api/canvas/{cid}/nodes", headers=H_b,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).status_code == 404
    # A 自己仍能访问(确认 404 不是误伤)
    assert client.get(f"/api/canvas/{cid}", headers=H_a).status_code == 200


def test_node_cross_canvas_404(ctx):
    """用户在 A 画布下访问 B 画布的节点 → 404(防越权)。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid1 = client.post("/api/canvas", headers=H, json={"name": "c1"}).json()["id"]
    cid2 = client.post("/api/canvas", headers=H, json={"name": "c2"}).json()["id"]
    # 在 c2 加节点
    nid_c2 = client.post(
        f"/api/canvas/{cid2}/nodes", headers=H,
        json={"kind": "text", "position_x": 0, "position_y": 0},
    ).json()["id"]
    # 通过 cid1 访问 cid2 的节点 → 404(canvas_id 不匹配)
    assert client.get(f"/api/canvas/{cid1}", headers=H).status_code == 200
    r = client.patch(
        f"/api/canvas/{cid1}/nodes/{nid_c2}", headers=H,
        json={"title": "hack"},
    )
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 鉴权
# --------------------------------------------------------------------------- #
def test_endpoints_require_auth(ctx):
    """无 token → 401(覆盖几个关键端点)。"""
    client, *_ = ctx
    assert client.get("/api/canvas").status_code == 401
    assert client.post("/api/canvas", json={"name": "x"}).status_code == 401
    assert client.get("/api/canvas/nope").status_code == 401
    assert client.delete("/api/canvas/nope").status_code == 401


# --------------------------------------------------------------------------- #
# SSE(直接驱动 ASGI app —— httpx ASGITransport 在无限流式响应上会阻塞)
# --------------------------------------------------------------------------- #
async def _drive_sse(path: str, headers: list[tuple[bytes, bytes]] | None = None) -> dict:
    """驱动 ASGI app 跑一次 SSE 请求,返回响应头信息。

    通过 receive() 在响应头到达后立即发 http.disconnect,让 SSE handler 的
    断连检测器取消流并清理订阅。返回 ``{status, headers, first_body}``。
    """
    headers = headers or []
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 8888),
        "server": ("test", 80),
        "scheme": "http",
        "root_path": "",
        "app": app,
    }
    response_started = asyncio.Event()
    info: dict = {"status": None, "headers": {}, "first_body": b""}

    async def receive():
        # 等响应头到达后再发 disconnect,模拟"客户端读到响应头后断开"
        await response_started.wait()
        return {"type": "http.disconnect"}

    async def send(m):
        if m["type"] == "http.response.start":
            info["status"] = m["status"]
            info["headers"] = {k.decode(): v.decode() for k, v in m.get("headers", [])}
            response_started.set()
        elif m["type"] == "http.response.body" and not info["first_body"]:
            info["first_body"] = m.get("body", b"")

    await app(scope, receive, send)
    return info


async def test_sse_returns_200_and_correct_content_type(ctx):
    """SSE 端点应返回 200 且 content-type 为 text/event-stream。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "sse-test"}).json()["id"]

    info = await _drive_sse(
        f"/api/canvas/{cid}/events",
        headers=[(b"authorization", f"Bearer {token_a}".encode())],
    )
    assert info["status"] == 200, f"unexpected status: {info['status']}"
    ct = info["headers"].get("content-type", "")
    assert "text/event-stream" in ct, f"unexpected content-type: {ct}"
    # 初始 SSE 注释行应已发出(: connected,客户端 EventSource 自动忽略)
    assert info["first_body"].startswith(b":"), info["first_body"]


async def test_sse_unauthorized_401(ctx):
    """SSE 无 token → 401。"""
    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "sse-noauth"}).json()["id"]

    info = await _drive_sse(f"/api/canvas/{cid}/events")
    assert info["status"] == 401


async def test_sse_cross_tenant_404(ctx):
    """SSE 订阅别人画布 → 404(不泄露存在性)。"""
    client, token_a, token_b, _ = ctx
    H_a = _h(token_a)
    cid = client.post("/api/canvas", headers=H_a, json={"name": "A的画布"}).json()["id"]

    info = await _drive_sse(
        f"/api/canvas/{cid}/events",
        headers=[(b"authorization", f"Bearer {token_b}".encode())],
    )
    assert info["status"] == 404


async def test_sse_relay_event_from_bus(ctx):
    """SSE 应转发事件总线 publish 的事件(M1.2 Agent 工具会用到)。

    通过 publish 推一个 node_updated 事件,SSE 流应收到该事件并发出。

    关键时序:必须等 stream 发出 ``: connected`` 注释行(证明已 subscribe_queue)
    后再 publish,否则订阅未建立时事件会被丢弃,导致测试死锁。
    """
    from app.canvas_events import publish

    client, token_a, _, _ = ctx
    H = _h(token_a)
    cid = client.post("/api/canvas", headers=H, json={"name": "sse-bus"}).json()["id"]

    path = f"/api/canvas/{cid}/events"
    scope = {
        "type": "http", "method": "GET", "path": path,
        "raw_path": path.encode(), "query_string": b"",
        "headers": [(b"authorization", f"Bearer {token_a}".encode())],
        "client": ("127.0.0.1", 8888), "server": ("test", 80),
        "scheme": "http", "root_path": "", "app": app,
    }
    bodies: list[bytes] = []
    started = asyncio.Event()
    subscribed = asyncio.Event()  # 收到 `: connected` → 证明 stream 已 subscribe_queue
    got_event = asyncio.Event()

    async def receive():
        # 时序:响应开始 → stream 订阅(发 :connected)→ publish → 收到事件 → 断开
        await started.wait()
        await subscribed.wait()  # 等 stream 把订阅建好,否则 publish 的事件会丢
        await publish(cid, {"type": "node_updated", "canvas_id": cid, "node": {"id": "n1"}})
        await got_event.wait()
        return {"type": "http.disconnect"}

    async def send(m):
        if m["type"] == "http.response.start":
            started.set()
        elif m["type"] == "http.response.body":
            body = m.get("body", b"")
            bodies.append(body)
            if not subscribed.is_set() and body.startswith(b":"):
                subscribed.set()  # `: connected` 注释行 → stream 已订阅事件总线
            if b"node_updated" in body:
                got_event.set()

    await app(scope, receive, send)
    # 验证事件确实通过 SSE 流转发了
    joined = b"".join(bodies)
    assert b"node_updated" in joined
    # json.dumps 默认带空格(: 后),用 cid 自身做包含校验更稳
    assert cid.encode() in joined
