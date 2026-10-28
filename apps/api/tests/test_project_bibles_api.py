"""P0-2 ProjectBible API 错误码契约测（内存仓 + 黄潜夹具）。

覆盖：
- ingest 缺 version → 400
- ingest 黄潜 raw 钉 sha256
- GET 无 version → working_copy
- freeze 后 PATCH → 409 bible_frozen
- blob / 历史读拒绝 version=latest
- latest_version 仅展示
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.models import User
from app.routes import project_bibles
from app.services import project_bible_store as store

FIXTURE = Path(__file__).parent / "fixtures" / "ProjectBible_yellow_submarine_4B.0.0.json"
PIN_SHA = "e19a0b4c5442e888701dcd7e780aca9b657b1d3d08ce7b24cd12cf0af28f3fa0"


@pytest.fixture()
def client():
    store.reset()
    app = FastAPI()
    app.include_router(project_bibles.router, prefix="/api")
    fake = User(
        id="u-bible-1",
        email="bible@toiv.ai",
        hashed_password="x",
        tenant_id="t-bible",
    )
    app.dependency_overrides[get_current_user] = lambda: fake
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    store.reset()


def _load_fixture() -> tuple[dict, str]:
    raw = FIXTURE.read_text(encoding="utf-8")
    return json.loads(raw), raw


def test_ingest_missing_version_400(client: TestClient):
    r = client.post(
        "/api/project-bibles/ingest",
        json={"document": {"id": "x", "title": "t", "facts": []}},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"


def test_ingest_pilot_fixture_sha256(client: TestClient):
    doc, raw = _load_fixture()
    r = client.post(
        "/api/project-bibles/ingest",
        json={
            "document": doc,
            "expected_sha256": PIN_SHA,
            "pin_version": "4B.0.0",
            "raw_text": raw,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["version"] == "4B.0.0"
    assert body["sha256"] == PIN_SHA
    assert body["bible"]["id"] == "yellow-submarine-premonition"
    assert body["bible"]["status"] == "pilot_unfrozen"
    assert body["bible"]["latest_version"] == "4B.0.0"  # 展示


def test_ingest_sha256_mismatch(client: TestClient):
    doc, raw = _load_fixture()
    r = client.post(
        "/api/project-bibles/ingest",
        json={
            "document": doc,
            "expected_sha256": "0" * 64,
            "pin_version": "4B.0.0",
            "raw_text": raw,
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sha256_mismatch"


def test_get_working_copy_without_version(client: TestClient):
    doc, raw = _load_fixture()
    assert client.post(
        "/api/project-bibles/ingest",
        json={"document": doc, "expected_sha256": PIN_SHA, "raw_text": raw},
    ).status_code == 201

    r = client.get("/api/project-bibles/yellow-submarine-premonition")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "working_copy"
    assert body["document"]["version"] == "4B.0.0"
    assert body["bible"]["latest_version"] == "4B.0.0"


def test_get_version_latest_rejected(client: TestClient):
    doc, raw = _load_fixture()
    client.post(
        "/api/project-bibles/ingest",
        json={"document": doc, "expected_sha256": PIN_SHA, "raw_text": raw},
    )
    r = client.get(
        "/api/project-bibles/yellow-submarine-premonition",
        params={"version": "latest"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"


def test_freeze_then_patch_rejected(client: TestClient):
    doc, raw = _load_fixture()
    client.post(
        "/api/project-bibles/ingest",
        json={"document": doc, "expected_sha256": PIN_SHA, "raw_text": raw},
    )
    fr = client.post("/api/project-bibles/yellow-submarine-premonition/freeze")
    assert fr.status_code == 200, fr.text
    assert fr.json()["status"] == "frozen"
    assert fr.json()["sha256"]

    # frozen 后工作副本仍可读
    g = client.get("/api/project-bibles/yellow-submarine-premonition")
    assert g.status_code == 200, g.text
    assert g.json()["bible"]["status"] == "frozen"

    p = client.patch(
        "/api/project-bibles/yellow-submarine-premonition",
        json={"style_prefix": "CHANGED"},
    )
    assert p.status_code == 409
    assert p.json()["detail"]["code"] == "bible_frozen"


def test_blob_requires_version(client: TestClient):
    doc, raw = _load_fixture()
    client.post(
        "/api/project-bibles/ingest",
        json={"document": doc, "expected_sha256": PIN_SHA, "raw_text": raw},
    )
    r = client.get("/api/project-bibles/yellow-submarine-premonition/blob")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "version_required"

    r2 = client.get(
        "/api/project-bibles/yellow-submarine-premonition/blob",
        params={"version": "latest"},
    )
    assert r2.status_code == 400
    assert r2.json()["detail"]["code"] == "version_required"

    r3 = client.get(
        "/api/project-bibles/yellow-submarine-premonition/blob",
        params={"version": "4B.0.0"},
    )
    assert r3.status_code == 200, r3.text
    assert r3.json()["sha256"] == PIN_SHA


def test_fork_after_freeze(client: TestClient):
    doc, raw = _load_fixture()
    client.post(
        "/api/project-bibles/ingest",
        json={"document": doc, "expected_sha256": PIN_SHA, "raw_text": raw},
    )
    client.post("/api/project-bibles/yellow-submarine-premonition/freeze")
    r = client.post(
        "/api/project-bibles/yellow-submarine-premonition/versions",
        json={"base_version": "4B.0.0", "new_version": "4B.0.1", "note": "patch facts"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["version"] == "4B.0.1"
    assert r.json()["bible"]["status"] == "pilot_unfrozen"

    # 新版可 patch
    p = client.patch(
        "/api/project-bibles/yellow-submarine-premonition",
        json={"style_prefix": "2D theatrical anime, revised"},
    )
    assert p.status_code == 200, p.text


def test_list_exposes_latest_display_only(client: TestClient):
    doc, raw = _load_fixture()
    client.post(
        "/api/project-bibles/ingest",
        json={"document": doc, "expected_sha256": PIN_SHA, "raw_text": raw},
    )
    r = client.get("/api/project-bibles")
    assert r.status_code == 200
    items = r.json()["items"]
    assert items
    assert items[0]["latest_version"] == "4B.0.0"
    assert items[0]["current_version"] == "4B.0.0"
