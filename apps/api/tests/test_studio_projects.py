"""Studio CRUD 测试:项目 / 角色 / 分镜批量保存 + 租户隔离 + 鉴权。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
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
        tenant = Tenant(name="studio")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="studio@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "雨夜", "premise": "重逢"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_project_crud(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    assert len(client.get("/api/studio/projects", headers=H).json()) == 1
    r = client.patch(f"/api/studio/projects/{pid}", headers=H, json={"style": "赛博朋克"})
    assert r.json()["style"] == "赛博朋克"
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["title"] == "雨夜" and detail["characters"] == [] and detail["shots"] == []
    assert client.delete(f"/api/studio/projects/{pid}", headers=H).status_code == 200
    assert client.get("/api/studio/projects", headers=H).json() == []


def test_project_requires_auth(ctx):
    client, _ = ctx
    assert client.get("/api/studio/projects").status_code in (401, 403)


def test_character_crud(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "楚生", "visual_prompt": "1boy, black hair"},
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    client.patch(f"/api/studio/characters/{cid}", headers=H, json={"description": "落魄青年"})
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["characters"][0]["description"] == "落魄青年"
    assert client.delete(f"/api/studio/characters/{cid}", headers=H).status_code == 200


def test_shots_batch_save(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "开场", "prompt": "alley", "render_mode": "video", "characters": ["楚生"]},
            {"scene": "照片", "prompt": "photo", "render_mode": "image_motion"},
        ]},
    )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 2 and shots[0]["idx"] == 0
    assert shots[0]["render_mode"] == "video" and shots[1]["render_mode"] == "image_motion"
    # 再保存:带 id 更新,不带 id 追加
    r2 = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"id": shots[0]["id"], "scene": "开场改", "prompt": "alley2", "render_mode": "image_motion"},
            {"scene": "新镜", "prompt": "new"},
        ]},
    )
    shots2 = r2.json()["shots"]
    assert shots2[0]["scene"] == "开场改" and shots2[0]["render_mode"] == "image_motion"
    assert shots2[1]["scene"] == "新镜"
    # 全量替换语义:请求未包含的旧分镜(照片)已删除
    r3 = client.get(f"/api/studio/projects/{pid}", headers=H)
    remaining = r3.json()["shots"]
    assert len(remaining) == 2
    assert all(s["id"] != shots[1]["id"] for s in remaining)


# ── 渲染编排(M2)─────────────────────────────────────────────────────────────

import app.services.studio.orchestrator as orch


def _mk_shots(client: TestClient, H: dict, pid: str) -> list[dict]:
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "A", "prompt": "a", "render_mode": "video"},
            {"scene": "B", "prompt": "b", "render_mode": "image_motion"},
        ]},
    )
    assert r.status_code == 200, r.text
    return r.json()["shots"]


def test_render_single_shot(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    async def fake_render_shot(session, shot, pool=None, request=None):
        shot.status = "rendered"
        shot.video_url = "/api/studio/files/fake.mp4"
        shot.final_clip_url = shot.video_url
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rendered"
    assert r.json()["video_url"].endswith("fake.mp4")


def test_render_single_shot_error(ctx, monkeypatch):
    from app.services.studio.renderers.base import RenderError

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    async def fake_render_shot(session, shot, pool=None, request=None):
        raise RenderError("worker 全忙")

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)
    assert r.status_code == 502
    assert "worker 全忙" in r.json()["detail"]


def test_render_batch_skips_terminal(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    # 先把 shot A 渲染到终态(commit 落库,批量时才能被跳过)
    async def ok_render(session, shot, pool=None, request=None):
        shot.status = "rendered"
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", ok_render)
    client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)

    # 批量:仅应渲染仍处于 draft 的 shot B
    rendered: list[str] = []

    async def recording_render(session, shot, pool=None, request=None):
        rendered.append(shot.id)
        shot.status = "rendered"
        return shot

    monkeypatch.setattr(orch, "render_shot", recording_render)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == {"rendered": 1, "failed": 0}
    assert rendered == [shots[1]["id"]]


def test_render_batch_failure_not_blocking(ctx, monkeypatch):
    from app.services.studio.renderers.base import RenderError

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_shots(client, H, pid)

    async def failing_render(session, shot, pool=None, request=None):
        raise RenderError("出图失败")

    monkeypatch.setattr(orch, "render_shot", failing_render)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200
    assert r.json() == {"rendered": 0, "failed": 2}


def test_project_status_counts(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    _mk_shots(client, H, pid)
    r = client.get(f"/api/studio/projects/{pid}/status", headers=H)
    assert r.status_code == 200
    data = r.json()
    # 原字段契约不变;2026-08-15 起追加 next_step(状态重算),只增不改
    assert data["total"] == 2 and data["by_status"] == {"draft": 2}
    assert data["next_step"]["step"] == "render"


# ── 项目级产出规格(分辨率/帧率)───────────────────────────────────────────


def test_project_output_spec_create_patch(ctx):
    """创建/更新项目规格:默认 768×384@16;非法值(非 8 对齐/超范围)→ 422。"""
    client, token = ctx
    H = _h(token)
    # 默认值
    r = client.post("/api/studio/projects", headers=H, json={"title": "规格"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert (p["width"], p["height"], p["fps"]) == (768, 384, 16)
    pid = p["id"]
    # 自定义创建
    r = client.post(
        "/api/studio/projects", headers=H,
        json={"title": "竖屏", "width": 720, "height": 1280, "fps": 24},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["width"], r.json()["height"], r.json()["fps"]) == (720, 1280, 24)
    # PATCH 持久化
    r = client.patch(
        f"/api/studio/projects/{pid}", headers=H,
        json={"width": 1280, "height": 720, "fps": 24},
    )
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert (detail["width"], detail["height"], detail["fps"]) == (1280, 720, 24)
    # 非法:非 8 对齐 / fps 超范围 / 分辨率超范围
    for bad in ({"width": 765}, {"height": 433}, {"fps": 99}, {"width": 2048}):
        r = client.patch(f"/api/studio/projects/{pid}", headers=H, json=bad)
        assert r.status_code == 422, bad


def test_render_shot_injects_project_spec(ctx, monkeypatch):
    """编排层把项目 ckpt_name/width/height/fps 注入渲染器 kw。"""
    from app.services.studio.renderers.base import RenderResult

    client, token = ctx
    H = _h(token)
    r = client.post(
        "/api/studio/projects", headers=H,
        json={"title": "注入", "ckpt_name": "majicMIX.safetensors",
              "width": 1024, "height": 576, "fps": 12},
    )
    pid = r.json()["id"]
    shots = _mk_shots(client, H, pid)

    seen: dict[str, object] = {}

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            seen.update(kw)
            return RenderResult(kind="video", url="/api/studio/files/fake.mp4")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)
    assert r.status_code == 200, r.text
    assert seen["ckpt_name"] == "majicMIX.safetensors"
    assert (seen["width"], seen["height"], seen["fps"]) == (1024, 576, 12)


# ── L2 质量门接入(R1.3, advisory)───────────────────────────────────────────


def test_render_image_shot_runs_quality_gate(ctx, monkeypatch):
    """image 产物渲染后跑 L2 质量门;video 产物不跑;门异常不影响渲染结果。"""
    from app.quality import decision as quality_decision
    from app.services.studio.renderers.base import RenderResult

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)  # shots[0]=video, shots[1]=image_motion
    calls: list[tuple[str, str | None]] = []

    async def fake_gate(url, prompt, **kw):
        calls.append((url, prompt))
        return quality_decision.GateResult(
            quality_decision.QualityDecision.REGENERATE, score=0.5, critique="构图偏左"
        )

    class FakeRenderer:
        name = "image"

        async def render(self, shot, cast, pool, **kw):
            return RenderResult(kind="image", url="/api/studio/files/fake.png")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    monkeypatch.setattr(quality_decision, "evaluate_image", fake_gate)
    # image_motion 分镜渲染的是图像产物 → 触发质量门
    r = client.post(f"/api/studio/shots/{shots[1]['id']}/render", headers=H)
    assert r.status_code == 200, r.text
    assert calls == [("/api/studio/files/fake.png", "b")]
    # 渲染结果正常落库,质量门 advisory 不改变状态机
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    shot1 = [s for s in detail["shots"] if s["id"] == shots[1]["id"]][0]
    assert shot1["status"] == "rendered"
    assert shot1["image_url"] == "/api/studio/files/fake.png"


def test_render_quality_gate_exception_does_not_break_render(ctx, monkeypatch):
    """质量门抛异常 → 降级忽略,渲染照常成功(事件化后由 QualityPlugin 兜底)。"""
    from app.quality import decision as quality_decision
    from app.services.studio.renderers.base import RenderResult

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    async def boom_gate(url, prompt, **kw):
        raise RuntimeError("vlm down")

    class FakeRenderer:
        name = "image"

        async def render(self, shot, cast, pool, **kw):
            return RenderResult(kind="image", url="/api/studio/files/fake.png")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    # H3 事件化:质量门经 QUALITY_ADVISORY 事件 → QualityPlugin → evaluate_image;
    # 异常由插件 handler 的 try/except 兜底(降级直通语义不变)
    monkeypatch.setattr(quality_decision, "evaluate_image", boom_gate)
    r = client.post(f"/api/studio/shots/{shots[1]['id']}/render", headers=H)
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    shot1 = [s for s in detail["shots"] if s["id"] == shots[1]["id"]][0]
    assert shot1["status"] == "rendered"


# ── 产出文件服务(M2)──────────────────────────────────────────────────────────


def test_studio_file_serving(ctx, monkeypatch, tmp_path):
    import app.storage as storage

    out = tmp_path / "studio"
    out.mkdir()
    (out / "x.mp4").write_bytes(b"fake-mp4")
    monkeypatch.setattr(storage, "drama_output_root", lambda: tmp_path)

    client, token = ctx
    H = _h(token)
    # 未认证 → 401(T0 红线修复:此前是 13 个同类文件端点中唯一无鉴权的)
    assert client.get("/api/studio/files/x.mp4").status_code == 401
    r = client.get("/api/studio/files/x.mp4", headers=H)
    assert r.status_code == 200 and r.content == b"fake-mp4"
    assert r.headers["content-type"] == "video/mp4"
    # 不存在 → 404;路径穿越 → 400(或路由不匹配 404/405,绝不放行)
    assert client.get("/api/studio/files/none.mp4", headers=H).status_code == 404
    assert client.get("/api/studio/files/..%2F..%2Fsecret", headers=H).status_code in (400, 404, 405)

def test_character_reference_images_patch(ctx):
    """Batch2:CharacterPatch.reference_images list → DB JSON;响应为 list。"""
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body.get("reference_images"), list), body
    cid = body["id"]
    refs = [
        "/api/images?filename=front.png&type=input&worker=http://w",
        "/api/images?filename=side.png&type=input&worker=http://w",
        "/api/images?filename=full.png&type=input&worker=http://w",
    ]
    pr = client.patch(
        f"/api/studio/characters/{cid}",
        headers=H,
        json={"reference_images": refs},
    )
    assert pr.status_code == 200, pr.text
    out = pr.json()
    assert out["reference_images"] == refs
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["characters"][0]["reference_images"] == refs
    # 清空
    pr2 = client.patch(
        f"/api/studio/characters/{cid}",
        headers=H,
        json={"reference_images": []},
    )
    assert pr2.status_code == 200 and pr2.json()["reference_images"] == []


def test_project_scene_images_patch(ctx):
    """Batch3:ProjectPatch.scene_images list → DB JSON;详情/列表为 list。"""
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    detail0 = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail0.get("scene_images") == []
    assert "scene_images_json" not in detail0
    scenes = [
        "/api/images?filename=store.png&type=input&worker=http://w",
        "/api/images?filename=street.png&type=input&worker=http://w",
    ]
    pr = client.patch(
        f"/api/studio/projects/{pid}",
        headers=H,
        json={"scene_images": scenes},
    )
    assert pr.status_code == 200, pr.text
    out = pr.json()
    assert out["scene_images"] == scenes
    assert "scene_images_json" not in out
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["scene_images"] == scenes
    listed = client.get("/api/studio/projects", headers=H).json()
    hit = next(x for x in listed if x["id"] == pid)
    assert hit["scene_images"] == scenes
    # 超限
    bad = client.patch(
        f"/api/studio/projects/{pid}",
        headers=H,
        json={"scene_images": scenes + scenes + scenes},
    )
    # pydantic max_length=4 → 422;路由层兜底 → 400
    assert bad.status_code in (400, 422), bad.text
    # 清空
    pr2 = client.patch(
        f"/api/studio/projects/{pid}",
        headers=H,
        json={"scene_images": []},
    )
    assert pr2.status_code == 200 and pr2.json()["scene_images"] == []


def test_render_body_h3_default_and_candidates(ctx, monkeypatch):
    """Batch2:render body 默认 h3;num_candidates=2 写 candidates 并可 pick。"""
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderResult

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    # 角色三视图
    cr = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏", "visual_prompt": "girl"},
    )
    assert cr.status_code == 200
    cid = cr.json()["id"]
    refs = [
        "/api/images?filename=f.png&type=input&worker=w",
        "/api/images?filename=s.png&type=input&worker=w",
        "/api/images?filename=b.png&type=input&worker=w",
    ]
    assert client.patch(
        f"/api/studio/characters/{cid}", headers=H, json={"reference_images": refs}
    ).status_code == 200
    # 分镜
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={
            "shots": [
                {
                    "scene": "雨夜便利店",
                    "prompt": "rainy convenience store",
                    "characters": ["林夏"],
                    "render_mode": "video",
                }
            ]
        },
    )
    assert sr.status_code == 200, sr.text
    sid = sr.json()["shots"][0]["id"]

    n = {"i": 0}

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            n["i"] += 1
            # 校验默认/显式 h3 + 参考注入路径有 cast
            assert kw.get("video_model") == "h3"
            return RenderResult(kind="video", url=f"/api/studio/files/c{n['i']}.mp4")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())

    r = client.post(
        f"/api/studio/shots/{sid}/render",
        headers=H,
        json={"video_model": "h3", "num_candidates": 2},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_model"] == "h3"
    assert body["status"] == "rendered"
    assert isinstance(body.get("candidates"), list) and len(body["candidates"]) == 2
    assert body["video_url"].endswith("c1.mp4")
    assert body["candidates"][0]["is_picked"] is True
    assert isinstance(body.get("ref_images"), list) and len(body["ref_images"]) == 3

    # pick 第二个
    c2 = body["candidates"][1]["id"]
    pr = client.post(f"/api/studio/shots/{sid}/candidates/{c2}/pick", headers=H)
    assert pr.status_code == 200, pr.text
    picked = pr.json()
    assert picked["video_url"].endswith("c2.mp4")
    assert any(c["id"] == c2 and c["is_picked"] for c in picked["candidates"])


def test_render_no_body_stays_single_candidate(ctx, monkeypatch):
    """无 body 的旧调用保持单候选,不强制翻倍打 H3。"""
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderResult

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"prompt": "x", "render_mode": "video"}]},
    )
    sid = sr.json()["shots"][0]["id"]
    calls = {"n": 0}

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            calls["n"] += 1
            return RenderResult(kind="video", url="/api/studio/files/one.mp4")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert calls["n"] == 1
    assert r.json()["video_model"] == "h3"


# ── 重试失败不得覆盖已有入选片 ─────────────────────────────────────────────


def test_render_retry_fail_preserves_selected_voiced(ctx, monkeypatch):
    """已 voiced 且有入选视频时,重试超时/失败只追加候选失败,status/URL 不变。"""
    from app.db import get_session
    from app.main import app
    from app.models import StudioShot
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderError, RenderResult
    from sqlmodel import Session

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"prompt": "rainy night", "render_mode": "video", "dialogue": "嗨"}]},
    )
    assert sr.status_code == 200, sr.text
    sid = sr.json()["shots"][0]["id"]

    class OkRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            return RenderResult(kind="video", url="/api/studio/files/picked-keep.mp4")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: OkRenderer())
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["video_url"].endswith("picked-keep.mp4")

    # 模拟已配音入选态(雨夜镜2 场景)
    with Session(app.dependency_overrides[get_session]().__next__().bind) as s:
        shot = s.get(StudioShot, sid)
        assert shot is not None
        shot.status = "voiced"
        shot.voice_url = "/api/studio/files/voice.wav"
        shot.final_clip_url = "/api/studio/files/picked-keep.mp4"
        shot.error = "prior-note"
        s.add(shot)
        s.commit()

    class BoomRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            raise RenderError("等待视频超时(1800s)")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: BoomRenderer())
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H)
    assert r.status_code == 502
    assert "1800" in r.json()["detail"]

    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    shot = detail["shots"][0]
    assert shot["status"] == "voiced", shot
    assert shot["video_url"].endswith("picked-keep.mp4")
    assert shot["final_clip_url"].endswith("picked-keep.mp4")
    assert shot.get("error") == "prior-note"
    cands = shot.get("candidates") or []
    assert any(
        isinstance(c, dict) and c.get("status") == "error" and "1800" in (c.get("error") or "")
        for c in cands
    ), cands
    # 入选条目仍在且未丢
    assert any(
        isinstance(c, dict) and c.get("is_picked") and str(c.get("url") or "").endswith("picked-keep.mp4")
        for c in cands
    ), cands


def test_render_retry_fail_preserves_lipsynced_selected(ctx, monkeypatch):
    """lipsynced 有入选片时,多候选全失败不得把镜次打成 error。"""
    from app.db import get_session
    from app.main import app
    from app.models import StudioShot
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderError, RenderResult
    from sqlmodel import Session

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"prompt": "doorway", "render_mode": "video"}]},
    )
    sid = sr.json()["shots"][0]["id"]

    class OkRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            return RenderResult(kind="video", url="/api/studio/files/ls-keep.mp4")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: OkRenderer())
    assert client.post(f"/api/studio/shots/{sid}/render", headers=H).status_code == 200

    with Session(app.dependency_overrides[get_session]().__next__().bind) as s:
        shot = s.get(StudioShot, sid)
        shot.status = "lipsynced"
        shot.final_clip_url = "/api/studio/files/ls-keep.mp4"
        s.add(shot)
        s.commit()

    class BoomRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            raise RenderError("全部候选生成失败")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: BoomRenderer())
    r = client.post(
        f"/api/studio/shots/{sid}/render",
        headers=H,
        json={"video_model": "h3", "num_candidates": 2},
    )
    assert r.status_code == 502
    shot = client.get(f"/api/studio/projects/{pid}", headers=H).json()["shots"][0]
    assert shot["status"] == "lipsynced"
    assert shot["video_url"].endswith("ls-keep.mp4")
    assert shot["status"] != "error"
    err_cands = [c for c in (shot.get("candidates") or []) if c.get("status") == "error"]
    assert len(err_cands) >= 1


def test_render_fail_without_selected_still_marks_error(ctx, monkeypatch):
    """无入选片时失败仍落 status=error(回归保护,避免误吞失败)。"""
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderError

    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [{"prompt": "empty", "render_mode": "video"}]},
    )
    sid = sr.json()["shots"][0]["id"]

    class BoomRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            raise RenderError("worker 全忙")

    monkeypatch.setattr(orch, "get_renderer", lambda shot: BoomRenderer())
    r = client.post(f"/api/studio/shots/{sid}/render", headers=H)
    assert r.status_code == 502
    shot = client.get(f"/api/studio/projects/{pid}", headers=H).json()["shots"][0]
    assert shot["status"] == "error"
    assert "worker 全忙" in (shot.get("error") or "")
