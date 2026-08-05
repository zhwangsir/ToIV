"""合成服务与端点测试:片段收集(顺序/就绪校验)、URL→路径解析、成片拼接、路由容错。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import assemble


def _shot(idx: int, clip: str = "") -> StudioShot:
    return StudioShot(project_id="p", idx=idx, final_clip_url=clip)


# ── 服务层:collect_clips ────────────────────────────────────────────────────


def test_collect_orders_by_idx():
    shots = [_shot(2, "/api/studio/files/c.mp4"), _shot(0, "/api/studio/files/a.mp4"), _shot(1, "/api/studio/files/b.mp4")]
    assert assemble.collect_clips(shots) == [
        "/api/studio/files/a.mp4",
        "/api/studio/files/b.mp4",
        "/api/studio/files/c.mp4",
    ]


def test_collect_missing_clip_raises():
    with pytest.raises(assemble.AssembleError, match="未就绪"):
        assemble.collect_clips([_shot(0, "/api/studio/files/a.mp4"), _shot(1)])


def test_collect_empty_raises():
    with pytest.raises(assemble.AssembleError, match="无分镜"):
        assemble.collect_clips([])


# ── 服务层:_clip_path 安全解析 ───────────────────────────────────────────────


def test_clip_path_rejects_foreign_url():
    with pytest.raises(assemble.AssembleError, match="非 Studio 产出"):
        assemble._clip_path("https://evil.example.com/x.mp4")


def test_clip_path_rejects_traversal():
    with pytest.raises(assemble.AssembleError, match="非 Studio 产出|片段文件缺失"):
        assemble._clip_path("/api/studio/files/../../etc/passwd")


# ── 服务层:assemble_project ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_assemble_project_ok(tmp_path, monkeypatch):
    monkeypatch.setattr(assemble, "drama_output_root", lambda: tmp_path)
    (tmp_path / "studio").mkdir()
    for n in ("a.mp4", "b.mp4"):
        (tmp_path / "studio" / n).write_bytes(b"mp4")
    written: dict[str, object] = {}

    async def fake_concat(parts, out):
        written["parts"] = parts
        out.write_bytes(b"final")

    monkeypatch.setattr(assemble, "concat_parts", fake_concat)
    project = StudioProject(tenant_id="t", user_id="u", title="x")
    shots = [_shot(0, "/api/studio/files/a.mp4"), _shot(1, "/api/studio/files/b.mp4")]

    url = await assemble.assemble_project(_NoSession(), project, shots)
    assert url.startswith("/api/studio/files/final-")
    assert project.status == "ready"
    assert [p.name for p in written["parts"]] == ["a.mp4", "b.mp4"]


@pytest.mark.asyncio
async def test_assemble_ffmpeg_error_marks_project(tmp_path, monkeypatch):
    from app.services.studio.ffmpeg_ops import FFmpegError

    monkeypatch.setattr(assemble, "drama_output_root", lambda: tmp_path)
    (tmp_path / "studio").mkdir()
    (tmp_path / "studio" / "a.mp4").write_bytes(b"mp4")

    async def bad_concat(parts, out):
        raise FFmpegError("boom")

    monkeypatch.setattr(assemble, "concat_parts", bad_concat)
    project = StudioProject(tenant_id="t", user_id="u", title="x")
    with pytest.raises(assemble.AssembleError, match="boom"):
        await assemble.assemble_project(
            _NoSession(), project, [_shot(0, "/api/studio/files/a.mp4")]
        )
    assert project.status == "error"
    assert project.error == "boom"


class _NoSession:
    """assemble_project 仅用 session 做持久化;服务层单测提供最小替身。"""

    def add(self, obj):
        return None

    def commit(self):
        return None

    def refresh(self, obj):
        return None


# ── 路由层:POST /studio/projects/{pid}/assemble ─────────────────────────────


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
        tenant = Tenant(name="studio-assemble")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="assemble@toiv.ai",
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
    r = client.post("/api/studio/projects", headers=H, json={"title": "成片"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mk_shot(client: TestClient, H: dict, pid: str) -> dict:
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"scene": "A", "prompt": "a"}]},
    )
    assert r.status_code == 200, r.text
    return r.json()["shots"][0]


def test_assemble_route_not_ready_422(ctx):
    """分镜缺 final_clip_url → 422。"""
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_shot(client, H, pid)
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 422
    assert "未就绪" in r.json()["detail"]


def test_assemble_route_no_shots_422(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 422


def test_assemble_route_ok(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shot = _mk_shot(client, H, pid)
    with Session(app.dependency_overrides[get_session]().__next__().bind) as s:
        db_shot = s.get(StudioShot, shot["id"])
        db_shot.final_clip_url = "/api/studio/files/a.mp4"
        db_shot.status = "lipsynced"
        s.add(db_shot)
        s.commit()

    async def fake_assemble(session, project, shots):
        project.final_url = "/api/studio/files/final-x.mp4"
        project.status = "ready"
        return project.final_url

    monkeypatch.setattr(
        "app.services.studio.assemble.assemble_project", fake_assemble
    )
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["final_url"].endswith("final-x.mp4")
    assert r.json()["status"] == "ready"


def test_assemble_route_error_502(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_shot(client, H, pid)

    async def fake_assemble(session, project, shots):
        raise assemble.AssembleError("ffmpeg 失败(code=1)")

    monkeypatch.setattr(
        "app.services.studio.assemble.assemble_project", fake_assemble
    )
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 502
