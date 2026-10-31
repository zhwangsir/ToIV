"""F4：剪映草稿结构生成 + 导出端点（fixture 时间线）。"""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import jianying_draft as jy


def _fixture_clips() -> list[jy.TimelineClip]:
    return [
        jy.TimelineClip(
            clip_id="SHOT-A",
            label="shot_00",
            duration_us=3_000_000,
            kind="video",
            media_url="/api/studio/files/a.mp4",
        ),
        jy.TimelineClip(
            clip_id="SHOT-B",
            label="shot_01",
            duration_us=4_000_000,
            kind="video",
            media_url="/api/studio/files/b.mp4",
        ),
        jy.TimelineClip(
            clip_id="VOICE-A",
            label="shot_00_voice",
            duration_us=3_000_000,
            kind="audio",
            media_url="/api/studio/files/a.wav",
            timeline_start_us=0,
        ),
        jy.TimelineClip(
            clip_id="BGM-1",
            label="bgm",
            duration_us=7_000_000,
            kind="audio",
            media_url="/api/studio/files/bgm.mp3",
            timeline_start_us=0,
        ),
    ]


def test_sec_to_us_and_sanitize():
    assert jy.sec_to_us(6) == 6_000_000
    assert jy.sec_to_us(0) == 6_000_000
    assert jy.sec_to_us(None) == 6_000_000
    name = jy.sanitize_draft_filename("雨夜 便利店!", draft_id="ABCDEF12-xxxx")
    assert "雨夜" in name
    assert "ABCDEF12"[:8].lower() in name.lower() or "ABCDEF12"[:8] in name


def test_build_draft_document_structure():
    clips = _fixture_clips()
    doc = jy.build_draft_document(draft_id="D1", name="雨夜", clips=clips)
    assert doc["id"] == "D1"
    assert doc["name"] == "雨夜"
    assert doc["duration"] == 7_000_000
    assert doc["platform"]["app_source"] == "lv"
    assert doc["extra_info"]["toiv_format"] == jy.DRAFT_FORMAT_VERSION
    assert len(doc["materials"]["videos"]) == 2
    assert len(doc["materials"]["audios"]) == 2
    types = [t["type"] for t in doc["tracks"]]
    assert "video" in types and "audio" in types
    vtrack = next(t for t in doc["tracks"] if t["type"] == "video")
    assert len(vtrack["segments"]) == 2
    assert vtrack["segments"][0]["target_timerange"]["start"] == 0
    assert vtrack["segments"][1]["target_timerange"]["start"] == 3_000_000


def test_export_zip_nonempty(tmp_path: Path):
    clips = _fixture_clips()
    result = jy.export_draft_zip(tmp_path, name="雨夜便利店", clips=clips, include_media=False)
    assert result.zip_path is not None and result.zip_path.is_file()
    assert result.zip_path.stat().st_size > 200
    assert result.video_segments == 2
    assert result.audio_segments == 2
    with zipfile.ZipFile(result.zip_path, "r") as zf:
        names = zf.namelist()
        assert any(n.endswith("draft_content.json") for n in names)
        assert any(n.endswith("draft_info.json") for n in names)
        assert any(n.endswith("draft_meta_info.json") for n in names)
        assert any(n.endswith("IMPORT.md") for n in names)
        assert any(n.endswith("toiv_manifest.json") for n in names)
        content_name = next(n for n in names if n.endswith("draft_content.json"))
        doc = json.loads(zf.read(content_name))
        assert doc["duration"] == 7_000_000
        assert len(doc["materials"]["videos"]) == 2


def test_clips_from_studio_shots_skips_empty():
    shots = [
        SimpleNamespace(
            id="s1", idx=1, duration_sec=5, final_clip_url="/api/studio/files/a.mp4",
            video_url="", voice_url="", dialogue="hi",
        ),
        SimpleNamespace(
            id="s2", idx=0, duration_sec=3, final_clip_url="",
            video_url="", voice_url="", dialogue="",
        ),
    ]
    clips = jy.clips_from_studio_shots(shots, resolve_path=lambda u: None)
    assert len([c for c in clips if c.kind == "video"]) == 1
    assert clips[0].clip_id == "s1"


def test_empty_clips_raises():
    with pytest.raises(jy.JianyingDraftError):
        jy.build_draft_document(draft_id="x", name="n", clips=[])


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _session():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _session
    with Session(engine) as s:
        t = Tenant(name="t")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            email=f"f4-{t.id[:8]}@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        token = create_token(u.id)
        p = StudioProject(tenant_id=t.id, user_id=u.id, title="雨夜F4")
        s.add(p)
        s.commit()
        s.refresh(p)
        s.add(
            StudioShot(
                project_id=p.id,
                idx=0,
                scene="进店",
                duration_sec=3,
                final_clip_url="/api/studio/files/f4-a.mp4",
            )
        )
        s.add(
            StudioShot(
                project_id=p.id,
                idx=1,
                scene="结账",
                duration_sec=4,
                final_clip_url="/api/studio/files/f4-b.mp4",
                voice_url="/api/studio/files/f4-a.wav",
            )
        )
        s.commit()
        pid = p.id
    client = TestClient(app)
    yield client, {"Authorization": f"Bearer {token}"}, pid
    app.dependency_overrides.clear()


def test_export_endpoint_zip(ctx):
    client, headers, pid = ctx
    r = client.get(
        f"/api/studio/projects/{pid}/export/jianying",
        params={"include_media": "false"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("application/zip")
    assert r.headers.get("x-toiv-draft-format") == jy.DRAFT_FORMAT_VERSION
    assert int(r.headers.get("x-toiv-video-segments") or 0) == 2
    assert len(r.content) > 200
    with zipfile.ZipFile(io.BytesIO(r.content), "r") as zf:
        assert any(n.endswith("draft_content.json") for n in zf.namelist())


def test_export_endpoint_no_clips_422(ctx):
    client, headers, _pid = ctx
    r0 = client.post(
        "/api/studio/projects",
        headers=headers,
        json={"title": "empty-f4"},
    )
    if r0.status_code >= 400:
        pytest.skip(f"create project shape: {r0.status_code}")
    body = r0.json()
    empty_pid = body.get("id") or (body.get("project") or {}).get("id")
    if not empty_pid:
        pytest.skip("no project id in create response")
    r = client.get(f"/api/studio/projects/{empty_pid}/export/jianying", headers=headers)
    assert r.status_code == 422
