"""AI 短剧工作室 MVP CRUD + 剧本拆解(mock LLM)smoke 测试。

覆盖:
  · 项目 CRUD + 鉴权隔离
  · 角色库 CRUD + 角色视觉 token 注入
  · 剧本拆解(mock llm.chat 返回结构化 shots,验证落库 + 角色 token 前置注入)
  · 分镜 PATCH(手动改 prompt/seed)
  · 合成前置校验(无已完成分镜 → 422)

不覆盖(依赖外部 ComfyUI/TTS/ffmpeg,留集成测试):
  · generate-video / generate-voice / assemble 实际执行
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.config import get_settings
from app.models import DramaCharacter, DramaEvent, DramaProject, DramaSession, DramaShot, DramaShotCandidate, Job, Tenant, User
from app.security import create_token, hash_password
from app.agent import llm


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
    # 批量精修等后台任务用 `from app.db import engine` 取独立 Session,
    # 需 patch app.db.engine 指向测试 engine,否则后台 Session 看不到内存表
    with patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="d")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="d@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
            # 第二个用户(隔离测试用)
            tenant2 = Tenant(name="d2")
            s.add(tenant2)
            s.commit()
            s.refresh(tenant2)
            user2 = User(
                email="d2@toiv.ai",
                hashed_password=hash_password("p"),
                tenant_id=tenant2.id,
            )
            s.add(user2)
            s.commit()
            s.refresh(user2)
            uid2 = user2.id
        yield TestClient(app), create_token(uid), create_token(uid2)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_project_crud(ctx):
    client, token, _ = ctx
    H = _h(token)
    r = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "短剧1", "premise": "赛博朋克", "script": "剧本..."},
    )
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert r.json()["status"] == "draft"
    # 列表
    assert len(client.get("/api/drama/projects", headers=H).json()) == 1
    # patch
    r = client.patch(f"/api/drama/projects/{pid}", headers=H, json={"style": "cyberpunk"})
    assert r.json()["style"] == "cyberpunk"
    # 详情(含空 characters/shots)
    detail = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert detail["characters"] == [] and detail["shots"] == []
    # 删
    assert client.delete(f"/api/drama/projects/{pid}", headers=H).status_code == 200
    assert client.get("/api/drama/projects", headers=H).json() == []


def test_delete_project_cascades_shots_and_candidates(ctx):
    """删除有分镜+候选的项目:级联清空 candidates/shots/characters(2026-08-05 修复)。

    根因:ORM session.delete 在无 Relationship 时 UOW 不按表级 FK 拓扑排序,
    PG(迁移后 confdeltype=NO ACTION)下 DELETE dramaproject 先于 dramashot 执行
    → FK 冲突 500;且 DramaShotCandidate 从未被删,修复前本测试在
    "candidate 已清空"断言上必红。
    """
    from app.db import engine  # ctx 已 patch 指向测试内存库

    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "级联删除"}).json()["id"]
    with Session(engine) as s:
        shot = DramaShot(project_id=pid, idx=0, prompt="a test shot")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        cand = DramaShotCandidate(shot_id=shot.id, project_id=pid)
        s.add(cand)
        s.commit()
        shot_id, cand_id = shot.id, cand.id

    r = client.delete(f"/api/drama/projects/{pid}", headers=H)
    assert r.status_code == 200, r.text

    with Session(engine) as s:
        assert s.get(DramaProject, pid) is None
        assert s.get(DramaShot, shot_id) is None
        assert s.get(DramaShotCandidate, cand_id) is None


def test_character_crud(ctx):
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={
            "name": "阿明",
            "description": "男主",
            "visual_prompt": "1boy, black hair, leather jacket",
        },
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    # list
    assert len(client.get(f"/api/drama/projects/{pid}/characters", headers=H).json()) == 1
    # patch
    client.patch(f"/api/drama/characters/{cid}", headers=H, json={"name": "小明"})
    detail = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert detail["characters"][0]["name"] == "小明"
    # delete
    assert client.delete(f"/api/drama/characters/{cid}", headers=H).status_code == 200


def test_storyboard_with_character_injection(ctx):
    """剧本拆解:mock LLM 返回 shots,验证角色视觉 token 前置注入到 prompt。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "短剧", "script": "阿明走在街上,看到一只猫。"},
    ).json()["id"]
    # 建角色
    client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={
            "name": "阿明",
            "visual_prompt": "1boy, black hair, leather jacket",
        },
    )

    fake_msg = {
        "content": '{"shots":[{"scene":"街道","prompt":"1boy, walking on street, daytime","characters":["阿明"],"dialogue":"","speaker":"","duration_sec":6}]}'
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(
            f"/api/drama/projects/{pid}/storyboard",
            headers=H,
            json={"num_shots": 1},
        )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 1
    # 角色 token 应被前置注入
    assert shots[0]["prompt"].startswith("1boy, black hair, leather jacket")
    assert "walking on street" in shots[0]["prompt"]
    assert shots[0]["characters"] == ["阿明"]
    # 项目状态应转为 storyboard
    p = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert p["status"] == "storyboard"


def test_shot_patch(ctx):
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x", "script": "s"}).json()["id"]
    fake_msg = {
        "content": '{"shots":[{"scene":"s","prompt":"1boy, running","characters":[],"dialogue":"hi","speaker":"narrator","duration_sec":5}]}'
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 1})
    sid = r.json()["shots"][0]["id"]
    # 改 prompt + seed
    r = client.patch(
        f"/api/drama/shots/{sid}",
        headers=H,
        json={"prompt": "1girl, sitting", "seed": 12345},
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt"] == "1girl, sitting"
    assert r.json()["seed"] == 12345


def test_shot_patch_mood_beat(ctx):
    """LibTV 工作台:mood/beat 两字段 PATCH 写入 + 详情读回往返。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x", "script": "s"}).json()["id"]
    fake_msg = {
        "content": '{"shots":[{"scene":"s","prompt":"1boy, running","characters":[],"dialogue":"hi","speaker":"narrator","duration_sec":5}]}'
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 1})
    shot = r.json()["shots"][0]
    # 新建分镜默认空串
    assert shot["mood"] == ""
    assert shot["beat"] == ""
    # PATCH 写入
    r = client.patch(
        f"/api/drama/shots/{shot['id']}",
        headers=H,
        json={"mood": "压抑", "beat": "0-3秒 中景推进,主角回头"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["mood"] == "压抑"
    assert r.json()["beat"] == "0-3秒 中景推进,主角回头"
    # 项目详情读回(确认落库且 _shot_dict 输出)
    p = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    s = next(x for x in p["shots"] if x["id"] == shot["id"])
    assert s["mood"] == "压抑"
    assert s["beat"] == "0-3秒 中景推进,主角回头"
    # 超长校验:mood > 64 / beat > 200 → 422
    r = client.patch(f"/api/drama/shots/{shot['id']}", headers=H, json={"mood": "x" * 65})
    assert r.status_code == 422
    r = client.patch(f"/api/drama/shots/{shot['id']}", headers=H, json={"beat": "x" * 201})
    assert r.status_code == 422


def test_assemble_requires_done_shots(ctx):
    """无已完成分镜视频时合成应返回 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x", "script": "s"}).json()["id"]
    fake_msg = {"content": '{"shots":[{"scene":"s","prompt":"1boy","characters":[],"dialogue":"","speaker":"","duration_sec":5}]}'}
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        client.post(f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 1})
    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=H, json={})
    assert r.status_code == 422
    assert "无已完成的分镜视频" in r.json()["detail"]


def test_project_isolation(ctx):
    """不同用户互相看不到对方的项目。"""
    client, token, token2 = ctx
    H = _h(token)
    H2 = _h(token2)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "mine"}).json()["id"]
    # 用户2 看不到用户1 的项目列表
    assert client.get("/api/drama/projects", headers=H2).json() == []
    # 用户2 直接访问用户1 的项目 → 404
    assert client.get(f"/api/drama/projects/{pid}", headers=H2).status_code == 404


# ---------------------------------------------------------------------------
# M1: 角色三视图生成
# ---------------------------------------------------------------------------
def _fake_pool(queue_side_effect):
    """构造 mock WorkerPool + mock ComfyUIClient。queue_prompt 按 side_effect 依次返回。"""
    pool = MagicMock()
    cli = AsyncMock()
    cli.base_url = "http://worker"
    cli.queue_prompt = AsyncMock(side_effect=queue_side_effect)
    cli.upload_image = AsyncMock(return_value="uploaded")
    pool.pick = AsyncMock(return_value=cli)
    return pool, cli


def test_generate_character_reference(ctx):
    """M1: 角色三视图生成 —— mock ComfyUI t2i,断言返回 reference_front/side/back 非空。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    cid = client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={"name": "阿明", "visual_prompt": "1boy, black hair, leather jacket"},
    ).json()["id"]

    pool, _cli = _fake_pool(["pid-front", "pid-side", "pid-back"])
    app.dependency_overrides[get_pool] = lambda: pool

    fake_results = {
        "pid-front": ["/api/images?filename=front.png&worker=http://worker"],
        "pid-side": ["/api/images?filename=side.png&worker=http://worker"],
        "pid-back": ["/api/images?filename=back.png&worker=http://worker"],
    }
    try:
        with patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value=fake_results)):
            r = client.post(
                f"/api/drama/characters/{cid}/generate-reference",
                headers=H,
                json={},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["reference_front"] == fake_results["pid-front"][0]
    assert data["reference_side"] == fake_results["pid-side"][0]
    assert data["reference_back"] == fake_results["pid-back"][0]
    pool.pick.assert_awaited_once()


def test_generate_character_reference_override_prompt(ctx):
    """M1: visual_prompt_override 覆盖角色已有的 visual_prompt。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    cid = client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={"name": "小红", "visual_prompt": "1girl, red dress"},
    ).json()["id"]

    pool, cli = _fake_pool(["p1", "p2", "p3"])
    app.dependency_overrides[get_pool] = lambda: pool

    try:
        with patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "p1": ["/img/front.png"], "p2": ["/img/side.png"], "p3": ["/img/back.png"],
             })):
            r = client.post(
                f"/api/drama/characters/{cid}/generate-reference",
                headers=H,
                json={"visual_prompt_override": "1girl, blue hair, school uniform"},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    # queue_prompt 第一次调用的 prompt 应包含 override 后的内容
    first_call_graph = cli.queue_prompt.call_args_list[0][0][0]
    # 找到 CLIPTextEncode 节点的 text 字段(正向提示词)
    positive_text = ""
    for node in first_call_graph.values():
        if isinstance(node, dict) and node.get("class_type") in ("CLIPTextEncode", "TextEncodeZImageOmni"):
            t = node.get("inputs", {}).get("text") or node.get("inputs", {}).get("prompt", "")
            if t and "blue hair" in str(t):
                positive_text = str(t)
                break
    assert "blue hair" in positive_text


def test_generate_character_reference_empty_prompt(ctx):
    """M1: 角色缺少视觉描述时返回 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    cid = client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={"name": "无名", "visual_prompt": ""},
    ).json()["id"]

    r = client.post(
        f"/api/drama/characters/{cid}/generate-reference",
        headers=H,
        json={},
    )
    assert r.status_code == 422
    assert "视觉描述" in r.json()["detail"]


def test_generate_character_reference_not_found(ctx):
    """M1: 不存在的角色 id 返回 404。"""
    client, token, _ = ctx
    H = _h(token)
    r = client.post(
        "/api/drama/characters/nonexistent/generate-reference",
        headers=H,
        json={},
    )
    assert r.status_code == 404


def test_generate_character_reference_other_user(ctx):
    """M1: 其他用户的角色 → 404(鉴权隔离)。"""
    client, token, token2 = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    cid = client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={"name": "阿明", "visual_prompt": "1boy"},
    ).json()["id"]
    # 用户2 访问用户1 的角色
    r = client.post(
        f"/api/drama/characters/{cid}/generate-reference",
        headers=_h(token2),
        json={},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# M2: 9/25 宫格分镜
# ---------------------------------------------------------------------------
def test_grid_storyboard_9_shots(ctx):
    """M2: 9 宫格分镜 —— mock LLM + ComfyUI t2i,断言 shots 数量 + grid_image 非空。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "短剧", "script": "阿明走在街上,遇到老朋友。"},
    ).json()["id"]

    shots_json = ",".join(
        '{"scene":"场景' + str(i) + '","prompt":"1boy, scene ' + str(i)
        + ', cinematic","characters":["阿明"],"dialogue":"台词","speaker":"阿明","duration_sec":5}'
        for i in range(9)
    )
    fake_msg = {"content": '{"shots":[' + shots_json + "]}"}

    pool, _cli = _fake_pool(["grid-pid-9"])
    app.dependency_overrides[get_pool] = lambda: pool

    try:
        with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)), \
             patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "grid-pid-9": ["/api/images?filename=grid9.png&worker=http://worker"],
             })):
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 9},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["shots"]) == 9
    assert data["grid_image"] == "/api/images?filename=grid9.png&worker=http://worker"
    for i, shot in enumerate(data["shots"]):
        assert shot["idx"] == i
        assert shot["grid_image"] == data["grid_image"]
        assert shot["prompt"]  # 非空
    # 项目状态应转为 storyboard
    assert data["project"]["status"] == "storyboard"


def test_grid_storyboard_25_shots(ctx):
    """M2: 25 宫格分镜(5x5)—— 断言 grid_size 为 5x5。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "长剧", "script": "一段长剧情..."},
    ).json()["id"]

    shots_json = ",".join(
        '{"scene":"s' + str(i) + '","prompt":"1boy, shot ' + str(i)
        + '","characters":[],"dialogue":"","speaker":"","duration_sec":4}'
        for i in range(25)
    )
    fake_msg = {"content": '{"shots":[' + shots_json + "]}"}

    pool, cli = _fake_pool(["grid-pid-25"])
    app.dependency_overrides[get_pool] = lambda: pool

    try:
        with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)), \
             patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "grid-pid-25": ["/api/images?filename=grid25.png&worker=http://worker"],
             })):
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 25},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["shots"]) == 25
    assert data["grid_image"]
    # 验证 grid prompt 包含 5x5
    grid_call_graph = cli.queue_prompt.call_args_list[0][0][0]
    grid_text = ""
    for node in grid_call_graph.values():
        if isinstance(node, dict) and node.get("class_type") in ("CLIPTextEncode", "TextEncodeZImageOmni"):
            t = node.get("inputs", {}).get("text") or node.get("inputs", {}).get("prompt", "")
            if t and "5x5" in str(t):
                grid_text = str(t)
                break
    assert "5x5" in grid_text


def test_grid_storyboard_character_injection(ctx):
    """M2: 宫格分镜应注入角色视觉 token 到 shot prompt(与 storyboard 一致)。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "x", "script": "阿明出场。"},
    ).json()["id"]
    client.post(
        f"/api/drama/projects/{pid}/characters",
        headers=H,
        json={"name": "阿明", "visual_prompt": "1boy, black hair, leather jacket"},
    )

    fake_msg = {
        "content": '{"shots":[{"scene":"s","prompt":"walking on street","characters":["阿明"],'
        '"dialogue":"","speaker":"","duration_sec":5}]}'
    }
    pool, _cli = _fake_pool(["grid-pid"])
    app.dependency_overrides[get_pool] = lambda: pool

    try:
        with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)), \
             patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "grid-pid": ["/img/grid.png"],
             })):
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 1},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    # 角色 token 应被前置注入
    assert shot["prompt"].startswith("1boy, black hair, leather jacket")
    assert "walking on street" in shot["prompt"]


def test_grid_storyboard_seam_persisted(ctx):
    """SKILLS-SEAM 遗留补齐:grid 路径与 text storyboard 一致,
    LLM 规划的 seam_to_next/seam_anchor 必须落库(此前 grid 路径漏传)。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "x", "script": "阿明挥刀,刀光接瞳孔特写。"},
    ).json()["id"]

    fake_msg = {
        "content": '{"shots":['
        '{"scene":"s1","prompt":"slash","characters":[],"dialogue":"","speaker":"",'
        '"duration_sec":5,"seam_to_next":"matchcut","seam_anchor":"刀刃",'
        '"mood":"紧张","beat":"对峙"},'
        '{"scene":"s2","prompt":"eye closeup","characters":[],"dialogue":"","speaker":"",'
        '"duration_sec":6,"seam_to_next":"hardcut","seam_anchor":"",'
        '"mood":"释然","beat":"收束"}]}'
    }
    pool, _cli = _fake_pool(["grid-pid-seam"])
    app.dependency_overrides[get_pool] = lambda: pool

    try:
        with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)), \
             patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "grid-pid-seam": ["/img/grid-seam.png"],
             })):
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 2},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 2
    # 首镜 matchcut + 锚点落库
    assert shots[0]["seam_to_next"] == "matchcut"
    assert shots[0]["seam_anchor"] == "刀刃"
    # 次镜 hardcut(锚点空)
    assert shots[1]["seam_to_next"] == "hardcut"
    assert shots[1]["seam_anchor"] == ""
    # mood/beat 同步落库(WORKBENCH follow-up:grid 路径与 text 路径一致)
    assert shots[0]["mood"] == "紧张" and shots[0]["beat"] == "对峙"
    assert shots[1]["mood"] == "释然" and shots[1]["beat"] == "收束"


def test_grid_storyboard_empty_script(ctx):
    """M2: 项目缺少剧本时返回 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/grid-storyboard",
        headers=H,
        json={"num_shots": 9},
    )
    assert r.status_code == 422
    assert "剧本" in r.json()["detail"]


def test_grid_storyboard_replaces_old_shots(ctx):
    """M2: 重新生成宫格分镜应清掉旧 shots。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "x", "script": "剧本..."},
    ).json()["id"]

    # 先用普通 storyboard 建几个旧 shots
    old_msg = {"content": '{"shots":[{"scene":"old","prompt":"old prompt","characters":[],"dialogue":"","speaker":"","duration_sec":5}]}'}
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=old_msg)):
        client.post(f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 1})
    # 确认有 1 个旧 shot
    detail = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert len(detail["shots"]) == 1
    assert detail["shots"][0]["prompt"] == "old prompt"

    # 再用 grid-storyboard 重新生成
    new_msg = {"content": '{"shots":[{"scene":"new","prompt":"new prompt","characters":[],"dialogue":"","speaker":"","duration_sec":6}]}'}
    pool, _cli = _fake_pool(["grid-pid"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=new_msg)), \
             patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "grid-pid": ["/img/grid.png"],
             })):
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 1},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    # 确认旧 shot 被清掉,只有新 shot
    detail = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert len(detail["shots"]) == 1
    assert detail["shots"][0]["prompt"] == "new prompt"
    assert detail["shots"][0]["grid_image"] == "/img/grid.png"


# ---------------------------------------------------------------------------
# M3: 3D 导演台(轻量 2D 版)—— 场景构图 GET/PUT
# ---------------------------------------------------------------------------
def _make_shot(ctx, token: str, *, prompt: str = "1boy, walking") -> tuple[str, str]:
    """建项目 + 拆 1 个分镜,返回 (pid, sid)。"""
    client = ctx[0]
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "x", "script": "剧本..."},
    ).json()["id"]
    fake_msg = {
        "content": '{"shots":[{"scene":"s","prompt":"' + prompt
        + '","characters":[],"dialogue":"","speaker":"","duration_sec":5}]}'
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 1})
    sid = r.json()["shots"][0]["id"]
    return pid, sid


def test_get_scene_layout_empty(ctx):
    """M3: 新建分镜 scene_layout 为空,GET 返回 null。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    r = client.get(f"/api/drama/shots/{sid}/scene-layout", headers=H)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["shot_id"] == sid
    assert data["scene_layout"] is None
    assert data["raw"] == ""


def test_update_scene_layout(ctx):
    """M3: PUT 更新 layout,再 GET 确认一致。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    layout = {
        "actors": [
            {"name": "阿明", "x": 0.2, "y": 0.5, "facing": "right", "scale": 1.0},
            {"name": "小红", "x": 0.8, "y": 0.5, "facing": "left", "scale": 1.0},
        ],
        "props": [{"name": "sword", "x": 0.5, "y": 0.5, "scale": 1.0}],
        "camera": {"angle": "low", "distance": "medium"},
        "notes": "对决构图",
    }
    r = client.put(f"/api/drama/shots/{sid}/scene-layout", headers=H, json={"layout": layout})
    assert r.status_code == 200, r.text
    # 返回的 shot_dict 里 scene_layout 应为解析后的 dict
    assert r.json()["scene_layout"] == layout

    # 再 GET 确认持久化
    r = client.get(f"/api/drama/shots/{sid}/scene-layout", headers=H)
    assert r.json()["scene_layout"] == layout
    assert "对决构图" in r.json()["raw"]


def test_update_scene_layout_generate_reference(ctx):
    """M3: generate_reference=True,mock t2i 链路,确认 grid_image 被写入。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    layout = {
        "actors": [
            {"name": "A", "x": 0.2, "y": 0.5, "facing": "right", "scale": 1.0},
            {"name": "B", "x": 0.8, "y": 0.5, "facing": "left", "scale": 1.0},
        ],
        "props": [],
        "camera": {"angle": "low", "distance": "medium"},
        "notes": "",
    }
    pool, _cli = _fake_pool(["scene-layout-pid"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "scene-layout-pid": ["/api/images?filename=layout.png&worker=http://worker"],
             })):
            r = client.put(
                f"/api/drama/shots/{sid}/scene-layout",
                headers=H,
                json={"layout": layout, "generate_reference": True},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    assert r.json()["grid_image"] == "/api/images?filename=layout.png&worker=http://worker"
    pool.pick.assert_awaited_once()


def test_scene_layout_other_user(ctx):
    """M3: 其他用户的分镜,GET/PUT 返回 404(鉴权隔离)。"""
    client, token, token2 = ctx
    H = _h(token)
    H2 = _h(token2)
    _, sid = _make_shot(ctx, token)
    # 用户2 GET
    assert client.get(f"/api/drama/shots/{sid}/scene-layout", headers=H2).status_code == 404
    # 用户2 PUT
    r = client.put(
        f"/api/drama/shots/{sid}/scene-layout",
        headers=H2,
        json={"layout": {"actors": []}},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# M3: 分镜对口型(LatentSync)
# ---------------------------------------------------------------------------
def test_shot_lipsync_success(ctx):
    """M3: 分镜对口型成功提交并回写。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)

    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.video_status = "done"
        shot.video_url = "/api/drama/output/drama-test.mp4"
        shot.voice_status = "done"
        shot.voice_url = "/api/drama/voice/voice-test.wav"
        s.add(shot)
        s.commit()

    pool, cli = _fake_pool(["lipsync-pid"])
    app.dependency_overrides[get_pool] = lambda: pool

    fake_result = {
        "lipsync-pid": ["/api/images?filename=lipsync.mp4&worker=http://worker"]
    }

    mock_resp = MagicMock()
    mock_resp.content = b"fake"
    mock_resp.raise_for_status = MagicMock()
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    try:
        with patch("app.routes.drama_studio.httpx.AsyncClient", return_value=mock_client), \
             patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.comfy.tracker.wait_for_jobs", AsyncMock(return_value=fake_result)):
            r = client.post(
                f"/api/drama/shots/{sid}/lipsync",
                headers=H,
                json={"lips_expression": 1.5, "inference_steps": 20, "seed": 42},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["shot_id"] == sid
    assert data["lipsync_status"] == "generating"
    assert data["seed"] == 42

    # 后台回写已完成(wait_for_jobs 被 mock 立即返回)
    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    shot = next(s for s in proj["shots"] if s["id"] == sid)
    assert shot["lipsync_status"] == "done"
    assert shot["lipsync_video_url"] == fake_result["lipsync-pid"][0]

    # 确认提交的是 LatentSync 工作流
    graph = cli.queue_prompt.call_args[0][0]
    assert any(node.get("class_type") == "LatentSyncNode" for node in graph.values())


def test_shot_lipsync_requires_video_and_voice(ctx):
    """M3: 视频或配音未 done 时返回 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)

    # 两者都未完成
    r = client.post(f"/api/drama/shots/{sid}/lipsync", headers=H, json={})
    assert r.status_code == 422, r.text
    assert "视频" in r.json()["detail"]

    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.video_status = "done"
        shot.video_url = "/api/drama/output/v.mp4"
        s.add(shot)
        s.commit()

    # 仅视频完成
    r = client.post(f"/api/drama/shots/{sid}/lipsync", headers=H, json={})
    assert r.status_code == 422, r.text
    assert "配音" in r.json()["detail"]


def test_shot_lipsync_other_user_404(ctx):
    """M3: 其他用户访问分镜对口型返回 404。"""
    client, token, token2 = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)

    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.video_status = "done"
        shot.video_url = "/api/drama/output/v.mp4"
        shot.voice_status = "done"
        shot.voice_url = "/api/drama/voice/v.wav"
        s.add(shot)
        s.commit()

    r = client.post(
        f"/api/drama/shots/{sid}/lipsync",
        headers=_h(token2),
        json={},
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# M6: 视频生成模型聚合
# ---------------------------------------------------------------------------
def test_list_video_generators(ctx, monkeypatch):
    """M6: GET /api/drama/video-generators 返回 5 个生成器(含 H3)。

    QA-FULL-2026-08-11 P3(引擎状态一致性):available/reason 由后端统一下发,
    与 /api/models/engines 同源——ltx 仅余 R18 链路(LTX-2.5 SFW 2026-08-23 退役),
    映射 ltx-nsfw-t2v:SFW 上下文该引擎被过滤 → 不可用 + 原因;H3 走独立实例探测
    (替身在线)可用;stub(seedance/kling)固定不可用;liveact 随配置开关。
    """
    client, token, _ = ctx
    H = _h(token)
    from app.config import get_settings
    from app.services import engine_registry

    async def _h3_nodes():
        return {"MiniMaxH3ImageToVideo"}

    async def _longcat_nodes():
        return {"WanVideoModelLoader"}

    monkeypatch.setattr(engine_registry, "_fetch_h3_nodes", _h3_nodes)
    monkeypatch.setattr(engine_registry, "_fetch_longcat_nodes", _longcat_nodes)
    app.dependency_overrides[get_pool] = _dead_pool
    try:
        r = client.get("/api/drama/video-generators", headers=H)
    finally:
        app.dependency_overrides.pop(get_pool, None)
    assert r.status_code == 200, r.text
    gens = {g["name"]: g for g in r.json()["generators"]}
    assert set(gens) == {"ltx", "h3", "seedance", "kling", "liveact"}
    # ltx 仅余 R18 链路:SFW 上下文 ltx-nsfw-t2v 被过滤 → 不可用且带原因;h3 独立实例在线 → 可用
    assert gens["ltx"]["available"] is False
    assert gens["ltx"]["unavailable_reason"]
    assert gens["h3"]["available"] is True
    # stub 固定不可用
    assert gens["seedance"]["available"] is False
    assert gens["kling"]["available"] is False
    # liveact 可用性 = 当前配置是否给了 worker 基址
    liveact_expected = bool(get_settings().liveact_base)
    assert gens["liveact"]["available"] is liveact_expected
    if not liveact_expected:
        assert "LiveAct" in gens["liveact"]["unavailable_reason"]


def test_generate_video_v2_unsupported(ctx):
    """M6: POST generate-video-v2 model=seedance(stub)→ 501。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video-v2",
        headers=H,
        json={"model": "seedance"},
    )
    assert r.status_code == 501, r.text
    assert "stub" in r.json()["detail"] or "尚未接入" in r.json()["detail"]


def test_generate_video_v2_unknown_model(ctx):
    """M6: 未知 model 名称 → 400。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video-v2",
        headers=H,
        json={"model": "nonexistent-model"},
    )
    assert r.status_code == 400, r.text
    assert "未知视频生成器" in r.json()["detail"]


def test_v2_error_status_classification():
    """P3: _v2_error_status 语义分类 —— 未接入/未部署→501,上游不可达/超时→503,其余→502。"""
    from app.routes.drama_studio import _v2_error_status

    assert _v2_error_status("Seedance 生成器尚未接入,当前为 stub") == 501
    assert _v2_error_status("Kling 生成器尚未接入,当前为 stub") == 501
    assert _v2_error_status("LiveAct 未部署") == 501
    assert _v2_error_status("LiveAct worker 不可达:ConnectError") == 503
    assert _v2_error_status("LiveAct 生成超时(20 分钟)") == 503
    assert _v2_error_status("没有具备所需模型且可用的 worker") == 503
    assert _v2_error_status("ComfyUI 拒绝了工作流: missing node") == 502
    assert _v2_error_status("其他错误") == 502


def test_generate_video_v2_single_candidate_upstream_error(ctx):
    """P3: v2 单候选上游失败按语义分状态码,不再一律 501。"""
    from app.services.video_generators import VideoGenResult

    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)

    def _gen_with_error(msg: str):
        gen = MagicMock()
        gen.generate = AsyncMock(
            return_value=VideoGenResult(success=False, model="ltx", error=msg)
        )
        return gen

    # 上游无可用 worker → 503
    with patch(
        "app.services.video_generators.get_generator",
        return_value=_gen_with_error("没有具备所需模型且可用的 worker"),
    ):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "ltx"},
        )
    assert r.status_code == 503, r.text

    # 上游拒绝工作流 → 502
    with patch(
        "app.services.video_generators.get_generator",
        return_value=_gen_with_error("ComfyUI 拒绝了工作流: missing node"),
    ):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "ltx"},
        )
    assert r.status_code == 502, r.text

    # 失败已回写 shot 状态
    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "拒绝了工作流" in shot.error


# ---------------------------------------------------------------------------
# M1: 分镜可视化流水线 — 单镜多候选生成 + 候选管理
# ---------------------------------------------------------------------------
def _fake_video_generator(prompt_ids: list[str]):
    """构造 mock 视频生成器,按顺序返回 prompt_ids 作为 job_id。"""
    from app.services.video_generators import VideoGenResult

    gen = MagicMock()
    call_idx = [0]

    async def _generate(*args, **kwargs):
        idx = call_idx[0]
        call_idx[0] += 1
        pid = prompt_ids[idx] if idx < len(prompt_ids) else f"pid-{idx}"
        return VideoGenResult(
            success=True,
            job_id=pid,
            model="ltx",
            raw={
                "prompt_id": pid,
                "client_id": "cid",
                "worker": "http://worker",
                "seed": kwargs.get("seed", 0),
            },
        )

    gen.generate = AsyncMock(side_effect=_generate)
    return gen


def test_generate_video_v2_multi_candidate(ctx):
    """M1: num_candidates=3 创建 3 条 candidate 记录并返回列表。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    fake_gen = _fake_video_generator(["pid-c0", "pid-c1", "pid-c2"])
    with patch("app.services.video_generators.get_generator", return_value=fake_gen), \
         patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={})):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "ltx", "num_candidates": 3},
        )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["num_candidates"] == 3
    assert len(data["candidates"]) == 3
    assert all(c["status"] == "generating" for c in data["candidates"])
    assert all(c["shot_id"] == sid for c in data["candidates"])

    # project detail 里 shot 应携带 candidates
    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    shot = next(s for s in proj["shots"] if s["id"] == sid)
    assert shot["video_status"] == "generating"
    assert shot["video_url"] == ""
    assert len(shot["candidates"]) == 3


def test_list_candidates_empty(ctx):
    """M1: 无候选时分镜候选列表返回空数组。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    r = client.get(f"/api/drama/shots/{sid}/candidates", headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_pick_and_delete_candidate(ctx):
    """M1: 多候选生成后 pick 一个,再删除 active 候选回退 shot 状态。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    fake_gen = _fake_video_generator(["pid-c0", "pid-c1"])
    with patch("app.services.video_generators.get_generator", return_value=fake_gen), \
         patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={})):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "ltx", "num_candidates": 2},
        )

    assert r.status_code == 200, r.text
    cids = [c["id"] for c in r.json()["candidates"]]

    # pick 第二个候选
    r = client.post(f"/api/drama/shots/{sid}/candidates/{cids[1]}/pick", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["is_picked"] is True

    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    shot = next(s for s in proj["shots"] if s["id"] == sid)
    assert shot["video_status"] == "done"
    picked = next(c for c in shot["candidates"] if c["id"] == cids[1])
    assert picked["is_picked"] is True
    assert shot["video_url"] == picked["url"]
    # 其余候选 unpick
    assert all(c["is_picked"] is False for c in shot["candidates"] if c["id"] != cids[1])

    # 删除 active 候选,其余候选因 wait_for_jobs mock 已变为 error,shot 回退到 pending
    r = client.delete(f"/api/drama/shots/{sid}/candidates/{cids[1]}", headers=H)
    assert r.status_code == 200, r.text
    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    shot = next(s for s in proj["shots"] if s["id"] == sid)
    assert shot["video_status"] == "pending"
    assert shot["video_url"] == ""


def test_generate_video_v2_multi_candidate_auto_pick(ctx):
    """M1: 首个完成的候选自动被 pick 为 active。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    fake_gen = _fake_video_generator(["pid-fast", "pid-slow"])
    with patch("app.services.video_generators.get_generator", return_value=fake_gen), \
         patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
             "pid-fast": ["/api/images?filename=fast.mp4&worker=http://worker"],
         })):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "ltx", "num_candidates": 2},
        )
        assert r.status_code == 200, r.text

        # 给后台 _writeback_candidate 任务一点时间启动
        import time
        time.sleep(0.3)

        # 轮询直到有候选被 pick
        deadline = time.time() + 3
        picked = None
        while time.time() < deadline:
            proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
            shot = next(s for s in proj["shots"] if s["id"] == sid)
            for c in shot["candidates"]:
                if c["is_picked"]:
                    picked = c
                    break
            if picked:
                break
            time.sleep(0.05)
        assert picked is not None
        assert picked["url"] == "/api/images?filename=fast.mp4&worker=http://worker"
        assert shot["video_url"] == picked["url"]
        assert shot["video_status"] == "done"


def test_generate_video_v2_single_candidate_writeback(ctx):
    """P0 修复: v2 单候选(num_candidates=1)提交后挂回写任务,tracker 落库后 shot 推进到 done。"""
    import json
    import time

    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    fake_gen = _fake_video_generator(["pid-single"])
    video_url = "/api/images?filename=single.mp4&worker=http://worker"

    async def _fake_wait(session, prompt_ids, **kwargs):
        # 模拟 tracker 落库:Job 标 done 并写产物 URL(回写依赖 Job 行状态)
        from app.db import engine

        with Session(engine) as s:
            job = s.exec(select(Job).where(Job.prompt_id == prompt_ids[0])).first()
            job.status = "done"
            job.result = json.dumps([video_url])
            s.add(job)
            s.commit()
        return {prompt_ids[0]: [video_url]}

    with patch("app.services.video_generators.get_generator", return_value=fake_gen), \
         patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(side_effect=_fake_wait)):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "ltx", "seed": 42},  # num_candidates 默认 1 → 单候选分支
        )
        assert r.status_code == 200, r.text
        assert r.json()["prompt_id"] == "pid-single"

        # 轮询直到后台回写把 shot 推进到 done
        deadline = time.time() + 3
        shot = None
        while time.time() < deadline:
            proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
            shot = next(s for s in proj["shots"] if s["id"] == sid)
            if shot["video_status"] == "done":
                break
            time.sleep(0.05)
        assert shot is not None and shot["video_status"] == "done"
        assert shot["video_url"] == video_url


def test_generate_video_sfw_nsfw_ckpt_split(ctx):
    """SFW/NSFW 底模分流:默认(无 nsfw)用 SFW 底模,nsfw=True(须 X-NSFW 头)才用 10Eros。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid_sfw = _make_shot(ctx, token)
    _, sid_nsfw = _make_shot(ctx, token)

    pool, cli = _fake_pool(["pid-sfw", "pid-nsfw"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={})):
            r_sfw = client.post(
                f"/api/drama/shots/{sid_sfw}/generate-video", headers=H, json={}
            )
            # nsfw=True 走 10Eros 成人底模,属 R18 门控:须带 X-NSFW 头(模拟 /nsfw 专区)
            r_nsfw = client.post(
                f"/api/drama/shots/{sid_nsfw}/generate-video",
                headers={**H, "X-NSFW": "1"},
                json={"nsfw": True},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r_sfw.status_code == 200, r_sfw.text
    assert r_nsfw.status_code == 200, r_nsfw.text
    settings = get_settings()
    g_sfw = cli.queue_prompt.call_args_list[0][0][0]
    g_nsfw = cli.queue_prompt.call_args_list[1][0][0]
    assert g_sfw["1"]["inputs"]["unet_name"] == settings.default_video_ckpt
    assert g_nsfw["1"]["inputs"]["unet_name"] == settings.nsfw_default_video_ckpt


# ---------------------------------------------------------------------------
# P0 修复: IPAdapter 角色首帧 —— 次世代底模明确回退 / 传统 checkpoint 正常生成
# ---------------------------------------------------------------------------
def _make_shot_with_char(ctx, token: str) -> tuple[str, str]:
    """建项目 + 1 个分镜,并关联一个带参考图的角色,返回 (pid, sid)。"""
    from app.db import engine

    pid, sid = _make_shot(ctx, token)
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.characters = '["阿明"]'
        s.add(shot)
        s.add(DramaCharacter(project_id=pid, name="阿明", ref_image="/img/ref.png"))
        s.commit()
    return pid, sid


def test_keyframe_pulid_nextgen_falls_back(ctx):
    """次世代默认底模(flux2)且 pool 无 PuLID 能力:明确跳过首帧,不向 worker 提交。"""
    import asyncio

    from app.comfy.client import ComfyUIError
    from app.db import engine
    from app.routes.drama_studio import _generate_keyframe_for_shot

    _, token, _ = ctx
    pid, sid = _make_shot_with_char(ctx, token)

    mock_client = MagicMock()
    mock_client.upload_image = AsyncMock()
    pool = MagicMock()
    pool.pick = AsyncMock(side_effect=ComfyUIError("没有具备所需模型且可用的 worker"))
    settings = MagicMock(
        default_ckpt="flux2_dev_fp8mixed.safetensors",
        pulid_flux_ckpt="flux1-dev-fp8.safetensors",
    )
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        project = s.get(DramaProject, pid)
        result = asyncio.run(
            _generate_keyframe_for_shot(mock_client, shot, project, settings, s, pool)
        )
    assert result is None
    mock_client.upload_image.assert_not_called()


def test_keyframe_pulid_nextgen_uses_pulid_flux(ctx):
    """次世代默认底模(flux2)且 pool 有 PuLID:走 PuLID-Flux(FLUX.1)生成角色一致首帧。"""
    import asyncio

    from app.db import engine
    from app.routes.drama_studio import _generate_keyframe_for_shot
    from app.workflows.pulid import REQUIRED_NODES

    _, token, _ = ctx
    pid, sid = _make_shot_with_char(ctx, token)

    mock_client = MagicMock()
    mock_client.upload_image = AsyncMock(side_effect=["ref.png", "kf.png"])
    mock_client.queue_prompt = AsyncMock(return_value="pid-kf")
    mock_client.get_result_files = AsyncMock(
        return_value=[{"filename": "out.png", "subfolder": "", "type": "output"}]
    )
    mock_client.get_image_bytes = AsyncMock(return_value=(b"img", "image/png"))
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=mock_client)
    settings = MagicMock(
        default_ckpt="flux2_dev_fp8mixed.safetensors",
        pulid_flux_ckpt="flux1-dev-fp8.safetensors",
    )
    with Session(engine) as s, \
         patch("app.routes.drama_studio._fetch_ref_image_bytes", AsyncMock(return_value=b"ref")):
        shot = s.get(DramaShot, sid)
        project = s.get(DramaProject, pid)
        result = asyncio.run(
            _generate_keyframe_for_shot(mock_client, shot, project, settings, s, pool)
        )

    assert result == "kf.png"
    # pool 探测要求 PuLID 节点 + FLUX.1 底模
    pick_kw = pool.pick.call_args.kwargs
    assert pick_kw["required"] == {"flux1-dev-fp8.safetensors"}
    assert pick_kw["required_nodes"] == REQUIRED_NODES
    graph = mock_client.queue_prompt.call_args[0][0]
    classes = {n["class_type"] for n in graph.values()}
    assert "ApplyPulidFlux" in classes
    assert "IPAdapterAdvanced" not in classes
    ckpt_nodes = [n for n in graph.values() if n.get("class_type") == "CheckpointLoaderSimple"]
    assert ckpt_nodes, "PuLID 图必须包含 CheckpointLoaderSimple"
    assert ckpt_nodes[0]["inputs"]["ckpt_name"] == "flux1-dev-fp8.safetensors"


def test_keyframe_ipadapter_traditional_ckpt(ctx):
    """传统 checkpoint 底模:走 IPAdapter 生成角色一致首帧,返回上传后的文件名。"""
    import asyncio

    from app.db import engine
    from app.routes.drama_studio import _generate_keyframe_for_shot

    _, token, _ = ctx
    pid, sid = _make_shot_with_char(ctx, token)

    mock_client = MagicMock()
    mock_client.upload_image = AsyncMock(side_effect=["ref.png", "kf.png"])
    mock_client.queue_prompt = AsyncMock(return_value="pid-kf")
    mock_client.get_result_files = AsyncMock(
        return_value=[{"filename": "out.png", "subfolder": "", "type": "output"}]
    )
    mock_client.get_image_bytes = AsyncMock(return_value=(b"img", "image/png"))
    settings = MagicMock(default_ckpt="realistic_v5.safetensors")
    with Session(engine) as s, \
         patch("app.routes.drama_studio._fetch_ref_image_bytes", AsyncMock(return_value=b"ref")):
        shot = s.get(DramaShot, sid)
        project = s.get(DramaProject, pid)
        result = asyncio.run(
            _generate_keyframe_for_shot(mock_client, shot, project, settings, s, MagicMock())
        )

    assert result == "kf.png"
    graph = mock_client.queue_prompt.call_args[0][0]
    ckpt_nodes = [n for n in graph.values() if n.get("class_type") == "CheckpointLoaderSimple"]
    assert ckpt_nodes, "IPAdapter 图必须包含 CheckpointLoaderSimple"
    assert ckpt_nodes[0]["inputs"]["ckpt_name"] == "realistic_v5.safetensors"


# ===========================================================================
# AICG 四层模型流水线 — L2 润色 / L3 精修 / L3 异步批量精修 测试
# ===========================================================================

def test_refine_l2_success(ctx):
    """L2 主力润色:mock llm.chat_layered 返回润色后文本,验证响应 + process_data 记录。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "L2 测试", "script": "原剧本对白。"},
    ).json()["id"]

    fake_msg = {"content": "润色后的剧本对白,情感更饱满。"}
    with (
        # 润色层由独立配置决定(drama_refine_layer,默认 L2);此处钉住 L2 验证层透传
        patch.object(get_settings(), "drama_refine_layer", "L2"),
        patch(
            "app.routes.drama_studio.llm.chat_layered",
            AsyncMock(return_value=fake_msg),
        ),
    ):
        r = client.post(
            f"/api/drama/projects/{pid}/refine",
            headers=H,
            json={"text": "原剧本对白。"},
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["layer"] == "L2"
    assert data["refined"] == "润色后的剧本对白,情感更饱满。"
    assert data["original"] == "原剧本对白。"

    # process_data 应有 refine_l2 记录
    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    steps = proj["process_data"]
    assert any(s["step"] == "refine_l2" for s in steps)


def test_refine_l2_empty_text(ctx):
    """L2 润色:空文本 → 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/refine", headers=H, json={"text": "  "}
    )
    assert r.status_code == 422, r.text
    assert "为空" in r.json()["detail"]


def test_refine_l2_llm_error(ctx):
    """L2 润色:LLM 调用失败 → 503。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    with patch(
        "app.routes.drama_studio.llm.chat_layered",
        AsyncMock(side_effect=llm.LLMError("EXO 不可用")),
    ):
        r = client.post(
            f"/api/drama/projects/{pid}/refine",
            headers=H,
            json={"text": "对白"},
        )
    assert r.status_code == 503, r.text
    assert "EXO 不可用" in r.json()["detail"]


def test_refine_l2_other_user_404(ctx):
    """L2 润色:非项目 owner → 404。"""
    client, token, token2 = ctx
    H = _h(token)
    H2 = _h(token2)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/refine", headers=H2, json={"text": "对白"}
    )
    assert r.status_code == 404, r.text


def test_polish_l3_success(ctx):
    """L3 终稿精修:mock llm.chat_layered 返回精修文本,验证响应 + process_data。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "L3 测试", "script": "原稿。"},
    ).json()["id"]

    fake_msg = {"content": "终稿精修后的高质量文本。"}
    with (
        # 精修层由配置决定(默认 L1);此处钉住 L3 验证层透传
        patch.object(get_settings(), "drama_polish_layer", "L3"),
        patch(
            "app.routes.drama_studio.llm.chat_layered",
            AsyncMock(return_value=fake_msg),
        ),
    ):
        r = client.post(
            f"/api/drama/projects/{pid}/polish",
            headers=H,
            json={"text": "原稿。"},
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["layer"] == "L3"
    assert data["polished"] == "终稿精修后的高质量文本。"

    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert any(s["step"] == "polish_l3" for s in proj["process_data"])


def test_polish_l3_empty_content(ctx):
    """L3 精修:LLM 返回空内容 → 502。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    with patch(
        "app.routes.drama_studio.llm.chat_layered",
        AsyncMock(return_value={"content": "  "}),
    ):
        r = client.post(
            f"/api/drama/projects/{pid}/polish",
            headers=H,
            json={"text": "原稿"},
        )
    assert r.status_code == 502, r.text
    assert "空内容" in r.json()["detail"]


def test_polish_batch_starts_and_returns_task_id(ctx):
    """L3 异步批量精修:立即返回 task_id,初始状态 pending。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token, prompt="原分镜 prompt")

    r = client.post(
        f"/api/drama/projects/{pid}/polish/batch",
        headers=H,
        json={"shot_ids": [sid]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "pending"
    assert data["total"] == 1
    assert "task_id" in data
    assert "poll_url" in data


def test_polish_batch_with_texts(ctx):
    """L3 批量精修:用 texts 数组(无 shot_ids)启动。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/polish/batch",
        headers=H,
        json={"texts": ["文本1", "文本2"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 2


def test_polish_batch_empty_request(ctx):
    """L3 批量精修:shot_ids 和 texts 都空 → 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/polish/batch",
        headers=H,
        json={},
    )
    assert r.status_code == 422, r.text


def test_polish_batch_shot_not_found(ctx):
    """L3 批量精修:shot_id 不存在 → 404。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.post(
        f"/api/drama/projects/{pid}/polish/batch",
        headers=H,
        json={"shot_ids": ["nonexistent-shot-id"]},
    )
    assert r.status_code == 404, r.text


def test_polish_batch_shot_wrong_project(ctx):
    """L3 批量精修:shot 归属其他项目 → 404。"""
    client, token, _ = ctx
    H = _h(token)
    # 项目 A 的分镜
    pid_a, sid_a = _make_shot(ctx, token, prompt="A 的分镜")
    # 项目 B
    pid_b = client.post(
        "/api/drama/projects", headers=H, json={"title": "B"}
    ).json()["id"]
    # 把 A 的分镜 ID 传给 B → 应 404
    r = client.post(
        f"/api/drama/projects/{pid_b}/polish/batch",
        headers=H,
        json={"shot_ids": [sid_a]},
    )
    assert r.status_code == 404, r.text


def test_polish_batch_empty_shot_skipped(ctx):
    """L3 批量精修:分镜内容为空(prompt+dialogue+scene 全空)→ 被跳过,items 空 → 422。

    注:storyboard 路由对 prompt 全空的分镜会前置 422(storyboard 自身校验),
    所以这里用 _make_shot 建一个有 prompt 的分镜,再 PATCH 清空 prompt/scene/dialogue。
    """
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token, prompt="待清空的 prompt")
    # PATCH 清空 prompt/scene/dialogue,模拟"空分镜"
    pd = client.patch(
        f"/api/drama/shots/{sid}",
        headers=H,
        json={"prompt": "", "scene": "", "dialogue": ""},
    )
    assert pd.status_code == 200, pd.text

    r2 = client.post(
        f"/api/drama/projects/{pid}/polish/batch",
        headers=H,
        json={"shot_ids": [sid]},
    )
    assert r2.status_code == 422, r2.text
    assert "为空" in r2.json()["detail"]


def test_get_polish_task_not_found(ctx):
    """查询不存在的 task_id → 404。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.get(
        f"/api/drama/projects/{pid}/polish-tasks/nonexistent-task-id",
        headers=H,
    )
    assert r.status_code == 404, r.text


def test_list_polish_tasks_empty(ctx):
    """项目无批量精修任务 → 空数组。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x"}
    ).json()["id"]
    r = client.get(f"/api/drama/projects/{pid}/polish-tasks", headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_polish_batch_e2e_with_mock(ctx):
    """L3 批量精修 E2E:mock chat_layered,验证任务从 pending→done + 分镜 prompt 回写。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token, prompt="原始 prompt 待精修")

    # mock chat_layered 返回精修后的 prompt
    fake_msg = {"content": "精修后的高质量 prompt,cinematic, masterpiece"}
    with patch(
        "app.routes.drama_studio.llm.chat_layered",
        AsyncMock(return_value=fake_msg),
    ):
        # 启动批量精修
        r = client.post(
            f"/api/drama/projects/{pid}/polish/batch",
            headers=H,
            json={"shot_ids": [sid], "concurrency": 1},
        )
        assert r.status_code == 200, r.text
        task_id = r.json()["task_id"]

        # 轮询直到 done(最多 5 秒)
        import time
        deadline = time.time() + 5
        final_status = None
        while time.time() < deadline:
            gr = client.get(
                f"/api/drama/projects/{pid}/polish-tasks/{task_id}", headers=H
            )
            assert gr.status_code == 200, gr.text
            td = gr.json()
            final_status = td["status"]
            if final_status == "done":
                break
            time.sleep(0.1)

        assert final_status == "done", f"任务未在 5s 内完成,最后状态: {final_status}"

    # 验证分镜 prompt 已被回写
    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    shot = next(s for s in proj["shots"] if s["id"] == sid)
    assert "精修后的高质量 prompt" in shot["prompt"]

    # 验证列表端点能查到
    lr = client.get(f"/api/drama/projects/{pid}/polish-tasks", headers=H)
    assert lr.status_code == 200, lr.text
    tasks = lr.json()
    assert len(tasks) >= 1
    assert any(t["task_id"] == task_id for t in tasks)


def test_polish_batch_partial_failure(ctx):
    """L3 批量精修:部分分镜失败不影响其他,最终 status=done,results 含 error。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid1 = _make_shot(ctx, token, prompt="分镜1")
    # 再拆一个分镜(用不同 prompt)
    pid2, sid2 = _make_shot(ctx, token, prompt="分镜2")
    # 注意:_make_shot 每次新建项目,这里把 sid2 的分镜挪到 pid 项目下不可行
    # 改为直接在 pid 项目下用 texts 批量精修(2 条文本,1 成功 1 失败)

    call_count = [0]

    async def _fake_chat_layered(messages, layer="L1", **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return {"content": "精修成功的内容"}
        raise llm.LLMError("GLM-5.2 超时")

    with patch(
        "app.routes.drama_studio.llm.chat_layered",
        side_effect=_fake_chat_layered,
    ):
        r = client.post(
            f"/api/drama/projects/{pid}/polish/batch",
            headers=H,
            json={"texts": ["文本1", "文本2"], "concurrency": 1},
        )
        assert r.status_code == 200, r.text
        task_id = r.json()["task_id"]

        import time
        deadline = time.time() + 5
        final = None
        while time.time() < deadline:
            gr = client.get(
                f"/api/drama/projects/{pid}/polish-tasks/{task_id}", headers=H
            )
            td = gr.json()
            final = td
            if td["status"] == "done":
                break
            time.sleep(0.1)

    assert final is not None
    assert final["status"] == "done"
    assert final["total"] == 2
    assert final["done"] == 2
    statuses = [r["status"] for r in final["results"]]
    assert "done" in statuses
    assert "error" in statuses


# ---------------------------------------------------------------------------
# M5: 播放数据反哺创作
# ---------------------------------------------------------------------------
def test_playback_insights_empty(ctx):
    """M5: 无播放数据时返回 0 指标与默认建议。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)

    r = client.get(f"/api/drama/projects/{pid}/playback-insights", headers=H)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["project"]["sessions"] == 0
    assert data["project"]["completion_rate"] == 0.0
    assert len(data["shots"]) == 1
    assert data["shots"][0]["shot_id"] == sid
    assert data["shots"][0]["heat_score"] == 0.0
    assert "暂无播放数据" in data["shots"][0]["suggestions"][0]


def test_playback_insights_with_events(ctx):
    """M5: 模拟 2 次会话 + 播放/点赞/完播事件,验证分镜热度与建议。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)

    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.start_sec = 0.0
        shot.duration_sec = 5
        s.add(shot)
        s.commit()

        # 构造 2 个会话:都进入并看完该镜,其中 1 个点赞
        for idx in range(2):
            session_id = f"sess-{idx}"
            sess = DramaSession(
                session_id=session_id,
                user_id="u1",
                drama_id=pid,
                video_url="/x.mp4",
                is_completed=True,
                started_at=datetime.now(timezone.utc),
                ended_at=datetime.now(timezone.utc),
                duration_sec=5.0,
                drop_off_at=5.0,
            )
            s.add(sess)
            s.add(
                DramaEvent(
                    event_id=f"play-{idx}",
                    session_id=session_id,
                    user_id="u1",
                    drama_id=pid,
                    event_type="play",
                    current_time=1.0,
                    client_ts=1,
                )
            )
            s.add(
                DramaEvent(
                    event_id=f"like-{idx}",
                    session_id=session_id,
                    user_id="u1",
                    drama_id=pid,
                    event_type="like",
                    current_time=2.0,
                    client_ts=2,
                )
            )
            if idx == 0:
                s.add(
                    DramaEvent(
                        event_id=f"replay-{idx}",
                        session_id=session_id,
                        user_id="u1",
                        drama_id=pid,
                        event_type="replay",
                        current_time=3.0,
                        client_ts=3,
                    )
                )
        s.commit()

    r = client.get(f"/api/drama/projects/{pid}/playback-insights", headers=H)
    assert r.status_code == 200, r.text
    data = r.json()
    proj = data["project"]
    assert proj["sessions"] == 2
    assert proj["plays"] == 2
    assert proj["completed"] == 2
    assert proj["completion_rate"] == 1.0
    assert proj["engagement_rate"] == 1.0

    shot = data["shots"][0]
    assert shot["enters"] == 2
    assert shot["completion_rate"] == 1.0
    assert shot["like_count"] == 2
    assert shot["heat_score"] > 90
    assert any("高互动" in sug or "完播率高" in sug for sug in shot["suggestions"])


def test_playback_insights_drop_off_suggestion(ctx):
    """M5: 高流失分镜应给出流失优化建议。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)

    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.start_sec = 0.0
        shot.duration_sec = 5
        s.add(shot)
        s.commit()

        # 5 个会话进入,4 个在该镜流失
        for idx in range(5):
            session_id = f"sess-drop-{idx}"
            drop_at = 1.0 if idx < 4 else 5.0
            sess = DramaSession(
                session_id=session_id,
                user_id="u1",
                drama_id=pid,
                video_url="/x.mp4",
                is_completed=(idx >= 4),
                started_at=datetime.now(timezone.utc),
                ended_at=datetime.now(timezone.utc),
                duration_sec=drop_at,
                drop_off_at=drop_at,
            )
            s.add(sess)
            s.add(
                DramaEvent(
                    event_id=f"play-drop-{idx}",
                    session_id=session_id,
                    user_id="u1",
                    drama_id=pid,
                    event_type="play",
                    current_time=0.5,
                    client_ts=1,
                )
            )
        s.commit()

    r = client.get(f"/api/drama/projects/{pid}/playback-insights", headers=H)
    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    assert shot["enters"] == 5
    assert shot["drop_offs"] == 4
    assert any("流失严重" in sug for sug in shot["suggestions"])


def test_playback_insights_other_user_404(ctx):
    """M5: 其他用户访问播放洞察返回 404。"""
    client, token, token2 = ctx
    H = _h(token)
    pid, _ = _make_shot(ctx, token)
    r = client.get(
        f"/api/drama/projects/{pid}/playback-insights",
        headers=_h(token2),
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# LiveAct 全身数字人(generate-video-v2 model=liveact 分支)
# ---------------------------------------------------------------------------
_LIVEACT_VOICE = f"voice-{'a' * 32}.wav"


def _prepare_liveact_shot(
    sid: str, *, with_ref: bool = True, ref_url: str = "/api/drama/assets/ref.png"
) -> None:
    """直接把 shot 置为配音完成;with_ref 时建一个带参考图的出场角色。"""
    from app.db import engine

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.voice_status = "done"
        shot.voice_url = f"/api/drama/voice/{_LIVEACT_VOICE}"
        if with_ref:
            shot.characters = '["阿明"]'
            s.add(
                DramaCharacter(
                    project_id=shot.project_id,
                    name="阿明",
                    ref_image=ref_url,
                )
            )
        s.add(shot)
        s.commit()


def _fake_liveact_generator(task_id: str = "task-abc"):
    """构造 mock LiveAct 生成器,返回 task_id。"""
    from app.services.video_generators import VideoGenResult

    gen = MagicMock()
    gen.generate = AsyncMock(
        return_value=VideoGenResult(
            success=True,
            job_id=task_id,
            model="liveact",
            raw={"task_id": task_id, "worker": "http://192.168.71.127:9400"},
        )
    )
    return gen


def _mock_ref_download():
    """mock drama_studio 内的 httpx.AsyncClient,参考图下载返回固定字节。"""
    resp = MagicMock()
    resp.content = b"fake-png"
    http = AsyncMock()
    http.__aenter__.return_value = http
    http.get = AsyncMock(return_value=resp)
    return http


def test_generate_video_v2_liveact_multi_candidate_422(ctx):
    """LiveAct 不支持多候选 → 422。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video-v2",
        headers=H,
        json={"model": "liveact", "num_candidates": 2},
    )
    assert r.status_code == 422, r.text
    assert "多候选" in r.json()["detail"]


def test_generate_video_v2_liveact_voice_not_done_422(ctx):
    """配音未完成 → 422 提示先配音。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video-v2",
        headers=H,
        json={"model": "liveact"},
    )
    assert r.status_code == 422, r.text
    assert "配音" in r.json()["detail"]


def test_generate_video_v2_liveact_no_ref_image_422(ctx):
    """配音完成但无角色参考图 → 422 提示设参考图。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    _prepare_liveact_shot(sid, with_ref=False)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video-v2",
        headers=H,
        json={"model": "liveact"},
    )
    assert r.status_code == 422, r.text
    assert "参考图" in r.json()["detail"]


def test_generate_video_v2_liveact_voice_file_missing_422(ctx):
    """voice_url 指向的 wav 不在盘上 → 422 提示重新配音。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid = _make_shot(ctx, token)
    _prepare_liveact_shot(sid)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video-v2",
        headers=H,
        json={"model": "liveact"},
    )
    assert r.status_code == 422, r.text
    assert "配音文件" in r.json()["detail"]


def test_generate_video_v2_liveact_submit_success(ctx, tmp_path):
    """LiveAct 提交成功 → 200 + task_id,shot 置 generating,后台任务被创建。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    _prepare_liveact_shot(sid)
    (tmp_path / _LIVEACT_VOICE).write_bytes(b"RIFF-fake-wav")

    fake_gen = _fake_liveact_generator()
    with patch("app.services.video_generators.get_generator", return_value=fake_gen), \
         patch("app.routes.drama_studio.httpx.AsyncClient", return_value=_mock_ref_download()), \
         patch("app.routes.drama_studio._drama_dir", lambda: tmp_path), \
         patch("app.routes.drama_studio._await_liveact_result", AsyncMock()):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": "liveact"},
        )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["task_id"] == "task-abc"
    assert data["model"] == "liveact"
    # generate() 收到了参考图与音频字节
    kwargs = fake_gen.generate.call_args.kwargs
    assert kwargs["ref_image_bytes"] == b"fake-png"
    assert kwargs["audio_bytes"] == b"RIFF-fake-wav"
    # shot 立即置 generating,video_model 记录 liveact
    proj = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    shot = next(s for s in proj["shots"] if s["id"] == sid)
    assert shot["video_status"] == "generating"
    assert shot["video_model"] == "liveact"


def test_generate_video_v2_liveact_ref_via_images_url(ctx, tmp_path):
    """参考图为 /api/images? 产物 URL 时走 pool worker 直读(HTTP 自调会 401)。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    _prepare_liveact_shot(
        sid,
        ref_url="/api/images?filename=ref.png&type=output&worker=http://192.168.71.127:8189",
    )
    (tmp_path / _LIVEACT_VOICE).write_bytes(b"RIFF-fake-wav")

    worker_cli = MagicMock()
    worker_cli.base_url = "http://192.168.71.127:8189"
    worker_cli.get_image_bytes = AsyncMock(return_value=(b"pool-png", None))
    pool = MagicMock()
    pool.clients = [worker_cli]
    app.dependency_overrides[get_pool] = lambda: pool

    fake_gen = _fake_liveact_generator()
    try:
        with patch("app.services.video_generators.get_generator", return_value=fake_gen), \
             patch("app.routes.drama_studio.resolve_worker", return_value=worker_cli), \
             patch("app.routes.drama_studio._drama_dir", lambda: tmp_path), \
             patch("app.routes.drama_studio._await_liveact_result", AsyncMock()):
            r = client.post(
                f"/api/drama/shots/{sid}/generate-video-v2",
                headers=H,
                json={"model": "liveact"},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    worker_cli.get_image_bytes.assert_awaited_once_with("ref.png", "", "output")
    kwargs = fake_gen.generate.call_args.kwargs
    assert kwargs["ref_image_bytes"] == b"pool-png"


@pytest.mark.asyncio
async def test_liveact_await_writeback_done(ctx, tmp_path):
    """后台轮询:worker done → 拉 /result 落盘,shot 回写 done + video_url。"""
    from app.db import engine
    from app.routes.drama_studio import _await_liveact_result

    _, token, _ = ctx
    _, sid = _make_shot(ctx, token)
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.video_status = "generating"
        s.add(shot)
        s.commit()

    status_resp = MagicMock()
    status_resp.json.return_value = {
        "status": "done",
        "progress": 1,
        "error": None,
        "output_name": "task-abc.mp4",
    }
    result_resp = MagicMock()

    async def _chunks(chunk_size):
        yield b"mp4-"
        yield b"bytes"

    result_resp.aiter_bytes = _chunks
    stream_cm = AsyncMock()
    stream_cm.__aenter__.return_value = result_resp
    stream_cm.__aexit__.return_value = False
    http = AsyncMock()
    http.__aenter__.return_value = http
    http.get = AsyncMock(side_effect=[status_resp])
    http.stream = MagicMock(return_value=stream_cm)

    fake_settings = MagicMock()
    fake_settings.liveact_base = "http://192.168.71.127:9400"
    with patch("app.routes.drama_studio.get_settings", return_value=fake_settings), \
         patch("app.routes.drama_studio.httpx.AsyncClient", return_value=http), \
         patch("app.routes.drama_studio._drama_dir", lambda: tmp_path):
        await _await_liveact_result(sid, "task-abc")

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_model == "liveact"
        assert shot.video_url.startswith("/api/drama/output/drama-")
        name = shot.video_url.rsplit("/", 1)[-1]
    assert (tmp_path / name).read_bytes() == b"mp4-bytes"


@pytest.mark.asyncio
async def test_liveact_await_writeback_error(ctx):
    """后台轮询:worker error → shot 置 error 并记录错误信息。"""
    from app.db import engine
    from app.routes.drama_studio import _await_liveact_result

    _, token, _ = ctx
    _, sid = _make_shot(ctx, token)
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.video_status = "generating"
        s.add(shot)
        s.commit()

    status_resp = MagicMock()
    status_resp.json.return_value = {"status": "error", "progress": 0.5, "error": "CUDA OOM"}
    http = AsyncMock()
    http.__aenter__.return_value = http
    http.get = AsyncMock(return_value=status_resp)

    fake_settings = MagicMock()
    fake_settings.liveact_base = "http://192.168.71.127:9400"
    with patch("app.routes.drama_studio.get_settings", return_value=fake_settings), \
         patch("app.routes.drama_studio.httpx.AsyncClient", return_value=http):
        await _await_liveact_result(sid, "task-err")

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "CUDA OOM" in shot.error


# ===========================================================================
# 启动 reconcile(服务重启中断收口,P1-2)
# ===========================================================================

def _reconcile_seed(engine, *, video_model: str = "", job_status: str | None = None):
    """落库:1 项目 + 1 个 generating 分镜(可选配套 drama Job)。返回 (shot_id, pid)。"""
    with Session(engine) as s:
        tenant = Tenant(name="rc")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="rc@toiv.ai",
            hashed_password=hash_password("p"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        p = DramaProject(tenant_id=tenant.id, user_id=user.id, title="t")
        s.add(p)
        s.commit()
        s.refresh(p)
        shot = DramaShot(
            project_id=p.id, idx=0, prompt="a boy runs", seed=42,
            video_status="generating", video_model=video_model,
        )
        s.add(shot)
        s.commit()
        s.refresh(shot)
        if job_status is not None:
            s.add(Job(
                tenant_id=tenant.id, user_id=user.id, prompt_id="pid-1",
                worker="http://w:8188", kind="drama_shot_video", status=job_status,
                prompt="a boy runs", seed=42,
                result='["/api/images?filename=x.mp4&worker=w"]' if job_status == "done" else "",
            ))
            s.commit()
        return shot.id, p.id


def test_reconcile_rehangs_generating_shot_with_pending_job(ctx):
    """generating 分镜 + 未终态 Job:按 seed+prompt 找回 prompt_id,重挂回写,不标 error。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, _ = _reconcile_seed(engine, job_status="queued")
    spawned: list = []

    def _fake_spawn(coro):
        spawned.append(coro)
        coro.close()  # 不真正执行,关闭防 RuntimeWarning
        return MagicMock()

    with patch.object(ds, "_spawn", _fake_spawn):
        stats = ds.reconcile_interrupted()

    assert stats["rehang"] == 1
    assert len(spawned) == 1
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "generating"  # 等重挂的回写任务收口


def test_reconcile_marks_error_without_job(ctx):
    """generating 分镜找不回 Job:标 error,不永久 generating。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, _ = _reconcile_seed(engine)
    stats = ds.reconcile_interrupted()

    assert stats["error"] == 1
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "服务重启中断" in shot.error


def test_reconcile_writes_back_done_job(ctx):
    """generating 分镜 + 已 done Job:直接回写 video_url,标 done。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, _ = _reconcile_seed(engine, job_status="done")
    stats = ds.reconcile_interrupted()

    assert stats["writeback"] == 1
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "done"
        assert shot.video_url == "/api/images?filename=x.mp4&worker=w"


def test_reconcile_liveact_shot_marks_error(ctx):
    """LiveAct 分镜 task_id 未持久化,重启后找不回:标 error 提示重新生成。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    sid, _ = _reconcile_seed(engine, video_model="liveact")
    stats = ds.reconcile_interrupted()

    assert stats["error"] == 1
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.video_status == "error"
        assert "LiveAct 任务不可恢复" in shot.error


def test_reconcile_marks_interrupted_autorun_and_batch(ctx):
    """process_data 中非终态 autorun/批量精修记录:标 error 注明可重新触发;done 不动。"""
    from app.db import engine
    import app.routes.drama_studio as ds

    with Session(engine) as s:
        tenant = Tenant(name="rc2")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="rc2@toiv.ai",
            hashed_password=hash_password("p"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        p = DramaProject(tenant_id=tenant.id, user_id=user.id, title="t")
        p.process_data = json.dumps([
            {"step": "autorun", "task_id": "a1", "ts": "t", "status": "running",
             "total": 3, "done": 1, "current": "分镜视频 1/3 完成", "error": ""},
            {"step": "autorun", "task_id": "a0", "ts": "t", "status": "done",
             "total": 3, "done": 3, "current": "", "error": ""},
            {"step": "polish_batch_l3", "task_id": "b1", "ts": "t", "status": "pending",
             "total": 2, "done": 0, "results": []},
        ], ensure_ascii=False)
        s.add(p)
        s.commit()
        s.refresh(p)
        pid = p.id

    stats = ds.reconcile_interrupted()

    assert stats["task_interrupted"] == 2
    with Session(engine) as s:
        p = s.get(DramaProject, pid)
        steps = json.loads(p.process_data)
        a1 = next(st for st in steps if st.get("task_id") == "a1")
        assert a1["status"] == "error"
        assert "服务重启中断,可重新触发" in a1["error"]
        assert a1["current"] == ""
        a0 = next(st for st in steps if st.get("task_id") == "a0")
        assert a0["status"] == "done"  # 已完成的记录不动
        b1 = next(st for st in steps if st.get("task_id") == "b1")
        assert b1["status"] == "error"



# ---------------------------------------------------------------------------
# R18 门控回归(2026-08-08):drama nsfw=true 必须带 X-NSFW 头,否则 403
# 修复前 generate-video / generate-video-v2 的 nsfw 参数完全不校验,
# 主站任意登录用户可直传 nsfw=true 用 10Eros 成人底模,破坏「主站零 R18」。
# ---------------------------------------------------------------------------


def _mk_shot_for_token_user(ctx, *, prompt: str = "a girl, cinematic") -> str:
    """给 ctx 首个用户(d@toiv.ai)建 1 项目 + 1 分镜,返回 shot_id。"""
    from app.db import engine

    with Session(engine) as s:
        user = s.exec(select(User).where(User.email == "d@toiv.ai")).first()
        p = DramaProject(tenant_id=user.tenant_id, user_id=user.id, title="gate")
        s.add(p)
        s.commit()
        s.refresh(p)
        shot = DramaShot(project_id=p.id, idx=0, prompt=prompt, duration_sec=6)
        s.add(shot)
        s.commit()
        s.refresh(shot)
        return shot.id


def test_generate_video_nsfw_blocked_without_x_nsfw(ctx):
    """generate-video:nsfw=true 无 X-NSFW 头 → 403,且不落任何 Job。"""
    from app.db import engine

    client, token, _ = ctx
    sid = _mk_shot_for_token_user(ctx)
    r = client.post(
        f"/api/drama/shots/{sid}/generate-video",
        headers=_h(token),
        json={"nsfw": True},
    )
    assert r.status_code == 403, r.text
    assert "NSFW 专区" in r.json()["detail"]
    with Session(engine) as s:
        assert s.exec(select(Job)).all() == []


def test_generate_video_v2_nsfw_blocked_without_x_nsfw(ctx):
    """generate-video-v2(含多候选 batch 路径):nsfw=true 无 X-NSFW 头 → 403。"""
    from app.db import engine

    client, token, _ = ctx
    sid = _mk_shot_for_token_user(ctx)
    for body in ({"nsfw": True}, {"nsfw": True, "num_candidates": 2}):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=_h(token),
            json=body,
        )
        assert r.status_code == 403, r.text
        assert "NSFW 专区" in r.json()["detail"]
    with Session(engine) as s:
        assert s.exec(select(Job)).all() == []


def test_generate_video_nsfw_allowed_with_x_nsfw(ctx):
    """generate-video:带 X-NSFW: 1 头时门控放行(生成提交 mock,验证全链路 200)。"""
    import app.routes.drama_studio as ds

    client, token, _ = ctx
    sid = _mk_shot_for_token_user(ctx)
    submit = AsyncMock(return_value=("pid-nsfw", "cid-1", "http://w:8188", 7))
    with patch.object(ds, "_submit_shot_video", submit), patch.object(
        ds, "_spawn", lambda coro: coro.close()
    ):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video",
            headers={**_h(token), "X-NSFW": "1"},
            json={"nsfw": True},
        )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "pid-nsfw"
    # nsfw 标记须透传到提交层(10Eros 底模 + Job 打标)
    assert submit.await_args.kwargs["nsfw"] is True


def _dead_pool():
    """无可用 worker 的 mock pool:pick 直接抛 ComfyUIError,隔离真实集群网络。"""
    from app.comfy.client import ComfyUIError

    pool = MagicMock()
    pool.pick = AsyncMock(side_effect=ComfyUIError("test: no worker"))
    return pool


def test_generate_video_v2_nsfw_passes_gate_with_x_nsfw(ctx):
    """generate-video-v2:带 X-NSFW 头不再 403(死 pool 下落到 5xx,证明已过门控)。"""
    client, token, _ = ctx
    sid = _mk_shot_for_token_user(ctx)
    app.dependency_overrides[get_pool] = _dead_pool
    try:
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers={**_h(token), "X-NSFW": "1"},
            json={"nsfw": True},
        )
    finally:
        app.dependency_overrides.pop(get_pool, None)
    assert r.status_code != 403, r.text


def test_generate_video_sfw_default_unaffected(ctx):
    """SFW 默认(nsfw=false)不受新门控影响:主站调用不 403(死 pool 下为 5xx)。"""
    client, token, _ = ctx
    sid = _mk_shot_for_token_user(ctx)
    app.dependency_overrides[get_pool] = _dead_pool
    try:
        for url in (
            f"/api/drama/shots/{sid}/generate-video",
            f"/api/drama/shots/{sid}/generate-video-v2",
        ):
            r = client.post(url, headers=_h(token), json={})
            assert r.status_code != 403, f"{url} 不应被 R18 门控拦截: {r.text}"
    finally:
        app.dependency_overrides.pop(get_pool, None)


# ---------------------------------------------------------------------------
# P2: 宫格阶段B 纪律(VLM 逐格观察实际宫格 + 二次 LLM 据实改写各镜 prompt)
# ---------------------------------------------------------------------------
def test_grid_storyboard_grounding_rewrites_prompts(ctx):
    """阶段B grounded 路径:prompt 被据实改写且含 VLM 观察到的实际要素。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects",
        headers=H,
        json={"title": "短剧", "script": "阿明走在街上,遇到老朋友。"},
    ).json()["id"]

    split_msg = {
        "content": '{"shots":[{"scene":"s0","prompt":"1boy, standing on street",'
        '"characters":["阿明"],"dialogue":"","speaker":"","duration_sec":5}]}'
    }
    rewrite_msg = {
        "content": '{"prompts":[{"index":0,'
        '"prompt":"1boy, red hoodie, sitting by window, wide shot"}]}'
    }
    vlm_raw = '{"panels":[{"index":1,"description":"实际画面:红帽衫男孩坐在窗边,远景"}]}'

    pool, _cli = _fake_pool(["grid-pid-g"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch(
            "app.routes.drama_studio.llm.chat",
            AsyncMock(side_effect=[split_msg, rewrite_msg]),
        ) as chat_mock, patch(
            "app.routes.drama_studio.spawn_tracker", lambda c, p: None
        ), patch(
            "app.routes.drama_studio.wait_for_jobs",
            AsyncMock(return_value={
                "grid-pid-g": ["/api/images?filename=g.png&worker=http://worker"],
            }),
        ), patch(
            "app.routes.drama_studio.fetch_product_image_bytes",
            AsyncMock(return_value=b"\x89PNG-fake"),
        ) as fetch_mock, patch(
            "app.routes.drama_studio._chat_completion", AsyncMock(return_value=vlm_raw)
        ) as vlm_mock:
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 1},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    # prompt 被据实改写,含 VLM 实际观察要素,原想象内容被纠正
    assert "red hoodie" in shot["prompt"]
    assert "sitting by window" in shot["prompt"]
    assert "standing on street" not in shot["prompt"]
    assert shot["detected_colors"]["grounding_status"] == "grounded"
    # VLM 调一次:宫格 base64 data URL + 逐格描述 system(1 镜 ≤9 → 3x3 判定口径)
    assert vlm_mock.await_count == 1
    vlm_system, vlm_part = vlm_mock.await_args[0][0], vlm_mock.await_args[0][1]
    assert "3x3" in vlm_system
    assert vlm_part["type"] == "image_url"
    assert vlm_part["image_url"]["url"].startswith("data:image/png;base64,")
    assert fetch_mock.await_count == 1
    # 两次 LLM:拆镜 + 据实改写
    assert chat_mock.await_count == 2


def test_grid_storyboard_grounding_fallback_on_vlm_failure(ctx):
    """阶段B 降级路径:VLM 不可用 → 保留 LLM 原 prompt,标记 fallback,不再调二次 LLM。"""
    from fastapi import HTTPException

    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x", "script": "剧本..."}
    ).json()["id"]

    split_msg = {
        "content": '{"shots":[{"scene":"s0","prompt":"original prompt",'
        '"characters":[],"dialogue":"","speaker":"","duration_sec":5}]}'
    }
    pool, _cli = _fake_pool(["grid-pid-f"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch(
            "app.routes.drama_studio.llm.chat", AsyncMock(return_value=split_msg)
        ) as chat_mock, patch(
            "app.routes.drama_studio.spawn_tracker", lambda c, p: None
        ), patch(
            "app.routes.drama_studio.wait_for_jobs",
            AsyncMock(return_value={
                "grid-pid-f": ["/api/images?filename=g.png&worker=http://worker"],
            }),
        ), patch(
            "app.routes.drama_studio.fetch_product_image_bytes",
            AsyncMock(return_value=b"\x89PNG-fake"),
        ), patch(
            "app.routes.drama_studio._chat_completion",
            AsyncMock(side_effect=HTTPException(status_code=502, detail="vlm down")),
        ):
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 1},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    assert shot["prompt"] == "original prompt"  # 回落保持原 prompt
    assert shot["detected_colors"]["grounding_status"] == "fallback"
    assert chat_mock.await_count == 1  # 仅拆镜,VLM 失败不再触发二次改写


def test_grid_storyboard_grounding_disabled_by_config(ctx, monkeypatch):
    """TOIV_GRID_GROUNDING_ENABLED=false:不走 VLM、不写 grounding 元数据(零行为变更)。"""
    monkeypatch.setattr(get_settings(), "grid_grounding_enabled", False)
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x", "script": "剧本..."}
    ).json()["id"]

    split_msg = {
        "content": '{"shots":[{"scene":"s0","prompt":"original prompt",'
        '"characters":[],"dialogue":"","speaker":"","duration_sec":5}]}'
    }
    pool, _cli = _fake_pool(["grid-pid-d"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch(
            "app.routes.drama_studio.llm.chat", AsyncMock(return_value=split_msg)
        ), patch(
            "app.routes.drama_studio.spawn_tracker", lambda c, p: None
        ), patch(
            "app.routes.drama_studio.wait_for_jobs",
            AsyncMock(return_value={
                "grid-pid-d": ["/api/images?filename=g.png&worker=http://worker"],
            }),
        ), patch(
            "app.routes.drama_studio._chat_completion", AsyncMock()
        ) as vlm_mock:
            r = client.post(
                f"/api/drama/projects/{pid}/grid-storyboard",
                headers=H,
                json={"num_shots": 1},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    assert vlm_mock.await_count == 0
    assert shot["prompt"] == "original prompt"
    assert shot["detected_colors"] is None  # 未尝试 grounding,无 color_mark 时仍为空


# ---------------------------------------------------------------------------
# P2: @图片N 多参考图(services/h3_refs)—— H3 引擎分镜 prompt 绝对开头注入
# ---------------------------------------------------------------------------
def _mk_h3_shot_with_char(
    ctx, token: str, *, ref_front: str = "", ref_image: str = ""
) -> str:
    """建项目 + 1 分镜(characters=["阿明"]) + 角色卡(可选参考图),返回 sid。"""
    from app.db import engine

    pid, sid = _make_shot(ctx, token)
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        shot.characters = json.dumps(["阿明"], ensure_ascii=False)
        s.add(shot)
        s.add(
            DramaCharacter(
                project_id=pid,
                name="阿明",
                reference_front=ref_front,
                ref_image=ref_image,
            )
        )
        s.commit()
    return sid


def _post_v2_and_get_prompt(client, H, sid, model: str) -> str:
    """以 fake 生成器 POST generate-video-v2,返回生成器实际收到的 prompt。"""
    fake_gen = _fake_video_generator([f"pid-{model}-ref"])
    with patch(
        "app.services.video_generators.get_generator", return_value=fake_gen
    ), patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={})):
        r = client.post(
            f"/api/drama/shots/{sid}/generate-video-v2",
            headers=H,
            json={"model": model, "seed": 12345},
        )
    assert r.status_code == 200, r.text
    return fake_gen.generate.call_args[0][0]


def test_generate_video_v2_h3_injects_ref_prefix(ctx):
    """H3 引擎 + 角色有三视图(取正面)→ prompt 绝对开头注入 @图片N 引用行。"""
    client, token, _ = ctx
    H = _h(token)
    sid = _mk_h3_shot_with_char(
        ctx, token, ref_front="/api/images?filename=front.png&worker=http://worker"
    )
    sent_prompt = _post_v2_and_get_prompt(client, H, sid, "h3")
    # 绝对开头 = 引用行;原 prompt 完整保留在引用行之后
    assert sent_prompt.startswith("@图片1作为阿明身份与服装参考\n")
    assert "1boy, walking" in sent_prompt


def test_generate_video_v2_h3_without_ref_keeps_prompt(ctx):
    """H3 引擎但角色无参考图 → 不注入,prompt 原样。"""
    client, token, _ = ctx
    H = _h(token)
    sid = _mk_h3_shot_with_char(ctx, token)  # 无 reference_front / ref_image
    sent_prompt = _post_v2_and_get_prompt(client, H, sid, "h3")
    assert not sent_prompt.startswith("@图片")
    assert sent_prompt == "1boy, walking"


def test_generate_video_v2_ltx_ignores_ref_prefix(ctx):
    """角色有参考图但非 H3 引擎(ltx)→ 不注入 @图片N(H3 专属语法)。"""
    client, token, _ = ctx
    H = _h(token)
    sid = _mk_h3_shot_with_char(
        ctx, token, ref_front="/api/images?filename=front.png&worker=http://worker"
    )
    sent_prompt = _post_v2_and_get_prompt(client, H, sid, "ltx")
    assert not sent_prompt.startswith("@图片")
    assert sent_prompt == "1boy, walking"


# ---------------------------------------------------------------------------
# P1 衔接策略层:seam_to_next / seam_anchor 字段端到端 + modifier 注入
# ---------------------------------------------------------------------------
def test_storyboard_seam_fields(ctx):
    """P1:LLM 拆解返回接缝策略/锚点 → 落库并透出;域外值回落空;末镜强制置空。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x", "script": "三镜短剧"}
    ).json()["id"]
    fake_msg = {
        "content": (
            '{"shots":['
            '{"scene":"a","prompt":"1boy, draw sword","characters":[],"dialogue":"",'
            '"speaker":"","duration_sec":5,"seam_to_next":"matchcut","seam_anchor":"太刀刀刃"},'
            '{"scene":"b","prompt":"1boy, page flip","characters":[],"dialogue":"",'
            '"speaker":"","duration_sec":5,"seam_to_next":"dissolve","seam_anchor":"x"},'
            '{"scene":"c","prompt":"1boy, walking away","characters":[],"dialogue":"",'
            '"speaker":"","duration_sec":5,"seam_to_next":"hardcut","seam_anchor":""}'
            "]}"
        )
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(
            f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 3}
        )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 3
    # matchcut + 锚点透出
    assert shots[0]["seam_to_next"] == "matchcut"
    assert shots[0]["seam_anchor"] == "太刀刀刃"
    # 域外值(dissolve)按未规划回落空串,不阻断拆解
    assert shots[1]["seam_to_next"] == ""
    # 末镜没有「下一镜」,LLM 给的 hardcut 被强制纠正为空
    assert shots[2]["seam_to_next"] == ""
    # 项目详情读回一致(落库确认)
    p = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    s0 = next(x for x in p["shots"] if x["idx"] == 0)
    assert s0["seam_to_next"] == "matchcut" and s0["seam_anchor"] == "太刀刀刃"


def test_storyboard_mood_beat_persisted(ctx):
    """WORKBENCH follow-up:LLM 拆解返回 mood/beat → 落库并透出;
    超长截断(mood 64/beat 200,对齐 ShotPatch 上限);缺省空串兼容。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x", "script": "两镜短剧"}
    ).json()["id"]
    long_mood = "紧" * 80
    long_beat = "对峙" * 120  # 240 字 > 200
    fake_msg = {
        "content": (
            '{"shots":['
            '{"scene":"a","prompt":"1boy, draw sword","characters":[],"dialogue":"",'
            '"speaker":"","duration_sec":5,"mood":"紧张","beat":"对峙"},'
            '{"scene":"b","prompt":"1boy, walking away","characters":[],"dialogue":"",'
            '"speaker":"","duration_sec":5,"mood":"' + long_mood + '",'
            '"beat":"' + long_beat + '"}'
            "]}"
        )
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)):
        r = client.post(
            f"/api/drama/projects/{pid}/storyboard", headers=H, json={"num_shots": 2}
        )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert shots[0]["mood"] == "紧张"
    assert shots[0]["beat"] == "对峙"
    # 超长截断不阻断(LLM 输出不可信)
    assert shots[1]["mood"] == "紧" * 64
    assert shots[1]["beat"] == "对峙" * 100
    # 项目详情读回一致(落库确认)
    p = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    s0 = next(x for x in p["shots"] if x["idx"] == 0)
    assert s0["mood"] == "紧张" and s0["beat"] == "对峙"


def test_storyboard_without_seam_fields_defaults_empty(ctx):
    """P1 兼容:LLM 不返回接缝字段 → 缺省空串(旧拆解 JSON 行为不变)。"""
    client, token, _ = ctx
    pid, sid = _make_shot(ctx, token)  # mock LLM JSON 无 seam 字段
    shot = client.get(f"/api/drama/projects/{pid}", headers=_h(token)).json()["shots"][0]
    assert shot["id"] == sid
    assert shot["seam_to_next"] == ""
    assert shot["seam_anchor"] == ""


def test_shot_patch_seam(ctx):
    """P1:seam_to_next/seam_anchor PATCH 写入读回;域外枚举 422。"""
    client, token, _ = ctx
    H = _h(token)
    pid, sid = _make_shot(ctx, token)
    r = client.patch(
        f"/api/drama/shots/{sid}",
        headers=H,
        json={"seam_to_next": "overlap", "seam_anchor": "圆环"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["seam_to_next"] == "overlap"
    assert r.json()["seam_anchor"] == "圆环"
    # 项目详情读回(确认落库)
    p = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    s = next(x for x in p["shots"] if x["id"] == sid)
    assert s["seam_to_next"] == "overlap" and s["seam_anchor"] == "圆环"
    # 清空(回到未规划)
    r = client.patch(f"/api/drama/shots/{sid}", headers=H, json={"seam_to_next": ""})
    assert r.status_code == 200 and r.json()["seam_to_next"] == ""
    # 非法枚举 → 422
    r = client.patch(
        f"/api/drama/shots/{sid}", headers=H, json={"seam_to_next": "dissolve"}
    )
    assert r.status_code == 422


def test_apply_seam_modifier_unit():
    """_apply_seam_modifier:matchcut 追加技能块(锚点/方向槽位渲染);其余原样返回。"""
    from types import SimpleNamespace

    from app.routes.drama_studio import _apply_seam_modifier

    shot = SimpleNamespace(width=832, height=480)  # 横屏 → 横向
    prev = SimpleNamespace(seam_to_next="matchcut", seam_anchor="太刀刀刃")
    out = _apply_seam_modifier("1boy, draw sword", shot, prev)
    assert out.startswith("1boy, draw sword")
    assert "转场丝滑度最高优先级" in out
    assert "太刀刀刃" in out
    assert "横向" in out
    assert "{{anchor}}" not in out and "{{direction}}" not in out
    # 非 matchcut / 首镜(None) → 原样
    for bad in (
        SimpleNamespace(seam_to_next="overlap", seam_anchor="x"),
        SimpleNamespace(seam_to_next="hardcut", seam_anchor=""),
        SimpleNamespace(seam_to_next="", seam_anchor=""),
        None,
    ):
        assert _apply_seam_modifier("p", shot, bad) == "p"
    # 竖屏 → 纵向;锚点缺失 → 兜底描述
    vshot = SimpleNamespace(width=480, height=832)
    out_v = _apply_seam_modifier(
        "p", vshot, SimpleNamespace(seam_to_next="matchcut", seam_anchor="")
    )
    assert "纵向" in out_v and "上一镜头主导视觉锚点" in out_v


def _mk_matchcut_prev_shot(ctx, token: str) -> tuple[str, str]:
    """建项目 + 两镜,首镜置 matchcut+锚点,返回 (pid, 第二镜 sid)。"""
    from app.db import engine

    pid, sid0 = _make_shot(ctx, token)
    with Session(engine) as s:
        shot0 = s.get(DramaShot, sid0)
        shot0.seam_to_next = "matchcut"
        shot0.seam_anchor = "太刀刀刃"
        s.add(shot0)
        s.add(
            DramaShot(
                project_id=pid, idx=1, prompt="1boy, sheath the sword", duration_sec=5
            )
        )
        s.commit()
        shot1 = s.exec(
            select(DramaShot).where(
                DramaShot.project_id == pid, DramaShot.idx == 1
            )
        ).first()
        return pid, shot1.id


def test_generate_video_v2_matchcut_seam_modifier_injected(ctx):
    """P1:前一镜声明 matchcut → v2 生成 prompt 末尾追加 h3-seam-polish 转场约束。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid1 = _mk_matchcut_prev_shot(ctx, token)
    sent_prompt = _post_v2_and_get_prompt(client, H, sid1, "ltx")
    assert sent_prompt.startswith("1boy, sheath the sword")
    assert "转场丝滑度最高优先级" in sent_prompt
    assert "太刀刀刃" in sent_prompt


def test_generate_video_v2_seam_modifier_with_prompt_override(ctx):
    """P1:prompt_override 存在时 modifier 同样追加(管线行为,非用户 prompt 一部分)。"""
    client, token, _ = ctx
    H = _h(token)
    _, sid1 = _mk_matchcut_prev_shot(ctx, token)
    fake_gen = _fake_video_generator(["pid-seam-override"])
    with patch(
        "app.services.video_generators.get_generator", return_value=fake_gen
    ), patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={})):
        r = client.post(
            f"/api/drama/shots/{sid1}/generate-video-v2",
            headers=H,
            json={"model": "ltx", "seed": 7, "prompt_override": "1boy, custom override"},
        )
    assert r.status_code == 200, r.text
    sent_prompt = fake_gen.generate.call_args[0][0]
    assert sent_prompt.startswith("1boy, custom override")
    assert "转场丝滑度最高优先级" in sent_prompt


def test_generate_video_v2_no_matchcut_seam_no_modifier(ctx):
    """P1:前一镜非 matchcut(hardcut)→ v2 生成 prompt 原样,不追加转场约束。"""
    client, token, _ = ctx
    H = _h(token)
    from app.db import engine

    pid, sid0 = _make_shot(ctx, token)
    with Session(engine) as s:
        shot0 = s.get(DramaShot, sid0)
        shot0.seam_to_next = "hardcut"
        s.add(shot0)
        s.add(DramaShot(project_id=pid, idx=1, prompt="1boy, walking", duration_sec=5))
        s.commit()
        sid1 = s.exec(
            select(DramaShot).where(DramaShot.project_id == pid, DramaShot.idx == 1)
        ).first().id
    sent_prompt = _post_v2_and_get_prompt(client, H, sid1, "ltx")
    assert sent_prompt == "1boy, walking"
