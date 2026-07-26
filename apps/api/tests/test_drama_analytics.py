"""短剧播放分析 API 测试。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import DramaEvent, DramaSession


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
    yield TestClient(app)
    app.dependency_overrides.clear()


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
        "user_id": "u1",
        "drama_id": "short_drama_v1",
        "event_type": event_type,
        "current_time": current_time,
        "duration": 90.0,
        "payload": payload,
        "client_ts": 1700000000000,
    }


class TestIngest:
    def test_ingest_single_event_creates_session(self, client):
        payload = {
            "events": [_event("e1", "s1", "play", 0.0)],
            "device": {"ua": "pytest", "screen": "1920x1080"},
            "video_url": "/api/drama/video/short_drama_v1.mp4",
        }
        resp = client.post("/api/drama/event", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["ingested"] == 1
        assert data["session_id"] == "s1"

    def test_ingest_invalid_event_type_rejected(self, client):
        payload = {
            "events": [_event("e1", "s1", "invalid_event")],
            "video_url": "",
        }
        resp = client.post("/api/drama/event", json=payload)
        assert resp.status_code == 422

    def test_empty_events_rejected(self, client):
        payload = {"events": [], "video_url": ""}
        resp = client.post("/api/drama/event", json=payload)
        assert resp.status_code == 422

    def test_idempotent_event_id(self, client):
        payload = {
            "events": [_event("e1", "s1", "play", 0.0)],
            "video_url": "",
        }
        assert client.post("/api/drama/event", json=payload).status_code == 200
        resp = client.post("/api/drama/event", json=payload)
        assert resp.status_code == 200
        assert resp.json()["ingested"] == 0

    def test_session_completed_flag_updated(self, client):
        payload = {
            "events": [
                _event("e1", "s1", "play", 0.0),
                _event("e2", "s1", "timeupdate", 89.5),
                _event("e3", "s1", "completed", 90.0),
            ],
            "video_url": "",
        }
        resp = client.post("/api/drama/event", json=payload)
        assert resp.status_code == 200

        metrics = client.get("/api/drama/metrics/s1").json()
        assert metrics["completed"] is True
        assert metrics["watch_sec"] == 90.0


class TestMetrics:
    def test_session_metrics_not_found(self, client):
        resp = client.get("/api/drama/metrics/not-exist")
        assert resp.status_code == 404

    def test_drama_summary_aggregates(self, client):
        # 两个会话:一个看完,一个中途退出
        client.post(
            "/api/drama/event",
            json={
                "events": [
                    _event("a1", "sa", "play", 0.0),
                    _event("a2", "sa", "completed", 90.0),
                ],
                "video_url": "",
            },
        )
        client.post(
            "/api/drama/event",
            json={
                "events": [
                    _event("b1", "sb", "play", 0.0),
                    _event("b2", "sb", "timeupdate", 30.0),
                    _event("b3", "sb", "drop_off", 30.0, {"last_time": 30.0}),
                ],
                "video_url": "",
            },
        )
        # 一个互动事件
        client.post(
            "/api/drama/event",
            json={
                "events": [_event("b4", "sb", "like", 25.0)],
                "video_url": "",
            },
        )

        summary = client.get("/api/drama/metrics/short_drama_v1/summary").json()
        assert summary["sessions"] == 2
        assert summary["completed"] == 1
        assert summary["completion_rate"] == 0.5
        assert summary["avg_watch_sec"] == 60.0
        assert summary["engagement_rate"] == 0.5
        assert summary["plays"] == 2

    def test_drama_summary_not_found(self, client):
        resp = client.get("/api/drama/metrics/unknown-drama/summary")
        assert resp.status_code == 404


class TestVideoProxy:
    def test_video_fallback_to_short_drama_v1(self, client):
        # 当前开发期仅服务 short_drama_v1.mp4,任意 drama_id 均回退到该文件
        resp = client.get("/api/drama/video/any_id.mp4")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "video/mp4"

    def test_video_range_invalid_format(self, client):
        # 范围请求格式错误时返回 416
        resp = client.get(
            "/api/drama/video/any_id.mp4",
            headers={"range": "bytes=not-a-number"},
        )
        assert resp.status_code == 416
