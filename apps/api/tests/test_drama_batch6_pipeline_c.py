"""Batch6: 管线 C 构图 / 提示词清洗 / 候选选优 / render body pipeline 字段。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.workflows.h3_pipeline_c import H3PipelineCParams, build_h3_pipeline_c_graph
from app.services.studio.prompt_c import build_c_visual_prompt, strip_dialogue, merge_negative
from app.services.studio.candidate_pick import pick_best_candidate


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
        tenant = Tenant(name="studio-b6")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="studio-b6@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def test_strip_dialogue_removes_quotes_and_speech():
    s = strip_dialogue('林夏推门进店说：「还营业吧？」然后走向冷柜')
    assert "还营业吧" not in s
    assert "「" not in s
    assert "冷柜" in s or "推门" in s


def test_build_c_visual_prompt_keeps_dialogue_out():
    p = build_c_visual_prompt(
        shot_prompt='进店，看着店员说：「还营业吧？」',
        dialogue="还营业吧？",
        scene="雨夜便利店",
        ref_prefix="@图片1作为林夏正面身份与服装参考\n",
    )
    assert "还营业吧" not in p
    assert "Avoid:" in p
    assert "字幕" in p
    assert p.startswith("@图片1")


def test_merge_negative_adds_subtitle_block():
    n = merge_negative("blur")
    assert "blur" in n and "字幕" in n


def test_pipeline_c_graph_first_segment():
    g = build_h3_pipeline_c_graph(
        H3PipelineCParams(
            positive="test prompt",
            images=("a.png", "b.png", "c.png"),
            clip_index=1,
        )
    )
    assert g["9"]["class_type"] == "MiniMaxH3AudioConditioningT8"
    assert g["8"]["inputs"]["unet_name"].startswith("minimax_h3_ref2va")
    assert "ref_images.ref_image_0" in g["9"]["inputs"]
    assert "21" not in g  # 首段无 MotionContext
    assert g["19"]["class_type"] == "MiniMaxH3MotionContextSaveLatent"
    assert g["9"]["inputs"]["audio_mode"] == "native"
    assert g["9"]["inputs"]["length"] == 362
    assert g["9"]["inputs"]["task_type"] == "Ref2VA"  # 无首帧不可用 Hybrid


def test_pipeline_c_graph_hybrid_when_first_frame():
    g = build_h3_pipeline_c_graph(
        H3PipelineCParams(
            positive="test",
            images=("a.png",),
            first_frame="tail.png",
        )
    )
    assert g["9"]["inputs"]["task_type"] == "Hybrid"
    assert g["9"]["inputs"]["first_frame"] == ["7", 0]
    assert g["7"]["inputs"]["image"] == "tail.png"


def test_pipeline_c_graph_continue_has_motion_context():
    g = build_h3_pipeline_c_graph(
        H3PipelineCParams(
            positive="续写",
            images=("a.png",),
            clip_index=2,
            context_latent_path="toiv_drama_c/context/x_00001.safetensors",
        )
    )
    assert g["20"]["class_type"] == "MiniMaxH3MotionContextLoadLatent"
    assert g["21"]["class_type"] == "MiniMaxH3MotionContext"
    assert g["21"]["inputs"]["context_length"] == "22"
    assert g["21"]["inputs"]["audio_context_length"] == 24
    assert g["22"]["class_type"] == "MiniMaxH3MotionContextTrim"


def test_pipeline_c_requires_refs():
    with pytest.raises(ValueError, match="参考图"):
        build_h3_pipeline_c_graph(H3PipelineCParams(positive="x", images=()))


def test_pick_best_fallback_first_when_no_scorer():
    cands = [
        {"id": "a", "url": "/nope/a.mp4", "status": "done", "is_picked": True},
        {"id": "b", "url": "/nope/b.mp4", "status": "done", "is_picked": False},
    ]
    wid, out = pick_best_candidate(cands, ref_image_path=None)
    assert wid == "a"
    assert out[0]["is_picked"] is True


def test_pick_best_fallback_when_scorer_raises(tmp_path, monkeypatch):
    """选优内部异常必须回落，不能冒泡成 render 500。"""
    import app.services.studio.candidate_pick as cp

    ref = tmp_path / "ref.jpg"
    ref.write_bytes(b"x")
    vid = tmp_path / "a.mp4"
    vid.write_bytes(b"y")
    cands = [
        {"id": "a", "url": str(vid), "status": "done", "is_picked": True},
        {"id": "b", "url": str(vid), "status": "done", "is_picked": False},
    ]
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    wid, out = pick_best_candidate(cands, ref_image_path=ref)
    assert wid == "a"
    assert out[0]["is_picked"] is True
    assert "face_scorer_error_fallback" in (out[0].get("pick_note") or "")


def test_render_body_accepts_pipeline_c(ctx, monkeypatch):
    from app.services.studio import orchestrator as orch
    from app.services.studio.renderers.base import RenderResult

    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    pr = client.post(
        "/api/studio/projects",
        headers=H,
        json={"title": "b6", "premise": "x", "render_mode_default": "video"},
    )
    assert pr.status_code == 200, pr.text
    pid = pr.json()["id"]
    # 角色+三视图
    cr = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "林夏", "visual_prompt": "girl"},
    )
    cid = cr.json()["id"]
    refs = [
        "/api/studio/files/sample_linxia_front.png",
        "/api/studio/files/sample_linxia_side.png",
        "/api/studio/files/sample_linxia_full.png",
    ]
    assert client.patch(
        f"/api/studio/characters/{cid}", headers=H, json={"reference_images": refs}
    ).status_code == 200
    sr = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={
            "shots": [
                {
                    "scene": "雨夜",
                    "prompt": '进店说：「还营业吧？」',
                    "dialogue": "还营业吧？",
                    "characters": ["林夏"],
                    "render_mode": "video",
                }
            ]
        },
    )
    sid = sr.json()["shots"][0]["id"]
    seen = {"pipeline": None, "n": 0}

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            seen["pipeline"] = kw.get("pipeline")
            seen["n"] += 1
            assert kw.get("video_model") == "h3"
            # 提示词清洗在 pipeline_c_render；此处 fake 只断言 pipeline 下发
            return RenderResult(
                kind="video",
                url=f"/api/studio/files/b6_{seen['n']}.mp4",
                pipeline_meta={
                    "pipeline": "c",
                    "context_latent": f"toiv_drama_c/context/x_{seen['n']}_00001.safetensors",
                    "prompt": "cleaned",
                },
            )

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    # 禁用 face pick 依赖真实文件
    monkeypatch.setattr(
        "app.services.studio.candidate_pick.pick_best_candidate",
        lambda cands, ref_image_path=None, local_url_resolver=None: (
            cands[0]["id"],
            [{**c, "is_picked": i == 0} for i, c in enumerate(cands)],
        ),
    )
    r = client.post(
        f"/api/studio/shots/{sid}/render",
        headers=H,
        json={"video_model": "h3", "pipeline": "c", "num_candidates": 2},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert seen["pipeline"] == "c"
    assert seen["n"] == 2
    assert body["status"] == "rendered"
    assert len(body["candidates"]) == 2
    assert body["candidates"][0].get("pipeline") == "c" or body["candidates"][0].get("context_latent")
