"""D1b:候选快照 digest 与 take 唯一拍板 CAS。"""
from __future__ import annotations

import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as session:
        tenant = Tenant(name="take-a")
        other_tenant = Tenant(name="take-b")
        session.add(tenant)
        session.add(other_tenant)
        session.commit()
        session.refresh(tenant)
        session.refresh(other_tenant)
        user = User(
            email="take-a@toiv.ai", hashed_password=hash_password("p"), tenant_id=tenant.id
        )
        other = User(
            email="take-b@toiv.ai", hashed_password=hash_password("p"), tenant_id=other_tenant.id
        )
        session.add(user)
        session.add(other)
        session.commit()
        session.refresh(user)
        session.refresh(other)
        tokens = create_token(user.id), create_token(other.id)
    try:
        yield TestClient(app), tokens[0], tokens[1], engine
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _candidate(cid: str, url: str, **extra) -> dict:
    return {
        "id": cid,
        "url": url,
        "seed": 1,
        "status": "done",
        "is_picked": False,
        "error": "",
        "video_model": "h3",
        **extra,
    }


def _setup_shot(client: TestClient, token: str, engine, candidates: list[dict]) -> tuple[str, str]:
    headers = _headers(token)
    response = client.post("/api/studio/projects", headers=headers, json={"title": "take"})
    assert response.status_code == 200, response.text
    pid = response.json()["id"]
    response = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=headers,
        json={"shots": [{"scene": "A", "prompt": "p", "status": "rendered"}]},
    )
    assert response.status_code == 200, response.text
    sid = response.json()["shots"][0]["id"]
    with Session(engine) as session:
        shot = session.get(StudioShot, sid)
        shot.candidates_json = json.dumps(candidates, ensure_ascii=False, indent=1)
        shot.video_url = "/api/studio/files/before.mp4"
        shot.final_clip_url = "/api/studio/files/final-before.mp4"
        shot.voice_url = "/api/studio/files/voice.wav"
        shot.status = "voiced"
        shot.final_visual_revision_id = "old-visual"
        shot.final_voice_revision_id = "old-voice"
        session.add(shot)
        session.commit()
    return pid, sid


def _project_shot(client: TestClient, token: str, pid: str, sid: str) -> dict:
    response = client.get(f"/api/studio/projects/{pid}", headers=_headers(token))
    assert response.status_code == 200, response.text
    return next(shot for shot in response.json()["shots"] if shot["id"] == sid)


def _digest(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def test_http_digest_and_successful_pick_is_unique(ctx):
    client, token, _, engine = ctx
    pid, sid = _setup_shot(
        client,
        token,
        engine,
        [
            _candidate("a", "/api/studio/files/a.mp4", revision_id="rev-a"),
            _candidate("b", "/api/studio/files/b.mp4", revision_id="rev-b"),
        ],
    )
    with Session(engine) as session:
        raw = session.get(StudioShot, sid).candidates_json
    before = _project_shot(client, token, pid, sid)
    assert before["candidates_digest"] == _digest(raw)

    response = client.post(
        f"/api/studio/shots/{sid}/candidates/b/pick",
        headers=_headers(token),
        json={"expected_candidates_digest": before["candidates_digest"]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [c["id"] for c in body["candidates"] if c["is_picked"]] == ["b"]
    assert body["video_url"] == body["final_clip_url"] == "/api/studio/files/b.mp4"
    assert body["rendered_revision_id"] == "rev-b"
    assert body["final_visual_revision_id"] == body["final_voice_revision_id"] == ""
    assert body["voice_url"] == "/api/studio/files/voice.wav"
    assert body["status"] == "voiced"
    assert body["candidates_digest"] != before["candidates_digest"]


def test_http_stale_digest_409_does_not_overwrite_or_fire_hook(ctx, monkeypatch):
    client, token, _, engine = ctx
    pid, sid = _setup_shot(
        client, token, engine, [_candidate("a", "/a.mp4"), _candidate("b", "/b.mp4")]
    )
    stale = _project_shot(client, token, pid, sid)["candidates_digest"]
    replacement = json.dumps([_candidate("new", "/new.mp4")])
    with Session(engine) as session:
        shot = session.get(StudioShot, sid)
        shot.candidates_json = replacement
        session.add(shot)
        session.commit()
    fired = []
    monkeypatch.setattr(orch, "_fire_video_transcript", fired.append)

    response = client.post(
        f"/api/studio/shots/{sid}/candidates/a/pick",
        headers=_headers(token),
        json={"expected_candidates_digest": stale},
    )
    assert response.status_code == 409, response.text
    with Session(engine) as session:
        shot = session.get(StudioShot, sid)
        assert shot.candidates_json == replacement
        assert shot.video_url == "/api/studio/files/before.mp4"
    assert fired == []


def test_http_pick_tenant_isolation_and_invalid_candidates(ctx):
    client, token, other_token, engine = ctx
    _, sid = _setup_shot(
        client,
        token,
        engine,
        [
            _candidate("queued", "", status="queued"),
            _candidate("error", "", status="error"),
            _candidate("missing", ""),
            _candidate("done", "/done.mp4"),
        ],
    )
    response = client.post(
        f"/api/studio/shots/{sid}/candidates/done/pick", headers=_headers(other_token)
    )
    assert response.status_code == 404, response.text
    for cid in ("queued", "error", "missing", "not-found"):
        response = client.post(
            f"/api/studio/shots/{sid}/candidates/{cid}/pick", headers=_headers(token)
        )
        assert response.status_code == 400, (cid, response.text)
    with Session(engine) as session:
        shot = session.get(StudioShot, sid)
        assert all(not c["is_picked"] for c in json.loads(shot.candidates_json))
        assert shot.video_url == "/api/studio/files/before.mp4"


def test_file_sqlite_independent_engines_same_snapshot_cas(ctx, tmp_path, monkeypatch):
    del ctx
    path = tmp_path / "take-race.db"
    engine1 = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    engine2 = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine1)
    candidates = [_candidate("a", "/a.mp4"), _candidate("b", "/b.mp4")]
    with Session(engine1) as session:
        project = StudioProject(title="race", tenant_id="t", user_id="u")
        session.add(project)
        session.commit()
        session.refresh(project)
        shot = StudioShot(
            project_id=project.id,
            candidates_json=json.dumps(candidates),
            video_url="/before.mp4",
            final_clip_url="/before.mp4",
        )
        session.add(shot)
        session.commit()
        session.refresh(shot)
        sid = shot.id
        raw = shot.candidates_json
    expected = _digest(raw)
    fired = []
    monkeypatch.setattr(orch, "_fire_video_transcript", fired.append)
    try:
        with Session(engine1) as session1, Session(engine2) as session2:
            shot1 = session1.get(StudioShot, sid)
            shot2 = session2.get(StudioShot, sid)
            assert shot1.candidates_json == shot2.candidates_json == raw
            orch.pick_candidate(session1, shot1, "a", expected_candidates_digest=expected)
            with pytest.raises(orch.CandidateConflictError):
                orch.pick_candidate(session2, shot2, "b", expected_candidates_digest=expected)
        with Session(engine2) as session:
            shot = session.get(StudioShot, sid)
            rows = json.loads(shot.candidates_json)
            assert [c["id"] for c in rows if c["is_picked"]] == ["a"]
            assert shot.video_url == shot.final_clip_url == "/a.mp4"
        assert fired == ["/a.mp4"]
    finally:
        engine1.dispose()
        engine2.dispose()


def test_repeat_and_legacy_pick_keep_single_owner_and_unknown_revision(ctx):
    client, token, _, engine = ctx
    pid, sid = _setup_shot(
        client,
        token,
        engine,
        [_candidate("legacy", "/legacy.mp4"), _candidate("other", "/other.mp4")],
    )
    url = f"/api/studio/shots/{sid}/candidates/legacy/pick"
    first = client.post(url, headers=_headers(token))
    assert first.status_code == 200, first.text
    assert first.json()["rendered_revision_id"] == ""
    assert first.json()["visual_media_status"] == "unknown"
    second = client.post(url, headers=_headers(token))
    assert second.status_code == 200, second.text
    assert [c["id"] for c in second.json()["candidates"] if c["is_picked"]] == ["legacy"]
    assert second.json()["video_url"] == second.json()["final_clip_url"] == "/legacy.mp4"
    assert second.json()["rendered_revision_id"] == ""
    assert second.json()["visual_media_status"] == "unknown"

    response = client.post(
        f"/api/studio/shots/{sid}/candidates/other/pick",
        headers=_headers(token),
        json={"expected_candidates_digest": second.json()["candidates_digest"]},
    )
    assert response.status_code == 200, response.text
    assert [c["id"] for c in response.json()["candidates"] if c["is_picked"]] == ["other"]
    assert response.json()["video_url"] == "/other.mp4"
