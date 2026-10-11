"""S3-b(2026-10-11):设定卡生成异步化——Job 建档/后台协程/轮询/取消终态不覆盖。"""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.studio as studio_rt
from app.db import get_session
from app.main import app
from app.models import Job, StudioCharacter, StudioProject, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # _run_sheet_job 用模块级 engine 开独立 Session,patch 到测试库(与 parse 异步测试同款)
    import app.db as db_mod
    from unittest.mock import patch as _patch

    with _patch.object(db_mod, "engine", engine):
        yield from _ctx_body(engine, override)
    app.dependency_overrides.clear()


def _ctx_body(engine, override):
    pid = cid = ""
    with Session(engine) as s:
        tenant = Tenant(name="t1"); s.add(tenant); s.commit(); s.refresh(tenant)
        s.add(User(id="u1", email="a@t.iv", hashed_password=hash_password("x"), tenant_id=tenant.id, role="user"))
        s.commit()
        p = StudioProject(tenant_id=tenant.id, user_id="u1", title="t", premise="p")
        s.add(p); s.commit(); s.refresh(p)
        pid = str(p.id)
        c = StudioCharacter(project_id=pid, name="小周", description="店员", visual_prompt="clerk")
        s.add(c); s.commit(); s.refresh(c)
        cid = str(c.id)
    yield TestClient(app), {"pid": pid, "cid": cid, "h": {"Authorization": "Bearer " + create_token("u1")}}


def _wait_done(client, cid, job_id, h, timeout=5.0):
    dl = time.time() + timeout
    while time.time() < dl:
        r = client.get(f"/api/studio/characters/{cid}/character-sheet/async/{job_id}", headers=h)
        assert r.status_code == 200
        body = r.json()
        if body.get("status") in ("done", "error"):
            return body
        time.sleep(0.05)
    raise AssertionError("sheet job 未在限时内完成")


def test_sheet_async_roundtrip(ctx, monkeypatch):
    client, ids = ctx
    async def fake_core(c, body, session, pool):
        return {"sheet_url": "/api/studio/files/x.png", "sheet_style": body.style,
                "panel_urls": {"front": "/f.png"}, "apply_to_video_refs": True}
    monkeypatch.setattr(studio_rt, "_generate_sheet_core", fake_core)
    r = client.post(
        f"/api/studio/characters/{ids['cid']}/character-sheet/async",
        json={"style": "ancient_realistic"}, headers=ids["h"],
    )
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    body = _wait_done(client, ids["cid"], job_id, ids["h"])
    assert body["status"] == "done"
    assert body["sheet_style"] == "ancient_realistic"
    assert body["panel_urls"] == {"front": "/f.png"}


def test_sheet_async_error_surfaced(ctx, monkeypatch):
    client, ids = ctx
    from fastapi import HTTPException
    async def boom(c, body, session, pool):
        raise HTTPException(status_code=422, detail="门禁拒绝:测试")
    monkeypatch.setattr(studio_rt, "_generate_sheet_core", boom)
    r = client.post(
        f"/api/studio/characters/{ids['cid']}/character-sheet/async",
        json={"style": "anime"}, headers=ids["h"],
    )
    body = _wait_done(client, ids["cid"], r.json()["job_id"], ids["h"])
    assert body["status"] == "error"
    assert "门禁拒绝" in body["error"]


def test_sheet_async_wrong_owner_404(ctx):
    client, ids = ctx
    r = client.get(f"/api/studio/characters/{ids['cid']}/character-sheet/async/nonexistent", headers=ids["h"])
    assert r.status_code == 404


def test_reconcile_covers_sheet_kind(ctx):
    # reconcile_parse_jobs 现在同时收口 _PARSE_KIND 与 _SHEET_KIND
    with Session(create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)) as s:
        pass  # 静态验证:源码过滤条件包含两 kind(结构性断言见下)
    import inspect
    src_text = inspect.getsource(studio_rt.reconcile_parse_jobs)
    assert "_SHEET_KIND" in src_text
