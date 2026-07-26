"""M2 画布子图 ↔ ComfyUI API JSON 双向桥测试。

覆盖:
- 映射表常量(CLASS_TYPE_TO_KIND / KIND_TO_COMFY_BUILDERS)
- 导出:canvas_subgraph_to_comfy_prompt(正向/负向/显式标签/缺图报错/多工作流报错)
- 导入:comfy_prompt_to_canvas_subgraph(提取 prompt/image/audio + 边标签)
- UI 格式转换:comfy_ui_graph_to_api(内置模板 widgets 映射 + 未知类型报错)
- REST 端点:/canvas/workflows/templates 列表 + /canvas/{cid}/import_workflow 导入 + /canvas/{cid}/run_subgraph 执行
"""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.canvas_comfy_bridge import (
    CLASS_TYPE_TO_KIND,
    KIND_TO_COMFY_BUILDERS,
    canvas_subgraph_to_comfy_prompt,
    comfy_prompt_to_canvas_subgraph,
    comfy_ui_graph_to_api,
    validate_comfy_prompt,
)
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Canvas, CanvasEdge, CanvasNode, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures(对齐 test_agent_canvas_tools.py 风格)
# --------------------------------------------------------------------------- #
def _make_user(session: Session, email: str = "u@toiv.ai") -> tuple[User, str]:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        role="user",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user, create_token(user.id)


def _make_canvas(session: Session, user: User, name: str = "测试画布") -> Canvas:
    c = Canvas(tenant_id=user.tenant_id, user_id=user.id, name=name)
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


@pytest.fixture
def ctx():
    """内存 SQLite + 已注册的 TestClient。每个测试独立 DB。"""
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
        user, token = _make_user(s)
    yield TestClient(app), token, user, engine
    app.dependency_overrides.clear()


def _fake_pool() -> tuple[MagicMock, AsyncMock]:
    """构造 fake WorkerPool,queue_prompt / get_result_files 均可 mock。"""
    pool = MagicMock()
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="prompt-1")
    client.get_result_files = AsyncMock(
        return_value=[{"filename": "out.png", "subfolder": "", "type": "output"}]
    )
    pool.clients = [client]
    pool.pick = AsyncMock(return_value=client)
    return pool, client


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# 一个最小可用的 ComfyUI API prompt(2 个 CLIPTextEncode + 1 个 SaveImage)
_MINI_GRAPH: dict[str, Any] = {
    "1": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "a cat", "clip": ["3", 1]},
    },
    "2": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "blurry", "clip": ["3", 1]},
    },
    "3": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "flux.safetensors"},
    },
    "9": {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "ToIV", "images": ["8", 0]},
    },
}


class _FakeNode:
    """模拟 CanvasNode(bridge 是纯函数,接受任意带属性的对象)。"""

    def __init__(self, id: str, kind: str, title: str = "", payload: dict | None = None):
        self.id = id
        self.kind = kind
        self.title = title
        self.payload = json.dumps(payload or {}, ensure_ascii=False)


class _FakeEdge:
    def __init__(self, source: str, target: str, label: str = ""):
        self.source = source
        self.target = target
        self.label = label


# --------------------------------------------------------------------------- #
# 1) 映射表常量
# --------------------------------------------------------------------------- #
def test_mapping_tables_cover_builtin_templates():
    """CLASS_TYPE_TO_KIND 至少覆盖 CLIPTextEncode/LoadImage/LoadAudio;
    KIND_TO_COMFY_BUILDERS 至少覆盖 prompt/text/image/audio。"""
    assert CLASS_TYPE_TO_KIND["CLIPTextEncode"] == "prompt"
    assert CLASS_TYPE_TO_KIND["LoadImage"] == "image"
    assert CLASS_TYPE_TO_KIND["LoadAudio"] == "audio"
    for k in ("prompt", "text", "image", "audio"):
        assert k in KIND_TO_COMFY_BUILDERS


# --------------------------------------------------------------------------- #
# 1b) M3.2:LoadVideo / VHS_LoadVideo 映射
# --------------------------------------------------------------------------- #
def test_m32_video_class_types_mapped():
    """M3.2:LoadVideo/VHS_LoadVideo → video kind;video builder 已登记。"""
    assert CLASS_TYPE_TO_KIND["LoadVideo"] == "video"
    assert CLASS_TYPE_TO_KIND["VHS_LoadVideo"] == "video"
    assert "video" in KIND_TO_COMFY_BUILDERS


def test_m32_export_video_node_overrides_load_video():
    """video 节点(payload.video)→ 覆盖 LoadVideo.video 输入。"""
    graph = dict(_MINI_GRAPH)
    graph["7"] = {"class_type": "LoadVideo", "inputs": {"video": "old.mp4"}}
    wf = _FakeNode("wf1", "comfy_workflow", payload={"graph": graph})
    vid = _FakeNode("v1", "video", payload={"video": "new.mp4"})
    out, report = canvas_subgraph_to_comfy_prompt(
        [wf, vid], [_FakeEdge("v1", "wf1", "7.video")]
    )
    assert out["7"]["inputs"]["video"] == "new.mp4"
    assert report["overrides"]["7.video"] == "v1"


def test_m32_export_video_node_falls_back_to_urls_basename():
    """video 节点只有 urls(pin 的产物)→ 取 basename 作为文件名。"""
    graph = dict(_MINI_GRAPH)
    graph["7"] = {"class_type": "LoadVideo", "inputs": {"video": "old.mp4"}}
    wf = _FakeNode("wf1", "comfy_workflow", payload={"graph": graph})
    vid = _FakeNode("v1", "video", payload={"urls": ["/api/images?filename=clip.webm&worker=w"]})
    out, _ = canvas_subgraph_to_comfy_prompt(
        [wf, vid], [_FakeEdge("v1", "wf1", "7.video")]
    )
    assert out["7"]["inputs"]["video"] == "clip.webm"


def test_m32_import_extracts_load_video_as_video_node():
    """导入:LoadVideo 提取为 video 节点,边标签指向真实输入键。"""
    graph = dict(_MINI_GRAPH)
    graph["7"] = {"class_type": "LoadVideo", "inputs": {"video": "in.mp4"}}
    nodes, edges = comfy_prompt_to_canvas_subgraph(graph, canvas_id="c1")
    vid_nodes = [n for n in nodes if n["kind"] == "video"]
    assert len(vid_nodes) == 1
    assert vid_nodes[0]["title"] == "输入视频"
    assert vid_nodes[0]["payload"]["filename"] == "in.mp4"
    vid_edges = [e for e in edges if e["source_ref"] == "x:7"]
    assert vid_edges and vid_edges[0]["label"] == "7.video"


def test_m32_ui_graph_converts_load_video_widgets():
    """UI 转换:LoadVideo 第 2 个 widget(上传按钮)被丢弃。"""
    ui = {
        "nodes": [
            {
                "id": 7,
                "type": "LoadVideo",
                "inputs": [],
                "widgets_values": ["demo.mp4", "upload"],
            },
        ],
        "links": [],
    }
    api = comfy_ui_graph_to_api(ui)
    assert api["7"] == {"class_type": "LoadVideo", "inputs": {"video": "demo.mp4"}}


# --------------------------------------------------------------------------- #
# 2) validate_comfy_prompt 结构校验
# --------------------------------------------------------------------------- #
def test_validate_comfy_prompt_rejects_bad_structure():
    with pytest.raises(ValueError, match="为空或不是 dict"):
        validate_comfy_prompt({})
    with pytest.raises(ValueError, match="缺少 class_type"):
        validate_comfy_prompt({"1": {"inputs": {}}})
    # 合法结构不抛错
    validate_comfy_prompt(_MINI_GRAPH)


# --------------------------------------------------------------------------- #
# 3) 导出:正向/负向/显式标签覆盖
# --------------------------------------------------------------------------- #
def test_export_overrides_positive_and_negative_text():
    wf = _FakeNode("wf1", "comfy_workflow", payload={"graph": _MINI_GRAPH})
    pos = _FakeNode("p1", "prompt", payload={"text": "a dog"})
    neg = _FakeNode("p2", "prompt", payload={"text": "ugly"})
    edges = [
        _FakeEdge("p1", "wf1", "positive"),
        _FakeEdge("p2", "wf1", "negative"),
    ]
    graph, report = canvas_subgraph_to_comfy_prompt([wf, pos, neg], edges)
    assert graph["1"]["inputs"]["text"] == "a dog"
    assert graph["2"]["inputs"]["text"] == "ugly"
    assert report["overrides"]["1.text"] == "p1"
    assert report["overrides"]["2.text"] == "p2"


def test_export_explicit_label_overrides_image_input():
    graph_with_image = dict(_MINI_GRAPH)
    graph_with_image["5"] = {
        "class_type": "LoadImage",
        "inputs": {"image": "old.png"},
    }
    wf = _FakeNode("wf1", "comfy_workflow", payload={"graph": graph_with_image})
    img = _FakeNode("i1", "image", payload={"filename": "new.png"})
    edges = [_FakeEdge("i1", "wf1", "5.image")]
    graph, _ = canvas_subgraph_to_comfy_prompt([wf, img], edges)
    assert graph["5"]["inputs"]["image"] == "new.png"


# --------------------------------------------------------------------------- #
# 4) 导出:缺工作流/多工作流/不支持 kind 报错
# --------------------------------------------------------------------------- #
def test_export_rejects_missing_workflow_node():
    with pytest.raises(ValueError, match="需要一个含 graph 的 comfy_workflow"):
        canvas_subgraph_to_comfy_prompt([_FakeNode("x", "text")], [])


def test_export_rejects_multiple_workflow_nodes():
    wf1 = _FakeNode("w1", "comfy_workflow", payload={"graph": _MINI_GRAPH})
    wf2 = _FakeNode("w2", "comfy_workflow", payload={"graph": _MINI_GRAPH})
    with pytest.raises(ValueError, match="最多包含一个"):
        canvas_subgraph_to_comfy_prompt([wf1, wf2], [])


def test_export_rejects_unsupported_source_kind():
    wf = _FakeNode("wf1", "comfy_workflow", payload={"graph": _MINI_GRAPH})
    m3d = _FakeNode("m1", "model3d", payload={"urls": ["x.glb"]})
    edges = [_FakeEdge("m1", "wf1", "positive")]
    with pytest.raises(ValueError, match="不能作为 ComfyUI 输入"):
        canvas_subgraph_to_comfy_prompt([wf, m3d], edges)


# --------------------------------------------------------------------------- #
# 5) 导入:提取 prompt/image/audio + 显式边标签
# --------------------------------------------------------------------------- #
def test_import_extracts_prompts_and_images():
    graph = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "hello"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "bad"}},
        "5": {"class_type": "LoadImage", "inputs": {"image": "in.png"}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }
    nodes, edges = comfy_prompt_to_canvas_subgraph(graph, canvas_id="c1")
    kinds = [n["kind"] for n in nodes]
    assert kinds.count("comfy_workflow") == 1
    assert kinds.count("prompt") == 2
    assert kinds.count("image") == 1
    # 边标签显式指向 <nid>.<key>
    labels = {e["label"] for e in edges}
    assert "1.text" in labels
    assert "2.text" in labels
    assert "5.image" in labels
    # 工作流节点 payload.graph 原样保存
    wf_node = next(n for n in nodes if n["kind"] == "comfy_workflow")
    assert wf_node["payload"]["graph"] == graph


def test_import_roundtrip_preserves_graph():
    """导入后再导出(不修改任何节点),graph 应与原图一致。"""
    nodes, edges = comfy_prompt_to_canvas_subgraph(_MINI_GRAPH, canvas_id="c1")
    wf = next(n for n in nodes if n["kind"] == "comfy_workflow")
    # 提取出的 prompt 节点在导出时会覆盖原图对应字段(值相同 → 图不变)
    fake_nodes = [
        _FakeNode(n["ref"], n["kind"], n["title"], n["payload"]) for n in nodes
    ]
    fake_edges = [
        _FakeEdge(e["source_ref"], e["target_ref"], e["label"]) for e in edges
    ]
    graph, _ = canvas_subgraph_to_comfy_prompt(fake_nodes, fake_edges)
    assert graph == _MINI_GRAPH


# --------------------------------------------------------------------------- #
# 6) UI 格式转换
# --------------------------------------------------------------------------- #
def test_ui_graph_to_api_converts_builtin_template():
    """txt2img_basic.json(UI 格式)转 API 格式后,关键节点/输入键齐全。"""
    ui = {
        "nodes": [
            {
                "id": 1,
                "type": "CheckpointLoaderSimple",
                "inputs": [],
                "widgets_values": ["flux.safetensors"],
            },
            {
                "id": 2,
                "type": "CLIPTextEncode",
                "inputs": [{"name": "clip", "link": 1}],
                "widgets_values": ["a cat"],
            },
            {
                "id": 3,
                "type": "KSampler",
                "inputs": [{"name": "model", "link": 2}],
                "widgets_values": [42, "randomize", 20, 7.0, "euler", "normal", 1.0],
            },
        ],
        "links": [
            [1, 1, 1, 2, 0, "CLIP"],
            [2, 1, 0, 3, 0, "MODEL"],
        ],
    }
    api = comfy_ui_graph_to_api(ui)
    assert api["1"]["class_type"] == "CheckpointLoaderSimple"
    assert api["1"]["inputs"]["ckpt_name"] == "flux.safetensors"
    assert api["2"]["inputs"]["text"] == "a cat"
    assert api["2"]["inputs"]["clip"] == ["1", 1]
    # KSampler 的 control_after_generate(None 项)被丢弃
    assert "control_after_generate" not in api["3"]["inputs"]
    assert api["3"]["inputs"]["seed"] == 42
    assert api["3"]["inputs"]["steps"] == 20


def test_ui_graph_to_api_rejects_unknown_class_type_with_widgets():
    ui = {
        "nodes": [
            {
                "id": 1,
                "type": "UnknownNode",
                "inputs": [],
                "widgets_values": ["x"],
            }
        ],
        "links": [],
    }
    with pytest.raises(ValueError, match="暂不支持转换 UnknownNode"):
        comfy_ui_graph_to_api(ui)


# --------------------------------------------------------------------------- #
# 7) REST 端点:/canvas/workflows/templates
# --------------------------------------------------------------------------- #
def test_rest_list_workflow_templates(ctx):
    client, token, _, _ = ctx
    resp = client.get("/api/canvas/workflows/templates", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    ids = {t["id"] for t in data["items"]}
    assert "txt2img_basic" in ids
    # 每个模板都带 API 格式 prompt + kind_hint(前端展示用)
    for t in data["items"]:
        assert isinstance(t["prompt"], dict)
        assert t["prompt"], f"{t['id']} prompt 为空"
        assert t["kind_hint"] in ("image", "video", "audio")


# --------------------------------------------------------------------------- #
# 8) REST 端点:/canvas/{cid}/import_workflow
# --------------------------------------------------------------------------- #
def test_rest_import_workflow_creates_nodes_and_edges(ctx):
    client, token, user, engine = ctx
    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id

    resp = client.post(
        f"/api/canvas/{cid}/import_workflow",
        headers=_auth(token),
        json={"template_id": "txt2img_basic"},
    )
    assert resp.status_code == 200
    data = resp.json()
    # O4.2:响应契约 {node_ids, edge_ids, count}(对齐前端 api.ts)
    assert data["count"] >= 2  # 至少 1 个 workflow + 1 个 prompt
    assert len(data["node_ids"]) == data["count"]
    assert isinstance(data["edge_ids"], list)

    # 落库校验
    with Session(engine) as s:
        nodes = s.exec(
            __import__("sqlmodel").select(CanvasNode).where(CanvasNode.canvas_id == cid)
        ).all()
        assert len(nodes) == data["count"]
        kinds = [n.kind for n in nodes]
        assert "comfy_workflow" in kinds
        # 边都指向 workflow 节点
        wf_id = next(n.id for n in nodes if n.kind == "comfy_workflow")
        edges = s.exec(
            __import__("sqlmodel").select(CanvasEdge).where(CanvasEdge.canvas_id == cid)
        ).all()
        for e in edges:
            assert e.target == wf_id


async def test_rest_import_workflow_publishes_sse_events(ctx):
    """O4.2:导入应推 node_added / edge_added 事件(前端实时落画布,不用刷新)。"""
    from app.canvas_events import subscribe_queue, unsubscribe_queue

    client, token, user, engine = ctx
    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id

    q = subscribe_queue(cid)
    try:
        resp = client.post(
            f"/api/canvas/{cid}/import_workflow",
            headers=_auth(token),
            json={"template_id": "txt2img_basic"},
        )
        assert resp.status_code == 200
        data = resp.json()
        events: list[dict] = []
        while True:
            try:
                events.append(q.get_nowait())
            except asyncio.QueueEmpty:
                break
        added_nodes = [e for e in events if e.get("type") == "node_added"]
        added_edges = [e for e in events if e.get("type") == "edge_added"]
        # 每个新增节点/边都推了事件,且 id 与响应一致
        assert {e["node"]["id"] for e in added_nodes} == set(data["node_ids"])
        assert {e["edge"]["id"] for e in added_edges} == set(data["edge_ids"])
        assert all(e.get("canvas_id") == cid for e in events)
    finally:
        unsubscribe_queue(cid, q)


def test_rest_import_workflow_rejects_other_users_canvas(ctx):
    client, token, user, engine = ctx
    # 另一个用户的画布
    with Session(engine) as s:
        other_tenant = Tenant(name="other")
        s.add(other_tenant)
        s.commit()
        s.refresh(other_tenant)
        other_user = User(
            email="other@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=other_tenant.id,
            role="user",
        )
        s.add(other_user)
        s.commit()
        s.refresh(other_user)
        other_canvas = Canvas(
            tenant_id=other_tenant.id, user_id=other_user.id, name="别人的画布"
        )
        s.add(other_canvas)
        s.commit()
        s.refresh(other_canvas)
        other_cid = other_canvas.id

    resp = client.post(
        f"/api/canvas/{other_cid}/import_workflow",
        headers=_auth(token),
        json={"template_id": "txt2img_basic"},
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# 9) REST 端点:/canvas/{cid}/run_subgraph
# --------------------------------------------------------------------------- #
def test_rest_run_subgraph_submits_and_returns_urls(ctx, monkeypatch):
    client, token, user, engine = ctx
    pool, fake_client = _fake_pool()
    app.dependency_overrides[get_pool] = lambda: pool

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        # 手动落一个 workflow 节点 + 一个 prompt 节点
        wf = CanvasNode(
            canvas_id=cid,
            kind="comfy_workflow",
            title="wf",
            payload=json.dumps({"graph": _MINI_GRAPH}),
        )
        p = CanvasNode(
            canvas_id=cid,
            kind="prompt",
            title="p",
            payload=json.dumps({"text": "a bird"}),
        )
        s.add(wf)
        s.add(p)
        s.commit()
        s.refresh(wf)
        s.refresh(p)
        s.add(CanvasEdge(canvas_id=cid, source=p.id, target=wf.id, label="positive"))
        s.commit()

    # 让 _wait_files 立刻返回(monkeypatch 掉真实等待)
    monkeypatch.setattr(
        "app.routes.canvas._wait_files",
        AsyncMock(return_value=[{"filename": "out.png", "subfolder": "", "type": "output"}]),
    )

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["prompt_id"] == "prompt-1"
    assert data["urls"]
    # 提交到 ComfyUI 的 graph 中 text 被覆盖
    submitted = fake_client.queue_prompt.call_args[0][0]
    assert submitted["1"]["inputs"]["text"] == "a bird"

    app.dependency_overrides.pop(get_pool, None)


# --------------------------------------------------------------------------- #
# 10) M3.1:run_subgraph 自动 pin 产物为画布节点
# --------------------------------------------------------------------------- #
def _setup_subgraph_canvas(engine, user) -> str:
    """建画布 + workflow 节点(带位置/标题) + prompt 节点 + positive 边,返回 cid。"""
    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        wf = CanvasNode(
            canvas_id=cid,
            kind="comfy_workflow",
            title="mywf",
            position_x=100.0,
            position_y=50.0,
            payload=json.dumps({"graph": _MINI_GRAPH}),
        )
        p = CanvasNode(
            canvas_id=cid,
            kind="prompt",
            title="p",
            payload=json.dumps({"text": "a bird"}),
        )
        s.add(wf)
        s.add(p)
        s.commit()
        s.refresh(wf)
        s.refresh(p)
        s.add(CanvasEdge(canvas_id=cid, source=p.id, target=wf.id, label="positive"))
        s.commit()
        return cid


def test_rest_run_subgraph_auto_pins_result_nodes(ctx, monkeypatch):
    """默认 auto_pin=true:png+mp4 混合产物 → pin 出 image/video 两个节点。"""
    client, token, user, engine = ctx
    pool, _ = _fake_pool()
    app.dependency_overrides[get_pool] = lambda: pool
    cid = _setup_subgraph_canvas(engine, user)

    monkeypatch.setattr(
        "app.routes.canvas._wait_files",
        AsyncMock(return_value=[
            {"filename": "a.png", "subfolder": "", "type": "output"},
            {"filename": "b.png", "subfolder": "", "type": "output"},
            {"filename": "c.mp4", "subfolder": "", "type": "output"},
            {"filename": "readme.txt", "subfolder": "", "type": "output"},  # 未知类型跳过
        ]),
    )

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30},
    )
    assert resp.status_code == 200
    data = resp.json()
    pinned = data["pinned"]
    assert len(pinned) == 2  # image / video 各一个,txt 被跳过

    by_kind = {n["kind"]: n for n in pinned}
    assert set(by_kind) == {"image", "video"}
    # image 节点含 2 个 urls,video 节点含 1 个
    assert len(by_kind["image"]["payload"]["urls"]) == 2
    assert len(by_kind["video"]["payload"]["urls"]) == 1
    # 状态与版本树
    assert all(n["status"] == "done" for n in pinned)
    wf_id = data["report"]["workflow_node_id"]
    assert all(n["parent_ids"] == [wf_id] for n in pinned)
    # 布局:工作流节点 (100,50) 右侧 420,纵向级联 240
    assert by_kind["image"]["position"]["x"] == 520.0
    assert by_kind["image"]["position"]["y"] == 50.0
    assert by_kind["video"]["position"]["y"] == 290.0
    # 标题含工作流名
    assert "mywf" in by_kind["image"]["title"]

    # 节点确实落库(画布快照能查到)
    snap = client.get(f"/api/canvas/{cid}", headers=_auth(token)).json()
    kinds = [n["kind"] for n in snap["nodes"]]
    assert kinds.count("image") == 1 and kinds.count("video") == 1

    app.dependency_overrides.pop(get_pool, None)


def test_rest_run_subgraph_auto_pin_disabled(ctx, monkeypatch):
    """auto_pin=false:不 pin 任何节点,pinned 为空数组。"""
    client, token, user, engine = ctx
    pool, _ = _fake_pool()
    app.dependency_overrides[get_pool] = lambda: pool
    cid = _setup_subgraph_canvas(engine, user)

    monkeypatch.setattr(
        "app.routes.canvas._wait_files",
        AsyncMock(return_value=[{"filename": "a.png", "subfolder": "", "type": "output"}]),
    )

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30, "auto_pin": False},
    )
    assert resp.status_code == 200
    assert resp.json()["pinned"] == []

    snap = client.get(f"/api/canvas/{cid}", headers=_auth(token)).json()
    assert not any(n["kind"] == "image" for n in snap["nodes"])

    app.dependency_overrides.pop(get_pool, None)


# --------------------------------------------------------------------------- #
# 11) M3.3:node_ids 选中过滤 + 工作流节点状态机
# --------------------------------------------------------------------------- #
def _canvas_node_ids(engine, cid: str) -> dict[str, str]:
    """返回 {kind: node_id} 映射(测试画布每类节点各一个)。"""
    with Session(engine) as s:
        rows = s.exec(select(CanvasNode).where(CanvasNode.canvas_id == cid)).all()
    return {n.kind: n.id for n in rows}


def test_m33_run_subgraph_with_node_ids_succeeds(ctx, monkeypatch):
    """node_ids 覆盖 wf+prompt 时正常执行(等价全画布)。"""
    client, token, user, engine = ctx
    pool, _ = _fake_pool()
    app.dependency_overrides[get_pool] = lambda: pool
    cid = _setup_subgraph_canvas(engine, user)
    ids = _canvas_node_ids(engine, cid)

    monkeypatch.setattr(
        "app.routes.canvas._wait_files",
        AsyncMock(return_value=[{"filename": "a.png", "subfolder": "", "type": "output"}]),
    )

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30, "node_ids": [ids["comfy_workflow"], ids["prompt"]]},
    )
    assert resp.status_code == 200
    assert resp.json()["urls"]

    app.dependency_overrides.pop(get_pool, None)


def test_m33_run_subgraph_node_ids_missing_workflow_returns_400(ctx):
    """选区不含 comfy_workflow 节点 → 400(而非 500)。"""
    client, token, user, engine = ctx
    cid = _setup_subgraph_canvas(engine, user)
    ids = _canvas_node_ids(engine, cid)

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30, "node_ids": [ids["prompt"]]},
    )
    assert resp.status_code == 400
    assert "comfy_workflow" in resp.json()["detail"]


def test_m33_run_subgraph_sets_wf_node_done(ctx, monkeypatch):
    """状态机:执行成功后工作流节点 status=done。"""
    client, token, user, engine = ctx
    pool, _ = _fake_pool()
    app.dependency_overrides[get_pool] = lambda: pool
    cid = _setup_subgraph_canvas(engine, user)

    monkeypatch.setattr(
        "app.routes.canvas._wait_files",
        AsyncMock(return_value=[{"filename": "a.png", "subfolder": "", "type": "output"}]),
    )

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30},
    )
    assert resp.status_code == 200

    ids = _canvas_node_ids(engine, cid)
    with Session(engine) as s:
        wf = s.get(CanvasNode, ids["comfy_workflow"])
        assert wf.status == "done"
        assert wf.error == ""

    app.dependency_overrides.pop(get_pool, None)


def test_m33_run_subgraph_timeout_sets_wf_node_error(ctx, monkeypatch):
    """状态机:超时(无产物)→ 504 且工作流节点 status=error。"""
    client, token, user, engine = ctx
    pool, _ = _fake_pool()
    app.dependency_overrides[get_pool] = lambda: pool
    cid = _setup_subgraph_canvas(engine, user)

    monkeypatch.setattr(
        "app.routes.canvas._wait_files",
        AsyncMock(return_value=[]),  # 超时:无产物
    )

    resp = client.post(
        f"/api/canvas/{cid}/run_subgraph",
        headers=_auth(token),
        json={"timeout": 30},
    )
    assert resp.status_code == 504

    ids = _canvas_node_ids(engine, cid)
    with Session(engine) as s:
        wf = s.get(CanvasNode, ids["comfy_workflow"])
        assert wf.status == "error"
        assert "超时" in wf.error

    app.dependency_overrides.pop(get_pool, None)


# --------------------------------------------------------------------------- #
# 12) O2:import_workflow 400 语义 + 模板列表缓存
# --------------------------------------------------------------------------- #
def test_o2_import_workflow_invalid_graph_returns_400(ctx):
    """graph 缺 class_type → 400(而非 500)。"""
    client, token, user, engine = ctx
    with Session(engine) as s:
        cid = _make_canvas(s, user).id

    resp = client.post(
        f"/api/canvas/{cid}/import_workflow",
        headers=_auth(token),
        json={"graph": {"1": {"inputs": {}}}},
    )
    assert resp.status_code == 400
    assert "class_type" in resp.json()["detail"]


def test_o2_template_list_cached_by_dir_signature():
    """目录签名不变 → 第二次调用返回同一对象(缓存命中)。"""
    from app.routes.canvas import _list_workflow_templates

    first = _list_workflow_templates()
    second = _list_workflow_templates()
    assert first is second  # 缓存命中:同一 list 对象
    assert first, "内置模板目录不应为空"
