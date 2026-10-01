"""Batch5:样片种子「雨夜便利店·林夏」+ 步骤整组重跑 重量级契约/边界。"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import StudioCharacter, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override

    # 样片素材:写入临时 assets 并劫持候选根
    assets = tmp_path / "assets"
    assets.mkdir()
    for name in (
        "linxia_front.png",
        "linxia_side.png",
        "linxia_full.png",
        "scene_rain_store.png",
    ):
        (assets / name).write_bytes(b"\x89PNG\r\n\x1a\n" + name.encode() + b"\0" * 32)

    out_root = tmp_path / "drama_out"
    out_root.mkdir()
    monkeypatch.setattr(
        "app.routes.studio._sample_asset_candidates", lambda: [assets]
    )
    monkeypatch.setattr("app.storage.drama_output_root", lambda: out_root)

    with Session(engine) as s:
        tenant = Tenant(name="batch5")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="batch5@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), engine, out_root
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_batch5_seed_requires_auth(ctx):
    client, _, _, _ = ctx
    r = client.post("/api/studio/sample-projects/rain-night")
    assert r.status_code in (401, 403), r.text


def test_batch5_seed_idempotent_and_pipeline(ctx):
    client, token, engine, out_root = ctx
    H = _h(token)
    r1 = client.post("/api/studio/sample-projects/rain-night", headers=H)
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["created"] is True
    assert body1["title"] == "雨夜便利店·林夏"
    assert body1["assets_ready"] is True
    assert len(body1["reference_images"]) == 3
    assert len(body1["scene_images"]) == 1
    assert body1["pipeline"]["total_shots"] == 4
    pid = body1["id"]
    shots = body1["project"]["shots"]
    assert len(shots) == 4
    dialogues = [s["dialogue"] for s in shots]
    assert "还营业吧？" in dialogues[0]
    assert any("加班到现在" in d for d in dialogues)
    assert any("微信可以吗" in d for d in dialogues)

    # 角色卡
    chars = body1["project"]["characters"]
    assert any(c["name"] == "林夏" for c in chars)
    lin = next(c for c in chars if c["name"] == "林夏")
    assert len(lin["reference_images"]) == 3

    # 文件已落盘
    studio_dir = out_root / "studio"
    assert (studio_dir / "sample_linxia_front.png").is_file()
    assert (studio_dir / "sample_scene_rain_store.png").is_file()

    # 幂等:再调不堆项目
    r2 = client.post("/api/studio/sample-projects/rain-night", headers=H)
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["created"] is False
    assert body2["id"] == pid
    listed = client.get("/api/studio/projects", headers=H)
    assert listed.status_code == 200
    titles = [p["title"] for p in listed.json() if p["title"] == "雨夜便利店·林夏"]
    assert len(titles) == 1
    # 列表含 pipeline 进度
    sample = next(p for p in listed.json() if p["id"] == pid)
    assert "pipeline" in sample
    assert sample["pipeline"]["total_shots"] == 4


def test_batch5_seed_degrades_without_assets(ctx, monkeypatch, tmp_path):
    client, token, _, _ = ctx
    empty = tmp_path / "empty_assets"
    empty.mkdir()
    monkeypatch.setattr(
        "app.routes.studio._sample_asset_candidates", lambda: [empty]
    )
    H = _h(token)
    r = client.post("/api/studio/sample-projects/rain-night", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["assets_ready"] is False
    assert body["asset_notes"]
    # 仍有角色与 4 镜
    assert len(body["project"]["shots"]) == 4
    assert any(c["name"] == "林夏" for c in body["project"]["characters"])


def test_batch5_step_rerun_invalid_step_422(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/studio/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.post(f"/api/studio/projects/{pid}/steps/nope/rerun", headers=H)
    assert r.status_code == 422, r.text
    assert "step" in r.json()["detail"]


def test_batch5_step_rerun_no_shots_422(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/studio/projects", headers=H, json={"title": "empty"}
    ).json()["id"]
    r = client.post(f"/api/studio/projects/{pid}/steps/video/rerun", headers=H)
    assert r.status_code == 422, r.text
    assert "分镜" in r.json()["detail"]


def test_batch5_step_rerun_voice_collects_errors(ctx):
    """有台词但缺视频/音色 → errors 聚合,不 500、不静默成功。"""
    client, token, _, _ = ctx
    H = _h(token)
    seed = client.post("/api/studio/sample-projects/rain-night", headers=H)
    assert seed.status_code == 200, seed.text
    pid = seed.json()["id"]
    r = client.post(f"/api/studio/projects/{pid}/steps/voice/rerun", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["step"] == "voice"
    assert body["attempted"] == 4
    assert body["failed"] == 4
    assert body["ok"] == 0
    assert len(body["errors"]) == 4
    assert any("视频" in e["detail"] or "音色" in e["detail"] for e in body["errors"])


def test_batch5_step_rerun_video_calls_orchestrator(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    seed = client.post("/api/studio/sample-projects/rain-night", headers=H)
    pid = seed.json()["id"]

    async def _fake_render(session, shot, request=None, **kw):
        shot.status = "rendered"
        shot.video_url = f"/api/studio/files/fake_{shot.idx}.mp4"
        session.add(shot)
        session.commit()
        return shot

    with patch(
        "app.routes.studio.orchestrator.render_shot",
        new=AsyncMock(side_effect=_fake_render),
    ) as mocked:
        r = client.post(f"/api/studio/projects/{pid}/steps/video/rerun", headers=H)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["attempted"] == 4
        assert body["ok"] == 4
        assert body["failed"] == 0
        assert mocked.await_count == 4

    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert all(s["status"] == "rendered" for s in detail["shots"])


def test_batch5_step_rerun_requires_auth(ctx):
    client, token, _, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/studio/projects", headers=H, json={"title": "a"}
    ).json()["id"]
    r = client.post(f"/api/studio/projects/{pid}/steps/video/rerun")
    assert r.status_code in (401, 403), r.text
