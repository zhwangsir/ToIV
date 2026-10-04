"""c_hybrid（实验 C 对齐：Hybrid 首帧锚定 + MotionContext）+ 管理员 worker_url 白名单。"""
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
from app.workflows.h3_pipeline_c import H3PipelineCParams, build_h3_pipeline_c_graph

REFS = [
    "/api/studio/files/sample_linxia_front.png",
    "/api/studio/files/sample_linxia_side.png",
    "/api/studio/files/sample_linxia_full.png",
]
W8195 = "http://100.68.100.90:8195"
W8264 = "http://100.68.100.90:8264"


# ───────────────────────── graph ─────────────────────────


def test_c_hybrid_graph_matches_experiment_c_continue():
    """续段：Hybrid + first_frame + 参考图 + MotionContext Load/Ctx/Trim/Save（对齐 C_zh_seg2_c*.json）。"""
    g = build_h3_pipeline_c_graph(
        H3PipelineCParams(
            positive="p",
            images=("front.png", "side.png", "full.png"),
            first_frame="tail.png",
            clip_index=2,
            context_latent_path="toiv_drama_c/context/x_1_1_00001.safetensors",
        )
    )
    t8 = g["9"]["inputs"]
    assert g["9"]["class_type"] == "MiniMaxH3AudioConditioningT8"
    assert t8["task_type"] == "Hybrid"
    assert t8["first_frame"] == ["7", 0]
    assert g["7"]["inputs"]["image"] == "tail.png"
    assert [t8[f"ref_images.ref_image_{i}"] for i in range(3)] == [["7a", 0], ["7b", 0], ["7c", 0]]
    assert g["8"]["inputs"]["unet_name"] == "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    assert t8["audio_mode"] == "native" and t8["length"] == 362
    assert g["20"]["inputs"]["clip_index"] == 1
    assert g["21"]["inputs"]["context_length"] == "22"
    assert g["21"]["inputs"]["audio_context_length"] == 24
    assert g["22"]["class_type"] == "MiniMaxH3MotionContextTrim"
    assert g["19"]["inputs"]["clip_index"] == 2
    assert g["13"]["inputs"]["steps"] == 20
    assert g["3"]["inputs"]["sampler_name"] == "res_multistep"


# ───────────────────── render_pipeline_c ─────────────────────


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


def _patch_pcr(monkeypatch, client: _FakeClient, picked: dict):
    import app.services.h3 as h3s
    import app.services.studio.pipeline_c_render as pcr

    async def _pick(worker_url=None):
        picked["worker_url"] = worker_url
        if worker_url:
            h3s.validate_worker_override(worker_url)
        return client

    async def _none(*a, **k):
        return None

    async def _bytes(url):
        return b"img"

    async def _wait(base, pid, request=None):
        return "/api/studio/files/out.mp4"

    async def _ocr(url):
        return {"hit": False, "text": "", "frames_checked": 1}

    monkeypatch.setattr(h3s, "ensure_h3_enabled", lambda: None)
    monkeypatch.setattr(h3s, "pick_h3_client", _pick)
    monkeypatch.setattr(h3s, "ensure_h3_ready", _none)
    monkeypatch.setattr(h3s, "ensure_h3_vram", _none)
    monkeypatch.setattr(pcr, "_fetch_bytes", _bytes)
    monkeypatch.setattr(pcr, "_wait_video_url", _wait)
    monkeypatch.setattr(pcr, "_brand_ocr_after_render", _ocr)
    monkeypatch.setattr(pcr, "_resolve_sheet_palette_colors", lambda cast, style: {})
    return pcr


def _shot_cast():
    shot = SimpleNamespace(
        id="abcdef123456",
        prompt='林夏推门进店说：「还营业吧？」',
        dialogue="还营业吧？",
        camera="medium shot",
        scene="雨夜便利店",
        negative="",
        duration_sec=15,
    )
    cast = [
        SimpleNamespace(
            id="c1",
            name="林夏",
            visual_prompt="young woman, dark raincoat",
            reference_images=json.dumps(REFS),
            reference_images_by_style=None,
        )
    ]
    return shot, cast


def test_render_pipeline_c_hybrid_uploads_first_frame_and_uses_hybrid(monkeypatch):
    client = _FakeClient()
    picked: dict = {}
    pcr = _patch_pcr(monkeypatch, client, picked)
    shot, cast = _shot_cast()
    out = asyncio.run(
        pcr.render_pipeline_c(
            shot,
            cast,
            seed=123,
            context_latent_path="toiv_drama_c/context/prev_1_9_00001.safetensors",
            clip_index=2,
            first_frame_url="/api/studio/files/chybrid_ff_abc.png",
            worker_url=W8195,
            pipeline_name="c_hybrid",
        )
    )
    assert picked["worker_url"] == W8195
    g = client.graphs[0]
    t8 = g["9"]["inputs"]
    assert t8["task_type"] == "Hybrid"
    ff_name = g["7"]["inputs"]["image"]
    assert ff_name.startswith("toiv_c_ff_") and ff_name in client.uploads
    assert "21" in g and "22" in g  # MotionContext 续写保留
    # 提示词：线上英文视觉提示，台词不进画面 + Avoid 屏蔽字幕/店招
    assert "还营业吧" not in t8["prompt"]
    assert "Avoid:" in t8["prompt"] and "字幕" in t8["prompt"]
    assert out["pipeline"] == "c_hybrid"
    assert out["first_frame"] == "/api/studio/files/chybrid_ff_abc.png"


def test_render_pipeline_c_default_unchanged_ref2va(monkeypatch):
    client = _FakeClient()
    picked: dict = {}
    pcr = _patch_pcr(monkeypatch, client, picked)
    shot, cast = _shot_cast()
    out = asyncio.run(pcr.render_pipeline_c(shot, cast, seed=1))
    g = client.graphs[0]
    assert g["9"]["inputs"]["task_type"] == "Ref2VA"
    assert "7" not in g and "first_frame" not in g["9"]["inputs"]
    assert out["pipeline"] == "c"
    assert picked["worker_url"] is None


def test_render_pipeline_c_hybrid_requires_first_frame(monkeypatch):
    from app.services.studio.renderers.base import RenderError

    client = _FakeClient()
    pcr = _patch_pcr(monkeypatch, client, {})
    shot, cast = _shot_cast()
    with pytest.raises(RenderError, match="c_hybrid 需要首帧"):
        asyncio.run(pcr.render_pipeline_c(shot, cast, pipeline_name="c_hybrid"))
    assert client.graphs == []


def test_render_pipeline_c_rejects_non_whitelisted_worker(monkeypatch):
    from app.services.studio.renderers.base import RenderError

    client = _FakeClient()
    pcr = _patch_pcr(monkeypatch, client, {})
    shot, cast = _shot_cast()
    with pytest.raises(RenderError, match="白名单"):
        asyncio.run(
            pcr.render_pipeline_c(shot, cast, worker_url="http://100.68.100.90:8196")
        )
    assert client.graphs == []


# ───────────────────── h3 worker override ─────────────────────


def test_validate_worker_override_whitelist():
    from app.services.h3 import validate_worker_override

    assert validate_worker_override(None) is None
    assert validate_worker_override("  ") is None
    assert validate_worker_override(W8195 + "/") == W8195
    assert validate_worker_override(W8264) == W8264
    for bad in (
        "http://100.68.100.90:8196",
        "http://100.68.100.90:8262",
        "http://100.68.100.90:8263",
        "http://192.168.71.127:8195",
        "http://evil.example:8195",
        "https://100.68.100.90:8195",
    ):
        with pytest.raises(ValueError, match="白名单"):
            validate_worker_override(bad)


def test_pick_h3_client_pinned(monkeypatch):
    import app.services.h3 as h3s

    c = asyncio.run(h3s.pick_h3_client(worker_url=W8264))
    assert c.base_url.rstrip("/") == W8264
    with pytest.raises(ValueError):
        asyncio.run(h3s.pick_h3_client(worker_url="http://100.68.100.90:8205"))


# ───────────────────── orchestrator + API ─────────────────────


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
        tenant = Tenant(name="studio-chy")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="chy-user@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        admin = User(
            email="chy-admin@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
            role="admin",
        )
        s.add(user)
        s.add(admin)
        s.commit()
        s.refresh(user)
        s.refresh(admin)
        uid, aid = user.id, admin.id
    yield TestClient(app), create_token(uid), create_token(aid)
    app.dependency_overrides.clear()


def _make_project(client, H, n_shots=2):
    pr = client.post(
        "/api/studio/projects",
        headers=H,
        json={"title": "chy", "premise": "x", "render_mode_default": "video"},
    )
    assert pr.status_code == 200, pr.text
    pid = pr.json()["id"]
    cid = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏", "visual_prompt": "girl"},
    ).json()["id"]
    assert client.patch(
        f"/api/studio/characters/{cid}", headers=H, json={"reference_images": REFS}
    ).status_code == 200
    shots = [
        {
            "scene": "雨夜",
            "prompt": f"beat {i}",
            "dialogue": "",
            "characters": ["林夏"],
            "render_mode": "video",
        }
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
            return RenderResult(
                kind="video",
                url=f"/api/studio/files/chy_{shot.idx}_{n}.mp4",
                pipeline_meta={
                    "pipeline": kw.get("pipeline"),
                    "context_latent": f"toiv_drama_c/context/s{shot.idx}_{n}_{shot.idx + 1:05d}.safetensors",
                    "first_frame": kw.get("first_frame_url") or "",
                    "worker": kw.get("worker_url") or "http://pool",
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


def test_c_hybrid_chain_first_shot_full_body_then_prev_tail(ctx, monkeypatch, tmp_path):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 2)
    seen: list = []
    orch = _install_fake_renderer(monkeypatch, seen)

    extracted: dict = {}
    prev_mp4 = tmp_path / "prev.mp4"
    prev_mp4.write_bytes(b"v")

    def fake_local(url):
        extracted.setdefault("local_urls", []).append(url)
        return prev_mp4

    def fake_extract(src, dst):
        extracted["src"] = src
        extracted["dst"] = dst
        dst.write_bytes(b"png")

    monkeypatch.setattr(orch, "_studio_local_path", fake_local)
    monkeypatch.setattr(orch, "_extract_last_frame", fake_extract)
    monkeypatch.setattr(orch, "_first_frame_out_dir", lambda: tmp_path)

    # 镜0：全身定妆图作首帧
    r0 = client.post(
        f"/api/studio/shots/{sids[0]}/render",
        headers=H,
        json={"pipeline": "c_hybrid", "num_candidates": 2},
    )
    assert r0.status_code == 200, r0.text
    assert len(seen) == 2
    assert all(k["pipeline"] == "c_hybrid" for k in seen)
    assert seen[0]["first_frame_url"] == "/api/studio/files/sample_linxia_full.png"
    assert "context_latent_path" not in seen[0]
    c0 = r0.json()["candidates"]
    assert [c.get("pipeline") for c in c0] == ["c_hybrid", "c_hybrid"]
    assert c0[0].get("first_frame") == "/api/studio/files/sample_linxia_full.png"
    picked0 = next(c for c in c0 if c.get("is_picked"))

    # 镜1：上一镜入选视频尾帧 + MotionContext 续写
    r1 = client.post(
        f"/api/studio/shots/{sids[1]}/render",
        headers=H,
        json={"pipeline": "c_hybrid", "num_candidates": 2},
    )
    assert r1.status_code == 200, r1.text
    kw1 = seen[2]
    assert extracted["local_urls"][0] == picked0["url"]
    assert extracted["src"] == prev_mp4
    assert kw1["first_frame_url"].startswith("/api/studio/files/chybrid_ff_")
    assert kw1["first_frame_url"].endswith(extracted["dst"].name)
    assert kw1["context_latent_path"] == picked0["context_latent"]
    assert kw1["clip_index"] == 2
    c1 = r1.json()["candidates"]
    assert all(c.get("pipeline") == "c_hybrid" for c in c1)


def test_c_hybrid_first_shot_without_full_body_errors(ctx, monkeypatch):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    pid, sids = _make_project(client, H, 1)
    # 角色只留正/侧（无全身）
    chars = client.get(f"/api/studio/projects/{pid}", headers=H).json().get("characters") or []
    cid = chars[0]["id"]
    client.patch(
        f"/api/studio/characters/{cid}", headers=H, json={"reference_images": REFS[:2]}
    )
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    r = client.post(
        f"/api/studio/shots/{sids[0]}/render",
        headers=H,
        json={"pipeline": "c_hybrid", "num_candidates": 1},
    )
    assert r.status_code == 502, r.text
    assert "全身定妆图" in r.text
    assert seen == []


def test_default_c_unchanged_no_first_frame(ctx, monkeypatch):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 1)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)
    r = client.post(f"/api/studio/shots/{sids[0]}/render", headers=H, json={"num_candidates": 1})
    assert r.status_code == 200, r.text
    assert seen[0]["pipeline"] == "c"
    assert "first_frame_url" not in seen[0]
    assert "worker_url" not in seen[0]
    assert r.json()["candidates"][0]["pipeline"] == "c"


def test_render_body_rejects_unknown_pipeline(ctx):
    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 1)
    r = client.post(
        f"/api/studio/shots/{sids[0]}/render", headers=H, json={"pipeline": "bogus"}
    )
    assert r.status_code == 422


def test_worker_url_admin_gate_and_whitelist(ctx, monkeypatch):
    client, token, admin_token = ctx
    H = {"Authorization": f"Bearer {token}"}
    HA = {"Authorization": f"Bearer {admin_token}"}
    _pid, sids = _make_project(client, H, 1)
    seen: list = []
    _install_fake_renderer(monkeypatch, seen)

    # 普通用户（项目所有者）传 worker_url → 403
    r = client.post(
        f"/api/studio/shots/{sids[0]}/render",
        headers=H,
        json={"num_candidates": 1, "worker_url": W8195},
    )
    assert r.status_code == 403, r.text
    assert seen == []

    # 管理员但非白名单 → 422（不得落到渲染）
    for bad in ("http://100.68.100.90:8196", "http://100.68.100.90:8262", "http://x:8195"):
        r = client.post(
            f"/api/studio/shots/{sids[0]}/render",
            headers=HA,
            json={"num_candidates": 1, "worker_url": bad},
        )
        assert r.status_code == 422, (bad, r.text)
    assert seen == []

    # 管理员 + 白名单 → 下发到渲染器
    r = client.post(
        f"/api/studio/shots/{sids[0]}/render",
        headers=HA,
        json={"num_candidates": 1, "worker_url": W8195 + "/", "pipeline": "c"},
    )
    assert r.status_code == 200, r.text
    assert seen[-1]["worker_url"] == W8195


def test_orchestrator_rejects_bad_worker_before_status_change(ctx, monkeypatch):
    """直调编排层：非白名单 worker 在改状态前 RenderError。"""
    from app.models import StudioShot
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderError

    client, token, _ = ctx
    H = {"Authorization": f"Bearer {token}"}
    _pid, sids = _make_project(client, H, 1)
    gen = app.dependency_overrides[get_session]()
    session = next(gen)
    shot = session.get(StudioShot, sids[0])
    before = shot.status
    with pytest.raises(RenderError, match="白名单"):
        asyncio.run(
            orch.render_shot(session, shot, pool=object(), worker_url="http://100.68.100.90:8196")
        )
    session.refresh(shot)
    assert shot.status == before


# ───────────────────── 全身定妆图选择（设定卡分桶） ─────────────────────


def _char(**kw):
    from app.models import StudioCharacter

    base = dict(project_id="p", name="沈青禾", visual_prompt="girl", reference_images="[]",
                reference_images_by_style="{}")
    base.update(kw)
    return StudioCharacter(**base)


def test_full_body_prefers_explicit_full_sample():
    from app.services.studio import orchestrator as orch

    c = _char(reference_images=json.dumps(REFS))
    assert orch._full_body_ref_url([c], None) == "/api/studio/files/sample_linxia_full.png"


def test_full_body_from_sheet_bucket_uses_front_panel_not_side():
    """设定卡分桶 portrait/front/side/back：全身首帧取 front 格；portrait 半身、side 被槽标签误标「全身」。"""
    from app.services.studio import orchestrator as orch

    pre = "/api/studio/files/char_panel_1c790086_ancient_realistic_"
    bucket = [pre + "portrait_aa.png", pre + "front_bb.png", pre + "side_cc.png", pre + "back_dd.png"]
    c = _char(reference_images_by_style=json.dumps({"ancient_realistic": bucket}))
    assert orch._full_body_ref_url([c], "ancient_realistic") == pre + "front_bb.png"


def test_full_body_none_when_only_portrait_panel():
    from app.services.studio import orchestrator as orch

    pre = "/api/studio/files/char_panel_1c790086_ancient_realistic_"
    c = _char(reference_images_by_style=json.dumps({"ancient_realistic": [pre + "portrait_aa.png"]}))
    assert orch._full_body_ref_url([c], "ancient_realistic") is None
