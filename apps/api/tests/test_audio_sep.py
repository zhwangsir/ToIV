"""人声分离独立端点 POST /api/audio/separate + 公共服务 services.audio_sep 测试。

- 端点成功路径:200 + Job(kind=audio_sep, status=done, results=[url])落库
  + 产物文件存在 + /api/jobs 作品库回读 + GET /api/audio/files/{name} 可下载。
- 服务未配置(audio_sep_url="")→ 503;不可达/非 200 → 502(服务单测)。
- 非法扩展名 → 422;路径穿越文件名 → 400;空文件 → 400;超限 → 413。
- NAS 产物根目录不可写 → 自动降级本地回退目录,不 500。
"""
from __future__ import annotations

import io
import json
import wave
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.routes import audio_tools
from app.security import create_token, hash_password
from app.services import audio_sep


def _minimal_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 2400)  # 0.1s
    return buf.getvalue()


_MIN_WAV = _minimal_wav()


@pytest.fixture
def ctx(tmp_path, monkeypatch):
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
            email="sep@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id

    # 产物根目录固定到测试临时目录(等价 NAS 已挂载场景)
    monkeypatch.setattr(audio_tools, "audio_output_root", lambda: tmp_path)
    yield TestClient(app), create_token(uid), engine, tmp_path
    app.dependency_overrides.clear()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _post_sep(client: TestClient, token: str, filename: str = "song.mp3", data: bytes = b"fake"):
    return client.post(
        "/api/audio/separate",
        files={"file": (filename, data, "application/octet-stream")},
        headers=_auth(token),
    )


# ────────────────────────────────
# 端点
# ────────────────────────────────


def test_separate_success(ctx, monkeypatch):
    client, token, engine, out_dir = ctx

    async def _fake_sep(audio: bytes, filename: str = "audio") -> bytes:
        assert audio == b"fake-mp3-bytes"
        assert filename == "song.mp3"
        return _MIN_WAV

    monkeypatch.setattr(audio_tools, "separate_vocals", _fake_sep)

    r = _post_sep(client, token, data=b"fake-mp3-bytes")
    assert r.status_code == 200, r.text
    body = r.json()
    url = body["url"]
    assert url.startswith("/api/audio/files/audiosep-")
    assert body["duration_sec"] == pytest.approx(0.1)

    # 产物文件存在且内容一致
    name = url.rsplit("/", 1)[-1]
    assert (out_dir / name).is_file()
    assert (out_dir / name).read_bytes() == _MIN_WAV

    # Job 落库:kind=audio_sep, status=done, results=[url](与作品库同一套)
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.kind == "audio_sep")).first()
    assert job is not None
    assert job.status == "done"
    assert json.loads(job.result) == [url]

    # 作品库 /api/jobs 回读同一条
    r_jobs = client.get("/api/jobs", headers=_auth(token))
    assert r_jobs.status_code == 200
    entry = next(j for j in r_jobs.json() if j["kind"] == "audio_sep")
    assert entry["status"] == "done"
    assert entry["results"] == [url]

    # 产物可经下载端点回读
    r_get = client.get(url, headers=_auth(token))
    assert r_get.status_code == 200
    assert r_get.content == _MIN_WAV


def test_separate_requires_auth(ctx):
    client, *_ = ctx
    r = client.post(
        "/api/audio/separate",
        files={"file": ("song.mp3", b"fake", "application/octet-stream")},
    )
    assert r.status_code == 401


def test_separate_service_not_configured_returns_503(ctx, monkeypatch):
    client, token, *_ = ctx
    # 不打 separate_vocals 桩,走真实服务:audio_sep_url 为空 → 503
    monkeypatch.setattr(audio_sep, "get_settings", lambda: SimpleNamespace(audio_sep_url=""))
    r = _post_sep(client, token)
    assert r.status_code == 503
    assert "未配置" in r.json()["detail"]


def test_separate_bad_extension_returns_422(ctx, monkeypatch):
    client, token, *_ = ctx
    monkeypatch.setattr(
        audio_sep, "get_settings", lambda: SimpleNamespace(audio_sep_url="http://sep:9220")
    )
    assert _post_sep(client, token, filename="song.exe").status_code == 422
    assert _post_sep(client, token, filename="noext").status_code == 422


def test_separate_path_traversal_filename_returns_400(ctx, monkeypatch):
    client, token, *_ = ctx
    monkeypatch.setattr(
        audio_sep, "get_settings", lambda: SimpleNamespace(audio_sep_url="http://sep:9220")
    )
    for bad in ("../evil.wav", "../../secret.wav", "/etc/passwd.wav", "a/b.wav"):
        r = _post_sep(client, token, filename=bad)
        assert r.status_code == 400, f"{bad} 应被拒绝: {r.status_code}"


def test_separate_empty_file_returns_400(ctx, monkeypatch):
    client, token, *_ = ctx
    monkeypatch.setattr(
        audio_sep, "get_settings", lambda: SimpleNamespace(audio_sep_url="http://sep:9220")
    )
    assert _post_sep(client, token, data=b"").status_code == 400


def test_separate_oversize_returns_413(ctx, monkeypatch):
    client, token, *_ = ctx
    monkeypatch.setattr(
        audio_sep, "get_settings", lambda: SimpleNamespace(audio_sep_url="http://sep:9220")
    )
    monkeypatch.setattr(audio_tools, "_MAX_BYTES", 10)
    assert _post_sep(client, token, data=b"x" * 11).status_code == 413


def test_download_rejects_bad_name(ctx):
    client, token, *_ = ctx
    assert client.get("/api/audio/files/evil.wav", headers=_auth(token)).status_code == 400
    assert (
        client.get("/api/audio/files/audiosep-deadbeef.wav", headers=_auth(token)).status_code
        == 400
    )


def test_download_missing_returns_404(ctx):
    client, token, *_ = ctx
    name = "audiosep-" + "0" * 32 + ".wav"
    r = client.get(f"/api/audio/files/{name}", headers=_auth(token))
    assert r.status_code == 404


# ────────────────────────────────
# 产物写盘降级(NAS 不可写 → 本地回退目录,不 500)
# ────────────────────────────────


def test_write_output_falls_back_when_root_unwritable(tmp_path, monkeypatch):
    blocker = tmp_path / "blocker"
    blocker.write_text("x")  # 是个文件:对其 mkdir 必抛 FileExistsError(OSError)
    fallback = tmp_path / "fallback"
    monkeypatch.setattr(audio_tools, "audio_output_root", lambda: blocker)
    monkeypatch.setattr(audio_tools, "content_subdir", lambda name: fallback)

    out, name = audio_tools._write_output(b"RIFF-fake")
    assert out.parent == fallback
    assert out.read_bytes() == b"RIFF-fake"
    assert name.startswith("audiosep-") and name.endswith(".wav")


# ────────────────────────────────
# 公共服务 separate_vocals 单测
# ────────────────────────────────


class _Resp:
    def __init__(self, status_code: int = 200, content: bytes = _MIN_WAV):
        self.status_code = status_code
        self.content = content


class _FakeClient:
    def __init__(self, resp: _Resp | None = None, exc: Exception | None = None, **_kw):
        self._resp = resp or _Resp()
        self._exc = exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url: str, **kwargs) -> _Resp:
        if self._exc:
            raise self._exc
        return self._resp


def _patch_sep_settings(monkeypatch, url: str = "http://sep:9220"):
    monkeypatch.setattr(audio_sep, "get_settings", lambda: SimpleNamespace(audio_sep_url=url))


async def test_service_success(monkeypatch):
    _patch_sep_settings(monkeypatch)
    calls: list = []

    class _C(_FakeClient):
        async def post(self, url: str, **kwargs) -> _Resp:
            calls.append((url, kwargs))
            return await super().post(url, **kwargs)

    monkeypatch.setattr(audio_sep.httpx, "AsyncClient", lambda **kw: _C(**kw))
    vocals = await audio_sep.separate_vocals(b"RIFF-raw", filename="song.mp3")
    assert vocals == _MIN_WAV
    url, kwargs = calls[0]
    assert url == "http://sep:9220/separate"
    assert kwargs["files"]["file"] == ("song.mp3", b"RIFF-raw", "audio/wav")


async def test_service_not_configured_raises_503(monkeypatch):
    _patch_sep_settings(monkeypatch, "")
    with pytest.raises(HTTPException) as exc:
        await audio_sep.separate_vocals(b"RIFF-raw")
    assert exc.value.status_code == 503


async def test_service_unreachable_raises_502(monkeypatch):
    _patch_sep_settings(monkeypatch)
    monkeypatch.setattr(
        audio_sep.httpx,
        "AsyncClient",
        lambda **kw: _FakeClient(exc=httpx.ConnectError("boom"), **kw),
    )
    with pytest.raises(HTTPException) as exc:
        await audio_sep.separate_vocals(b"RIFF-raw")
    assert exc.value.status_code == 502
    assert "不可达" in exc.value.detail


async def test_service_timeout_raises_502(monkeypatch):
    _patch_sep_settings(monkeypatch)
    monkeypatch.setattr(
        audio_sep.httpx,
        "AsyncClient",
        lambda **kw: _FakeClient(exc=httpx.ReadTimeout("slow"), **kw),
    )
    with pytest.raises(HTTPException) as exc:
        await audio_sep.separate_vocals(b"RIFF-raw")
    assert exc.value.status_code == 502
    assert "超时" in exc.value.detail


async def test_service_bad_status_raises_502(monkeypatch):
    _patch_sep_settings(monkeypatch)
    monkeypatch.setattr(
        audio_sep.httpx,
        "AsyncClient",
        lambda **kw: _FakeClient(resp=_Resp(500, b"err"), **kw),
    )
    with pytest.raises(HTTPException) as exc:
        await audio_sep.separate_vocals(b"RIFF-raw")
    assert exc.value.status_code == 502


async def test_service_non_wav_raises_502(monkeypatch):
    _patch_sep_settings(monkeypatch)
    monkeypatch.setattr(
        audio_sep.httpx,
        "AsyncClient",
        lambda **kw: _FakeClient(resp=_Resp(200, b"not-a-wav"), **kw),
    )
    with pytest.raises(HTTPException) as exc:
        await audio_sep.separate_vocals(b"RIFF-raw")
    assert exc.value.status_code == 502
