"""短剧播放分析 API 测试。

全组端点需认证:POST /drama/event 的 user_id 以 token 为准(覆盖客户端上报值);
GET /drama/metrics/{session_id} 仅会话属主/admin 可见;summary 仅 admin;video 走 ?token=。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import DramaEvent, DramaSession, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def client():
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
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="user",
            hashed_password=hash_password("x"),
            tenant_id=tenant.id,
        )
        other = User(
            email="other",
            hashed_password=hash_password("x"),
            tenant_id=tenant.id,
        )
        admin = User(
            email="admin",
            hashed_password=hash_password("x"),
            tenant_id=tenant.id,
            role="admin",
        )
        s.add_all([user, other, admin])
        s.commit()
        s.refresh(user)
        s.refresh(other)
        s.refresh(admin)
        tokens = {
            "user": create_token(user.id),
            "other": create_token(other.id),
            "admin": create_token(admin.id),
        }
        user_id = user.id
    yield TestClient(app), tokens, user_id, engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _event(
    event_id: str,
    session_id: str,
    event_type: str,
    current_time: float | None = None,
    payload: dict | None = None,
):
    return {
        "event_id": event_id,
        "session_id": session_id,
        "user_id": "u1",  # 服务端会以 token 身份覆盖,此值仅为占位
        "drama_id": "short_drama_v1",
        "event_type": event_type,
        "current_time": current_time,
        "duration": 90.0,
        "payload": payload,
        "client_ts": 1700000000000,
    }


class TestAuthRequired:
    """未认证全组 401。"""

    def test_event_requires_auth(self, client):
        c, _, _, _ = client
        payload = {"events": [_event("e1", "s1", "play", 0.0)], "video_url": ""}
        assert c.post("/api/drama/event", json=payload).status_code == 401

    def test_session_metrics_requires_auth(self, client):
        c, _, _, _ = client
        assert c.get("/api/drama/metrics/s1").status_code == 401

    def test_summary_requires_auth(self, client):
        c, _, _, _ = client
        assert c.get("/api/drama/metrics/short_drama_v1/summary").status_code == 401

    def test_video_requires_auth(self, client):
        c, _, _, _ = client
        assert c.get("/api/drama/video/any_id.mp4").status_code == 401


class TestIngest:
    def test_ingest_single_event_creates_session(self, client):
        c, tokens, _, _ = client
        payload = {
            "events": [_event("e1", "s1", "play", 0.0)],
            "device": {"ua": "pytest", "screen": "1920x1080"},
            "video_url": "/api/drama/video/short_drama_v1.mp4",
        }
        resp = c.post("/api/drama/event", json=payload, headers=_h(tokens["user"]))
        assert resp.status_code == 200
        data = resp.json()
        assert data["ingested"] == 1
        assert data["session_id"] == "s1"

    def test_reported_user_id_overridden_by_token(self, client):
        """伪造他人 user_id 上报:session 与 event 都必须落 token 里的真实用户 id。"""
        c, tokens, uid, engine = client
        forged = _event("e1", "s1", "play", 0.0)
        forged["user_id"] = "victim-user-id"
        resp = c.post(
            "/api/drama/event",
            json={"events": [forged], "video_url": ""},
            headers=_h(tokens["user"]),
        )
        assert resp.status_code == 200
        with Session(engine) as s:
            ev = s.exec(select(DramaEvent).where(DramaEvent.event_id == "e1")).first()
            sess = s.get(DramaSession, "s1")
        assert ev.user_id == uid
        assert sess.user_id == uid

    def test_ingest_invalid_event_type_rejected(self, client):
        c, tokens, _, _ = client
        payload = {
            "events": [_event("e1", "s1", "invalid_event")],
            "video_url": "",
        }
        resp = c.post("/api/drama/event", json=payload, headers=_h(tokens["user"]))
        assert resp.status_code == 422

    def test_empty_events_rejected(self, client):
        c, tokens, _, _ = client
        payload = {"events": [], "video_url": ""}
        resp = c.post("/api/drama/event", json=payload, headers=_h(tokens["user"]))
        assert resp.status_code == 422

    def test_idempotent_event_id(self, client):
        c, tokens, _, _ = client
        payload = {
            "events": [_event("e1", "s1", "play", 0.0)],
            "video_url": "",
        }
        assert c.post(
            "/api/drama/event", json=payload, headers=_h(tokens["user"])
        ).status_code == 200
        resp = c.post("/api/drama/event", json=payload, headers=_h(tokens["user"]))
        assert resp.status_code == 200
        assert resp.json()["ingested"] == 0

    def test_session_completed_flag_updated(self, client):
        c, tokens, _, _ = client
        payload = {
            "events": [
                _event("e1", "s1", "play", 0.0),
                _event("e2", "s1", "timeupdate", 89.5),
                _event("e3", "s1", "completed", 90.0),
            ],
            "video_url": "",
        }
        resp = c.post("/api/drama/event", json=payload, headers=_h(tokens["user"]))
        assert resp.status_code == 200

        metrics = c.get("/api/drama/metrics/s1", headers=_h(tokens["user"])).json()
        assert metrics["completed"] is True
        assert metrics["watch_sec"] == 90.0


class TestMetrics:
    def test_session_metrics_not_found(self, client):
        c, tokens, _, _ = client
        resp = c.get("/api/drama/metrics/not-exist", headers=_h(tokens["user"]))
        assert resp.status_code == 404

    def test_session_metrics_non_owner_404(self, client):
        """非属主看他人 session metrics → 404(不泄露存在性);admin → 200。"""
        c, tokens, _, _ = client
        payload = {"events": [_event("e1", "s1", "play", 0.0)], "video_url": ""}
        c.post("/api/drama/event", json=payload, headers=_h(tokens["user"]))

        r = c.get("/api/drama/metrics/s1", headers=_h(tokens["other"]))
        assert r.status_code == 404
        r = c.get("/api/drama/metrics/s1", headers=_h(tokens["admin"]))
        assert r.status_code == 200
        assert r.json()["session_id"] == "s1"

    def test_drama_summary_aggregates(self, client):
        c, tokens, _, _ = client
        # 两个会话:一个看完,一个中途退出
        c.post(
            "/api/drama/event",
            json={
                "events": [
                    _event("a1", "sa", "play", 0.0),
                    _event("a2", "sa", "completed", 90.0),
                ],
                "video_url": "",
            },
            headers=_h(tokens["user"]),
        )
        c.post(
            "/api/drama/event",
            json={
                "events": [
                    _event("b1", "sb", "play", 0.0),
                    _event("b2", "sb", "timeupdate", 30.0),
                    _event("b3", "sb", "drop_off", 30.0, {"last_time": 30.0}),
                ],
                "video_url": "",
            },
            headers=_h(tokens["user"]),
        )
        # 一个互动事件
        c.post(
            "/api/drama/event",
            json={
                "events": [_event("b4", "sb", "like", 25.0)],
                "video_url": "",
            },
            headers=_h(tokens["user"]),
        )

        summary = c.get(
            "/api/drama/metrics/short_drama_v1/summary", headers=_h(tokens["admin"])
        ).json()
        assert summary["sessions"] == 2
        assert summary["completed"] == 1
        assert summary["completion_rate"] == 0.5
        assert summary["avg_watch_sec"] == 60.0
        assert summary["engagement_rate"] == 0.5
        assert summary["plays"] == 2

    def test_drama_summary_non_admin_403(self, client):
        """聚合商业数据仅 admin 可见。"""
        c, tokens, _, _ = client
        resp = c.get(
            "/api/drama/metrics/short_drama_v1/summary", headers=_h(tokens["user"])
        )
        assert resp.status_code == 403

    def test_drama_summary_not_found(self, client):
        c, tokens, _, _ = client
        resp = c.get(
            "/api/drama/metrics/unknown-drama/summary", headers=_h(tokens["admin"])
        )
        assert resp.status_code == 404


class TestVideoProxy:
    def test_video_fallback_to_short_drama_v1(self, client):
        # 当前开发期仅服务 short_drama_v1.mp4,任意 drama_id 均回退到该文件
        # <video> 无法带 header,走 ?token= 查询参数认证
        c, tokens, _, _ = client
        resp = c.get(f"/api/drama/video/any_id.mp4?token={tokens['user']}")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "video/mp4"

    def test_video_range_invalid_format(self, client):
        # 范围请求格式错误时返回 416
        c, tokens, _, _ = client
        resp = c.get(
            "/api/drama/video/any_id.mp4",
            headers={"range": "bytes=not-a-number", **_h(tokens["user"])},
        )
        assert resp.status_code == 416

    def test_video_invalid_drama_id_400(self, client):
        """drama_id 白名单:含非字母数字字符直接 400(防路径穿越)。"""
        c, tokens, _, _ = client
        resp = c.get("/api/drama/video/bad%20id.mp4", headers=_h(tokens["user"]))
        assert resp.status_code == 400
