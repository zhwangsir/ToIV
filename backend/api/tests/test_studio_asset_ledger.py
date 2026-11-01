"""跨集资产对账台账(P0-1):只读聚合 + 幂等 apply。

验收口径(spec §B3):
- ≥2 集(同租户项目)能看到逐集资产版本清单、漂移点与确定性建议;
- apply 以 receipt_id 幂等,重放不改写后来编辑;
- 漂移可定位到镜头(shot_id)。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import Entity, StudioCharacter, StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    ids: dict = {}
    with Session(engine) as s:
        t = Tenant(name="ledger"); s.add(t); s.commit(); s.refresh(t)
        s.add(User(id="u1", email="l1@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.add(User(id="u2", email="l2@t.iv", hashed_password=hash_password("x"), tenant_id=t.id))
        s.commit()
        p1 = StudioProject(tenant_id=t.id, user_id="u1", title="第一集")
        p2 = StudioProject(tenant_id=t.id, user_id="u1", title="第二集")
        p3 = StudioProject(tenant_id=t.id, user_id="u2", title="别人的集")
        s.add(p1); s.add(p2); s.add(p3); s.commit()
        for p in (p1, p2, p3):
            s.refresh(p)
        ids.update(p1=str(p1.id), p2=str(p2.id), p3=str(p3.id))

        def char(pid: str, name: str, refs: list[str], prompt: str = "") -> StudioCharacter:
            c = StudioCharacter(project_id=pid, name=name, visual_prompt=prompt,
                                reference_images=json.dumps(refs, ensure_ascii=False))
            s.add(c); s.commit(); s.refresh(c)
            return c

        ids["c_lin_p1"] = str(char(ids["p1"], "林夏", ["/r/p1a.png", "/r/p1b.png"], "lin xia").id)
        ids["c_qi_p1"] = str(char(ids["p1"], "阿七", []).id)
        char(ids["p2"], "林夏", ["/r/canon.png"], "lin xia")
        char(ids["p2"], "韩霜", ["/r/han.png"])
        char(ids["p3"], "林夏", ["/r/other.png"])

        e = Entity(tenant_id=t.id, user_id="u1", kind="character", name="林夏",
                   description="女主", prompt_hint="lin xia", ref_image="/r/canon.png")
        s.add(e); s.commit(); s.refresh(e)
        ids["e_lin"] = str(e.id)
        scene = Entity(tenant_id=t.id, user_id="u1", kind="scene", name="便利店",
                       ref_image="/r/store.png")
        prop = Entity(tenant_id=t.id, user_id="u1", kind="prop", name="雨伞")
        s.add(scene); s.add(prop); s.commit(); s.refresh(scene); s.refresh(prop)
        ids["e_scene"] = str(scene.id)
        ids["e_prop"] = str(prop.id)

        s1 = StudioShot(project_id=ids["p1"], idx=0, scene="便利店", prompt="推门而入", duration_sec=6,
                        characters=json.dumps(["林夏"], ensure_ascii=False),
                        ref_images_json=json.dumps(["/r/p1a.png"]),
                        ref_epoch=0,
                        scene_ref_json=json.dumps({"scene_id": "sc1", "anchor_id": "a1",
                                                   "anchor_image": "/r/a.png", "anchor_sha256": "deadbeef"}))
        s2 = StudioShot(project_id=ids["p1"], idx=1, scene="便利店", prompt="雨夜 雨伞 特写", duration_sec=4,
                        characters=json.dumps(["林夏"], ensure_ascii=False),
                        ref_images_json=json.dumps(["/r/p1b.png"]),
                        ref_epoch=1)
        s.add(s1); s.add(s2); s.commit(); s.refresh(s1); s.refresh(s2)
        ids.update(s1=str(s1.id), s2=str(s2.id))
    yield TestClient(app), ids, {"Authorization": "Bearer " + create_token("u1")}, engine
    app.dependency_overrides.clear()


def _ledger(client, ids, headers) -> dict:
    r = client.get(f"/api/studio/projects/{ids['p1']}/asset-ledger", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_ledger_lists_episodes_assets_shots_and_drifts(ctx):
    client, ids, h, _ = ctx
    data = _ledger(client, ids, h)

    assert data["project_id"] == ids["p1"] and data["project_title"] == "第一集"
    episodes = {e["project_id"]: e for e in data["episodes"]}
    assert set(episodes) == {ids["p1"], ids["p2"]}  # 别人的集不出现
    assert episodes[ids["p1"]]["is_current"] is True
    assert episodes[ids["p2"]]["is_current"] is False
    assert {c["name"] for c in episodes[ids["p1"]]["characters"]} == {"林夏", "阿七"}

    assets = {a["key"]: a for a in data["assets"]}
    lin = assets["character:林夏"]
    assert lin["status"] == "outdated" and lin["canonical_entity_id"] == ids["e_lin"]
    assert {e["project_id"] for e in lin["episodes"]} == {ids["p1"], ids["p2"]}
    by_episode = {e["project_id"]: e for e in lin["episodes"]}
    assert by_episode[ids["p1"]]["matches_canonical"] is False
    assert by_episode[ids["p2"]]["matches_canonical"] is True
    assert assets["character:阿七"]["status"] == "local_only"
    assert assets["character:韩霜"]["status"] == "local_only"
    assert assets["scene:便利店"]["used_in_shot_ids"] == [ids["s1"], ids["s2"]]
    assert assets["prop:雨伞"]["used_in_shot_ids"] == [ids["s2"]]

    assert [s["shot_id"] for s in data["shots"]] == [ids["s1"], ids["s2"]]
    assert data["shots"][0]["characters"] == [{"name": "林夏", "ref_epoch": 0, "ref_count": 1}]
    assert data["shots"][1]["characters"][0]["ref_epoch"] == 1
    assert data["shots"][0]["scene_anchor"]["anchor_id"] == "a1"
    assert set(data["shots"][0]["media"]) == {"visual", "audio", "final"}

    codes = {d["code"] for d in data["drifts"]}
    assert {"ASSET_MULTI_VERSION", "ASSET_LOCAL_ONLY", "ASSET_MISSING_REFERENCE", "SHOT_REF_EPOCH_SWITCH"} <= codes
    missing = next(d for d in data["drifts"] if d["code"] == "ASSET_MISSING_REFERENCE")
    assert "阿七" in missing["message"]
    epoch = next(d for d in data["drifts"] if d["code"] == "SHOT_REF_EPOCH_SWITCH")
    assert epoch["asset_key"] == "character:林夏" and epoch["severity"] == "info"

    suggestions = {s["asset_key"]: s for s in data["suggestions"]}
    assert suggestions["character:林夏"]["action"] == "merge"
    assert suggestions["character:林夏"]["entity_id"] == ids["e_lin"]
    assert suggestions["character:林夏"]["confidence"] == 1.0
    assert suggestions["character:阿七"]["action"] == "create"
    assert data["receipts"] == []


def test_apply_merge_fills_canon_and_replay_is_idempotent(ctx):
    client, ids, h, engine = ctx
    body = {"receipt_id": "receipt-merge-1", "action": "merge",
            "asset_key": "character:林夏", "entity_id": ids["e_lin"]}
    r = client.post(f"/api/studio/projects/{ids['p1']}/asset-ledger/apply", json=body, headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["applied"] is True and out["replayed"] is False
    assert out["entity"]["id"] == ids["e_lin"]
    with Session(engine) as s:
        e = s.get(Entity, ids["e_lin"])
        assert e.ref_image == "/r/canon.png"  # 已有槽位不被覆盖
        assert e.reference_front == "/r/p1a.png"
        assert e.reference_side == "/r/p1b.png"

    replay = client.post(f"/api/studio/projects/{ids['p1']}/asset-ledger/apply",
                         json={**body, "action": "create"}, headers=h)
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True and replay.json()["receipt"]["action"] == "merge"
    with Session(engine) as s:
        assert len(s.exec(select(Entity)).all()) == 3  # 重放不新建

    after = _ledger(client, ids, h)
    lin = next(a for a in after["assets"] if a["key"] == "character:林夏")
    assert lin["status"] == "synced"
    assert [r["receipt_id"] for r in after["receipts"]] == ["receipt-merge-1"]


def test_apply_create_is_single_and_import_fills_project_character(ctx):
    client, ids, h, engine = ctx
    create = {"receipt_id": "receipt-create-1", "action": "create", "asset_key": "character:阿七"}
    r = client.post(f"/api/studio/projects/{ids['p1']}/asset-ledger/apply", json=create, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["entity"]["name"] == "阿七"
    again = client.post(f"/api/studio/projects/{ids['p1']}/asset-ledger/apply", json=create, headers=h)
    assert again.json()["replayed"] is True
    with Session(engine) as s:
        assert len(s.exec(select(Entity).where(Entity.name == "阿七")).all()) == 1

    created_id = r.json()["entity"]["id"]
    with Session(engine) as s:  # 模拟正典后来补了定妆
        e = s.get(Entity, created_id)
        e.ref_image = "/r/qi.png"
        e.reference_front = "/r/qi-front.png"
        s.add(e); s.commit()
    imported = client.post(f"/api/studio/projects/{ids['p1']}/asset-ledger/apply", headers=h,
                           json={"receipt_id": "receipt-import-1", "action": "import",
                                 "asset_key": "character:阿七", "entity_id": created_id})
    assert imported.status_code == 200
    with Session(engine) as s:
        qi = [c for c in s.exec(select(StudioCharacter)).all() if c.name == "阿七"][0]
        assert json.loads(qi.reference_images) == ["/r/qi.png", "/r/qi-front.png"]


def test_apply_guards_and_tenant_isolation(ctx):
    client, ids, h, _ = ctx
    url = f"/api/studio/projects/{ids['p1']}/asset-ledger/apply"
    assert client.post(url, headers=h, json={"receipt_id": "r-x1", "action": "merge",
                                             "asset_key": "character:林夏"}).status_code == 422
    assert client.post(url, headers=h, json={"receipt_id": "r-x2", "action": "bogus",
                                             "asset_key": "character:林夏"}).status_code == 422
    assert client.post(url, headers=h, json={"receipt_id": "r-x3", "action": "create",
                                             "asset_key": "scene:便利店"}).status_code == 422
    other = {"Authorization": "Bearer " + create_token("u2")}
    assert client.get(f"/api/studio/projects/{ids['p1']}/asset-ledger", headers=other).status_code == 404
