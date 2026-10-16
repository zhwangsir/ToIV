"""scene_asset 场景一致性 v0(FU1)测试:dramaclaw 设计采纳。

覆盖:
  · 基础场景 CRUD + 变体派生(变体不能再派生)
  · prompt 组装器:环境+变体增量+时段板;派生场景组合非空
  · 锚点冻结:master/reverse/selected;缺图 422;非法 anchor 422
  · 分镜绑定:scene_ref 写进 scene_layout JSON(零 schema 变更);prompt 幂等注入
  · 删除级联:变体级联删+分镜 scene_ref 就地解绑
  · 孤儿变体透出与归属校验
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import DramaProject, DramaShot, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="d")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="d@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
        tenant2 = Tenant(name="d2")
        s.add(tenant2)
        s.commit()
        s.refresh(tenant2)
        user2 = User(email="d2@toiv.ai", hashed_password=hash_password("p"), tenant_id=tenant2.id)
        s.add(user2)
        s.commit()
        s.refresh(user2)
        uid2 = user2.id
    yield TestClient(app), create_token(uid), create_token(uid2)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client, tok, title="场景一致性") -> str:
    return client.post("/api/drama/projects", headers=_h(tok), json={"title": title}).json()["id"]


def _mk_shot(client, tok, pid: str, prompt="雨夜巷口, 霓虹灯", scene="巷口") -> str:
    # 直接走 storyboard 拆解要 LLM;改用 SVML 导入建镜(确定性)
    script = f"[scene:{scene}]\n<林夏> 走。"
    r = client.post(f"/api/drama/projects/{pid}/import-svml", headers=_h(tok), json={"script": script})
    assert r.status_code == 200, r.text
    return r.json()["shots"][0]["id"]


def test_scene_crud_and_variant(ctx):
    client, tok, _ = ctx
    pid = _mk_project(client, tok)
    # 建基础场景
    r = client.post(
        f"/api/drama/projects/{pid}/scenes",
        headers=_h(tok),
        json={"name": "雨夜巷口", "environment_prompt": "narrow rainy alley, neon signs, wet asphalt",
              "time_of_day": "night", "master_ref": "/api/drama/output/master.png",
              "reverse_ref": "/api/drama/output/reverse.png"},
    )
    assert r.status_code == 200, r.text
    scene = r.json()["scene"]
    assert scene["is_variant"] is False
    assert "night scene" in scene["composed_prompt"]
    # 非法时段 422
    assert client.post(
        f"/api/drama/projects/{pid}/scenes", headers=_h(tok), json={"name": "x", "time_of_day": "noonish"}
    ).status_code == 422
    # 派生变体(清晨版)
    r2 = client.post(
        f"/api/drama/scenes/{scene['id']}/variants",
        headers=_h(tok),
        json={"variant_prompt": "police tape across the alley", "time_of_day": "dawn"},
    )
    assert r2.status_code == 200, r2.text
    variant = r2.json()["scene"]
    assert variant["is_variant"] is True
    assert variant["environment_prompt"] == ""  # 环境继承基础(存取在基础行)
    # 组合提示词:变体增量+时段板(环境取基础行的在 list 接口由 base 呈现,
    # 变体自身 composed 只拼自己的增量+时段——环境词由 attach 时取基础)
    assert "police tape" in variant["composed_prompt"]
    assert "dawn" in variant["composed_prompt"] or "dawn light" in variant["composed_prompt"]
    # 变体不能再派生
    assert client.post(
        f"/api/drama/scenes/{variant['id']}/variants", headers=_h(tok), json={"variant_prompt": "x"}
    ).status_code == 422
    # 清单:基础带 variants,composed 齐全
    lst = client.get(f"/api/drama/projects/{pid}/scenes", headers=_h(tok)).json()
    assert len(lst["scenes"]) == 1
    assert lst["scenes"][0]["variants"][0]["id"] == variant["id"]
    assert "master.png" in lst["scenes"][0]["master_ref"]


def test_freeze_anchor_and_attach(ctx, monkeypatch):
    import app.routes.drama_scenes as ds

    monkeypatch.setattr(ds, "_read_image_bytes", lambda url: f"bytes:{url}".encode())
    client, tok, _ = ctx
    pid = _mk_project(client, tok)
    sid_scene = client.post(
        f"/api/drama/projects/{pid}/scenes",
        headers=_h(tok),
        json={"name": "巷口", "master_ref": "/api/drama/output/m.png", "reverse_ref": "/api/drama/output/r.png"},
    ).json()["scene"]["id"]
    shot_id = _mk_shot(client, tok, pid)
    # 未设参考前 selected 冻结缺图 422
    assert client.post(
        f"/api/drama/scenes/{sid_scene}/freeze-anchor", headers=_h(tok), json={"anchor_id": "selected"}
    ).status_code == 422
    # master 冻结(用场景 master_ref)
    r = client.post(
        f"/api/drama/scenes/{sid_scene}/freeze-anchor", headers=_h(tok), json={"anchor_id": "master"}
    )
    assert r.status_code == 200, r.text
    frozen = r.json()["scene"]["frozen_anchor"]
    assert frozen["anchor_id"] == "master" and "m.png" in frozen["image_url"]
    # 非法锚点 422
    assert client.post(
        f"/api/drama/scenes/{sid_scene}/freeze-anchor", headers=_h(tok), json={"anchor_id": "weird"}
    ).status_code == 422
    # 绑定分镜:scene_ref 进 scene_layout,环境词注入 prompt
    r2 = client.post(
        f"/api/drama/scenes/{sid_scene}/attach",
        headers=_h(tok),
        json={"shot_id": shot_id, "use_frozen": True},
    )
    assert r2.status_code == 200, r2.text
    data = r2.json()
    assert data["scene_ref"]["anchor_id"] == "master"
    # P4:绑定的是不可变内容寻址快照(非原图 URL),原图仅存 frozen.image_url 作溯源
    assert "scene_anchor_" in data["anchor_image"]
    assert data["scene_ref"]["anchor_sha256"]
    assert data["prompt_injected"] is False  # 组合词为空(环境未填)则不注入
    # 再验证注入与幂等:给场景补环境词后重绑
    client.patch(
        f"/api/drama/scenes/{sid_scene}",
        headers=_h(tok),
        json={"environment_prompt": "narrow alley, neon signs"},
    )
    r3 = client.post(
        f"/api/drama/scenes/{sid_scene}/attach", headers=_h(tok), json={"shot_id": shot_id}
    )
    body = r3.json()
    assert body["prompt_injected"] is True
    assert body["prompt"].startswith("narrow alley, neon signs")
    r4 = client.post(
        f"/api/drama/scenes/{sid_scene}/attach", headers=_h(tok), json={"shot_id": shot_id}
    )
    assert r4.json()["prompt_injected"] is False  # 幂等:已包含不重复注入
    # 读回
    rd = client.get(f"/api/drama/shots/{shot_id}/scene-ref", headers=_h(tok)).json()
    assert rd["scene_ref"]["scene_id"] == sid_scene
    assert rd["scene"]["name"] == "巷口"
    # scene_ref 结构合法(经 API 读回校验)
    assert rd["scene_ref"]["anchor_image"].startswith("/api/studio/files/scene_anchor_")


def test_delete_cascades_and_detaches(ctx):
    client, tok, tok2 = ctx
    pid = _mk_project(client, tok)
    scene = client.post(
        f"/api/drama/projects/{pid}/scenes",
        headers=_h(tok),
        json={"name": "天台", "environment_prompt": "rooftop, water tanks", "master_ref": "/x/m.png"},
    ).json()["scene"]
    variant = client.post(
        f"/api/drama/scenes/{scene['id']}/variants",
        headers=_h(tok),
        json={"variant_prompt": "rain", "time_of_day": "night"},
    ).json()["scene"]
    shot_id = _mk_shot(client, tok, pid)
    r_attach = client.post(
        f"/api/drama/scenes/{variant['id']}/attach",
        headers=_h(tok),
        json={"shot_id": shot_id, "use_frozen": False},
    )
    assert r_attach.status_code == 200, r_attach.text
    # 他人删除 → 404
    assert client.delete(f"/api/drama/scenes/{scene['id']}", headers=_h(tok2)).status_code == 404
    # 删除基础场景:级联变体+解绑分镜
    r = client.delete(f"/api/drama/scenes/{scene['id']}", headers=_h(tok))
    assert r.status_code == 200
    assert r.json() == {"deleted": 2, "variants": 1, "shots_detached": 1}
    rd = client.get(f"/api/drama/shots/{shot_id}/scene-ref", headers=_h(tok)).json()
    assert rd["scene_ref"] is None and rd["scene"] is None
    lst = client.get(f"/api/drama/projects/{pid}/scenes", headers=_h(tok)).json()
    assert lst["scenes"] == [] and lst["orphans"] == []


def test_attach_cross_project_rejected(ctx):
    client, tok, _ = ctx
    pid1 = _mk_project(client, tok, "P1")
    pid2 = _mk_project(client, tok, "P2")
    scene = client.post(
        f"/api/drama/projects/{pid1}/scenes", headers=_h(tok), json={"name": "A"}
    ).json()["scene"]
    shot2 = _mk_shot(client, tok, pid2)
    r = client.post(
        f"/api/drama/scenes/{scene['id']}/attach", headers=_h(tok), json={"shot_id": shot2}
    )
    assert r.status_code == 422
