"""P4(2026-10-16):场景锚点冻结=不可变字节快照;scene_asset 接通 Studio 用户链路。

设计来源 dramaclaw(Elastic-2.0,设计采纳未抄码;NOTICE 见 third_party/licenses/)。
覆盖:快照内容寻址/重复冻结不改旧绑定/StudioShot scene_ref 落库/渲染参考注入/跨用户拒绝。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import DramaProject, DramaShot, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="t1"); s.add(tenant); s.commit(); s.refresh(tenant)
        tenant2 = Tenant(name="t2"); s.add(tenant2); s.commit(); s.refresh(tenant2)
        s.add(User(id="u1", email="a@t.iv", hashed_password=hash_password("x"), tenant_id=tenant.id, role="user"))
        # u2=异租户(Studio 域归属按租户校验,同租户成员可协作)
        s.add(User(id="u2", email="b@t.iv", hashed_password=hash_password("x"), tenant_id=tenant2.id, role="user"))
        s.commit()
        dp = DramaProject(tenant_id=tenant.id, user_id="u1", title="d", script="s")
        s.add(dp); s.commit(); s.refresh(dp)
        dshot = DramaShot(project_id=dp.id, idx=0, prompt="x", dialogue="", speaker="")
        s.add(dshot); s.commit(); s.refresh(dshot)
        sp = StudioProject(tenant_id=tenant.id, user_id="u1", title="st", premise="p")
        s.add(sp); s.commit(); s.refresh(sp)
        sshot = StudioShot(project_id=sp.id, idx=0, scene="x", prompt="x", render_mode="video")
        s.add(sshot); s.commit(); s.refresh(sshot)
        ids = {
            "dp": dp.id, "dshot": dshot.id, "sp": sp.id, "sshot": sshot.id,
            "h": {"Authorization": "Bearer " + create_token("u1")},
            "h2": {"Authorization": "Bearer " + create_token("u2")},
        }
    yield TestClient(app), ids
    app.dependency_overrides.clear()


def _fake_bytes(monkeypatch, payload: bytes):
    import app.routes.drama_scenes as ds

    monkeypatch.setattr(ds, "_read_image_bytes", lambda url: payload)


def test_freeze_writes_content_addressed_snapshot(ctx, monkeypatch):
    client, ids = ctx
    _fake_bytes(monkeypatch, b"anchor-bytes-1")
    r = client.post(f"/api/drama/projects/{ids['dp']}/scenes", headers=ids["h"],
                    json={"name": "雨巷", "environment_prompt": "rainy alley", "master_ref": "m.png"})
    assert r.status_code == 200, r.text
    sid = r.json()["scene"]["id"]
    r = client.post(f"/api/drama/scenes/{sid}/freeze-anchor", headers=ids["h"],
                    json={"anchor_id": "master"})
    assert r.status_code == 200, r.text
    frozen = r.json()["scene"]["frozen_anchor"]
    assert frozen["sha256"], frozen
    assert frozen["snapshot_url"].startswith("/api/studio/files/scene_anchor_"), frozen
    assert frozen["image_url"] == "m.png"  # 原图保留作溯源


def test_refreeze_never_mutates_old_binding(ctx, monkeypatch):
    client, ids = ctx
    _fake_bytes(monkeypatch, b"anchor-bytes-1")
    r = client.post(f"/api/drama/projects/{ids['dp']}/scenes", headers=ids["h"],
                    json={"name": "雨巷", "environment_prompt": "rainy alley", "master_ref": "m.png"})
    sid = r.json()["scene"]["id"]
    r = client.post(f"/api/drama/scenes/{sid}/freeze-anchor", headers=ids["h"], json={"anchor_id": "master"})
    snap1 = r.json()["scene"]["frozen_anchor"]["snapshot_url"]
    r = client.post(f"/api/drama/scenes/{sid}/attach", headers=ids["h"],
                    json={"shot_id": ids["dshot"], "use_frozen": True})
    assert r.status_code == 200, r.text
    assert r.json()["anchor_image"] == snap1

    _fake_bytes(monkeypatch, b"anchor-bytes-TOTALLY-DIFFERENT")
    r = client.post(f"/api/drama/scenes/{sid}/freeze-anchor", headers=ids["h"],
                    json={"anchor_id": "selected", "image_url": "other.png"})
    assert r.status_code == 200, r.text
    snap2 = r.json()["scene"]["frozen_anchor"]["snapshot_url"]
    assert snap2 != snap1  # 二次冻结=新快照,非覆盖

    r = client.get(f"/api/drama/shots/{ids['dshot']}/scene-ref", headers=ids["h"])
    assert r.json()["scene_ref"]["anchor_image"] == snap1  # 旧绑定不漂移
    assert r.json()["scene_ref"]["anchor_sha256"]


def test_attach_writes_studio_shot_and_render_consumes_anchor(ctx, monkeypatch):
    client, ids = ctx
    _fake_bytes(monkeypatch, b"studio-anchor")
    # Studio 项目下建场景(FK 放开后 registry 与唯一宿主 StudioProject 对齐)
    r = client.post(f"/api/drama/projects/{ids['sp']}/scenes", headers=ids["h"],
                    json={"name": "天台", "environment_prompt": "rooftop dusk", "master_ref": "m.png"})
    assert r.status_code == 200, r.text
    sid = r.json()["scene"]["id"]
    r = client.post(f"/api/drama/scenes/{sid}/freeze-anchor", headers=ids["h"], json={"anchor_id": "master"})
    snap = r.json()["scene"]["frozen_anchor"]["snapshot_url"]
    r = client.post(f"/api/drama/scenes/{sid}/attach", headers=ids["h"],
                    json={"shot_id": ids["sshot"], "use_frozen": True})
    assert r.status_code == 200, r.text
    assert r.json()["anchor_image"] == snap

    r = client.get(f"/api/drama/shots/{ids['sshot']}/scene-ref", headers=ids["h"])
    assert r.status_code == 200, r.text
    assert r.json()["scene_ref"]["anchor_image"] == snap

    # 渲染消费:场景参考注入把锚点图排在最前
    from app.services.studio.shot_refs import scene_images_with_anchor

    with Session(_engine_of(client)) as s:
        shot = s.get(StudioShot, ids["sshot"])
        merged = scene_images_with_anchor(["proj_a.png", "proj_b.png"], shot)
    assert merged[0] == snap
    assert merged[1:] == ["proj_a.png", "proj_b.png"]
    # 幂等:锚点已在列表时不重复注入
    assert scene_images_with_anchor(merged, shot) == merged


def _engine_of(client):
    from sqlmodel import Session as _S  # noqa: F401
    # TestClient fixture 的 engine 由依赖覆盖持有;这里复用全局覆盖拿同一库
    gen = app.dependency_overrides[get_session]()
    session = next(gen)
    return session.get_bind()


def test_attach_foreign_user_denied(ctx, monkeypatch):
    client, ids = ctx
    _fake_bytes(monkeypatch, b"x")
    r = client.post(f"/api/drama/projects/{ids['sp']}/scenes", headers=ids["h"],
                    json={"name": "天台", "environment_prompt": "x", "master_ref": "m.png"})
    sid = r.json()["scene"]["id"]
    client.post(f"/api/drama/scenes/{sid}/freeze-anchor", headers=ids["h"], json={"anchor_id": "master"})
    r = client.post(f"/api/drama/scenes/{sid}/attach", headers=ids["h2"],
                    json={"shot_id": ids["sshot"], "use_frozen": True})
    assert r.status_code == 404
    r = client.post(f"/api/drama/scenes/{sid}/freeze-anchor", headers=ids["h2"], json={"anchor_id": "master"})
    assert r.status_code == 404
