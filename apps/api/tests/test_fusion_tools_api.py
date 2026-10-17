"""FU2/FU5 API 面端点测试:pack/EDL/剪点/QA/manifest+路径安全闸。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        t = Tenant(name="t"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="a@t.iv", hashed_password=hash_password("x"), tenant_id=t.id, role="user"))
        s.commit()
        h = {"Authorization": "Bearer " + create_token("u1")}
    yield TestClient(app), h
    app.dependency_overrides.clear()


def test_pack_transcript_endpoint(ctx):
    client, h = ctx
    words = [{"word": "hello", "start": 0.0, "end": 0.3}, {"word": "world", "start": 0.4, "end": 0.8},
             {"word": "again", "start": 2.0, "end": 2.4}]
    r = client.post("/api/fusion/transcript/pack", json={"payload": words}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["segments"] and "[000.00-000.80] hello world" in body["markdown"]


def test_edl_validate_endpoint_rejects_midword(ctx):
    client, h = ctx
    edl = {"items": [{"source": "a.mp4", "start": 0.15, "end": 1.0, "beat": "b", "quote": "q", "reason": "r"}]}
    words = {"a.mp4": [{"word": "hello", "start": 0.0, "end": 0.5}]}
    r = client.post("/api/fusion/edl/validate", json={"edl": edl, "words_by_source": words}, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and any(i["kind"] == "midword_cut" for i in body["issues"]), body
    # 结构非法 422
    r = client.post("/api/fusion/edl/validate", json={"edl": {"items": "bad"}}, headers=h)
    assert r.status_code == 422


def test_cut_plan_endpoint(ctx):
    client, h = ctx
    words = [{"word": "a", "start": 0.0, "end": 0.4}, {"word": "b", "start": 1.2, "end": 1.6}]
    r = client.post("/api/fusion/edl/cut-plan", json={"words": words, "pad_ms": 9999, "min_silence": 0.4}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert 0 < body["pad_ms"] <= 200  # 夹值
    assert "cut_points" in body


def test_qa_and_timeline_path_guard(ctx):
    client, h = ctx
    for path, ep in (("/etc/hostname", "/api/fusion/qa/review"), ("/etc/hostname", "/api/fusion/qa/timeline-png")):
        payload = {"video_path": path, "cut_points": [1.0]} if "review" in ep else {"video_path": path, "words": [], "ambiguity_points": [1.0]}
        r = client.post(ep, json=payload, headers=h)
        assert r.status_code == 403, (ep, r.status_code, r.text)
    r = client.post("/api/fusion/qa/review",
                    json={"video_path": "/nonexistent/inside/none.mp4", "cut_points": [1.0]}, headers=h)
    assert r.status_code in (403, 404)


def test_manifest_validate_endpoint(ctx):
    client, h = ctx
    good = {"name": "drama-compose", "version": 1, "stages": [
        {"id": "script", "skill": "parse", "produces": ["beats"], "success_criteria": ["beats>0"]} for _ in range(1)
    ]}
    # 结构按 validate_manifest 真实契约:先探合法模板
    from app.services.pipeline.manifest import validate_manifest
    from app.services.pipeline import manifest as mf
    tmpl = getattr(mf, "DRAMA_COMPOSE_TEMPLATE", None)
    if callable(tmpl):
        good = tmpl()
    elif tmpl is not None:
        good = tmpl
    r = client.post("/api/fusion/manifest/validate", json={"manifest": good}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    r = client.post("/api/fusion/manifest/validate", json={"manifest": {"name": "x"}}, headers=h)
    assert r.status_code == 422


def test_fusion_endpoints_require_auth(ctx):
    client, _ = ctx
    r = client.post("/api/fusion/transcript/pack", json={"payload": []})
    assert r.status_code == 401


def test_media_path_guard_accepts_url_forms(ctx, tmp_path, monkeypatch):
    """E-8 双形态:产品 URL(/api/studio/files/、/api/drama/output/)与本地路径等价,防任意读仍拒。"""
    from app.storage import drama_output_root
    root = tmp_path / "drama"
    (root / "studio").mkdir(parents=True)
    (root / "output").mkdir(parents=True)
    (root / "studio" / "clip.mp4").write_bytes(b"x")
    (root / "output" / "out.mp4").write_bytes(b"y")
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)
    import app.routes.fusion_tools as ft
    monkeypatch.setattr(ft, "__name__", ft.__name__)  # noop
    p1 = ft._safe_media_path("/api/studio/files/clip.mp4")
    p2 = ft._safe_media_path("/api/drama/output/out.mp4")
    p3 = ft._safe_media_path(str(root / "studio" / "clip.mp4"))
    assert p1 == p2.resolve() or p1.name == "clip.mp4"
    assert p3.name == "clip.mp4"
    with pytest.raises(Exception):
        ft._safe_media_path("/api/studio/files/../../../etc/passwd")
