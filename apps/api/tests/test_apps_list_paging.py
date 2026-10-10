"""W0.2a(2026-10-11 S1):/api/apps limit/offset 实装 + X-Total-Count + 未知 query 422。

此前 limit 被静默忽略(?limit=500 实返全量 ~7MB/6731 行,画布市场全量渲染);现切片返回,
总数走 X-Total-Count;拼错/多余的查询参数显式 422,防"参数失效无人知"再次发生。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.security import create_token
from app.services import apps_list_cache
from tests.test_app_curation import _make_user, _seed_app


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        uid = _make_user(s, "bob@toiv.ai")
        for i in range(7):
            _seed_app(s, f"app-{i:02d}", name=f"app-{i:02d}", is_public=True)
        _seed_app(s, "hidden-01", name="hidden-01", is_public=False)
    apps_list_cache.bump()
    yield TestClient(app), {"Authorization": f"Bearer {create_token(uid)}"}
    app.dependency_overrides.clear()
    apps_list_cache.bump()


def test_limit_slices_and_reports_total(ctx):
    c, h = ctx
    r = c.get("/api/apps?limit=3", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 3
    assert r.headers["x-total-count"] == "7"  # 私有 hidden-01 不计入
    assert [a["name"] for a in body] == ["app-00", "app-01", "app-02"]


def test_offset_pages_through(ctx):
    c, h = ctx
    p1 = c.get("/api/apps?limit=3&offset=3", headers=h)
    assert p1.status_code == 200
    assert [a["name"] for a in p1.json()] == ["app-03", "app-04", "app-05"]
    assert p1.headers["x-total-count"] == "7"
    p2 = c.get("/api/apps?limit=3&offset=6", headers=h)
    assert [a["name"] for a in p2.json()] == ["app-06"]


def test_offset_without_limit_returns_tail(ctx):
    c, h = ctx
    r = c.get("/api/apps?offset=5", headers=h)
    assert [a["name"] for a in r.json()] == ["app-05", "app-06"]
    assert r.headers["x-total-count"] == "7"


def test_no_paging_keeps_bare_array_and_no_header(ctx):
    c, h = ctx
    r = c.get("/api/apps", headers=h)
    assert r.status_code == 200
    assert len(r.json()) == 7
    assert "x-total-count" not in r.headers


def test_unknown_query_rejected(ctx):
    c, h = ctx
    r = c.get("/api/apps?lim=1", headers=h)  # 拼错示例:旧版静默忽略
    assert r.status_code == 422
    assert "lim" in r.json()["detail"]
    r2 = c.get("/api/apps?kind=image", headers=h)
    assert r2.status_code == 422


def test_limit_bounds_validated(ctx):
    c, h = ctx
    assert c.get("/api/apps?limit=0", headers=h).status_code == 422
    assert c.get("/api/apps?limit=1001", headers=h).status_code == 422
    assert c.get("/api/apps?offset=-1", headers=h).status_code == 422


def test_cache_hit_path_slices_per_request(ctx):
    """缓存键不含 limit/offset:同过滤集不同分页命中同一全量缓存后各自切片。"""
    c, h = ctx
    a = c.get("/api/apps?limit=2", headers=h)
    b = c.get("/api/apps?limit=2&offset=2", headers=h)  # 命中上一请求的缓存
    assert [x["name"] for x in a.json()] == ["app-00", "app-01"]
    assert [x["name"] for x in b.json()] == ["app-02", "app-03"]
    assert b.headers["x-total-count"] == "7"
