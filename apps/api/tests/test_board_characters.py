"""分镜板 M2 角色一致性——角色草稿落库 Entity/单镜生成端点(三引擎分支)/导出角色升维。"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.services.board_generate as board_gen
import app.routes.boards as boards_route
from app.db import get_session
from app.main import app
from app.models import Entity, Job, Tenant, User
from app.security import create_token, hash_password
from app.services.studio.schemas import CharacterDraft, ShotDraft
from app.services.studio.storyboard import StoryboardError  # noqa: F401  (文档性导入,失败语义见 M1 测试)


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
        u1 = User(email="mc1@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        u2 = User(email="mc2@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id)
        s.add(u1); s.add(u2)
        s.commit()
        s.refresh(u1); s.refresh(u2)
        t1 = create_token(u1.id)
        t2 = create_token(u2.id)
    client = TestClient(app)
    yield client, t1, t2, engine
    app.dependency_overrides.pop(get_session, None)


def _entities(ctx, name: str | None = None) -> list[Entity]:
    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        q = select(Entity).where(Entity.kind == "character")
        if name:
            q = q.where(Entity.name == name)
        return list(s.exec(q).all())


def _add_entity(ctx, uid_email: str, name: str, *, ref_image: str = "", prompt_hint: str = "",
                ref_audio: str = "") -> str:
    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        u = s.exec(select(User).where(User.email == uid_email)).first()
        e = Entity(tenant_id=u.tenant_id, user_id=u.id, kind="character", name=name,
                   ref_image=ref_image, prompt_hint=prompt_hint, ref_audio=ref_audio)
        s.add(e)
        s.commit()
        s.refresh(e)
        return e.id


def _drafts() -> tuple[list[CharacterDraft], list[ShotDraft]]:
    chars = [
        CharacterDraft(name="林凡", description="山村少年", visual_prompt="1boy, black hair, cloth clothes"),
        CharacterDraft(name="小雪", description="神秘少女", visual_prompt="1girl, silver hair, red cloak"),
    ]
    shots = [
        ShotDraft(scene="破庙外雨夜", prompt="1boy, rain, temple", duration_sec=4,
                  characters=["林凡"]),
        ShotDraft(scene="庙内烤火", prompt="1girl, firelight", duration_sec=6,
                  characters=["小雪", "林凡"]),
    ]
    return chars, shots


def _mock_parse(monkeypatch):
    async def fake_parse(premise, num_shots=8, style="", known_characters=None):
        return _drafts()
    monkeypatch.setattr(boards_route, "parse_script", fake_parse)


def test_from_script_upserts_characters(ctx, monkeypatch):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    _mock_parse(monkeypatch)

    r = c.post("/api/boards/from-script", json={"script": "破庙相遇", "num_shots": 2}, headers=H)
    assert r.status_code == 200, r.text
    bid = r.json()["board"]["id"]

    ents = _entities(ctx)
    assert {e.name for e in ents} == {"林凡", "小雪"}
    lin = next(e for e in ents if e.name == "林凡")
    assert lin.prompt_hint == "1boy, black hair, cloth clothes"
    assert lin.description == "山村少年"

    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    meta0 = json.loads(items[0]["shot_meta"])
    assert meta0["entity_ids"] == [lin.id]  # 与 characters 同序
    meta1 = json.loads(items[1]["shot_meta"])
    assert len(meta1["entity_ids"]) == 2  # 小雪在前(characters 序)

    # 幂等:同名再拆不重复建行;既有 prompt_hint 不被覆盖
    r = c.post("/api/boards/from-script", json={"script": "破庙相遇 二周目", "num_shots": 2}, headers=H)
    assert r.status_code == 200
    assert len(_entities(ctx, "林凡")) == 1
    assert _entities(ctx, "林凡")[0].prompt_hint == "1boy, black hair, cloth clothes"


def test_upsert_only_fills_blanks(ctx, monkeypatch):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    # 用户策展的既有主体:prompt_hint 已有,description 空
    eid = _add_entity(ctx, "mc1@t.io", "林凡", prompt_hint="CURATED, do not touch")
    _mock_parse(monkeypatch)
    r = c.post("/api/boards/from-script", json={"script": "x", "num_shots": 2}, headers=H)
    assert r.status_code == 200
    ents = _entities(ctx, "林凡")
    assert len(ents) == 1 and ents[0].id == eid
    assert ents[0].prompt_hint == "CURATED, do not touch"  # 不覆盖
    assert ents[0].description == "山村少年"  # 只补空


def _mk_board_with_row(ctx, monkeypatch, shot_meta: dict, shot_text: str = "") -> tuple[str, int, object]:
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    bid = c.post("/api/boards", json={"name": "生成测试板"}, headers=H).json()["id"]
    r = c.put(f"/api/boards/{bid}/items", json={"items": [
        {"job_id": "", "shot_text": shot_text, "shot_meta": json.dumps(shot_meta, ensure_ascii=False)},
    ]}, headers=H)
    assert r.json()["item_count"] == 1
    item_id = c.get(f"/api/boards/{bid}/items", headers=H).json()[0]["id"]
    return bid, item_id, H


def test_generate_phantom_filters_imageless(ctx, monkeypatch):
    c, t1, _, _ = ctx
    e_img = _add_entity(ctx, "mc1@t.io", "有照", ref_image='{"filename":"a.png","worker":"http://w1:8188"}')
    _add_entity(ctx, "mc1@t.io", "无照")
    bid, item_id, H = _mk_board_with_row(ctx, monkeypatch, {
        "prompt": "two people talking", "duration_sec": 6,
        "characters": ["有照", "无照"], "entity_ids": [e_img],
    })
    captured = {}

    async def fake_phantom(req, user, session):
        captured["req"] = req
        return {"prompt_id": "p-1", "kind": "phantom_s2v"}

    monkeypatch.setattr(board_gen, "generate_phantom_s2v", fake_phantom)
    r = c.post(f"/api/boards/{bid}/items/{item_id}/generate",
               json={"engine": "phantom-s2v"}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["engine"] == "phantom-s2v"
    req = captured["req"]
    assert req.entity_ids == [e_img]  # 无照主体被预过滤
    assert req.positive == "two people talking"
    assert 17 <= req.num_frames <= 241 and (req.num_frames - 1) % 4 == 0  # duration×fps→4n+1

    # 全滤光 → 422 指引
    _add_entity(ctx, "mc1@t.io", "路人")
    bid2, item2, _ = _mk_board_with_row(ctx, monkeypatch, {
        "prompt": "x", "characters": ["路人"], "entity_ids": [],
    })
    r = c.post(f"/api/boards/{bid2}/items/{item2}/generate",
               json={"engine": "phantom-s2v"}, headers=H)
    assert r.status_code == 422
    assert "定妆照" in r.json()["detail"]


def test_generate_r2v_resolve_refs_alignment(ctx, monkeypatch):
    c, t1, _, _ = ctx
    e_img = _add_entity(ctx, "mc1@t.io", "有照", ref_image='{"filename":"a.png","worker":"http://w1:8188"}')
    bid, item_id, H = _mk_board_with_row(ctx, monkeypatch, {
        "prompt": "hero runs", "duration_sec": 8,
        "characters": ["有照"], "entity_ids": [e_img],
    })
    captured = {}

    async def fake_resolve(body, user, session, pool):
        return {"refs": [{"entity_id": e_img, "filename": "ref-1.png", "worker": "http://pool:8188",
                          "name": "有照", "prompt_hint": ""}],
                "skipped": [], "worker": "http://pool:8188"}

    async def fake_r2v(req, user, session):
        captured["req"] = req
        return {"prompt_id": "p-2", "kind": "h3_r2v"}

    monkeypatch.setattr(board_gen, "resolve_entity_refs", fake_resolve)
    monkeypatch.setattr(board_gen, "generate_h3_r2v", fake_r2v)
    r = c.post(f"/api/boards/{bid}/items/{item_id}/generate", json={"engine": "h3-r2v"}, headers=H)
    assert r.status_code == 200, r.text
    req = captured["req"]
    assert req.images == ["ref-1.png"] and req.worker == "http://pool:8188"
    assert req.entity_ids == [e_img]  # refs 产出子集,保 @图片N 对齐
    assert req.duration_sec == 8.0

    # refs 全空 → 422
    async def empty_resolve(body, user, session, pool):
        return {"refs": [], "skipped": [{"reason": "无参考图"}], "worker": "http://pool:8188"}
    monkeypatch.setattr(board_gen, "resolve_entity_refs", empty_resolve)
    r = c.post(f"/api/boards/{bid}/items/{item_id}/generate", json={"engine": "h3-r2v"}, headers=H)
    assert r.status_code == 422


def test_generate_t2v_passthrough_and_fallbacks(ctx, monkeypatch):
    c, t1, t2, _ = ctx
    H2 = {"Authorization": f"Bearer {t2}"}
    e_img = _add_entity(ctx, "mc1@t.io", "有照", ref_image='{"filename":"a.png","worker":"http://w1:8188"}')
    _add_entity(ctx, "mc1@t.io", "无照")
    bid, item_id, H = _mk_board_with_row(ctx, monkeypatch, {
        "prompt": "duo scene", "characters": ["有照", "无照"], "entity_ids": [e_img],
    })
    captured = {}

    async def fake_t2v(req, user, session):
        captured["req"] = req
        return {"prompt_id": "p-3", "kind": "h3_t2v"}

    monkeypatch.setattr(board_gen, "generate_h3_t2v", fake_t2v)
    r = c.post(f"/api/boards/{bid}/items/{item_id}/generate", json={"engine": "h3-t2v"}, headers=H)
    assert r.status_code == 200, r.text
    # t2v 容忍无图主体:有照(id)+无照(名下放)全量透传
    assert len(captured["req"].entity_ids) == 2

    # 手动占位行:无 shot_meta,shot_text 作 scene 兜底
    bid2, item2, _ = _mk_board_with_row(ctx, monkeypatch, {}, shot_text="夕阳下两人告别")
    r = c.post(f"/api/boards/{bid2}/items/{item2}/generate", json={"engine": "h3-t2v"}, headers=H)
    assert r.status_code == 200, r.text
    assert captured["req"].positive == "夕阳下两人告别"
    assert captured["req"].entity_ids is None

    # 空 prompt+空文本 → 422;他人板 404;item 不属板 404
    bid3, item3, _ = _mk_board_with_row(ctx, monkeypatch, {})
    r = c.post(f"/api/boards/{bid3}/items/{item3}/generate", json={"engine": "h3-t2v"}, headers=H)
    assert r.status_code == 422
    assert c.post(f"/api/boards/{bid}/items/{item_id}/generate", json={"engine": "h3-t2v"}, headers=H2).status_code == 404
    assert c.post(f"/api/boards/{bid}/items/{item3}/generate", json={"engine": "h3-t2v"}, headers=H).status_code == 404
    # 非法引擎 → 422(pattern)
    assert c.post(f"/api/boards/{bid}/items/{item_id}/generate", json={"engine": "wan"}, headers=H).status_code == 422


def test_export_characters_enriched(ctx, monkeypatch):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    _mock_parse(monkeypatch)
    bid = c.post("/api/boards/from-script", json={"script": "破庙相遇", "num_shots": 2}, headers=H).json()["board"]["id"]
    # 给林凡主体补音色(导出应携带)
    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        e = s.exec(select(Entity).where(Entity.name == "林凡")).first()
        e.ref_audio = "/api/drama/voice/voice-linfan.wav"
        s.add(e)
        s.commit()
    # 加一行引用不存在角色(解析不到 → 键在值空)
    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    payload = [{"job_id": "", "shot_text": it["shot_text"], "shot_meta": it["shot_meta"], "note": ""} for it in items]
    payload.append({"job_id": "", "shot_text": "x",
                    "shot_meta": json.dumps({"characters": ["不存在"], "prompt": "p"})})
    c.put(f"/api/boards/{bid}/items", json={"items": payload}, headers=H)

    doc = c.get(f"/api/boards/{bid}/export", headers=H).json()
    by_name = {ch["name"]: ch for ch in doc["characters"]}
    lin = by_name["林凡"]
    assert lin["entity_id"] and lin["visual_prompt"] == "1boy, black hair, cloth clothes"
    assert lin["ref_audio"] == "/api/drama/voice/voice-linfan.wav"
    assert "reference_front" in lin
    ghost = by_name["不存在"]
    assert ghost["entity_id"] == "" and ghost["visual_prompt"] == ""
