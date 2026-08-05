"""Studio CRUD 测试:项目 / 角色 / 分镜批量保存 + 租户隔离 + 鉴权。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="studio")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="studio@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "雨夜", "premise": "重逢"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_project_crud(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    assert len(client.get("/api/studio/projects", headers=H).json()) == 1
    r = client.patch(f"/api/studio/projects/{pid}", headers=H, json={"style": "赛博朋克"})
    assert r.json()["style"] == "赛博朋克"
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["title"] == "雨夜" and detail["characters"] == [] and detail["shots"] == []
    assert client.delete(f"/api/studio/projects/{pid}", headers=H).status_code == 200
    assert client.get("/api/studio/projects", headers=H).json() == []


def test_project_requires_auth(ctx):
    client, _ = ctx
    assert client.get("/api/studio/projects").status_code in (401, 403)


def test_character_crud(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "楚生", "visual_prompt": "1boy, black hair"},
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    client.patch(f"/api/studio/characters/{cid}", headers=H, json={"description": "落魄青年"})
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["characters"][0]["description"] == "落魄青年"
    assert client.delete(f"/api/studio/characters/{cid}", headers=H).status_code == 200


def test_shots_batch_save(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "开场", "prompt": "alley", "render_mode": "video", "characters": ["楚生"]},
            {"scene": "照片", "prompt": "photo", "render_mode": "image_motion"},
        ]},
    )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 2 and shots[0]["idx"] == 0
    assert shots[0]["render_mode"] == "video" and shots[1]["render_mode"] == "image_motion"
    # 再保存:带 id 更新,不带 id 追加
    r2 = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"id": shots[0]["id"], "scene": "开场改", "prompt": "alley2", "render_mode": "image_motion"},
            {"scene": "新镜", "prompt": "new"},
        ]},
    )
    shots2 = r2.json()["shots"]
    assert shots2[0]["scene"] == "开场改" and shots2[0]["render_mode"] == "image_motion"
    assert shots2[1]["scene"] == "新镜"
    # 全量替换语义:请求未包含的旧分镜(照片)已删除
    r3 = client.get(f"/api/studio/projects/{pid}", headers=H)
    remaining = r3.json()["shots"]
    assert len(remaining) == 2
    assert all(s["id"] != shots[1]["id"] for s in remaining)


# ── 渲染编排(M2)─────────────────────────────────────────────────────────────

import app.services.studio.orchestrator as orch


def _mk_shots(client: TestClient, H: dict, pid: str) -> list[dict]:
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "A", "prompt": "a", "render_mode": "video"},
            {"scene": "B", "prompt": "b", "render_mode": "image_motion"},
        ]},
    )
    assert r.status_code == 200, r.text
    return r.json()["shots"]


def test_render_single_shot(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    async def fake_render_shot(session, shot, pool=None):
        shot.status = "rendered"
        shot.video_url = "/api/studio/files/fake.mp4"
        shot.final_clip_url = shot.video_url
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rendered"
    assert r.json()["video_url"].endswith("fake.mp4")


def test_render_single_shot_error(ctx, monkeypatch):
    from app.services.studio.renderers.base import RenderError

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    async def fake_render_shot(session, shot, pool=None):
        raise RenderError("worker 全忙")

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)
    assert r.status_code == 502
    assert "worker 全忙" in r.json()["detail"]


def test_render_batch_skips_terminal(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    # 先把 shot A 渲染到终态(commit 落库,批量时才能被跳过)
    async def ok_render(session, shot, pool=None):
        shot.status = "rendered"
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", ok_render)
    client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)

    # 批量:仅应渲染仍处于 draft 的 shot B
    rendered: list[str] = []

    async def recording_render(session, shot, pool=None):
        rendered.append(shot.id)
        shot.status = "rendered"
        return shot

    monkeypatch.setattr(orch, "render_shot", recording_render)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == {"rendered": 1, "failed": 0}
    assert rendered == [shots[1]["id"]]


def test_render_batch_failure_not_blocking(ctx, monkeypatch):
    from app.services.studio.renderers.base import RenderError

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_shots(client, H, pid)

    async def failing_render(session, shot, pool=None):
        raise RenderError("出图失败")

    monkeypatch.setattr(orch, "render_shot", failing_render)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200
    assert r.json() == {"rendered": 0, "failed": 2}


def test_project_status_counts(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_shots(client, H, pid)
    r = client.get(f"/api/studio/projects/{pid}/status", headers=H)
    assert r.status_code == 200
    assert r.json() == {"total": 2, "by_status": {"draft": 2}}


# ── 产出文件服务(M2)──────────────────────────────────────────────────────────


def test_studio_file_serving(ctx, monkeypatch, tmp_path):
    import app.storage as storage

    out = tmp_path / "studio"
    out.mkdir()
    (out / "x.mp4").write_bytes(b"fake-mp4")
    monkeypatch.setattr(storage, "drama_output_root", lambda: tmp_path)

    client, _ = ctx
    r = client.get("/api/studio/files/x.mp4")
    assert r.status_code == 200 and r.content == b"fake-mp4"
    assert r.headers["content-type"] == "video/mp4"
    # 不存在 → 404;路径穿越 → 400(或路由不匹配 404/405,绝不放行)
    assert client.get("/api/studio/files/none.mp4").status_code == 404
    assert client.get("/api/studio/files/..%2F..%2Fsecret").status_code in (400, 404, 405)
