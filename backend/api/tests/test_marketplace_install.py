"""模型市场安装落地(POST /api/marketplace/install)测试 —— NAS 下载链路版。

2026-08-09 重构后:install 不再走 worker 上的 ComfyUI-Manager(策展白名单/漂移/无进度),
而是组装 NasDownloadRequest 复用 /nas/download 作业管线(直落 NAS 模型库)。

测试聚焦(start_download_job / require_nas_ready 均 monkeypatch 隔离,不触网):
- source=civitai + id → civitai 解析流(type 归一化、name 透传)
- Civitai 模型页链接(/models/{id})→ 自动转 civitai 解析流;/api/download/ 直链保持 url 流
- 裸下载直链(白名单主机)→ source=url 直通
- huggingface source+id → hf 解析流(filename 可空=自动挑主权重)
- url 白名单拒绝(非白名单主机 → 400;非 http(s) → 400)
- type 归一化(Civitai 分类名大小写/别名)与未知类型 → 400
- 权限:非管理员 403,未登录 401;NAS 未就绪 503
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.marketplace as marketplace_route
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# fixtures / fakes
# --------------------------------------------------------------------------- #


def _make_client(role: str):
    """建测试客户端 + 指定角色的登录 token。"""
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
        tenant = Tenant(name=f"mkt-{role}")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email=f"{role}@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
            role=role,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    return TestClient(app), create_token(uid)


@pytest.fixture
def client_admin():
    c, token = _make_client("admin")
    yield c, token
    app.dependency_overrides.clear()


@pytest.fixture
def client_user():
    c, token = _make_client("user")
    yield c, token
    app.dependency_overrides.clear()


def _capture_job(monkeypatch) -> dict:
    """替换 start_download_job / require_nas_ready:捕获 NasDownloadRequest,不触网不起任务。"""
    captured: dict = {}

    def fake_start(body, user, session):  # noqa: ANN001, ANN202
        captured["body"] = body
        captured["user"] = user
        return {"job_id": "job-123", "filename": body.filename or "x.safetensors"}

    monkeypatch.setattr(marketplace_route, "start_download_job", fake_start)
    monkeypatch.setattr(marketplace_route, "require_nas_ready", lambda: None)
    return captured


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- #
# 1) civitai source+id → civitai 解析流
# --------------------------------------------------------------------------- #


def test_install_civitai_source_uses_api_resolution(client_admin, monkeypatch):
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={
            "type": "LORA",
            "source": "civitai",
            "id": "12345",
            "name": "Cool Style",
            # 前端同时会带模型页 url;source+id 必须优先于裸 url
            "url": "https://civitai.red/models/12345",
        },
    )
    assert r.status_code == 200, r.text
    body = captured["body"]
    assert body.source == "civitai"
    assert body.id == "12345"
    assert body.name == "Cool Style"
    assert body.type == "lora"  # LORA 归一化
    resp = r.json()
    assert resp["accepted"] is True
    assert resp["job_id"] == "job-123"
    assert "filename" in resp and "message" in resp


def test_install_civitai_web_page_url_converted_to_civitai_source(client_admin, monkeypatch):
    """Civitai 模型页链接(/models/{id})不是下载直链 → 自动转 civitai API 解析。"""
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "Checkpoint", "url": "https://civitai.red/models/67890/"},
    )
    assert r.status_code == 200, r.text
    body = captured["body"]
    assert body.source == "civitai"
    assert body.id == "67890"
    assert body.type == "checkpoint"


def test_install_civitai_download_api_url_stays_url_source(client_admin, monkeypatch):
    """/api/download/models/{id} 是真下载直链 → 保持 source=url 直通(不转模型页解析)。"""
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://civitai.red/api/download/models/3203205"},
    )
    assert r.status_code == 200, r.text
    body = captured["body"]
    assert body.source == "url"
    assert body.url == "https://civitai.red/api/download/models/3203205"


# --------------------------------------------------------------------------- #
# 2) 裸直链(白名单)→ source=url 直通
# --------------------------------------------------------------------------- #


def test_install_whitelisted_direct_url_passthrough(client_admin, monkeypatch):
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={
            "type": "vae",
            "url": "https://huggingface.co/foo/bar/resolve/main/vae.safetensors",
        },
    )
    assert r.status_code == 200, r.text
    body = captured["body"]
    assert body.source == "url"
    assert body.url.endswith("/vae.safetensors")
    assert body.type == "vae"


def test_install_allows_civitai_subdomain(client_admin, monkeypatch):
    c, token = client_admin
    _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://cdn.civitai.com/a/b.safetensors"},
    )
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- #
# 3) huggingface source+id → hf 解析流
# --------------------------------------------------------------------------- #


def test_install_huggingface_source_with_filename(client_admin, monkeypatch):
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={
            "type": "checkpoint",
            "source": "huggingface",
            "id": "stabilityai/sdxl",
            "filename": "sd_xl_base.safetensors",
        },
    )
    assert r.status_code == 200, r.text
    body = captured["body"]
    assert body.source == "huggingface"
    assert body.id == "stabilityai/sdxl"
    assert body.hf_file == "sd_xl_base.safetensors"


def test_install_huggingface_without_filename_auto_picks(client_admin, monkeypatch):
    """hf_file 可空 → nas_models._pick_hf_file 自动挑主权重文件。"""
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "checkpoint", "source": "huggingface", "id": "foo/bar"},
    )
    assert r.status_code == 200, r.text
    assert captured["body"].hf_file == ""


# --------------------------------------------------------------------------- #
# 4) url 白名单 / scheme 校验
# --------------------------------------------------------------------------- #


def test_install_rejects_non_whitelisted_host(client_admin, monkeypatch):
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "https://evil.example.com/payload.safetensors"},
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]
    assert "body" not in captured  # 校验失败应在建作业前短路


def test_install_rejects_non_http_scheme(client_admin, monkeypatch):
    c, token = client_admin
    _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "url": "file:///etc/passwd"},
    )
    assert r.status_code == 400
    assert "http" in r.json()["detail"].lower()


# --------------------------------------------------------------------------- #
# 5) type 归一化与校验
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw,expect",
    [
        ("Checkpoint", "checkpoint"),
        ("LORA", "lora"),
        ("LoCon", "lora"),  # LyCORIS → loras/
        ("VAE", "vae"),
        ("Controlnet", "controlnet"),
        ("Upscaler", "upscale"),  # 旧链路会 400 误杀的类型
        ("TextualInversion", "embeddings"),
        ("Hypernetwork", "hypernetworks"),
        ("diffusion_models", "diffusion_models"),
    ],
)
def test_install_type_normalization(client_admin, monkeypatch, raw, expect):
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": raw, "source": "civitai", "id": "1"},
    )
    assert r.status_code == 200, r.text
    assert captured["body"].type == expect


def test_install_rejects_unknown_type(client_admin, monkeypatch):
    c, token = client_admin
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "malware", "url": "https://civitai.red/x.safetensors"},
    )
    assert r.status_code == 400
    assert "未知模型类型" in r.json()["detail"]
    assert "body" not in captured


def test_install_rejects_unknown_source(client_admin, monkeypatch):
    c, token = client_admin
    _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "source": "piratebay", "id": "1"},
    )
    assert r.status_code == 400
    assert "未知模型来源" in r.json()["detail"]


def test_install_requires_url_or_source_id(client_admin, monkeypatch):
    c, token = client_admin
    _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora"},
    )
    assert r.status_code == 400
    assert "缺少安装目标" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# 6) 权限与就绪检查
# --------------------------------------------------------------------------- #


def test_install_requires_auth(client_admin, monkeypatch):
    c, _ = client_admin
    _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        json={"type": "lora", "source": "civitai", "id": "1"},
    )
    assert r.status_code == 401


def test_install_requires_admin(client_user, monkeypatch):
    """写共享模型库仅管理员;普通用户 403(与 /nas/download 一致)。"""
    c, token = client_user
    captured = _capture_job(monkeypatch)
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "source": "civitai", "id": "1"},
    )
    assert r.status_code == 403
    assert "body" not in captured


def test_install_503_when_nas_not_ready(client_admin, monkeypatch):
    c, token = client_admin

    def _not_ready():
        raise HTTPException(status_code=503, detail="NAS 未配置")

    monkeypatch.setattr(marketplace_route, "require_nas_ready", _not_ready)
    monkeypatch.setattr(
        marketplace_route,
        "start_download_job",
        lambda *a, **k: pytest.fail("NAS 未就绪时不应建作业"),
    )
    r = c.post(
        "/api/marketplace/install",
        headers=_auth(token),
        json={"type": "lora", "source": "civitai", "id": "1"},
    )
    assert r.status_code == 503
