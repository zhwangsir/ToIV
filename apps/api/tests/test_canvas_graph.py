"""A2 画布编排——validate_api_graph 静态校验 / propose_canvas_graph 工具 / canvas-proposal 端点。"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.agent.tools_gen as tools_gen
from app.models import AgentSession, Tenant, User
from app.security import hash_password
from app.services.canvas_graph import validate_api_graph

_OBJINFO = {
    "KSampler": {
        "input": {"required": {
            "model": ["MODEL"],
            "positive": ["CONDITIONING"],
            "negative": ["CONDITIONING"],
            "latent_image": ["LATENT"],
            "seed": ["INT", {"default": 0}],
            "steps": ["INT", {"default": 20}],
            "cfg": ["FLOAT", {"default": 7.0}],
            "sampler_name": [["euler", "dpmpp_2m", "ddim"]],
        }},
        "output": ["LATENT"],
    },
    "CheckpointLoaderSimple": {
        "input": {"required": {"ckpt_name": [["a.safetensors", "b.safetensors"]]}},
        "output": ["MODEL", "CLIP", "VAE"],
    },
    "CLIPTextEncode": {
        "input": {"required": {"text": ["STRING"], "clip": ["CLIP"]}},
        "output": ["CONDITIONING"],
    },
    "EmptyLatentImage": {
        "input": {"required": {"width": ["INT", {"default": 512}],
                               "height": ["INT", {"default": 512}],
                               "batch_size": ["INT", {"default": 1}]}},
        "output": ["LATENT"],
    },
    "VAEDecode": {
        "input": {"required": {"samples": ["LATENT"], "vae": ["VAE"]}},
        "output": ["IMAGE"],
    },
    "SaveImage": {
        "input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING", {"default": "ComfyUI"}]}},
        "output": [],
    },
}


def _good_graph() -> dict:
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "pos", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "neg", "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512}},
        "5": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
            "latent_image": ["4", 0], "steps": 4, "sampler_name": "euler",
        }},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "t"}},
    }


def test_validate_good_graph():
    v = validate_api_graph(_good_graph(), _OBJINFO)
    assert v["errors"] == [] and v["node_count"] == 7


def test_validate_unknown_class_and_bad_link():
    g = _good_graph()
    g["8"] = {"class_type": "NoSuchNode", "inputs": {}}
    g["9"] = {"class_type": "SaveImage", "inputs": {"images": ["404", 0]}}
    g["10"] = {"class_type": "VAEDecode", "inputs": {"samples": ["5", 9], "vae": ["1", 2]}}
    v = validate_api_graph(g, _OBJINFO)
    assert any("NoSuchNode" in e for e in v["errors"])
    assert any("源节点 404 不存在" in e for e in v["errors"])
    assert any("输出槽 9 超界" in e for e in v["errors"])


def test_validate_required_and_combo():
    g = _good_graph()
    g["2"] = {"class_type": "CLIPTextEncode", "inputs": {}}  # 缺 text/clip required
    g["1"]["inputs"]["ckpt_name"] = "zzz.safetensors"  # 不在选项
    v = validate_api_graph(g, _OBJINFO)
    # 连线型(clip=CLIP 引用)缺失 → error;widget 型(text=STRING)缺失 → 仅 warning
    assert any("缺 required 连线输入 clip" in e for e in v["errors"])
    assert not any("缺 required 输入 text" in e for e in v["errors"])
    assert any("text: required widget 未给值" in w for w in v["warnings"])
    assert any("不在选项内" in w for w in v["warnings"])
    assert v["combo_fixes"][0]["suggestion"] in ("a.safetensors", "b.safetensors")


def test_validate_widget_2list_not_link():
    """widget 2-list 值([name, 强度])不得误判为连线(2026-09-21 LLM 图误杀实证)。"""
    obj = dict(_OBJINFO)
    obj["LoraLoader"] = {
        "input": {"required": {
            "model": ["MODEL"], "clip": ["CLIP"],
            "lora_name": [["x.safetensors", "y.safetensors"]],
            "strength_model": ["FLOAT", {"default": 1.0}],
        }},
        "output": ["MODEL", "CLIP"],
    }
    g = _good_graph()
    g["8"] = {"class_type": "LoraLoader", "inputs": {
        "model": ["1", 0], "clip": ["1", 1], "lora_name": "x.safetensors",
    }}
    # strength_model 有默认不查;若误把 ["1",0] 当 widget 值不该报,真连线才该过
    v = validate_api_graph(g, obj)
    assert v["errors"] == [], v["errors"]
    # 形态像 widget 但 spec 是引用类型 → 仍按连线查(真断链应报)
    g["8"]["inputs"]["model"] = ["404", 0]
    v2 = validate_api_graph(g, obj)
    assert any("源节点 404 不存在" in e for e in v2["errors"])


def test_validate_shape_guards():
    assert validate_api_graph({}, _OBJINFO)["errors"]
    big = {str(i): {"class_type": "EmptyLatentImage", "inputs": {}} for i in range(201)}
    assert any("上限" in e for e in validate_api_graph(big, _OBJINFO)["errors"])


# ---------------------------------------------------------------------------
# 工具与端点
# ---------------------------------------------------------------------------


@pytest.fixture
def fx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        u = User(email="cv@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        s.add(u)
        s.commit()
        s.refresh(u)
        sess = AgentSession(id=uuid.uuid4().hex, user_id=u.id, title="t")
        s.add(sess)
        s.commit()
        s.refresh(sess)
        ids = (u.id, sess.id)
    return engine, ids


def _ctx(engine, uid, sid, with_session=True):
    with Session(engine) as s:
        user = s.get(User, uid)
        agent_sess = s.get(AgentSession, sid) if with_session else None
    return {"user": user, "session": Session(engine), "pool": None, "agent_session": agent_sess}


def _run(coro):
    import asyncio
    return asyncio.run(coro)


def test_propose_canvas_graph_flow(fx, monkeypatch):
    engine, (uid, sid) = fx

    async def fake_objinfo(classes="", user=None):
        return {k: _OBJINFO[k] for k in _OBJINFO if not classes or k in classes.split(",")}

    monkeypatch.setattr("app.routes.canvas.canvas_object_info", fake_objinfo)
    c = _ctx(engine, uid, sid)
    text, events = _run(tools_gen.exec_propose_canvas_graph(
        {"title": "t2i 基础图", "description": "加载→采样→解码→保存", "graph": _good_graph()}, c))
    assert "校验通过" in text and "7 节点" in text
    assert events and events[0]["type"] == "proposal"
    assert events[0]["data"]["kind"] == "canvas_graph"
    assert events[0]["data"]["node_count"] == 7

    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        prop = json.loads(sess.pending_proposal)
    assert prop["type"] == "canvas_graph" and prop["status"] == "pending"
    assert prop["graph"]["5"]["class_type"] == "KSampler"
    c["session"].close()

    # 校验失败:错误返给 LLM 重写,不落提案
    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        sess.pending_proposal = None
        s.add(sess)
        s.commit()
    bad = _good_graph()
    bad["9"] = {"class_type": "GhostNode", "inputs": {}}
    c = _ctx(engine, uid, sid)
    text, events = _run(tools_gen.exec_propose_canvas_graph(
        {"title": "x", "description": "y", "graph": bad}, c))
    assert "GhostNode" in text and events and events[0]["type"] == "tool_event"
    with Session(engine) as s:
        assert s.get(AgentSession, sid).pending_proposal is None
    c["session"].close()

    # 无会话上下文
    c = _ctx(engine, uid, sid, with_session=False)
    text, _ = _run(tools_gen.exec_propose_canvas_graph(
        {"title": "x", "description": "y", "graph": _good_graph()}, c))
    assert "不支持" in text
    c["session"].close()

    # object_info 空 → 干净报错不落提案
    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        sess.pending_proposal = None
        s.add(sess)
        s.commit()

    async def fake_empty(classes="", user=None):
        return {}

    monkeypatch.setattr("app.routes.canvas.canvas_object_info", fake_empty)
    c = _ctx(engine, uid, sid)
    text, events = _run(tools_gen.exec_propose_canvas_graph(
        {"title": "x", "description": "y", "graph": _good_graph()}, c))
    assert "清单为空" in text and events[0]["type"] == "tool_event"
    with Session(engine) as s:
        assert s.get(AgentSession, sid).pending_proposal is None
    c["session"].close()


def test_canvas_proposal_endpoint(fx):
    from fastapi.testclient import TestClient
    from app.db import get_session
    from app.main import app
    from app.security import create_token

    engine, (uid, sid) = fx
    graph = _good_graph()
    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        sess.pending_proposal = json.dumps({
            "type": "canvas_graph", "proposal_id": "p1", "title": "图", "body": "说明",
            "warnings": [], "graph": graph, "status": "pending"})
        s.add(sess)
        s.commit()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    c = TestClient(app)
    H = {"Authorization": f"Bearer {create_token(uid)}"}
    r = c.get(f"/api/agent/sessions/{sid}/canvas-proposal", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "图" and body["graph"]["1"]["class_type"] == "CheckpointLoaderSimple"
    # 无 pending → 404;非画布类 → 404
    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        sess.pending_proposal = None
        s.add(sess)
        s.commit()
    assert c.get(f"/api/agent/sessions/{sid}/canvas-proposal", headers=H).status_code == 404
    with Session(engine) as s:
        sess = s.get(AgentSession, sid)
        sess.pending_proposal = json.dumps({"type": "plan", "title": "x", "status": "pending"})
        s.add(sess)
        s.commit()
    assert c.get(f"/api/agent/sessions/{sid}/canvas-proposal", headers=H).status_code == 404
    app.dependency_overrides.pop(get_session, None)
