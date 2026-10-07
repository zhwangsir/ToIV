"""10-07 拍板：短剧视频步默认逐镜独立 Ref2VA（每镜 4 张定妆参考、不续写），c / c_hybrid 显式可选。"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.h3_refs import RefImage
from app.services.studio.pipelines import (
    C_PIPELINES,
    DEFAULT_VIDEO_PIPELINE,
    INDEP_PIPELINE,
    INDEP_REFS_PER_SHOT,
)
from app.services.studio.renderers.base import RenderError
from app.services.studio.shot_refs import cast_missing_refs, select_indep_shot_refs
from app.workflows.h3_pipeline_c import H3PipelineCParams, build_h3_pipeline_c_graph

LX = [f"/api/studio/files/sample_linxia_{k}.png" for k in ("front", "side", "full", "back")]
CL = [f"/api/studio/files/sample_clerk_{k}.png" for k in ("front", "side", "full", "back")]
SCENE = "/api/studio/files/scene_rain_store.png"


# ───────────────────────── 常量 / 构图 ─────────────────────────


def test_default_pipeline_is_indep_ref2va():
    assert DEFAULT_VIDEO_PIPELINE == INDEP_PIPELINE == "ref2va"
    assert INDEP_PIPELINE not in C_PIPELINES
    assert INDEP_REFS_PER_SHOT == 4


def test_graph_without_save_context_has_no_latent_nodes():
    g = build_h3_pipeline_c_graph(
        H3PipelineCParams(positive="x", images=("a.png",), save_context=False)
    )
    classes = {n["class_type"] for n in g.values()}
    assert "MiniMaxH3MotionContextSaveLatent" not in classes
    assert "MiniMaxH3MotionContext" not in classes
    assert "MiniMaxH3MotionContextLoadLatent" not in classes
    assert g["9"]["inputs"]["task_type"] == "Ref2VA"
    # 默认（c）仍保存 context 供下一镜续写
    g2 = build_h3_pipeline_c_graph(H3PipelineCParams(positive="x", images=("a.png",)))
    assert g2["19"]["class_type"] == "MiniMaxH3MotionContextSaveLatent"


# ───────────────────────── 参考选取 ─────────────────────────


def _refs(name, urls):
    return [RefImage(label=f"{name}{i}", role=name, image_url=u) for i, u in enumerate(urls)]


def test_select_single_character_caps_at_four_plus_one_scene():
    refs = _refs("林夏", LX + ["/api/studio/files/x5.png"]) + [
        RefImage(label="场景1", role="scene", image_url=SCENE),
        RefImage(label="场景2", role="scene", image_url="/api/studio/files/s2.png"),
    ]
    out = select_indep_shot_refs(refs, per_shot=4)
    assert [r.image_url for r in out] == LX + [SCENE]


def test_select_two_characters_round_robin_keeps_both():
    out = select_indep_shot_refs(_refs("林夏", LX) + _refs("店员", CL), per_shot=4)
    assert [r.image_url for r in out] == LX[:2] + CL[:2]


def test_select_three_characters_each_gets_one():
    refs = _refs("A", LX) + _refs("B", CL) + _refs("C", ["/c0.png", "/c1.png"])
    out = select_indep_shot_refs(refs, per_shot=4)
    roles = [r.role for r in out]
    assert roles.count("A") == 2 and roles.count("B") == 1 and roles.count("C") == 1
    assert len(out) == 4


def test_select_fewer_than_four_returns_all():
    out = select_indep_shot_refs(_refs("林夏", LX[:2]), per_shot=4)
    assert [r.image_url for r in out] == LX[:2]


def test_cast_missing_refs_names_character():
    cast = [SimpleNamespace(name="林夏"), SimpleNamespace(name="店员")]
    assert cast_missing_refs(cast, _refs("林夏", LX)) == ["店员"]
    assert cast_missing_refs(cast, _refs("林夏", LX) + _refs("店员", CL)) == []


# ───────────────────────── render_pipeline_c(ref2va) ─────────────────────────


class _FakeClient:
    def __init__(self, base_url="http://fake:1"):
        self.base_url = base_url
        self.uploads: list[str] = []
        self.graphs: list[dict] = []

    async def upload_image(self, data, fname):
        self.uploads.append(fname)
        return fname

    async def queue_prompt(self, graph, client_id):
        self.graphs.append(graph)
        return "pid-1"


def _patch_pcr(monkeypatch, client):
    import app.services.h3 as h3s
    import app.services.studio.pipeline_c_render as pcr

    ready_nodes: list[str] = []

    async def _pick(worker_url=None):
        return client

    async def _ready(c, node=None, **k):
        ready_nodes.append(node)

    async def _none(*a, **k):
        return None

    async def _bytes(url):
        return b"img"

    async def _wait(base, pid, request=None):
        return "/api/studio/files/out.mp4"

    async def _ocr(url, skip_until_frame=0):
        return {"hit": False, "text": "", "frames_checked": 1}

    monkeypatch.setattr(h3s, "ensure_h3_enabled", lambda: None)
    monkeypatch.setattr(h3s, "pick_h3_client", _pick)
    monkeypatch.setattr(h3s, "ensure_h3_ready", _ready)
    monkeypatch.setattr(h3s, "ensure_h3_vram", _none)
    monkeypatch.setattr(pcr, "_fetch_bytes", _bytes)
    monkeypatch.setattr(pcr, "_wait_video_url", _wait)
    monkeypatch.setattr(pcr, "_brand_ocr_after_render", _ocr)
    monkeypatch.setattr(pcr, "_resolve_sheet_palette_colors", lambda cast, style: {})
    return pcr, ready_nodes


def _shot():
    return SimpleNamespace(
        id="abcdef123456",
        prompt="林夏推门进店，店员抬头",
        dialogue="",
        camera="medium shot",
        scene="雨夜便利店",
        negative="",
        duration_sec=5,
    )


def _char(name, urls):
    return SimpleNamespace(
        id=name,
        name=name,
        visual_prompt="young woman",
        reference_images=json.dumps(urls),
        reference_images_by_style=None,
    )


def test_render_ref2va_four_refs_no_context(monkeypatch):
    client = _FakeClient()
    pcr, ready = _patch_pcr(monkeypatch, client)
    cast = [_char("林夏", LX), _char("店员", CL)]
    out = asyncio.run(
        pcr.render_pipeline_c(
            _shot(), cast, seed=7, scene_images=[SCENE], pipeline_name="ref2va", clip_index=3
        )
    )
    g = client.graphs[0]
    t8 = g["9"]["inputs"]
    assert t8["task_type"] == "Ref2VA"
    assert "first_frame" not in t8
    for nid in ("19", "20", "21", "22"):
        assert nid not in g
    ref_keys = sorted(k for k in t8 if k.startswith("ref_images."))
    assert len(ref_keys) == 5  # 4 定妆 + 1 场景
    assert out["ref_images"] == LX[:2] + CL[:2] + [SCENE]
    # 引用行编号与提交顺序一致：@图片1..@图片5，无 @图片6
    assert "@图片5作为" in t8["prompt"] and "@图片6" not in t8["prompt"]
    assert out["pipeline"] == "ref2va"
    assert out["context_latent"] == ""
    assert "MiniMaxH3MotionContext" not in ready


def test_render_ref2va_rejects_context_latent(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    with pytest.raises(RenderError, match="不续写"):
        asyncio.run(
            pcr.render_pipeline_c(
                _shot(), [_char("林夏", LX)], pipeline_name="ref2va",
                context_latent_path="toiv_drama_c/context/x_00001.safetensors",
            )
        )
    assert client.graphs == [] and client.uploads == []


def test_render_ref2va_rejects_first_frame(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    with pytest.raises(RenderError, match="不接首帧"):
        asyncio.run(
            pcr.render_pipeline_c(
                _shot(), [_char("林夏", LX)], pipeline_name="ref2va",
                first_frame_url="/api/studio/files/ff.png",
            )
        )
    assert client.graphs == []


def test_render_ref2va_character_without_refs_errors(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    cast = [_char("林夏", LX), _char("店员", [])]
    with pytest.raises(RenderError, match="店员 无参考图"):
        asyncio.run(
            pcr.render_pipeline_c(_shot(), cast, scene_images=[SCENE], pipeline_name="ref2va")
        )
    assert client.graphs == [] and client.uploads == []


def test_render_ref2va_no_refs_at_all_errors(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    with pytest.raises(RenderError, match="独立镜 Ref2VA 需要角色定妆参考图或场景参考图"):
        asyncio.run(pcr.render_pipeline_c(_shot(), [], pipeline_name="ref2va"))
    assert client.graphs == []


def test_render_ref2va_scene_only_shot_ok(monkeypatch):
    client = _FakeClient()
    pcr, _ = _patch_pcr(monkeypatch, client)
    out = asyncio.run(
        pcr.render_pipeline_c(_shot(), [], scene_images=[SCENE], pipeline_name="ref2va")
    )
    assert out["ref_images"] == [SCENE]


def test_render_c_still_continues(monkeypatch):
    client = _FakeClient()
    pcr, ready = _patch_pcr(monkeypatch, client)
    out = asyncio.run(
        pcr.render_pipeline_c(
            _shot(), [_char("林夏", LX)], pipeline_name="c", clip_index=2,
            context_latent_path="toiv_drama_c/context/p_00001.safetensors",
        )
    )
    g = client.graphs[0]
    assert "21" in g and "19" in g
    assert out["context_latent"].endswith("_00002.safetensors")
    assert "MiniMaxH3MotionContext" in ready


# ───────────────────────── API / 编排默认路由 ─────────────────────────


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
        tenant = Tenant(name="studio-ref2va")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="ref2va@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


def _make_project(client, H, n_shots=2):
    pid = client.post(
        "/api/studio/projects",
        headers=H,
        json={"title": "ref2va", "premise": "x", "render_mode_default": "video"},
    ).json()["id"]
    cid = client.post(
        f"/api/studio/projects/{pid}/characters", headers=H, json={"name": "林夏", "visual_prompt": "girl"}
    ).json()["id"]
    assert client.patch(
        f"/api/studio/characters/{cid}", headers=H, json={"reference_images": LX}
    ).status_code == 200
    shots = [
        {"scene": "雨夜", "prompt": f"beat {i}", "dialogue": "", "characters": ["林夏"], "render_mode": "video"}
        for i in range(n_shots)
    ]
    sr = client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": shots})
    assert sr.status_code == 200, sr.text
    return pid, [s["id"] for s in sr.json()["shots"]]


def _install_fake_renderer(monkeypatch, seen: list):
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderResult

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            seen.append(dict(kw))
            n = len(seen)
            pipe = kw.get("pipeline")
            return RenderResult(
                kind="video",
                url=f"/api/studio/files/r2v_{shot.idx}_{n}.mp4",
                pipeline_meta={
                    "pipeline": pipe,
                    "context_latent": (
                        "" if pipe == "ref2va"
                        else f"toiv_drama_c/context/s{shot.idx}_{n}_{shot.idx + 1:05d}.safetensors"
                    ),
                    "ref_images": LX[:4],
                    "job_id": f"pid-{n}",
                },
            )

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    monkeypatch.setattr(
        "app.services.studio.candidate_pick.pick_best_candidate",
        lambda cands, ref_image_path=None, local_url_resolver=None, **kw: (
            cands[0]["id"],
            [{**c, "is_picked": i == 0} for i, c in enumerate(cands)],
        ),
    )
    return orch


def test_api_default_routes_ref2va_and_never_continues(ctx, monkeypatch):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 2)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    # 镜0 显式 c 出带 context 的入选候选，镜1 默认（不传 pipeline）必须不续写
    r0 = client.post(f"/api/studio/shots/{sids[0]}/render", headers=H, json={"pipeline": "c", "num_candidates": 1})
    assert r0.status_code == 200, r0.text
    assert r0.json()["candidates"][0]["context_latent"]
    r1 = client.post(f"/api/studio/shots/{sids[1]}/render", headers=H, json={"num_candidates": 2})
    assert r1.status_code == 200, r1.text
    for kw in seen[1:]:
        assert kw["pipeline"] == "ref2va"
        assert "context_latent_path" not in kw
        assert "first_frame_url" not in kw
    body = r1.json()
    assert [c["pipeline"] for c in body["candidates"]] == ["ref2va", "ref2va"]
    assert all(not c.get("context_latent") for c in body["candidates"])


def test_api_no_body_defaults_ref2va(ctx, monkeypatch):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 1)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    r = client.post(f"/api/studio/shots/{sids[0]}/render", headers=H)
    assert r.status_code == 200, r.text
    assert seen[0]["pipeline"] == "ref2va"
    assert json.loads(r.json().get("ref_images_json") or "[]") == LX[:4] or r.json().get("ref_images") == LX[:4]


def test_api_explicit_c_still_continues_prev_context(ctx, monkeypatch):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 2)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    r0 = client.post(f"/api/studio/shots/{sids[0]}/render", headers=H, json={"pipeline": "c", "num_candidates": 1})
    ctx0 = r0.json()["candidates"][0]["context_latent"]
    r1 = client.post(f"/api/studio/shots/{sids[1]}/render", headers=H, json={"pipeline": "c", "num_candidates": 1})
    assert r1.status_code == 200, r1.text
    assert seen[1]["pipeline"] == "c"
    assert seen[1]["context_latent_path"] == ctx0


def test_api_accepts_ref2va_and_rejects_unknown(ctx):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 1)
    r = client.post(f"/api/studio/shots/{sids[0]}/render", headers=H, json={"pipeline": "motion"})
    assert r.status_code == 422
    assert "ref2va" in r.text


def test_api_batch_render_uses_ref2va(ctx, monkeypatch):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    pid, _sids = _make_project(client, H, 2)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["rendered"] == 2
    assert seen and all(k["pipeline"] == "ref2va" for k in seen)
    assert all("context_latent_path" not in k for k in seen)


def test_orchestrator_rejects_explicit_context_for_ref2va_before_status_change(ctx, monkeypatch):
    from app.models import StudioShot
    from app.services.studio import orchestrator as orch

    client, token, engine = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 1)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    with Session(engine) as s:
        shot = s.get(StudioShot, sids[0])
        before = shot.status
        with pytest.raises(RenderError, match="不续写"):
            asyncio.run(
                orch.render_shot(
                    s, shot, pool=object(),
                    context_latent_path="toiv_drama_c/context/x_00001.safetensors",
                )
            )
        s.refresh(shot)
        assert shot.status == before
    assert seen == []
