"""译制上传 POST /api/dub/upload 媒体格式白名单测试。

音频板块 ASR 工具卡与译制共用此上传通道:_EXT_OK 放行视频 + 常见音频,
_NAME_RE 同步放行;非法扩展名仍 400。落盘目录 monkeypatch 到 tmp。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes import dub
from app.security import create_token, hash_password


@pytest.fixture
def ctx(tmp_path):
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
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="up@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id

    import app.routes.dub as dub_mod

    old_dir = dub_mod._DUB_DIR
    dub_mod._DUB_DIR = tmp_path
    yield TestClient(app), create_token(uid), tmp_path
    dub_mod._DUB_DIR = old_dir
    app.dependency_overrides.clear()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _upload(client: TestClient, token: str, filename: str, data: bytes = b"x" * 16):
    return client.post(
        "/api/dub/upload",
        files={"video": (filename, data, "application/octet-stream")},
        headers=_auth(token),
    )


@pytest.mark.parametrize("ext", ["mp4", "mov", "webm", "mkv", "mp3", "wav", "flac", "ogg", "m4a"])
def test_upload_accepts_video_and_audio(ctx, ext: str):
    client, token, out_dir = ctx
    r = _upload(client, token, f"media.{ext}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"].endswith(f".{ext}")
    assert body["size"] == 16
    assert (out_dir / body["name"]).is_file()


@pytest.mark.parametrize("ext", ["exe", "srt", "txt", "ass"])
def test_upload_rejects_unknown_extension(ctx, ext: str):
    client, token, _ = ctx
    r = _upload(client, token, f"evil.{ext}")
    assert r.status_code == 400
    assert "不支持的媒体格式" in r.json()["detail"]


def test_upload_audio_name_matches_readback_regex(ctx):
    """上传成功的音频文件名须能过 _NAME_RE(dub_source / transcribe 回读共用)。"""
    client, token, _ = ctx
    r = _upload(client, token, "voice.wav")
    assert r.status_code == 200, r.text
    assert dub._NAME_RE.match(r.json()["name"])
