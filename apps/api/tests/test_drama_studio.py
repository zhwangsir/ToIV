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

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.config import get_settings
from app.models import DramaEvent, DramaSession, DramaShot, Tenant, User
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
def test_list_video_generators(ctx):
    """M6: GET /api/drama/video-generators 返回 3 个生成器。"""
    client, token, _ = ctx
    H = _h(token)
    r = client.get("/api/drama/video-generators", headers=H)
    assert r.status_code == 200, r.text
    names = {g["name"] for g in r.json()["generators"]}
    assert names == {"ltx", "seedance", "kling"}


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
        # 润色层由配置决定(默认 L1);此处钉住 L2 验证层透传
        patch.object(get_settings(), "drama_polish_layer", "L2"),
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
