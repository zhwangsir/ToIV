"""POST /api/upload 三重白名单(扩展名+Content-Type+魔数)测试。

QA-FULL-2026-08-11 P0:此前仅按扩展名接收,MZ exe 伪装 .png / PHP 伪装 .jpg /
无扩展名文件全部 200 落 worker,可投递 webshell。
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
_JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
_WAV = b"RIFF" + b"\x24" * 4 + b"WAVEfmt " + b"\x00" * 16
_MP3 = b"ID3\x04\x00" + b"\x00" * 32
_EXE = b"MZ\x90\x00" + b"\x00" * 32  # PE 可执行文件头
_PHP = b"<?php echo shell_exec($_GET['c']); ?>"


class _FakeClient:
    base_url = "http://fake-worker:8188"

    async def upload_image(self, content: bytes, name: str) -> str:
        return name

    async def model_names(self) -> set[str]:
        return set()

    async def node_names(self) -> set[str]:
        return set()


class _FakePool:
    def __init__(self) -> None:
        self._client = _FakeClient()
        self.clients = [self._client]

    async def pick(self, required=None, required_nodes=None) -> _FakeClient:
        return self._client


@pytest.fixture
def ctx():
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
    app.dependency_overrides[get_pool] = lambda: _FakePool()
    with Session(engine) as s:
        tenant = Tenant(name="uploader")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="uploader@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        token = create_token(user.id)
    yield TestClient(app), {"Authorization": f"Bearer {token}"}
    app.dependency_overrides.clear()


def _upload(client: TestClient, headers: dict, data: bytes, filename: str, content_type: str, **params):
    return client.post(
        "/api/upload",
        params={"kind": "avatar", **params},
        files={"image": (filename, data, content_type)},
        headers=headers,
    )


def test_valid_png_accepted(ctx):
    client, h = ctx
    r = _upload(client, h, _PNG, "ref.png", "image/png")
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == "ref.png"


def test_valid_jpg_and_wav_accepted(ctx):
    client, h = ctx
    assert _upload(client, h, _JPG, "ref.jpg", "image/jpeg").status_code == 200
    assert _upload(client, h, _WAV, "voice.wav", "audio/wav").status_code == 200
    assert _upload(client, h, _MP3, "voice.mp3", "audio/mpeg").status_code == 200


def test_exe_disguised_as_png_rejected(ctx):
    """MZ 可执行文件伪装 .png → 415,不得落 worker。"""
    client, h = ctx
    r = _upload(client, h, _EXE, "evil.png", "image/png")
    assert r.status_code == 415
    assert "不符" in r.json()["detail"]


def test_php_disguised_as_jpg_rejected(ctx):
    client, h = ctx
    r = _upload(client, h, _PHP, "evil.jpg", "image/jpeg")
    assert r.status_code == 415


def test_extensionless_rejected(ctx):
    client, h = ctx
    r = _upload(client, h, _PNG, "noext", "image/png")
    assert r.status_code == 415
    assert "无扩展名" in r.json()["detail"]


def test_dangerous_extension_rejected(ctx):
    client, h = ctx
    r = _upload(client, h, _PHP, "shell.php", "application/x-php")
    assert r.status_code == 415


def test_mismatched_extension_rejected(ctx):
    """真 MP3 内容却叫 .png → 415。"""
    client, h = ctx
    r = _upload(client, h, _MP3, "fake.png", "image/png")
    assert r.status_code == 415


def test_mismatched_content_type_rejected(ctx):
    """内容是 PNG 但 Content-Type 声称 audio → 415。"""
    client, h = ctx
    r = _upload(client, h, _PNG, "ref.png", "audio/wav")
    assert r.status_code == 415


def test_octet_stream_content_type_bypasses_major_check(ctx):
    """部分浏览器/客户端发 application/octet-stream:魔数为准,放行。"""
    client, h = ctx
    r = _upload(client, h, _PNG, "ref.png", "application/octet-stream")
    assert r.status_code == 200


def test_all_workers_mode_also_validated(ctx):
    client, h = ctx
    ok = _upload(client, h, _PNG, "ref.png", "image/png", all_workers="true")
    assert ok.status_code == 200
    assert ok.json()["all_workers"] is True
    bad = _upload(client, h, _EXE, "evil.png", "image/png", all_workers="true")
    assert bad.status_code == 415


def test_upload_rate_limited_after_10_in_a_minute(ctx):
    """P1-11:upload scope(60s/10 次)生效 —— 连发 11 次,第 11 次 429 带 Retry-After。

    conftest 每个用例前清空限流桶,本用例独占配额,不受其它用例污染。
    """
    client, h = ctx
    for i in range(10):
        r = _upload(client, h, _PNG, "ref.png", "image/png")
        assert r.status_code == 200, (i, r.text)
    r = _upload(client, h, _PNG, "ref.png", "image/png")
    assert r.status_code == 429
    assert "Retry-After" in r.headers
