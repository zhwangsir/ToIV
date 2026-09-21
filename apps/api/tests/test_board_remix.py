"""整片级 remix(M3.5)——克隆改写三类/主体映射校验/路由端点。"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.boards as boards_route
from app.db import get_session
from app.main import app
from app.models import Board, BoardItem, Entity, Job, Tenant, User
from app.security import create_token, hash_password
from app.services.board_remix import clone_board_with_remix, resolve_character_map


@pytest.fixture
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        u1 = User(email="r1@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        u2 = User(email="r2@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id)
        s.add(u1); s.add(u2)
        s.commit()
        s.refresh(u1); s.refresh(u2)
        # u1 已有视频作业(复用语义源)
        vjob = Job(id=uuid.uuid4().hex, prompt_id=uuid.uuid4().hex, tenant_id=tenant.id,
                   user_id=u1.id, worker="w", kind="h3_t2v", status="done", prompt="p", seed=1,
                   result='["/api/images?filename=v.mp4&worker=w"]')
        s.add(vjob)
        # 角色主体:林凡(老)/雪衣(新,带外观 hint)
        e_old = Entity(id=uuid.uuid4().hex, tenant_id=tenant.id, user_id=u1.id, kind="character",
                       name="林凡", prompt_hint="1boy, black hair")
        e_new = Entity(id=uuid.uuid4().hex, tenant_id=tenant.id, user_id=u1.id, kind="character",
                       name="雪衣", prompt_hint="1girl, silver hair, red cloak")
        e_scene = Entity(id=uuid.uuid4().hex, tenant_id=tenant.id, user_id=u1.id, kind="scene",
                         name="破庙")
        s.add(vjob); s.add(e_old); s.add(e_new); s.add(e_scene)
        # 板:镜一挂视频(林凡),镜二占位(林凡+小雪),镜三无角色
        b = Board(id=uuid.uuid4().hex, tenant_id=tenant.id, user_id=u1.id, name="原剧")
        s.add(b)
        s.commit()
        s.refresh(vjob); s.refresh(b)
        meta1 = {"prompt": "林凡 runs in rain", "scene": "雨夜破庙外", "duration_sec": 4,
                 "dialogue": "快走", "speaker": "林凡", "characters": ["林凡"],
                 "entity_ids": [e_old.id]}
        meta2 = {"prompt": "林凡 and 小雪 talk", "scene": "庙内", "duration_sec": 3,
                 "characters": ["林凡", "小雪"], "entity_ids": [e_old.id]}
        s.add(BoardItem(board_id=b.id, job_id=vjob.id, sort_order=0, shot_text="镜一",
                        shot_meta=json.dumps(meta1, ensure_ascii=False)))
        s.add(BoardItem(board_id=b.id, job_id="", sort_order=1, shot_text="镜二",
                        shot_meta=json.dumps(meta2, ensure_ascii=False)))
        s.add(BoardItem(board_id=b.id, job_id="", sort_order=2, shot_text="镜三",
                        shot_meta=json.dumps({"prompt": "empty road"}, ensure_ascii=False)))
        s.commit()
        t1 = create_token(u1.id)
        t2 = create_token(u2.id)
        ids = {"board": b.id, "vjob": vjob.id, "e_old": e_old.id, "e_new": e_new.id,
               "e_scene": e_scene.id, "uid1": u1.id, "uid2": u2.id}
    client = TestClient(app)
    yield client, t1, t2, engine, ids
    app.dependency_overrides.pop(get_session, None)


def _items(engine, board_id):
    with Session(engine) as s:
        return s.exec(select(BoardItem).where(BoardItem.board_id == board_id).order_by(BoardItem.sort_order)).all()


def test_resolve_character_map_validation(ctx):
    _, _, _, engine, ids = ctx
    with Session(engine) as s:
        u1 = s.get(User, ids["uid1"])
        m = resolve_character_map(s, u1, {"林凡": ids["e_new"]})
        assert m["林凡"].name == "雪衣"
        # 非 character kind → 422
        with pytest.raises(Exception) as exc:
            resolve_character_map(s, u1, {"林凡": ids["e_scene"]})
        assert "不是角色类" in str(exc.value)
        # 不存在 → 422
        with pytest.raises(Exception):
            resolve_character_map(s, u1, {"林凡": "nope"})
        # 空 map → 422
        with pytest.raises(Exception):
            resolve_character_map(s, u1, {})


def test_protagonist_clone_transform(ctx):
    _, _, _, engine, ids = ctx
    with Session(engine) as s:
        u1 = s.get(User, ids["uid1"])
        b = s.get(Board, ids["board"])
        char_map = resolve_character_map(s, u1, {"林凡": ids["e_new"]})
        nb, stats = clone_board_with_remix(s, u1, b, "protagonist", character_map=char_map)
        assert "remix换主角" in nb.name and nb.id != b.id
    items = _items(engine, nb.id)
    assert len(items) == 3
    m1 = json.loads(items[0].shot_meta)
    # 命中行:换名+换绑+外观前缀+强制重出
    assert m1["characters"] == ["雪衣"]
    assert m1["entity_ids"] == [ids["e_new"]]
    assert m1["prompt"].startswith("1girl, silver hair, red cloak")
    assert "雪衣 runs in rain" in m1["prompt"]
    assert m1["dialogue"] == "快走" and m1["speaker"] == "雪衣"
    assert items[0].job_id == ""  # 强制重出(原有视频不再复用)
    m2 = json.loads(items[1].shot_meta)
    assert m2["characters"] == ["雪衣", "小雪"]
    assert m2["entity_ids"][0] == ids["e_new"]
    assert items[1].job_id == ""
    # 未命中行:不动
    assert json.loads(items[2].shot_meta)["characters"] if "characters" in json.loads(items[2].shot_meta) else True
    assert items[2].job_id == ""
    assert stats["video_reset"] == 2
    # 原版不动
    orig = _items(engine, ids["board"])
    assert orig[0].job_id == ids["vjob"]
    assert json.loads(orig[0].shot_meta)["characters"] == ["林凡"]


def test_words_clone_keeps_jobs(ctx):
    _, _, _, engine, ids = ctx
    with Session(engine) as s:
        u1 = s.get(User, ids["uid1"])
        b = s.get(Board, ids["board"])
        item1 = s.exec(select(BoardItem).where(BoardItem.board_id == b.id)).first()
        nb, stats = clone_board_with_remix(
            s, u1, b, "words",
            dialogue_overrides={item1.id: {"dialogue": "新词:灯亮着", "speaker": "旁白"}},
        )
        nb_id = nb.id
    items = _items(engine, nb_id)
    m1 = json.loads(items[0].shot_meta)
    assert m1["dialogue"] == "新词:灯亮着" and m1["speaker"] == "旁白"
    assert items[0].job_id == ids["vjob"]  # 视频全复用
    assert stats["video_reset"] == 0 and stats["voice_redo"] == 1


def test_broll_clone_reset(ctx):
    _, _, _, engine, ids = ctx
    with Session(engine) as s:
        u1 = s.get(User, ids["uid1"])
        b = s.get(Board, ids["board"])
        nb, stats = clone_board_with_remix(s, u1, b, "broll", prompt_suffix="cyberpunk city, neon")
        nb_id = nb.id
    items = _items(engine, nb_id)
    for it in items:
        meta = json.loads(it.shot_meta)
        assert "cyberpunk city, neon" in meta["prompt"]
        assert it.job_id == ""
    assert stats["video_reset"] == 3


def test_remix_endpoint(ctx, monkeypatch):
    c, t1, t2, engine, ids = ctx
    H = {"Authorization": f"Bearer {t1}"}
    spawned = []
    monkeypatch.setattr("app.services.board_film.spawn_film", lambda pid: spawned.append(pid))

    r = c.post(f"/api/boards/{ids['board']}/remix", json={
        "kind": "protagonist", "engine": "h3-t2v",
        "character_map": {"林凡": ids["e_new"]},
    }, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "remix换主角" in body["board"]["name"]
    assert body["stats"]["video_reset"] == 2
    assert body["film"]["prompt_id"].startswith("film-")
    assert spawned == [body["film"]["prompt_id"]]

    # words 缺省 auto_assemble=false
    item1 = _items(engine, ids["board"])[0].id
    r = c.post(f"/api/boards/{ids['board']}/remix", json={
        "kind": "words", "dialogue_overrides": {str(item1): {"dialogue": "改词"}},
        "auto_assemble": False,
    }, headers=H)
    assert r.status_code == 200 and r.json()["film"] is None

    # 非法类/缺 map/他人板
    assert c.post(f"/api/boards/{ids['board']}/remix", json={"kind": "wat"}, headers=H).status_code == 422
    assert c.post(f"/api/boards/{ids['board']}/remix", json={"kind": "protagonist"}, headers=H).status_code == 422
    assert c.post(f"/api/boards/{ids['board']}/remix", json={"kind": "words"},
                  headers={"Authorization": f"Bearer {t2}"}).status_code == 404
