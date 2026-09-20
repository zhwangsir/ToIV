"""分镜板 v2(M1)——LLM 拆剧本建板/占位分镜行/shot_meta 回读/整板导出 drama_studio 格式。"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.boards as boards_route
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.services.studio.schemas import CharacterDraft, ShotDraft
from app.services.studio.storyboard import StoryboardError


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
        u1 = User(email="sb1@t.io", hashed_password=hash_password("x1"), tenant_id=tenant.id)
        u2 = User(email="sb2@t.io", hashed_password=hash_password("x2"), tenant_id=tenant.id)
        s.add(u1); s.add(u2)
        s.commit()
        s.refresh(u1); s.refresh(u2)
        # u1:一个图产物作业 + 一个视频+图双产物作业(导出媒体分流用)
        s.add(Job(id=uuid.uuid4().hex, prompt_id=uuid.uuid4().hex,
                  tenant_id=tenant.id, user_id=u1.id, worker="w", kind="txt2img",
                  status="done", prompt="girl in rain", seed=42,
                  result='["/api/images?filename=a.png&worker=w"]'))
        s.add(Job(id=uuid.uuid4().hex, prompt_id=uuid.uuid4().hex,
                  tenant_id=tenant.id, user_id=u1.id, worker="w", kind="h3_t2v",
                  status="done", prompt="running boy", seed=7,
                  result='["/api/videos?filename=v.mp4&worker=w", "/api/images?filename=b.png&worker=w"]'))
        s.commit()
        t1 = create_token(u1.id)
        t2 = create_token(u2.id)
    client = TestClient(app)
    yield client, t1, t2, engine
    app.dependency_overrides.pop(get_session, None)


def _u1_job_ids(ctx) -> list[str]:
    _, _, _, engine = ctx
    from sqlmodel import select
    with Session(engine) as s:
        u = s.exec(select(User).where(User.email == "sb1@t.io")).first()
        return [j.id for j in s.exec(select(Job).where(Job.user_id == u.id)).all()]


def _fake_shots() -> list[ShotDraft]:
    return [
        ShotDraft(scene="夜色山路,少年独行", prompt="1boy, night road, cinematic",
                  dialogue="我一定要走出这座山", speaker="林凡", duration_sec=4,
                  characters=["林凡"], camera="wide shot"),
        ShotDraft(scene="破庙内,少女烤火", prompt="1girl, temple, firelight",
                  duration_sec=5, characters=["小雪"], camera="close-up"),
        ShotDraft(scene="庙门被推开", prompt="1boy, door, dramatic light",
                  dialogue="谁在那里?", speaker="小雪", duration_sec=6,
                  characters=["林凡", "小雪"]),
    ]


def test_from_script_creates_placeholder_rows(ctx, monkeypatch):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}

    async def fake_parse(premise, num_shots=8, style="", known_characters=None):
        assert num_shots == 3
        return [CharacterDraft(name="林凡"), CharacterDraft(name="小雪")], _fake_shots()

    monkeypatch.setattr(boards_route, "parse_script", fake_parse)
    r = c.post("/api/boards/from-script",
               json={"script": "山村少年夜行遇雨,破庙避雨遇少女。", "num_shots": 3},
               headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["item_count"] == 3
    assert body["board"]["name"].startswith("漫剧分镜 · 山村少年")
    bid = body["board"]["id"]

    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    assert len(items) == 3
    for it in items:
        assert it["job"] is None  # 占位行
    # shot_text 合成:scene + 台词(speaker) + 运镜
    assert "夜色山路" in items[0]["shot_text"]
    assert "台词(林凡):我一定要走出这座山" in items[0]["shot_text"]
    assert "运镜:wide shot" in items[0]["shot_text"]
    assert "破庙内" in items[1]["shot_text"]
    # shot_meta 结构化草稿可解析
    meta0 = json.loads(items[0]["shot_meta"])
    assert meta0["prompt"].startswith("1boy")
    assert meta0["duration_sec"] == 4
    assert meta0["characters"] == ["林凡"]

    # 显式板名优先
    r = c.post("/api/boards/from-script",
               json={"script": "另一段剧本", "num_shots": 3, "name": "我的短剧"}, headers=H)
    assert r.json()["board"]["name"] == "我的短剧"


def test_from_script_llm_failure_503(ctx, monkeypatch):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}

    async def boom(premise, num_shots=8, style="", known_characters=None):
        raise StoryboardError("LLM 不可用:连接拒绝")

    monkeypatch.setattr(boards_route, "parse_script", boom)
    r = c.post("/api/boards/from-script", json={"script": "任意剧本"}, headers=H)
    assert r.status_code == 503
    assert "剧本拆解服务暂不可用" in r.json()["detail"]


def test_placeholder_rows_put_list_and_dedupe(ctx):
    c, t1, _, _ = ctx
    H = {"Authorization": f"Bearer {t1}"}
    bid = c.post("/api/boards", json={"name": "分镜板"}, headers=H).json()["id"]
    ids = _u1_job_ids(ctx)
    meta = json.dumps({"scene": "s", "prompt": "p"}, ensure_ascii=False)

    # 两个占位行互不去重 + 真实 job 混合 + 重复真实 job 仍去重
    r = c.put(f"/api/boards/{bid}/items", json={"items": [
        {"job_id": "", "shot_text": "镜一", "shot_meta": meta},
        {"job_id": "", "shot_text": "镜二"},
        {"job_id": ids[0]},
        {"job_id": ids[0]},
    ]}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["item_count"] == 3

    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    assert [it["shot_text"] for it in items[:2]] == ["镜一", "镜二"]
    assert items[0]["job"] is None and items[1]["job"] is None
    assert items[0]["shot_meta"] == meta  # shot_meta round-trip
    assert items[2]["job"]["id"] == ids[0]
    assert "shot_meta" in items[2]

    # 越权 job 仍 422
    r = c.put(f"/api/boards/{bid}/items", json={"items": [{"job_id": "not-mine"}]}, headers=H)
    assert r.status_code == 422


def test_export_document_shape(ctx, monkeypatch):
    c, t1, t2, _ = ctx
    H, H2 = ({"Authorization": f"Bearer {t1}"}, {"Authorization": f"Bearer {t2}"})

    async def fake_parse(premise, num_shots=8, style="", known_characters=None):
        return [], _fake_shots()

    monkeypatch.setattr(boards_route, "parse_script", fake_parse)
    bid = c.post("/api/boards/from-script",
                 json={"script": "导出测试剧本", "num_shots": 3, "name": "导出板"},
                 headers=H).json()["board"]["id"]

    # 给镜一挂图产物作业,镜二挂视频+图双产物作业(媒体分流)
    ids = _u1_job_ids(ctx)
    items = c.get(f"/api/boards/{bid}/items", headers=H).json()
    payload = []
    for i, it in enumerate(items):
        row = {"job_id": "", "note": it["note"], "shot_text": it["shot_text"],
               "shot_meta": it["shot_meta"]}
        if i == 0:
            row["job_id"] = ids[0]
        elif i == 1:
            row["job_id"] = ids[1]
        payload.append(row)
    r = c.put(f"/api/boards/{bid}/items", json={"items": payload}, headers=H)
    assert r.json()["item_count"] == 3

    r = c.get(f"/api/boards/{bid}/export", headers=H)
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", "")
    doc = r.json()
    assert doc["title"] == "导出板"
    assert [s["idx"] for s in doc["shots"]] == [1, 2, 3]
    # characters 保序聚合去重
    assert [ch["name"] for ch in doc["characters"]] == ["林凡", "小雪"]
    # 媒体分流:镜一 image、镜二 video+image 取首个
    s1, s2, s3 = doc["shots"]
    assert s1["image_url"].startswith("/api/images?") and s1["video_url"] == ""
    assert s2["video_url"].startswith("/api/videos?") and s2["image_url"].startswith("/api/images?")
    assert s3["job_id"] == "" and s3["status"] == "pending"
    assert s1["seed"] == 42 and s1["status"] == "done"
    # prompt 来源:shot_meta 优先
    assert s1["prompt"].startswith("1boy")
    # seam:无草稿值时除末镜 hardcut、末镜空
    assert [s["seam_to_next"] for s in doc["shots"]] == ["hardcut", "hardcut", ""]
    # narration:有台词的行按全镜时长累计起止(4/5/6s)
    assert [(n["start"], n["end"], n["speaker"]) for n in doc["narration"]] == [
        (0.0, 4.0, "林凡"), (9.0, 15.0, "小雪"),
    ]
    assert doc["duration_sec"] == 15.0
    # 越权 404
    assert c.get(f"/api/boards/{bid}/export", headers=H2).status_code == 404
