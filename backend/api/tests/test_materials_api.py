"""P0-1 材料库 API 错误码契约测（内存仓）。

覆盖：
- 缺 version → 400 version_required
- version=latest 拒绝
- 响应必含 version + sha256 + trust；正文 fenced
- latest_version 仅展示；生产 get/files/render/install-info 无隐式 latest
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.models import User
from app.routes import materials
from app.services import materials_store as store


@pytest.fixture()
def client():
    store.reset()
    app = FastAPI()
    app.include_router(materials.router, prefix="/api")
    fake = User(
        id="u-mat-1",
        email="mat@toiv.ai",
        hashed_password="x",
        tenant_id="t-mat",
    )
    app.dependency_overrides[get_current_user] = lambda: fake
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    store.reset()


def test_search_returns_version_sha256_trust(client: TestClient):
    r = client.get("/api/materials")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "items" in data
    assert len(data["items"]) >= 1
    for it in data["items"]:
        assert it.get("version"), it
        assert it.get("sha256"), it
        assert it.get("trust"), it
        # latest_version 可展示
        assert "latest_version" in it


def test_get_missing_version_400(client: TestClient):
    r = client.get("/api/materials/toiv/anime-medium-prefix")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"


def test_get_version_latest_rejected(client: TestClient):
    r = client.get("/api/materials/toiv/anime-medium-prefix", params={"version": "latest"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"


def test_get_with_version_ok_fenced(client: TestClient):
    r = client.get(
        "/api/materials/toiv/anime-medium-prefix",
        params={"version": "1.0.0"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == "1.0.0"
    assert body["sha256"]
    assert body["trust"]
    assert body["fenced"] is True
    assert body["content_kind"] == "untrusted_material"
    # 展示字段可有；不得省略真实 version
    assert "latest_version" in body


def test_files_missing_version_400(client: TestClient):
    r = client.get(
        "/api/materials/toiv/character-continuity-lock/files",
        params={"path": "SKILL.md"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"


def test_files_ok_fenced(client: TestClient):
    r = client.get(
        "/api/materials/toiv/character-continuity-lock/files",
        params={"version": "0.1.0", "path": "SKILL.md"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fenced"] is True
    assert body["sha256"]
    assert body["version"] == "0.1.0"
    assert "content" in body


def test_files_traversal_rejected(client: TestClient):
    r = client.get(
        "/api/materials/toiv/character-continuity-lock/files",
        params={"version": "0.1.0", "path": "../etc/passwd"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_path"


def test_render_and_install_info_require_version(client: TestClient):
    r = client.post(
        "/api/materials/toiv/anime-medium-prefix/render",
        json={"parameters": {"Subject": "a girl"}},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"

    r2 = client.get("/api/materials/toiv/character-continuity-lock/install-info")
    assert r2.status_code == 400
    assert r2.json()["detail"]["code"] == "version_required"


def test_render_ok(client: TestClient):
    r = client.post(
        "/api/materials/toiv/anime-medium-prefix/render",
        params={"version": "1.0.0"},
        json={"parameters": {"Subject": "Carolyn"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Carolyn" in body["rendered"]
    assert "[Subject]" not in body["rendered"]
    assert body["fenced"] is True
    assert body["sha256"]


def test_install_info_skill_ok_prompt_404(client: TestClient):
    r = client.get(
        "/api/materials/toiv/character-continuity-lock/install-info",
        params={"version": "0.1.0"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["sha256"]
    assert r.json()["files"]

    r2 = client.get(
        "/api/materials/toiv/anime-medium-prefix/install-info",
        params={"version": "1.0.0"},
    )
    assert r2.status_code == 404
    assert r2.json()["detail"]["code"] == "public_published_skill_required"


def test_no_implicit_latest_production_paths(client: TestClient):
    """契约：生产读路径在缺 version 时必须 400，不得回落 catalog.latest_version。"""
    latest = store.catalog_latest_version("toiv/anime-medium-prefix")
    assert latest  # 展示字段存在
    for path in (
        "/api/materials/toiv/anime-medium-prefix",
        "/api/materials/toiv/anime-medium-prefix/files?path=SKILL.md",
        "/api/materials/toiv/anime-medium-prefix/install-info",
    ):
        r = client.get(path)
        assert r.status_code == 400, path
        assert r.json()["detail"]["code"] == "version_required", path
