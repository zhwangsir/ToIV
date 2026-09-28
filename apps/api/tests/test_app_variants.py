"""应用内「模式 / 示例」(2026-09-29):隐藏的模式目标可详情/运行但不进市场列表。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.services import app_variants
from tests.test_app_curation import _make_user, _seed_app


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    data = {
        "keep": {
            "modes": [
                {"label": "极速版", "desc": "更快", "app_id": "fast"},
                {"label": "R18", "desc": "", "app_id": "nsfw-mode"},
            ],
            "presets": [{"label": "3D卡通", "values": {"prompt": "3D卡通风格"}}],
        },
        "gone": {"modes": [{"label": "x", "app_id": "orphan"}], "presets": []},
    }
    p = tmp_path / "app_variants.json"
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(app_variants, "_PATH", p)
    monkeypatch.setitem(app_variants._cache, "mtime", None)

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        uid = _make_user(s, "bob@toiv.ai")
        _seed_app(s, "keep")
        _seed_app(s, "fast", is_public=False)
        _seed_app(s, "nsfw-mode", is_public=False, is_nsfw=True)
        _seed_app(s, "gone", is_public=False)
        _seed_app(s, "orphan", is_public=False)
        _seed_app(s, "plain-hidden", is_public=False)
    from app.security import create_token

    yield TestClient(app), {"Authorization": f"Bearer {create_token(uid)}"}
    app.dependency_overrides.clear()


def test_variants_for_keeper_and_mode(ctx):
    c, h = ctx
    r = c.get("/api/apps/keep/variants", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["keeper_id"] == "keep"
    assert [m["app_id"] for m in body["modes"]] == ["fast"]  # NSFW 目标对普通上下文不下发
    assert body["presets"][0]["values"] == {"prompt": "3D卡通风格"}
    r2 = c.get("/api/apps/fast/variants", headers=h)
    assert r2.json()["keeper_id"] == "keep"


def test_hidden_mode_target_detail_ok_but_not_listed(ctx):
    c, h = ctx
    assert c.get("/api/apps/fast", headers=h).status_code == 200
    assert c.get("/api/apps/plain-hidden", headers=h).status_code == 404
    # 代表卡本身已隐藏 → 其模式目标不放行
    assert c.get("/api/apps/orphan", headers=h).status_code == 404
    ids = {a["id"] for a in c.get("/api/apps", headers=h).json()}
    assert "keep" in ids and "fast" not in ids


def test_no_variants_returns_empty(ctx):
    c, h = ctx
    _ = c.get("/api/apps/keep", headers=h)
    r = c.get("/api/apps/plain-hidden/variants", headers=h)
    assert r.status_code == 404
