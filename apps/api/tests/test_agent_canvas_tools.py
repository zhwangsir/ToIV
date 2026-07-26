"""M1.2 Agent 画布工具 + 语音 Agent 端点测试。

覆盖:
- TOOL_SCHEMAS 数量 = 13(原 8 + 新 5)
- canvas_add_node:创建节点并返回 node_id + node_added 事件
- canvas_inspect:列出画布节点(空 / 非空)
- canvas_connect_nodes:连接两个节点 + 跨画布连接拒接
- canvas_pin_result:把 urls 固定为节点 + parent_id 落 parent_ids
- canvas_run_subgraph:text/llm 节点执行(image 节点 mock 复用 generate_image)
- canvas 工具在 canvas_id 为空时拒绝执行
- /api/agent/voice 端点:mock ASR + mock LLM,验证 SSE 流含 voice 事件
"""
from __future__ import annotations

import asyncio
import io
import json
import wave
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent import tools
from app.db import get_session
from app.main import app
from app.models import Canvas, CanvasEdge, CanvasNode, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures
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


def _fake_pool() -> MagicMock:
    """构造一个 fake WorkerPool,clients/pick 都可用(magic mock 不抛错)。"""
    pool = MagicMock()
    client = AsyncMock()
    client.base_url = "http://worker"
    client.queue_prompt = AsyncMock(return_value="prompt-1")
    client.get_result_files = AsyncMock(return_value=[{"filename": "out.png", "subfolder": "", "type": "output"}])
    pool.clients = [client]
    pool.pick = AsyncMock(return_value=client)
    return pool, client


def _patch_settings(monkeypatch, **overrides) -> None:
    """覆盖 app.config.get_settings 返回的简单对象。"""
    base = {
        "tts_url": "http://tts.local",
        "whisper_url": "",
        "whisper_model": "base",
        "whisper_compute": "int8",
        "whisper_device": "cpu",
        "default_ckpt": "flux2_dev_fp8mixed.safetensors",
    }
    base.update(overrides)

    class _S:
        pass

    s = _S()
    for k, v in base.items():
        setattr(s, k, v)
    monkeypatch.setattr("app.agent.tools.get_settings", lambda: s)
    monkeypatch.setattr("app.config.get_settings", lambda: s)


def _patch_ratelimit(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.routes.voice_agent.enforce_generation_rate_limit", lambda *a, **k: None
    )


# --------------------------------------------------------------------------- #
# 1) TOOL_SCHEMAS 数量与命名
# --------------------------------------------------------------------------- #
def test_tool_schemas_count_is_13():
    """原 8 + 新 5(canvas_inspect/add_node/connect_nodes/run_subgraph/pin_result)。"""
    assert len(tools.TOOL_SCHEMAS) == 13
    names = {t["function"]["name"] for t in tools.TOOL_SCHEMAS}
    expected_new = {
        "canvas_inspect", "canvas_add_node", "canvas_connect_nodes",
        "canvas_run_subgraph", "canvas_pin_result",
    }
    assert expected_new.issubset(names)


def test_canvas_add_node_schema_kind_enum_has_10_values():
    """canvas_add_node.kind 枚举应包含全部 10 种 CanvasNode.kind。"""
    schema = next(
        t for t in tools.TOOL_SCHEMAS if t["function"]["name"] == "canvas_add_node"
    )
    kind_enum = schema["function"]["parameters"]["properties"]["kind"]["enum"]
    assert set(kind_enum) == {
        "text", "prompt", "image", "video", "audio",
        "model3d", "llm", "comfy_workflow", "tts", "asr",
    }


# --------------------------------------------------------------------------- #
# 2) canvas_add_node:创建节点 + node_added 事件
# --------------------------------------------------------------------------- #
async def test_canvas_add_node_creates_node_and_emits_event(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id

        text, events = await tools.execute(
            "canvas_add_node",
            {
                "kind": "prompt",
                "title": "一只猫",
                "payload": {"text": "a cute cat", "negative": "blurry"},
                "position": {"x": 100, "y": 200},
            },
            pool, user, s, canvas_id=cid,
        )

    assert "已添加" in text or "添加" in text
    # 事件列表含 node_added
    added = [e for e in events if e.get("type") == "node_added"]
    assert len(added) == 1
    node_dict = added[0]["node"]
    assert node_dict["kind"] == "prompt"
    assert node_dict["title"] == "一只猫"
    assert node_dict["position"] == {"x": 100.0, "y": 200.0}
    assert node_dict["payload"] == {"text": "a cute cat", "negative": "blurry"}
    assert node_dict["status"] == "idle"

    # 节点真落库
    with Session(engine) as s:
        nodes = s.exec(select(CanvasNode).where(CanvasNode.canvas_id == cid)).all()
        assert len(nodes) == 1
        assert nodes[0].id == node_dict["id"]
        assert nodes[0].kind == "prompt"


async def test_canvas_add_node_default_position_random(ctx, monkeypatch):
    """不传 position 时,后端随机散布(坐标在合理范围内)。"""
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        _, events = await tools.execute(
            "canvas_add_node", {"kind": "text", "title": "笔记"},
            pool, user, s, canvas_id=canvas.id,
        )

    node = events[0]["node"]
    assert 0 <= node["position"]["x"] <= 800
    assert 0 <= node["position"]["y"] <= 600


async def test_canvas_add_node_rejects_invalid_kind(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        text, events = await tools.execute(
            "canvas_add_node", {"kind": "unknown_kind"},
            pool, user, s, canvas_id=canvas.id,
        )
    assert "非法 kind" in text
    assert events == []


async def test_canvas_add_node_rejects_without_canvas_id(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        text, events = await tools.execute(
            "canvas_add_node", {"kind": "text"}, pool, user, s, canvas_id=None,
        )
    assert "画布上下文" in text
    assert events == []


# --------------------------------------------------------------------------- #
# 3) canvas_inspect:列出节点
# --------------------------------------------------------------------------- #
async def test_canvas_inspect_lists_nodes(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        # 先加 2 个节点
        await tools.execute(
            "canvas_add_node", {"kind": "text", "title": "A"}, pool, user, s, canvas_id=cid
        )
        await tools.execute(
            "canvas_add_node", {"kind": "prompt", "title": "B"}, pool, user, s, canvas_id=cid
        )
        # inspect
        text, events = await tools.execute(
            "canvas_inspect", {}, pool, user, s, canvas_id=cid
        )

    assert "2 个节点" in text
    assert "A" in text and "B" in text
    assert events == []  # inspect 不产事件


async def test_canvas_inspect_empty_canvas(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        text, _ = await tools.execute(
            "canvas_inspect", {}, pool, user, s, canvas_id=canvas.id
        )
    assert "画布为空" in text


# --------------------------------------------------------------------------- #
# 4) canvas_connect_nodes:连接 + 跨画布拒接
# --------------------------------------------------------------------------- #
async def test_canvas_connect_nodes_creates_edge(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        _, ev1 = await tools.execute(
            "canvas_add_node", {"kind": "prompt", "title": "P"}, pool, user, s, canvas_id=cid
        )
        _, ev2 = await tools.execute(
            "canvas_add_node", {"kind": "image", "title": "I"}, pool, user, s, canvas_id=cid
        )
        src_id = ev1[0]["node"]["id"]
        tgt_id = ev2[0]["node"]["id"]

        text, events = await tools.execute(
            "canvas_connect_nodes",
            {"source_id": src_id, "target_id": tgt_id, "label": "prompt"},
            pool, user, s, canvas_id=cid,
        )

    assert "已连接" in text
    # 落库
    with Session(engine) as s:
        edges = s.exec(select(CanvasEdge).where(CanvasEdge.canvas_id == cid)).all()
        assert len(edges) == 1
        assert edges[0].source == src_id
        assert edges[0].target == tgt_id
        assert edges[0].label == "prompt"


async def test_canvas_connect_nodes_rejects_cross_canvas(ctx, monkeypatch):
    """跨画布连接应被拒(源/目标不属于当前 canvas)。"""
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        c1 = _make_canvas(s, user, name="c1")
        c2 = _make_canvas(s, user, name="c2")
        _, ev1 = await tools.execute(
            "canvas_add_node", {"kind": "text"}, pool, user, s, canvas_id=c1.id
        )
        _, ev2 = await tools.execute(
            "canvas_add_node", {"kind": "text"}, pool, user, s, canvas_id=c2.id
        )
        # 在 c1 上下文里连接 c2 的节点 → 应失败
        text, _ = await tools.execute(
            "canvas_connect_nodes",
            {"source_id": ev1[0]["node"]["id"], "target_id": ev2[0]["node"]["id"]},
            pool, user, s, canvas_id=c1.id,
        )
    assert "不属于当前画布" in text


# --------------------------------------------------------------------------- #
# 5) canvas_pin_result:固定产物为节点
# --------------------------------------------------------------------------- #
async def test_canvas_pin_result_creates_done_node(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        # 先加一个 prompt 节点(做父)
        _, ev_parent = await tools.execute(
            "canvas_add_node", {"kind": "prompt", "title": "父"}, pool, user, s, canvas_id=cid
        )
        parent_id = ev_parent[0]["node"]["id"]

        text, events = await tools.execute(
            "canvas_pin_result",
            {
                "kind": "image",
                "urls": ["/api/images?filename=a.png", "/api/images?filename=b.png"],
                "title": "结果1",
                "parent_id": parent_id,
            },
            pool, user, s, canvas_id=cid,
        )

    assert "2 个 image" in text
    added = [e for e in events if e.get("type") == "node_added"]
    assert len(added) == 1
    node = added[0]["node"]
    assert node["kind"] == "image"
    assert node["status"] == "done"  # pin 后直接 done
    assert node["title"] == "结果1"
    assert node["payload"]["urls"] == ["/api/images?filename=a.png", "/api/images?filename=b.png"]
    assert node["parent_ids"] == [parent_id]  # 版本树父节点


async def test_canvas_pin_result_rejects_empty_urls(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        text, events = await tools.execute(
            "canvas_pin_result", {"kind": "image", "urls": []},
            pool, user, s, canvas_id=canvas.id,
        )
    assert "urls 必填" in text
    assert events == []


# --------------------------------------------------------------------------- #
# 6) canvas_run_subgraph:text / llm 节点执行
# --------------------------------------------------------------------------- #
async def test_canvas_run_subgraph_text_node_returns_payload(ctx, monkeypatch):
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        _, ev = await tools.execute(
            "canvas_add_node",
            {"kind": "text", "payload": {"text": "你好"}},
            pool, user, s, canvas_id=cid,
        )
        nid = ev[0]["node"]["id"]

        text, events = await tools.execute(
            "canvas_run_subgraph", {"node_ids": [nid]},
            pool, user, s, canvas_id=cid,
        )

    assert "子图执行完成" in text
    assert "你好" in text
    # text 节点不产媒体事件,但节点 status 应落 done
    with Session(engine) as s:
        n = s.get(CanvasNode, nid)
        assert n.status == "done"


async def test_canvas_run_subgraph_llm_node_calls_chat(ctx, monkeypatch):
    """llm 节点执行时调 app.agent.llm.chat,response 落 payload。"""
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    captured: dict[str, Any] = {}

    async def fake_chat(messages, tools=None, **kw):
        captured["messages"] = messages
        return {"content": "LLM 回复内容"}

    monkeypatch.setattr("app.agent.llm.chat", fake_chat)

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        _, ev = await tools.execute(
            "canvas_add_node",
            {"kind": "llm", "payload": {"text": "你是谁?"}},
            pool, user, s, canvas_id=cid,
        )
        nid = ev[0]["node"]["id"]

        text, _ = await tools.execute(
            "canvas_run_subgraph", {"node_ids": [nid]},
            pool, user, s, canvas_id=cid,
        )

    assert "LLM 回复内容" in text
    # 落库
    with Session(engine) as s:
        n = s.get(CanvasNode, nid)
        assert n.status == "done"
        payload = json.loads(n.payload)
        assert payload["response"] == "LLM 回复内容"


async def test_canvas_run_subgraph_unknown_node_recorded(ctx, monkeypatch):
    """node_ids 含不存在 id,记录失败不阻断其余节点。"""
    _, _, user, engine = ctx
    _patch_settings(monkeypatch)
    pool, _ = _fake_pool()

    with Session(engine) as s:
        canvas = _make_canvas(s, user)
        cid = canvas.id
        _, ev = await tools.execute(
            "canvas_add_node", {"kind": "text", "payload": {"text": "x"}},
            pool, user, s, canvas_id=cid,
        )
        nid = ev[0]["node"]["id"]

        text, _ = await tools.execute(
            "canvas_run_subgraph", {"node_ids": [nid, "nonexistent-id"]},
            pool, user, s, canvas_id=cid,
        )

    assert "nonexistent-id" in text
    assert "节点不存在" in text


# --------------------------------------------------------------------------- #
# 7) /api/agent/voice 端点:mock ASR + mock LLM,验证 SSE 流含 voice 事件
# --------------------------------------------------------------------------- #
def _minimal_wav() -> bytes:
    """构造一个合法的最小 WAV 文件供 ASR mock 不报错。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 1600)  # 0.1s 静音
    return buf.getvalue()


class _FakeTTSResponse:
    def __init__(self, content: bytes = b"RIFFxxxx"):
        self.status_code = 200
        self.content = content

    def raise_for_status(self) -> None:
        pass


class _FakeTTSClient:
    """fake httpx.AsyncClient:POST /tts 返回 RIFF 开头的 wav 字节。"""

    def __init__(self, *args, **kwargs):
        self.calls: list[tuple] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def post(self, url: str, data=None, files=None):
        self.calls.append(("post", url, data, files))
        return _FakeTTSResponse(content=b"RIFF" + b"\x00" * 100)


def _patch_llm_simple(monkeypatch, reply: str = "你好,我是 ToIV 智能助手。"):
    """mock LLM:无 tool_calls,直接给一段文字回复。"""

    async def fake_chat(messages, tools=None, **kw):
        return {"content": reply, "tool_calls": []}

    monkeypatch.setattr("app.agent.llm.chat", fake_chat)


def _patch_asr_local(monkeypatch, transcript: str = "你好"):
    """mock 容器内置 faster-whisper 路径(不走真实模型)。"""

    async def fake_transcribe_local(path):
        return transcript

    monkeypatch.setattr(
        "app.routes.voice_agent._transcribe_local", fake_transcribe_local
    )
    # 同时 mock 外部 ASR,确保不会被意外调用
    async def fake_transcribe_external(base, path, name):
        return transcript

    monkeypatch.setattr(
        "app.routes.voice_agent._transcribe_external", fake_transcribe_external
    )


def test_voice_agent_endpoint_streams_text_and_voice_events(ctx, monkeypatch, tmp_path):
    """完整链路:ASR → LLM → SSE(text 事件 + voice 事件 + done)。"""
    c, token, _, _ = ctx
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)
    _patch_llm_simple(monkeypatch, reply="你好,我是 ToIV 助手。")
    _patch_asr_local(monkeypatch, transcript="你好")
    # TTS 用 fake client
    monkeypatch.setattr("httpx.AsyncClient", _FakeTTSClient)
    # 存储目录指到 tmp_path,避免污染 /data
    monkeypatch.setattr("app.routes.voice_agent.content_subdir", lambda name: tmp_path)

    wav_bytes = _minimal_wav()
    files = {"audio": ("voice.webm", wav_bytes, "audio/webm")}
    # TestClient 用 GET 处理 SSE,POST 也能拿到流
    with c.stream(
        "POST",
        "/api/agent/voice",
        files=files,
        headers={"Authorization": f"Bearer {token}"},
    ) as resp:
        assert resp.status_code == 200, resp.text
        events = []
        for line in resp.iter_lines():
            if not line:
                continue
            # SSE 格式:event: msg\ndata: {...}
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[len("data: "):]))
                except json.JSONDecodeError:
                    pass

    # 应至少有 1 个 text + 1 个 voice + done
    types = [e.get("type") for e in events]
    assert "text" in types, f"events: {events}"
    assert "voice" in types, f"events: {events}"
    # voice 事件应带 url
    voice_ev = next(e for e in events if e.get("type") == "voice")
    assert voice_ev["url"].startswith("/api/manju/voice/")
    assert voice_ev["text"] == "你好,我是 ToIV 助手。"


def test_voice_agent_endpoint_with_canvas_id_passes_through(ctx, monkeypatch, tmp_path):
    """canvas_id 透传:LLM 收到的 system 应含画布工具说明。"""
    c, token, _, engine = ctx
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)

    captured: dict[str, Any] = {}

    async def fake_chat(messages, tools=None, **kw):
        captured["system"] = messages[0]["content"]
        captured["tools"] = tools
        return {"content": "ok", "tool_calls": []}

    monkeypatch.setattr("app.agent.llm.chat", fake_chat)
    _patch_asr_local(monkeypatch, transcript="看一下画布")
    monkeypatch.setattr("httpx.AsyncClient", _FakeTTSClient)
    monkeypatch.setattr("app.routes.voice_agent.content_subdir", lambda name: tmp_path)

    with Session(engine) as s:
        user = s.exec(select(User)).first()
        canvas = _make_canvas(s, user)

    wav_bytes = _minimal_wav()
    files = {"audio": ("voice.webm", wav_bytes, "audio/webm")}
    data = {"canvas_id": canvas.id}

    with c.stream(
        "POST",
        "/api/agent/voice",
        files=files,
        data=data,
        headers={"Authorization": f"Bearer {token}"},
    ) as resp:
        assert resp.status_code == 200, resp.text
        # 消费完流
        for _ in resp.iter_lines():
            pass

    sys_prompt = captured.get("system", "")
    assert "画布上下文" in sys_prompt
    assert "canvas_inspect" in sys_prompt
    # tools 应包含 13 个(原 8 + 新 5)
    assert len(captured["tools"]) == 13


def test_voice_agent_rejects_empty_audio(ctx, monkeypatch):
    c, token, _, _ = ctx
    _patch_ratelimit(monkeypatch)
    _patch_settings(monkeypatch)

    files = {"audio": ("voice.webm", b"", "audio/webm")}
    r = c.post(
        "/api/agent/voice",
        files=files,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 400


def test_voice_agent_rejects_unauthenticated(ctx):
    c, *_ = ctx
    wav_bytes = _minimal_wav()
    files = {"audio": ("voice.webm", wav_bytes, "audio/webm")}
    r = c.post("/api/agent/voice", files=files)
    assert r.status_code == 401
