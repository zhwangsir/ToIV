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


# ── P-1 IDOR: fusion 视频路径类端点须归属校验 ───────────────────────────────


@pytest.fixture
def idor_fusion_ctx(tmp_path, monkeypatch):
    """双用户 + 落盘 A 的视频(挂 StudioProject.final_url)。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    root = tmp_path / "drama"
    (root / "studio").mkdir(parents=True)
    (root / "output").mkdir(parents=True)
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)

    from app.models import StudioProject

    with Session(engine) as s:
        t = Tenant(name="fu-idor")
        s.add(t)
        s.commit()
        s.refresh(t)
        s.add(User(id="fu-a", email="fa@t.iv", hashed_password=hash_password("x"),
                   tenant_id=t.id, role="user"))
        s.add(User(id="fu-b", email="fb@t.iv", hashed_password=hash_password("x"),
                   tenant_id=t.id, role="user"))
        name = "owned-by-a.mp4"
        (root / "studio" / name).write_bytes(b"\x00\x00\x00\x18ftypmp42")
        p = StudioProject(
            tenant_id=t.id, user_id="fu-a", title="fu",
            final_url=f"/api/studio/files/{name}",
        )
        s.add(p)
        s.commit()
    yield {
        "client": TestClient(app),
        "root": root,
        "name": "owned-by-a.mp4",
        "ha": {"Authorization": "Bearer " + create_token("fu-a")},
        "hb": {"Authorization": "Bearer " + create_token("fu-b")},
        "url": "/api/studio/files/owned-by-a.mp4",
    }
    app.dependency_overrides.clear()


def test_fusion_qa_review_other_user_404(idor_fusion_ctx):
    """用户 B 不能对用户 A 的成片做 QA 自评(IDOR)。"""
    c = idor_fusion_ctx
    # B 越权 → 404
    r = c["client"].post(
        "/api/fusion/qa/review",
        json={"video_path": c["url"], "cut_points": [0.5]},
        headers=c["hb"],
    )
    assert r.status_code == 404, (r.status_code, r.text)
    # 本地绝对路径形态同样拒
    abs_path = str(c["root"] / "studio" / c["name"])
    r2 = c["client"].post(
        "/api/fusion/qa/review",
        json={"video_path": abs_path, "cut_points": [0.5]},
        headers=c["hb"],
    )
    assert r2.status_code == 404, (r2.status_code, r2.text)


def test_fusion_timeline_png_other_user_404(idor_fusion_ctx):
    c = idor_fusion_ctx
    r = c["client"].post(
        "/api/fusion/qa/timeline-png",
        json={"video_path": c["url"], "words": [], "ambiguity_points": [0.5]},
        headers=c["hb"],
    )
    assert r.status_code == 404, (r.status_code, r.text)


def test_fusion_transcript_of_video_other_user_404(idor_fusion_ctx):
    """of-video 读侧车同样须归属;无侧车时越权也不得靠 404「尚无 transcript」区分存在性之外的信息——
    属主未挂侧车 → 404 尚无 transcript;越权用户 → 404 产物不存在(统一不存在口径优先)。"""
    c = idor_fusion_ctx
    # 先给属主挂侧车
    side = c["root"] / "owned-by-a.transcript.md"  # sidecar_candidates: drama 根优先,stem+SIDE_SUFFIX
    side.write_text("[000.00-001.00] hello\n", encoding="utf-8")
    # 属主可读
    r_ok = c["client"].get(
        "/api/fusion/transcript/of-video",
        params={"path": c["url"]},
        headers=c["ha"],
    )
    assert r_ok.status_code == 200, r_ok.text
    assert "hello" in r_ok.json().get("markdown", "")
    # B 越权 → 404
    r_deny = c["client"].get(
        "/api/fusion/transcript/of-video",
        params={"path": c["url"]},
        headers=c["hb"],
    )
    assert r_deny.status_code == 404, (r_deny.status_code, r_deny.text)
