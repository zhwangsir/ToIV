"""Batch4: 配音 / 对口型 / 成片 重量级失败与边界压测。

覆盖 Studio UI 主路径(/api/studio/*)与 drama 兼容路径(/api/drama/*):
  a) 配音:缺角色音色 / 空对白 / 非法 shot id → 明确 422/404,不 500
  b) 对口型:缺视频或缺音频 → 明确 422
  c) 成片:缺镜头视频 / 部分镜头缺失 → 明确 422(含可诊断镜号)
  d) 成功路径用 mock 证明契约;TTS/对口型不可达 → 502 且文案可诊断
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import (
    DramaProject,
    DramaShot,
    StudioShot,
    Tenant,
    User,
)
from app.security import create_token, hash_password
from app.services.studio import assemble as assemble_svc
from app.services.studio import voice as voice_svc


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
        tenant = Tenant(name="batch4")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="batch4@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_studio(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "Batch4"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _mk_studio_shot(client: TestClient, H: dict, pid: str, **over) -> dict:
    item = {"scene": "雨夜", "prompt": "便利店", "render_mode": "video"}
    item.update(over)
    r = client.put(
        f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": [item]}
    )
    assert r.status_code == 200, r.text
    return r.json()["shots"][0]


def _bind_engine(engine):
    """从 TestClient dependency override 取同一内存库 Session。"""
    return Session(engine)


# ── a) 配音失败边界 ─────────────────────────────────────────────────────────


def test_batch4_voice_empty_dialogue_422(ctx):
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    shot = _mk_studio_shot(client, H, pid, dialogue="   ")
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 422, r.text
    assert "台词" in r.json()["detail"]
    assert r.status_code != 500


def test_batch4_voice_invalid_shot_404(ctx):
    client, token, _ = ctx
    H = _h(token)
    r = client.post("/api/studio/shots/not-a-real-shot-id/voice", headers=H)
    assert r.status_code == 404, r.text
    assert "分镜" in r.json()["detail"]


def test_batch4_voice_speaker_no_character_422(ctx):
    """有说话人但角色卡不存在 → 422 缺角色,不静默默认音。"""
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    shot = _mk_studio_shot(client, H, pid, dialogue="我回来了。", speaker="林夏")
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 422, r.text
    assert "林夏" in r.json()["detail"]
    assert "角色卡" in r.json()["detail"]


def test_batch4_voice_character_missing_timbre_422(ctx):
    """角色卡存在但未配置音色 → 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    cr = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏", "visual_prompt": "1girl"},
    )
    assert cr.status_code == 200, cr.text
    assert not (cr.json().get("voice_ref_url") or "").strip()
    shot = _mk_studio_shot(client, H, pid, dialogue="今晚雨很大。", speaker="林夏")
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 422, r.text
    assert "未配置音色" in r.json()["detail"]


def test_batch4_voice_success_mock_contract(ctx, monkeypatch):
    """有台词+角色音色 → 200,状态 voiced(契约)。"""
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    cr = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏", "visual_prompt": "1girl"},
    )
    cid = cr.json()["id"]
    client.patch(
        f"/api/studio/characters/{cid}",
        headers=H,
        json={"voice_ref_url": "/api/studio/files/linxia-ref.wav"},
    )
    shot = _mk_studio_shot(client, H, pid, dialogue="今晚雨很大。", speaker="林夏")

    async def fake_synth(session, shot, character):
        assert character is not None
        assert character.voice_ref_url.endswith("linxia-ref.wav")
        shot.voice_url = "/api/studio/files/out.wav"
        shot.status = "voiced"
        shot.error = ""
        session.add(shot)
        session.commit()
        return shot.voice_url

    monkeypatch.setattr("app.services.studio.voice.synth_for_shot", fake_synth)
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "voiced"
    assert body["voice_url"].endswith("out.wav")


def test_batch4_voice_tts_unreachable_502(ctx, monkeypatch):
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    shot = _mk_studio_shot(client, H, pid, dialogue="旁白一句。")  # 无说话人 → 默认可配

    async def fake_synth(session, shot, character):
        raise voice_svc.VoiceError("TTS 服务不可达:ConnectError")

    monkeypatch.setattr("app.services.studio.voice.synth_for_shot", fake_synth)
    r = client.post(f"/api/studio/shots/{shot['id']}/voice", headers=H)
    assert r.status_code == 502, r.text
    assert "不可达" in r.json()["detail"]


def test_batch4_drama_voice_empty_dialogue_422(ctx):
    """drama 兼容路径:空对白 → 422。"""
    from sqlmodel import select

    client, token, engine = ctx
    H = _h(token)
    with _bind_engine(engine) as s:
        user = s.exec(select(User)).first()
        p = DramaProject(
            tenant_id=user.tenant_id, user_id=user.id, title="d4", script="s"
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        shot = DramaShot(
            project_id=p.id, idx=0, prompt="x", dialogue="", speaker=""
        )
        s.add(shot)
        s.commit()
        s.refresh(shot)
        sid = shot.id
    r = client.post(f"/api/drama/shots/{sid}/generate-voice", headers=H, json={})
    assert r.status_code == 422, r.text
    assert "台词" in r.json()["detail"]


def test_batch4_drama_voice_invalid_shot_404(ctx):
    client, token, _ = ctx
    H = _h(token)
    r = client.post(
        "/api/drama/shots/00000000-0000-0000-0000-000000000000/generate-voice",
        headers=H,
        json={},
    )
    assert r.status_code == 404, r.text


# ── b) 对口型失败边界 ───────────────────────────────────────────────────────


def test_batch4_lipsync_missing_video_422(ctx):
    client, token, engine = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    shot = _mk_studio_shot(client, H, pid, dialogue="x")
    with _bind_engine(engine) as s:
        db = s.get(StudioShot, shot["id"])
        db.voice_url = "/api/studio/files/v.wav"
        db.video_url = ""
        s.add(db)
        s.commit()
    r = client.post(f"/api/studio/shots/{shot['id']}/lipsync", headers=H)
    assert r.status_code == 422, r.text
    assert "视频" in r.json()["detail"] or "配音" in r.json()["detail"]


def test_batch4_lipsync_missing_audio_422(ctx):
    client, token, engine = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    shot = _mk_studio_shot(client, H, pid, dialogue="x")
    with _bind_engine(engine) as s:
        db = s.get(StudioShot, shot["id"])
        db.video_url = "/api/studio/files/v.mp4"
        db.voice_url = ""
        s.add(db)
        s.commit()
    r = client.post(f"/api/studio/shots/{shot['id']}/lipsync", headers=H)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "配音" in detail or "视频" in detail


def test_batch4_lipsync_invalid_shot_404(ctx):
    client, token, _ = ctx
    H = _h(token)
    r = client.post("/api/studio/shots/nope-shot/lipsync", headers=H)
    assert r.status_code == 404


def test_batch4_drama_lipsync_missing_video_422(ctx):
    client, token, engine = ctx
    H = _h(token)
    from sqlmodel import select

    with _bind_engine(engine) as s:
        user = s.exec(select(User)).first()
        p = DramaProject(
            tenant_id=user.tenant_id, user_id=user.id, title="ls", script="s"
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        shot = DramaShot(
            project_id=p.id,
            idx=0,
            prompt="x",
            dialogue="你好",
            voice_status="done",
            voice_url="/api/drama/voice/voice-" + "a" * 32 + ".wav",
            video_status="pending",
            video_url="",
        )
        s.add(shot)
        s.commit()
        s.refresh(shot)
        sid = shot.id
    r = client.post(f"/api/drama/shots/{sid}/lipsync", headers=H, json={})
    assert r.status_code == 422, r.text
    assert "视频" in r.json()["detail"]


# ── c) 成片 assemble 失败边界 ───────────────────────────────────────────────


def test_batch4_assemble_partial_missing_422(ctx):
    """两镜仅一镜有成片 → 422 且 detail 含缺镜号。"""
    client, token, engine = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={
            "shots": [
                {"scene": "A", "prompt": "a", "render_mode": "video"},
                {"scene": "B", "prompt": "b", "render_mode": "video"},
            ]
        },
    )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    with _bind_engine(engine) as s:
        db = s.get(StudioShot, shots[0]["id"])
        db.final_clip_url = "/api/studio/files/a.mp4"
        db.status = "lipsynced"
        s.add(db)
        s.commit()
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "未就绪" in detail
    assert "1" in detail  # 缺 idx=1


def test_batch4_assemble_no_shots_422(ctx):
    client, token, _ = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 422
    assert "无分镜" in r.json()["detail"]


def test_batch4_assemble_clip_file_missing(tmp_path, monkeypatch):
    """URL 在但本地文件丢 → AssembleError 可诊断。"""
    monkeypatch.setattr(assemble_svc, "drama_output_root", lambda: tmp_path)
    (tmp_path / "studio").mkdir()
    with pytest.raises(assemble_svc.AssembleError, match="片段文件缺失"):
        assemble_svc._clip_path("/api/studio/files/gone.mp4")


def test_batch4_assemble_success_mock(ctx, monkeypatch):
    client, token, engine = ctx
    H = _h(token)
    pid = _mk_studio(client, H)
    shot = _mk_studio_shot(client, H, pid)
    with _bind_engine(engine) as s:
        db = s.get(StudioShot, shot["id"])
        db.final_clip_url = "/api/studio/files/a.mp4"
        db.status = "lipsynced"
        s.add(db)
        s.commit()

    async def fake_assemble(session, project, shots):
        project.final_url = "/api/studio/files/final-batch4.mp4"
        project.status = "ready"
        session.add(project)
        session.commit()
        return project.final_url

    monkeypatch.setattr(
        "app.services.studio.assemble.assemble_project", fake_assemble
    )
    r = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["final_url"].endswith("final-batch4.mp4")
    assert r.json()["status"] == "ready"


def test_batch4_drama_assemble_partial_missing_422(ctx):
    """drama 路径:两镜仅一镜 done → 422 可诊断。"""
    client, token, engine = ctx
    H = _h(token)
    from sqlmodel import select

    with _bind_engine(engine) as s:
        user = s.exec(select(User)).first()
        p = DramaProject(
            tenant_id=user.tenant_id, user_id=user.id, title="asm", script="s"
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        s.add(
            DramaShot(
                project_id=p.id,
                idx=0,
                prompt="a",
                video_status="done",
                video_url="/api/drama/output/a.mp4",
            )
        )
        s.add(
            DramaShot(
                project_id=p.id,
                idx=1,
                prompt="b",
                video_status="pending",
                video_url="",
            )
        )
        s.commit()
        pid = p.id
    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=H, json={})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "分镜未就绪" in detail
    assert "1" in detail


def test_batch4_drama_assemble_empty_project_422(ctx):
    client, token, engine = ctx
    H = _h(token)
    from sqlmodel import select

    with _bind_engine(engine) as s:
        user = s.exec(select(User)).first()
        p = DramaProject(
            tenant_id=user.tenant_id, user_id=user.id, title="empty", script="s"
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id
    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=H, json={})
    assert r.status_code == 422, r.text
    assert "无分镜" in r.json()["detail"]
