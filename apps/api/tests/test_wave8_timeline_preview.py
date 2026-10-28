"""Wave8 P0: timeline-preview + active/boards/媒体闸(P0-5 R1/R2 已退役 UX 过滤)。"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from unittest.mock import patch

from app.comfy.tracker import image_sig, image_url
from app.db import get_session
from app.main import app
from app.models import Job, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio_file_access import studio_file_sig


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
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
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)

    with Session(engine) as s:
        t = Tenant(name="w8")
        s.add(t)
        s.commit()
        s.refresh(t)
        ordinary = User(
            email="ord@w8.io",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            content_mode="ordinary",
        )
        adult = User(
            email="adult@w8.io",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            content_mode="adult",
        )
        s.add(ordinary)
        s.add(adult)
        s.commit()
        s.refresh(ordinary)
        s.refresh(adult)
        oid, aid, tid = ordinary.id, adult.id, t.id

    client = TestClient(app)
    yield {
        "client": client,
        "engine": engine,
        "root": root,
        "ord": oid,
        "adult": aid,
        "tenant": tid,
        "h_ord": {"Authorization": f"Bearer {create_token(oid)}"},
        "h_adult": {"Authorization": f"Bearer {create_token(aid)}"},
    }
    app.dependency_overrides.clear()


def _mk_project(engine, *, user_id: str, tenant_id: str, fps: int = 24) -> str:
    with Session(engine) as s:
        p = StudioProject(
            tenant_id=tenant_id, user_id=user_id, title="tl", fps=fps
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        return p.id


def _mk_shot(
    engine,
    *,
    pid: str,
    idx: int,
    image_url: str = "",
    video_url: str = "",
    final_clip_url: str = "",
    duration_sec: int = 6,
) -> str:
    with Session(engine) as s:
        sh = StudioShot(
            project_id=pid,
            idx=idx,
            image_url=image_url,
            video_url=video_url,
            final_clip_url=final_clip_url,
            duration_sec=duration_sec,
            scene=f"s{idx}",
        )
        s.add(sh)
        s.commit()
        s.refresh(sh)
        return sh.id


def test_timeline_preview_aggregates_and_filters_nsfw(ctx):
    """P0-5 R1:ordinary 也不再过滤 NSFW 条;仍标注 nsfw + 透出 content_mode。"""
    eng = ctx["engine"]
    pid = _mk_project(eng, user_id=ctx["ord"], tenant_id=ctx["tenant"], fps=24)
    sfw_vid = "/api/studio/files/sfw-clip.mp4"
    nsfw_vid = "/api/studio/files/nsfw-clip.mp4"
    sid0 = _mk_shot(
        eng, pid=pid, idx=0, image_url="/api/studio/files/kf0.png", video_url=sfw_vid
    )
    sid1 = _mk_shot(eng, pid=pid, idx=1, video_url=nsfw_vid, duration_sec=8)
    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        s.add(
            Job(
                tenant_id=u.tenant_id,
                user_id=u.id,
                prompt_id="nsfw-hit",
                worker="w",
                kind="h3_t2v",
                status="done",
                nsfw=True,
                result=json.dumps([nsfw_vid]),
            )
        )
        s.commit()

    # ordinary: 两条都在(不再服务端过滤);nsfw 标仍真;content_mode 透出
    r = ctx["client"].get(
        f"/api/studio/projects/{pid}/timeline-preview", headers=ctx["h_ord"]
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fps"] == 24
    assert body["content_mode"] == "ordinary"
    assert {i["shot_id"] for i in body["items"]} == {sid0, sid1}
    by = {i["shot_id"]: i for i in body["items"]}
    assert by[sid0]["kind"] == "video"
    assert by[sid0]["preview_url"].endswith("kf0.png")
    assert by[sid0]["media_url"] == sfw_vid
    assert by[sid0]["nsfw"] is False
    assert by[sid1]["nsfw"] is True
    assert by[sid1]["duration_sec"] == 8

    # adult: 仍两条,content_mode 更新
    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        u.content_mode = "adult"
        s.add(u)
        s.commit()
    r2 = ctx["client"].get(
        f"/api/studio/projects/{pid}/timeline-preview", headers=ctx["h_ord"]
    )
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["content_mode"] == "adult"
    assert {i["shot_id"] for i in body2["items"]} == {sid0, sid1}


def test_jobs_active_filters_nsfw_like_list(ctx):
    """P0-5 R2:ordinary 也能看见 NSFW active jobs。"""
    eng = ctx["engine"]
    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        s.add(
            Job(
                tenant_id=u.tenant_id,
                user_id=u.id,
                prompt_id="act-sfw",
                worker="w",
                kind="txt2img",
                status="queued",
                nsfw=False,
                prompt="sfw",
            )
        )
        s.add(
            Job(
                tenant_id=u.tenant_id,
                user_id=u.id,
                prompt_id="act-nsfw",
                worker="w",
                kind="txt2img",
                status="running",
                nsfw=True,
                prompt="r18",
            )
        )
        s.commit()

    r = ctx["client"].get("/api/jobs/active", headers=ctx["h_ord"])
    assert r.status_code == 200
    ids = {i["prompt_id"] for i in r.json()["items"]}
    assert ids == {"act-sfw", "act-nsfw"}

    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        u.content_mode = "adult"
        s.add(u)
        s.commit()
    r2 = ctx["client"].get("/api/jobs/active", headers=ctx["h_ord"])
    ids2 = {i["prompt_id"] for i in r2.json()["items"]}
    assert ids2 == {"act-sfw", "act-nsfw"}


def test_boards_items_hide_nsfw_results_when_ordinary(ctx):
    """P0-5 R2:ordinary 也能看见 NSFW board items。"""
    eng = ctx["engine"]
    c = ctx["client"]
    H = ctx["h_ord"]
    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        j_sfw = Job(
            id=uuid.uuid4().hex,
            tenant_id=u.tenant_id,
            user_id=u.id,
            prompt_id="b-sfw",
            worker="w",
            kind="txt2img",
            status="done",
            nsfw=False,
            result='["/api/images?filename=sfw.png&worker=w"]',
        )
        j_nsfw = Job(
            id=uuid.uuid4().hex,
            tenant_id=u.tenant_id,
            user_id=u.id,
            prompt_id="b-nsfw",
            worker="w",
            kind="txt2img",
            status="done",
            nsfw=True,
            result='["/api/images?filename=nsfw.png&worker=w&sig=abc"]',
        )
        s.add(j_sfw)
        s.add(j_nsfw)
        s.commit()
        sfw_id, nsfw_id = j_sfw.id, j_nsfw.id

    bid = c.post("/api/boards", json={"name": "b"}, headers=H).json()["id"]
    put = c.put(
        f"/api/boards/{bid}/items",
        json={"items": [{"job_id": sfw_id}, {"job_id": nsfw_id}]},
        headers=H,
    )
    assert put.status_code == 200, put.text

    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    assert {i["job"]["id"] for i in items} == {sfw_id, nsfw_id}

    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        u.content_mode = "adult"
        s.add(u)
        s.commit()
    items2 = c.get(f"/api/boards/{bid}/items", headers=H).json()
    assert {i["job"]["id"] for i in items2} == {sfw_id, nsfw_id}


def test_images_nsfw_gate_ordinary_404_adult_ok(ctx, monkeypatch):
    """P0-5 R1:NSFW Job 产物 ordinary 也放行(媒体 UX 闸退役;签名路径)。"""
    from app.deps import get_pool

    eng = ctx["engine"]
    filename = "r18-out.png"
    worker = "http://127.0.0.1:8188"
    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        url = image_url(worker, {"filename": filename, "subfolder": "", "type": "output"})
        s.add(
            Job(
                tenant_id=u.tenant_id,
                user_id=u.id,
                prompt_id="img-nsfw",
                worker=worker,
                kind="txt2img",
                status="done",
                nsfw=True,
                result=json.dumps([url]),
            )
        )
        s.commit()

    class _Worker:
        base_url = worker

        async def get_image_bytes(self, *a, **k):
            return b"PNGDATA", "image/png"

    monkeypatch.setattr("app.routes.images.resolve_worker", lambda w: _Worker())
    app.dependency_overrides[get_pool] = lambda: type("P", (), {"clients": []})()

    sig = image_sig(filename, "", "output", worker)
    path = (
        f"/api/images?filename={filename}&subfolder=&type=output"
        f"&worker={worker}&sig={sig}"
    )

    r = ctx["client"].get(path, headers=ctx["h_ord"])
    assert r.status_code == 200, r.text
    assert r.content == b"PNGDATA"

    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        u.content_mode = "adult"
        s.add(u)
        s.commit()
    r2 = ctx["client"].get(path, headers=ctx["h_ord"])
    assert r2.status_code == 200, r2.text
    assert r2.content == b"PNGDATA"
    app.dependency_overrides.pop(get_pool, None)


def test_studio_file_nsfw_gate(ctx):
    eng = ctx["engine"]
    root = ctx["root"]
    name = "nsfw-studio-aaaaaaaa.mp4"
    (root / "studio" / name).write_bytes(b"SECRET")
    marker = f"/api/studio/files/{name}"
    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        s.add(
            Job(
                tenant_id=u.tenant_id,
                user_id=u.id,
                prompt_id="st-nsfw",
                worker="w",
                kind="studio_render",
                status="done",
                nsfw=True,
                result=json.dumps([marker]),
            )
        )
        s.commit()

    sig = studio_file_sig(name)
    # P0-5 R1:ordinary 也放行(媒体 UX 闸退役);sig/归属仍校验
    r = ctx["client"].get(
        f"/api/studio/files/{name}?sig={sig}", headers=ctx["h_ord"]
    )
    assert r.status_code == 200
    assert r.content == b"SECRET"

    with Session(eng) as s:
        u = s.get(User, ctx["ord"])
        u.content_mode = "adult"
        s.add(u)
        s.commit()
    r2 = ctx["client"].get(
        f"/api/studio/files/{name}?sig={sig}", headers=ctx["h_ord"]
    )
    assert r2.status_code == 200
    assert r2.content == b"SECRET"
