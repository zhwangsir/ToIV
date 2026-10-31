"""直播助手(数字人 M5)测试:KB CRUD/违禁词/摄入状态机/会话生命周期/历史隔离。

不依赖真实 OpenTalking/LLM:
- monkeypatch app.routes.live_assistant._ot_post 替代 OpenTalking 调用;
- monkeypatch app.routes.live_assistant._llm_reply 替代 LLM 兜底。
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.live_assistant as live
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def clients():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    tokens: dict[str, str] = {}
    with Session(engine) as s:
        for email in ("a@toiv.ai", "b@toiv.ai"):
            tenant = Tenant(name=email)
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email=email,
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
                role="user",
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            tokens[email] = create_token(user.id)
    live._SESSIONS.clear()
    yield TestClient(app), tokens["a@toiv.ai"], tokens["b@toiv.ai"]
    live._SESSIONS.clear()
    app.dependency_overrides.clear()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_kb(client: TestClient, token: str, **kw) -> dict:
    body = {"trigger_words": ["价格"], "reply_text": "今天全场八折"}
    body.update(kw)
    r = client.post("/api/live/kb", json=body, headers=_auth(token))
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# 知识库 CRUD + 属主隔离
# ---------------------------------------------------------------------------
def test_kb_crud_and_owner_isolation(clients):
    client, ta, tb = clients
    kb = _mk_kb(client, ta, trigger_words=["价格", "多少钱"], priority=5)
    assert kb["trigger_words"] == ["价格", "多少钱"]
    assert kb["reply_type"] == "text"
    assert kb["priority"] == 5
    assert kb["enabled"] is True

    # 列表仅本人可见;按 priority 升序
    _mk_kb(client, ta, trigger_words=["运费"], priority=1)
    r = client.get("/api/live/kb", headers=_auth(ta))
    assert [k["priority"] for k in r.json()] == [1, 5]
    assert client.get("/api/live/kb", headers=_auth(tb)).json() == []

    # PATCH 部分更新
    r = client.patch(
        f"/api/live/kb/{kb['id']}",
        json={"reply_text": "涨价了", "enabled": False},
        headers=_auth(ta),
    )
    assert r.status_code == 200
    assert r.json()["reply_text"] == "涨价了"
    assert r.json()["enabled"] is False
    assert r.json()["trigger_words"] == ["价格", "多少钱"]  # 未动

    # 他人 PATCH/DELETE 404(防枚举)
    assert (
        client.patch(
            f"/api/live/kb/{kb['id']}", json={"priority": 1}, headers=_auth(tb)
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/live/kb/{kb['id']}", headers=_auth(tb)).status_code == 404
    )

    # 本人 DELETE → 204,列表消失
    assert client.delete(f"/api/live/kb/{kb['id']}", headers=_auth(ta)).status_code == 204
    ids = [k["id"] for k in client.get("/api/live/kb", headers=_auth(ta)).json()]
    assert kb["id"] not in ids


def test_kb_validation(clients):
    client, ta, _ = clients
    # 文本回复缺 reply_text → 422
    r = client.post(
        "/api/live/kb", json={"trigger_words": ["x"]}, headers=_auth(ta)
    )
    assert r.status_code == 422
    # 视频回复缺 reply_asset_url → 422
    r = client.post(
        "/api/live/kb",
        json={"trigger_words": ["x"], "reply_type": "video"},
        headers=_auth(ta),
    )
    assert r.status_code == 422
    # 空触发词 → 422
    r = client.post(
        "/api/live/kb",
        json={"trigger_words": ["  "], "reply_text": "y"},
        headers=_auth(ta),
    )
    assert r.status_code == 422
    # PATCH 把 reply_text 清空 → 422(组合校验)
    kb = _mk_kb(client, ta)
    r = client.patch(
        f"/api/live/kb/{kb['id']}", json={"reply_text": ""}, headers=_auth(ta)
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# 违禁词 CRUD
# ---------------------------------------------------------------------------
def test_banned_crud_and_isolation(clients):
    client, ta, tb = clients
    r = client.post("/api/live/banned", json={"word": "违禁"}, headers=_auth(ta))
    assert r.status_code == 201
    wid = r.json()["id"]
    assert [w["word"] for w in client.get("/api/live/banned", headers=_auth(ta)).json()] == ["违禁"]
    assert client.get("/api/live/banned", headers=_auth(tb)).json() == []
    assert client.delete(f"/api/live/banned/{wid}", headers=_auth(tb)).status_code == 404
    assert client.delete(f"/api/live/banned/{wid}", headers=_auth(ta)).status_code == 204
    assert client.get("/api/live/banned", headers=_auth(ta)).json() == []


# ---------------------------------------------------------------------------
# 摄入:违禁词拦截(输入/回复双向)
# ---------------------------------------------------------------------------
def test_ingest_banned_input(clients, monkeypatch):
    client, ta, _ = clients
    client.post("/api/live/banned", json={"word": "傻逼"}, headers=_auth(ta))
    _mk_kb(client, ta, trigger_words=["价格"])
    llm_called = {"n": 0}

    async def _fake_llm(text, author, kb_summary):  # noqa: ANN001
        llm_called["n"] += 1
        return "不该被调用"

    monkeypatch.setattr(live, "_llm_reply", _fake_llm)
    r = client.post(
        "/api/live/ingest",
        json={"text": "你这个傻逼主播,价格多少", "author": "黑粉"},
        headers=_auth(ta),
    )
    assert r.status_code == 200
    ev = r.json()
    assert ev["status"] == "banned"
    assert ev["reply_text"] == ""
    assert ev["matched_kb_id"] is None
    assert llm_called["n"] == 0


def test_ingest_banned_reply(clients, monkeypatch):
    client, ta, _ = clients
    _mk_kb(client, ta, trigger_words=["优惠"], reply_text="当然有,全场特价")
    client.post("/api/live/banned", json={"word": "特价"}, headers=_auth(ta))
    r = client.post(
        "/api/live/ingest", json={"text": "有优惠吗"}, headers=_auth(ta)
    )
    ev = r.json()
    assert ev["status"] == "banned"
    assert ev["reply_text"] == ""
    assert ev["matched_kb_id"] is not None  # 命中 KB 但回复被拦截


# ---------------------------------------------------------------------------
# 摄入:KB 优先级 + 大小写不敏感
# ---------------------------------------------------------------------------
def test_ingest_kb_priority_and_case_insensitive(clients, monkeypatch):
    client, ta, _ = clients
    _mk_kb(client, ta, trigger_words=["price"], reply_text="低优先级答案", priority=100)
    high = _mk_kb(
        client, ta, trigger_words=["PRICE查询"], reply_text="高优先级答案", priority=10
    )
    # 两条 KB 触发词均命中(大小写不敏感),priority 小者优先
    r = client.post(
        "/api/live/ingest", json={"text": "请问 price查询 一下"}, headers=_auth(ta)
    )
    ev = r.json()
    assert ev["matched_kb_id"] == high["id"]
    assert ev["reply_text"] == "高优先级答案"
    assert ev["reply_type"] == "text"


def test_ingest_disabled_kb_skipped(clients, monkeypatch):
    client, ta, _ = clients
    _mk_kb(client, ta, trigger_words=["价格"], enabled=False)

    async def _fake_llm(text, author, kb_summary):  # noqa: ANN001
        return "LLM 兜底回复"

    monkeypatch.setattr(live, "_llm_reply", _fake_llm)
    r = client.post(
        "/api/live/ingest", json={"text": "价格多少"}, headers=_auth(ta)
    )
    ev = r.json()
    assert ev["matched_kb_id"] is None
    assert ev["reply_text"] == "LLM 兜底回复"


# ---------------------------------------------------------------------------
# 摄入:LLM 兜底与固定文案
# ---------------------------------------------------------------------------
def test_ingest_llm_fallback_on_error(clients, monkeypatch):
    """LLM 调用失败 → 真实 _llm_reply 回退固定文案;ingest 链路不阻塞。"""
    client, ta, _ = clients
    import asyncio

    async def _broken_chat(*a, **k):  # noqa: ANN002, ANN003
        raise RuntimeError("LLM down")

    monkeypatch.setattr("app.agent.llm.chat", _broken_chat)
    reply = asyncio.run(live._llm_reply("你好", "观众", ""))
    assert reply == "这个问题我暂时答不上来"

    # 端到端:无 KB 命中 + LLM 故障 → 事件落库为固定文案,不 5xx
    r = client.post(
        "/api/live/ingest", json={"text": "随便问点什么"}, headers=_auth(ta)
    )
    assert r.status_code == 200
    ev = r.json()
    assert ev["matched_kb_id"] is None
    assert ev["reply_text"] == "这个问题我暂时答不上来"
    assert ev["status"] == "no_session"


# ---------------------------------------------------------------------------
# 播报状态机:no_session / spoken / speak_failed / replied(video)
# ---------------------------------------------------------------------------
def test_ingest_no_session(clients):
    client, ta, _ = clients
    _mk_kb(client, ta, trigger_words=["价格"])
    r = client.post(
        "/api/live/ingest", json={"text": "价格多少"}, headers=_auth(ta)
    )
    assert r.json()["status"] == "no_session"


class _FakeOT:
    """替身 _ot_post:按路径分派;记录 speak 调用。"""

    def __init__(self, speak_status: int = 200, speak_exc: Exception | None = None):
        self.speak_status = speak_status
        self.speak_exc = speak_exc
        self.calls: list[tuple[str, dict | None]] = []

    async def __call__(self, path: str, body: dict | None = None) -> httpx.Response:
        self.calls.append((path, body))
        if path == "/sessions":
            return httpx.Response(200, json={"session_id": "sess-1"})
        if path.endswith("/start"):
            return httpx.Response(200, json={"status": "ready"})
        if path.endswith("/interrupt"):
            return httpx.Response(200, json={})
        if path.endswith("/speak"):
            if self.speak_exc is not None:
                raise self.speak_exc
            return httpx.Response(self.speak_status, json={})
        return httpx.Response(404, json={})


def _start_session(client: TestClient, token: str) -> None:
    r = client.post(
        "/api/live/session/start",
        json={"avatar_image": "av.png", "avatar_worker": "ws:4403"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["active"] is True
    assert r.json()["session_id"] == "sess-1"


def test_ingest_spoken(clients, monkeypatch):
    client, ta, _ = clients
    fake = _FakeOT()
    monkeypatch.setattr(live, "_ot_post", fake)
    _start_session(client, ta)
    _mk_kb(client, ta, trigger_words=["价格"])
    r = client.post(
        "/api/live/ingest", json={"text": "价格多少"}, headers=_auth(ta)
    )
    ev = r.json()
    assert ev["status"] == "spoken"
    speak_calls = [c for c in fake.calls if c[0].endswith("/speak")]
    assert speak_calls == [("/sessions/sess-1/speak", {"text": "今天全场八折"})]


def test_ingest_speak_failed(clients, monkeypatch):
    client, ta, _ = clients
    _mk_kb(client, ta, trigger_words=["价格"])

    # 情形一:上游 500
    fake = _FakeOT(speak_status=500)
    monkeypatch.setattr(live, "_ot_post", fake)
    _start_session(client, ta)
    r = client.post(
        "/api/live/ingest", json={"text": "价格多少"}, headers=_auth(ta)
    )
    assert r.json()["status"] == "speak_failed"

    # 情形二:网络错误
    fake2 = _FakeOT(speak_exc=httpx.ConnectError("boom"))
    monkeypatch.setattr(live, "_ot_post", fake2)
    _start_session(client, ta)
    r = client.post(
        "/api/live/ingest", json={"text": "价格多少"}, headers=_auth(ta)
    )
    assert r.json()["status"] == "speak_failed"


def test_ingest_video_reply_not_spoken(clients, monkeypatch):
    client, ta, _ = clients
    fake = _FakeOT()
    monkeypatch.setattr(live, "_ot_post", fake)
    _start_session(client, ta)
    _mk_kb(
        client,
        ta,
        trigger_words=["演示"],
        reply_type="video",
        reply_text="",
        reply_asset_url="/api/images/demo.mp4?sig=x",
    )
    r = client.post(
        "/api/live/ingest", json={"text": "来个产品演示"}, headers=_auth(ta)
    )
    ev = r.json()
    assert ev["reply_type"] == "video"
    assert ev["reply_text"] == "/api/images/demo.mp4?sig=x"
    assert ev["status"] == "replied"  # 视频回复不走 speak
    assert not [c for c in fake.calls if c[0].endswith("/speak")]


# ---------------------------------------------------------------------------
# 会话生命周期 + 502
# ---------------------------------------------------------------------------
def test_session_lifecycle(clients, monkeypatch):
    client, ta, _ = clients
    fake = _FakeOT()
    monkeypatch.setattr(live, "_ot_post", fake)

    # 初始无会话
    r = client.get("/api/live/session/status", headers=_auth(ta))
    assert r.json() == {"active": False, "session_id": None}

    _start_session(client, ta)
    r = client.get("/api/live/session/status", headers=_auth(ta))
    assert r.json() == {"active": True, "session_id": "sess-1"}

    # stop:幂等 + interrupt best-effort
    r = client.post("/api/live/session/stop", headers=_auth(ta))
    assert r.json() == {"active": False, "session_id": None}
    assert [c for c in fake.calls if c[0].endswith("/interrupt")]
    r = client.post("/api/live/session/stop", headers=_auth(ta))
    assert r.json() == {"active": False, "session_id": None}


def test_session_start_502_on_unreachable(clients, monkeypatch):
    client, ta, _ = clients

    async def _down(path, body=None):  # noqa: ANN001, ANN202
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(live, "_ot_post", _down)
    r = client.post(
        "/api/live/session/start",
        json={"avatar_image": "av.png", "avatar_worker": "ws:4403"},
        headers=_auth(ta),
    )
    assert r.status_code == 502
    assert "数字人" in r.json()["detail"]
    # 失败后不残留活跃会话
    assert client.get("/api/live/session/status", headers=_auth(ta)).json()["active"] is False


def test_session_start_502_on_upstream_error(clients, monkeypatch):
    client, ta, _ = clients

    async def _err(path, body=None):  # noqa: ANN001, ANN202
        return httpx.Response(500, json={"detail": "gpu busy"})

    monkeypatch.setattr(live, "_ot_post", _err)
    r = client.post(
        "/api/live/session/start",
        json={"avatar_image": "av.png", "avatar_worker": "ws:4403"},
        headers=_auth(ta),
    )
    assert r.status_code == 502


# ---------------------------------------------------------------------------
# 历史:仅本人 + 新→旧 + limit
# ---------------------------------------------------------------------------
def test_events_history_own_only(clients, monkeypatch):
    client, ta, tb = clients
    _mk_kb(client, ta, trigger_words=["价格"])
    _mk_kb(client, tb, trigger_words=["运费"], reply_text="包邮")

    for i in range(3):
        client.post(
            "/api/live/ingest", json={"text": f"价格多少 {i}"}, headers=_auth(ta)
        )
    client.post("/api/live/ingest", json={"text": "运费呢"}, headers=_auth(tb))

    ra = client.get("/api/live/events", headers=_auth(ta))
    assert ra.status_code == 200
    events_a = ra.json()
    assert len(events_a) == 3
    assert all(e["text"].startswith("价格") for e in events_a)
    # 新→旧
    assert events_a[0]["text"] == "价格多少 2"
    # 他人历史隔离
    events_b = client.get("/api/live/events", headers=_auth(tb)).json()
    assert len(events_b) == 1
    assert events_b[0]["text"] == "运费呢"
    # limit 生效
    limited = client.get("/api/live/events?limit=2", headers=_auth(ta)).json()
    assert len(limited) == 2


# ---------------------------------------------------------------------------
# 鉴权
# ---------------------------------------------------------------------------
def test_requires_auth(clients):
    client, _, _ = clients
    assert client.get("/api/live/kb").status_code == 401
    assert client.post("/api/live/ingest", json={"text": "hi"}).status_code == 401
    assert client.get("/api/live/events").status_code == 401
    assert client.get("/api/live/session/status").status_code == 401
