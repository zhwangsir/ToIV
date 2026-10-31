"""DramaClaw 借鉴 #4:颜色标记草图在场校验测试。

覆盖:
  纯函数(services/drama_presence):
    · PALETTE 调色板 RGB 两两可分离性(> 2×distance_threshold,无串色)
    · assign_character_colors 确定性(乱序同结果/取模回绕)
    · color_mark_prompt_suffix 颜色指令片段
    · detect_character_presence 命中/未命中/覆盖率数值/阈值边界/距离容差
    · detect_grid_panels 宫格切分数量与逐格内容
    · check_regions 位置命中/偏移/缺失三级
  端点(POST /api/drama/projects/{pid}/presence-check):
    · 宫格共享 URL 逐 panel 检测 → missing/unexpected 报告 + persist 落库
    · 无图 shot → unavailable 不炸全局;persist=False 不写库;shot_ids 过滤;归属 404
    · 单图(非宫格)+ scene_layout → region_check 附带
  prompt 注入:
    · grid-storyboard color_mark=True/False;prompt 含/不含火柴人颜色指令
    · scene-layout color_mark=True 注入 layout 角色颜色
"""
from __future__ import annotations

import io
import json
import math
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import DramaShot, Tenant, User
from app.security import create_token, hash_password
from app.services.drama_presence import (
    PALETTE,
    assign_character_colors,
    check_regions,
    color_mark_prompt_suffix,
    detect_character_presence,
    detect_grid_panels,
)


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
    # 后台任务用 `from app.db import engine` 取独立 Session,patch 指向测试内存库
    with patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="p")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="p@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
            tenant2 = Tenant(name="p2")
            s.add(tenant2)
            s.commit()
            s.refresh(tenant2)
            user2 = User(
                email="p2@toiv.ai",
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


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _img_with_blocks(size: int, blocks: list[tuple[tuple[int, int, int, int], str]]) -> bytes:
    """合成白底图 + 若干纯色矩形块,返回 PNG 字节。"""
    img = Image.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(img)
    for box, color in blocks:
        d.rectangle(list(box), fill=color)
    return _png_bytes(img)


# ---------------------------------------------------------------------------
# 纯函数:调色板与分配
# ---------------------------------------------------------------------------
def test_palette_rgb_separable():
    """调色板任意两色 RGB 欧氏距离 > 2×60:阈值 60 下一像素至多命中一色(无串色)。"""
    rgbs = []
    for hex_, _en, _cn in PALETTE:
        h = hex_.lstrip("#")
        rgbs.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    for i in range(len(rgbs)):
        for j in range(i + 1, len(rgbs)):
            d = math.dist(rgbs[i], rgbs[j])
            assert d > 120, f"{PALETTE[i][0]} 与 {PALETTE[j][0]} 距离 {d:.0f} 过近"
    assert len(PALETTE) == 12


def test_assign_character_colors_deterministic_and_wraps():
    """同集合任意顺序分配结果一致;>12 角色取模回绕。"""
    a = assign_character_colors(["阿明", "小红", "Mary"])
    b = assign_character_colors(["Mary", "阿明", "小红"])
    assert a == b
    assert set(a) == {"阿明", "小红", "Mary"}
    # 分配色必须来自调色板
    assert all(v in {p[0] for p in PALETTE} for v in a.values())
    # 13 个角色 → 第 13 个回绕复用第一个色
    many = assign_character_colors([f"角色{i:02d}" for i in range(13)])
    assert len(many) == 13
    assert len(set(many.values())) == 12
    # 空名过滤
    assert assign_character_colors(["", "阿明"]) == assign_character_colors(["阿明"])


def test_color_mark_prompt_suffix():
    suffix = color_mark_prompt_suffix({"阿明": "#FF0000", "Mary": "#00FFFF"})
    assert "stick figure" in suffix
    assert "white background" in suffix
    assert "阿明→bright red" in suffix  # 中文名 + 英文色名
    assert "Mary→cyan" in suffix


# ---------------------------------------------------------------------------
# 纯函数:在场检测
# ---------------------------------------------------------------------------
def test_detect_presence_hit_and_miss():
    cm = {"阿明": "#FF0000", "小红": "#0000FF", "路人": "#00FF00"}
    data = _img_with_blocks(256, [
        ((20, 20, 80, 80), "#FF0000"),
        ((120, 120, 180, 180), "#0000FF"),
    ])
    r = detect_character_presence(data, cm)
    assert r["阿明"]["present"] is True
    assert r["小红"]["present"] is True
    assert r["路人"]["present"] is False
    assert r["路人"]["coverage"] == 0.0
    # 返回结构带 color
    assert r["阿明"]["color"] == "#FF0000"


def test_detect_presence_coverage_value():
    """64×64 红块 / 256² → 覆盖率 0.0625(±0.01 容差,抗缩放取整)。"""
    cm = {"阿明": "#FF0000"}
    data = _img_with_blocks(256, [((0, 0, 63, 63), "#FF0000")])
    r = detect_character_presence(data, cm)
    assert abs(r["阿明"]["coverage"] - 0.0625) < 0.01


def test_detect_presence_min_coverage_boundary():
    """16×16(0.0039)≥ 默认 0.002 → 在场;8×8(0.00098)< 0.002 → 不在场。"""
    cm = {"阿明": "#FF0000"}
    big = _img_with_blocks(256, [((0, 0, 15, 15), "#FF0000")])
    small = _img_with_blocks(256, [((0, 0, 7, 7), "#FF0000")])
    assert detect_character_presence(big, cm)["阿明"]["present"] is True
    assert detect_character_presence(small, cm)["阿明"]["present"] is False


def test_detect_presence_distance_threshold():
    """轻微偏色(#F02020,距离≈48 < 60)命中;洗白粉色(#FF8080,距离≈181)不命中。"""
    cm = {"阿明": "#FF0000"}
    near = _img_with_blocks(256, [((0, 0, 63, 63), "#F02020")])
    washed = _img_with_blocks(256, [((0, 0, 63, 63), "#FF8080")])
    assert detect_character_presence(near, cm)["阿明"]["present"] is True
    assert detect_character_presence(washed, cm)["阿明"]["present"] is False


def test_detect_presence_ignores_achromatic():
    """白底/黑线/灰面不算任何标记色。"""
    cm = {"阿明": "#FF0000"}
    data = _img_with_blocks(256, [
        ((0, 0, 63, 63), "#202020"),
        ((100, 100, 163, 163), "#808080"),
    ])
    assert detect_character_presence(data, cm)["阿明"]["present"] is False


def test_detect_grid_panels_count_and_content():
    """3x3 切 9 块;逐格颜色独立检测;int 25 → 25 块。"""
    size = 270  # 每格 90×90
    img = Image.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, 70, 70], fill="#FF0000")  # 面板 0
    d.rectangle([100, 100, 160, 160], fill="#0000FF")  # 面板 4(中心格)
    panels = detect_grid_panels(_png_bytes(img), "3x3")
    assert len(panels) == 9
    cm = {"红": "#FF0000", "蓝": "#0000FF"}
    r0 = detect_character_presence(panels[0], cm)
    assert r0["红"]["present"] is True and r0["蓝"]["present"] is False
    r4 = detect_character_presence(panels[4], cm)
    assert r4["蓝"]["present"] is True and r4["红"]["present"] is False
    r1 = detect_character_presence(panels[1], cm)
    assert r1["红"]["present"] is False and r1["蓝"]["present"] is False
    assert len(detect_grid_panels(_png_bytes(img), 25)) == 25


def test_check_regions_region_elsewhere_missing():
    """分带三级:带内命中 region / 全图有但带外 elsewhere / 全图无 missing。"""
    img = Image.new("RGB", (400, 200), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([10, 0, 60, 200], fill="#FF0000")  # 红在左(x≈0.09)
    d.rectangle([340, 0, 390, 200], fill="#0000FF")  # 蓝在右(x≈0.91)
    data = _png_bytes(img)
    cm = {"阿明": "#FF0000", "小红": "#0000FF", "路人": "#00FF00"}

    r = check_regions(data, cm, [{"name": "阿明", "x": 0.1}])
    assert r["阿明"]["status"] == "region"
    assert r["阿明"]["region_coverage"] > 0.3

    # 阿明(红色)摆在右侧带 → 带内无红,但全图有红 → elsewhere
    r2 = check_regions(data, cm, [{"name": "阿明", "x": 0.9}])
    assert r2["阿明"]["status"] == "elsewhere"
    assert r2["阿明"]["region_coverage"] == 0.0
    assert r2["阿明"]["global_coverage"] > 0

    r3 = check_regions(data, cm, [{"name": "路人", "x": 0.5}])
    assert r3["路人"]["status"] == "missing"
    # 颜色映射外的名字跳过
    r4 = check_regions(data, cm, [{"name": "陌生人", "x": 0.5}])
    assert "陌生人" not in r4


# ---------------------------------------------------------------------------
# 端点:presence-check
# ---------------------------------------------------------------------------
def _grid_png_two_panels_marked(color_a: str) -> bytes:
    """3x3 宫格图:面板 0 与面板 1 各画一块 color_a 色块,其余留白。"""
    img = Image.new("RGB", (270, 270), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, 70, 70], fill=color_a)  # 面板 0
    d.rectangle([100, 10, 160, 70], fill=color_a)  # 面板 1
    return _png_bytes(img)


def _mock_fetch(image_bytes: bytes):
    """mock resolve_worker + pool,使 fetch_product_image_bytes 返回合成图字节。"""
    fake_client = MagicMock()
    fake_client.base_url = "http://worker"
    fake_client.get_image_bytes = AsyncMock(return_value=(image_bytes, "image/png"))
    pool = MagicMock()
    pool.clients = [fake_client]
    return pool, fake_client


def _seed_shots(pid: str, shots: list[dict]) -> list[str]:
    """直接落库分镜,返回 shot id 列表(与 shot.idx 顺序一致)。"""
    from app.db import engine

    with Session(engine) as s:
        ids = []
        for kw in shots:
            shot = DramaShot(project_id=pid, **kw)
            s.add(shot)
            s.commit()
            s.refresh(shot)
            ids.append(shot.id)
        return ids


def test_presence_check_grid_missing_unexpected_and_persist(ctx):
    """宫格共享 URL:shot0 命中;shot1 面板画了别人的色 → missing + unexpected;persist 落库。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "在场"}).json()["id"]
    for name in ("阿明", "小红"):
        client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": name})

    # 端点内部颜色映射(排序取模):用同一函数取色,保证测试与实现同源
    cm = assign_character_colors(["阿明", "小红"])
    grid_url = "/api/images?filename=grid.png&worker=http://worker"
    sid0, sid1 = _seed_shots(pid, [
        {"idx": 0, "characters": json.dumps(["小红"], ensure_ascii=False), "grid_image": grid_url},
        {"idx": 1, "characters": json.dumps(["阿明"], ensure_ascii=False), "grid_image": grid_url},
    ])
    # 面板 0/1 都画「小红」的色 → shot1 期望的「阿明」缺失,且意外出现「小红」
    grid_png = _grid_png_two_panels_marked(cm["小红"])
    pool, _cli = _mock_fetch(grid_png)
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.services.drama_presence.resolve_worker", return_value=pool.clients[0]):
            r = client.post(f"/api/drama/projects/{pid}/presence-check", headers=H, json={})
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["summary"] == {"total": 2, "ok": 1, "missing_chars": 1, "no_image": 0}
    by_id = {s["shot_id"]: s for s in data["shots"]}
    s0 = by_id[sid0]
    assert s0["status"] == "ok"
    assert s0["missing"] == [] and s0["unexpected"] == []
    assert s0["per_character"]["小红"]["present"] is True
    s1 = by_id[sid1]
    assert s1["missing"] == ["阿明"]
    assert s1["unexpected"] == ["小红"]

    # persist 落库:detected_colors 写回,shot 详情可见
    from app.db import engine
    with Session(engine) as s:
        shot1 = s.get(DramaShot, sid1)
        saved = json.loads(shot1.detected_colors)
        assert saved["source"] == "presence-check"
        assert saved["checked_at"]
        assert saved["per_character"]["小红"]["present"] is True
        assert saved["color_map"] == {"阿明": cm["阿明"]}
    # 过程记录追加一步
    detail = client.get(f"/api/drama/projects/{pid}", headers=H).json()
    assert any(st["step"] == "presence_check" for st in detail["process_data"])


def test_presence_check_single_image_with_region_check(ctx):
    """单图(非共享 URL)整图检测;有 scene_layout 时附带 region_check。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "单图"}).json()["id"]
    client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": "阿明"})
    cm = assign_character_colors(["阿明"])

    img = Image.new("RGB", (400, 200), "white")
    ImageDraw.Draw(img).rectangle([10, 0, 60, 200], fill=cm["阿明"])  # 左侧
    (sid,) = _seed_shots(pid, [{
        "idx": 0,
        "characters": json.dumps(["阿明"], ensure_ascii=False),
        "grid_image": "/api/images?filename=layout.png&worker=http://worker",
        "scene_layout": json.dumps({"actors": [{"name": "阿明", "x": 0.1}]}, ensure_ascii=False),
    }])
    pool, _cli = _mock_fetch(_png_bytes(img))
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.services.drama_presence.resolve_worker", return_value=pool.clients[0]):
            r = client.post(
                f"/api/drama/projects/{pid}/presence-check", headers=H, json={"persist": False}
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    assert shot["shot_id"] == sid
    assert shot["status"] == "ok" and shot["missing"] == []
    assert shot["region_check"]["阿明"]["status"] == "region"
    # persist=False → 不写库
    from app.db import engine
    with Session(engine) as s:
        assert s.get(DramaShot, sid).detected_colors == ""


def test_presence_check_no_image_unavailable(ctx):
    """无 grid_image 的 shot 记 unavailable,不炸全局;summary.no_image 计数。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "无图"}).json()["id"]
    client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": "阿明"})
    cm = assign_character_colors(["阿明"])
    ok_url = "/api/images?filename=one.png&worker=http://worker"
    sid_ok, sid_noimg = _seed_shots(pid, [
        {"idx": 0, "characters": json.dumps(["阿明"], ensure_ascii=False), "grid_image": ok_url},
        {"idx": 1, "characters": json.dumps(["阿明"], ensure_ascii=False), "grid_image": ""},
    ])
    png = _img_with_blocks(256, [((0, 0, 63, 63), cm["阿明"])])
    pool, _cli = _mock_fetch(png)
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.services.drama_presence.resolve_worker", return_value=pool.clients[0]):
            r = client.post(f"/api/drama/projects/{pid}/presence-check", headers=H, json={})
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["summary"]["no_image"] == 1
    assert data["summary"]["ok"] == 1
    by_id = {s["shot_id"]: s for s in data["shots"]}
    assert by_id[sid_ok]["status"] == "ok"
    assert by_id[sid_noimg]["status"] == "unavailable"
    assert by_id[sid_noimg]["reason"] == "no_image"


def test_presence_check_shot_ids_filter(ctx):
    """shot_ids 只校验选中分镜。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "过滤"}).json()["id"]
    client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": "阿明"})
    cm = assign_character_colors(["阿明"])
    url = "/api/images?filename=g.png&worker=http://worker"
    sid0, sid1 = _seed_shots(pid, [
        {"idx": 0, "characters": json.dumps(["阿明"], ensure_ascii=False), "grid_image": url},
        {"idx": 1, "characters": json.dumps(["阿明"], ensure_ascii=False), "grid_image": url},
    ])
    png = _grid_png_two_panels_marked(cm["阿明"])
    pool, _cli = _mock_fetch(png)
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.services.drama_presence.resolve_worker", return_value=pool.clients[0]):
            r = client.post(
                f"/api/drama/projects/{pid}/presence-check",
                headers=H, json={"shot_ids": [sid1], "persist": False},
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["summary"]["total"] == 1
    assert data["shots"][0]["shot_id"] == sid1


def test_presence_check_ownership_404(ctx):
    """他人项目 → 404。"""
    client, token, token2 = ctx
    pid = client.post("/api/drama/projects", headers=_h(token), json={"title": "mine"}).json()["id"]
    r = client.post(f"/api/drama/projects/{pid}/presence-check", headers=_h(token2), json={})
    assert r.status_code == 404
    # 未认证 → 401/403
    assert client.post(f"/api/drama/projects/{pid}/presence-check", json={}).status_code in (401, 403)


# ---------------------------------------------------------------------------
# prompt 注入:grid-storyboard / scene-layout color_mark
# ---------------------------------------------------------------------------
def _fake_pool(queue_side_effect):
    pool = MagicMock()
    cli = AsyncMock()
    cli.base_url = "http://worker"
    cli.queue_prompt = AsyncMock(side_effect=queue_side_effect)
    pool.pick = AsyncMock(return_value=cli)
    return pool, cli


def _graph_texts(graph: dict) -> str:
    """拼接图中所有文本输入(正向/负向 prompt),便于子串断言。"""
    parts = []
    for node in graph.values():
        if isinstance(node, dict):
            inputs = node.get("inputs", {})
            for key in ("text", "prompt"):
                v = inputs.get(key)
                if isinstance(v, str):
                    parts.append(v)
    return "\n".join(parts)


def _run_grid_storyboard(client, H, pid, *, color_mark: bool, cli):
    fake_msg = {
        "content": '{"shots":['
        '{"scene":"s0","prompt":"a","characters":["阿明"],"dialogue":"","speaker":"","duration_sec":5},'
        '{"scene":"s1","prompt":"b","characters":["新角色"],"dialogue":"","speaker":"","duration_sec":5}'
        "]}"
    }
    with patch("app.routes.drama_studio.llm.chat", AsyncMock(return_value=fake_msg)), \
         patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
         patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
             "grid-pid": ["/api/images?filename=g.png&worker=http://worker"],
         })):
        return client.post(
            f"/api/drama/projects/{pid}/grid-storyboard",
            headers=H,
            json={"num_shots": 2, "color_mark": color_mark},
        )


def test_grid_storyboard_color_mark_injects_prompt(ctx):
    """color_mark=True:宫格 prompt 含火柴人颜色指令;shot.detected_colors 写 expected 段。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x", "script": "阿明出场。"}
    ).json()["id"]
    client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": "阿明"})

    pool, cli = _fake_pool(["grid-pid"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        r = _run_grid_storyboard(client, H, pid, color_mark=True, cli=cli)
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    grid_graph = cli.queue_prompt.call_args_list[0][0][0]
    text = _graph_texts(grid_graph)
    assert "stick figure" in text
    assert "阿明→" in text and "新角色→" in text  # 含 LLM 新建角色
    cm = assign_character_colors(["阿明", "新角色"])
    from app.services.drama_presence import color_english_name
    assert color_english_name(cm["阿明"]) in text

    shots = r.json()["shots"]
    assert shots[0]["detected_colors"]["source"] == "color-mark"
    assert shots[0]["detected_colors"]["expected"] == ["阿明"]
    assert shots[0]["detected_colors"]["color_map"] == {"阿明": cm["阿明"]}
    assert shots[1]["detected_colors"]["color_map"] == {"新角色": cm["新角色"]}


def test_grid_storyboard_color_mark_default_off(ctx):
    """color_mark 缺省 False:prompt 不含颜色指令,detected_colors 无 color_map(零行为变更)。

    P2 注:阶段B grounding 默认开启,测试环境 VLM 不可达 → 回落标记
    grounding_status=fallback;这与 color_mark 的零变更语义正交。
    """
    client, token, _ = ctx
    H = _h(token)
    pid = client.post(
        "/api/drama/projects", headers=H, json={"title": "x", "script": "阿明出场。"}
    ).json()["id"]
    client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": "阿明"})

    pool, cli = _fake_pool(["grid-pid"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        r = _run_grid_storyboard(client, H, pid, color_mark=False, cli=cli)
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    grid_graph = cli.queue_prompt.call_args_list[0][0][0]
    assert "stick figure" not in _graph_texts(grid_graph)
    detected = r.json()["shots"][0]["detected_colors"]
    assert "color_map" not in detected
    assert detected["grounding_status"] == "fallback"


def test_scene_layout_color_mark_injects_prompt(ctx):
    """scene-layout color_mark=True + generate_reference:参考图 prompt 注入 layout 角色颜色。"""
    client, token, _ = ctx
    H = _h(token)
    pid = client.post("/api/drama/projects", headers=H, json={"title": "x"}).json()["id"]
    client.post(f"/api/drama/projects/{pid}/characters", headers=H, json={"name": "阿明"})
    (sid,) = _seed_shots(pid, [{"idx": 0, "prompt": "p"}])

    pool, cli = _fake_pool(["layout-pid"])
    app.dependency_overrides[get_pool] = lambda: pool
    try:
        with patch("app.routes.drama_studio.spawn_tracker", lambda c, p: None), \
             patch("app.routes.drama_studio.wait_for_jobs", AsyncMock(return_value={
                 "layout-pid": ["/api/images?filename=layout.png&worker=http://worker"],
             })):
            r = client.put(
                f"/api/drama/shots/{sid}/scene-layout",
                headers=H,
                json={
                    "layout": {"actors": [{"name": "阿明", "x": 0.3, "facing": "right"}]},
                    "generate_reference": True,
                    "color_mark": True,
                },
            )
    finally:
        app.dependency_overrides.pop(get_pool, None)

    assert r.status_code == 200, r.text
    graph = cli.queue_prompt.call_args_list[0][0][0]
    text = _graph_texts(graph)
    assert "stick figure" in text
    assert "阿明→" in text
    # Job 落库 prompt 同样带颜色指令(与实发 worker 的图一致)
    from app.db import engine
    from app.models import Job
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "layout-pid")).first()
        assert job is not None and "stick figure" in job.prompt
