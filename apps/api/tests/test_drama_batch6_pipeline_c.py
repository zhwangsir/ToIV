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
from app.services.studio.prompt_c import (
    build_c_visual_prompt, strip_dialogue, merge_negative,
    costume_lock_for_style, build_cast_visual_for_style,
    pick_garment_colors, costume_color_phrases_from_palette,
    hex_to_zh_en_color,
)
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
    assert "店招" in n and "storefront" in n.lower()


def test_build_c_visual_prompt_includes_storefront_avoid():
    """店招/乱码负向必须进 Avoid（曾被 _ = merge_negative 丢弃）。"""
    p = build_c_visual_prompt(
        shot_prompt="雨夜便利店门口",
        scene="门外",
        negative="blurry",
    )
    assert "Avoid:" in p
    assert "店招" in p
    assert "storefront" in p.lower() or "signboard" in p.lower()
    assert "乱码" in p or "garbled" in p.lower()
    assert "blurry" in p


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


def test_pick_best_raises_when_no_scorer_and_no_continuity():
    """无人脸评分且无连贯材料 → 抛错，禁止静默回落首候选。"""
    from app.services.studio.candidate_pick import CandidatePickError

    cands = [
        {"id": "a", "url": "/nope/a.mp4", "status": "done", "is_picked": True},
        {"id": "b", "url": "/nope/b.mp4", "status": "done", "is_picked": False},
    ]
    with pytest.raises(CandidatePickError, match="禁止静默回落"):
        pick_best_candidate(cands, ref_image_path=None)
    assert all(c.get("is_picked") is False for c in cands)
    assert "face_scorer_unavailable" in (cands[0].get("pick_note") or "")


def test_pick_best_raises_when_scorer_raises(tmp_path, monkeypatch):
    """选优内部异常必须抛错标失败，禁止回落首候选。"""
    import app.services.studio.candidate_pick as cp
    from app.services.studio.candidate_pick import CandidatePickError

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
    with pytest.raises(CandidatePickError, match="选优失败"):
        pick_best_candidate(cands, ref_image_path=ref)
    assert all(c.get("is_picked") is False for c in cands)
    assert "face_scorer_error" in (cands[0].get("pick_note") or "")


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
        lambda cands, ref_image_path=None, local_url_resolver=None, **kw: (
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


def test_continuity_prefers_matching_scene(tmp_path, monkeypatch):
    """无人脸评分时，连贯分更高的候选应胜出（抑制场景回退）。"""
    import app.services.studio.candidate_pick as cp

    good = tmp_path / "good.mp4"
    bad = tmp_path / "bad.mp4"
    good.write_bytes(b"g")
    bad.write_bytes(b"b")
    monkeypatch.setattr(cp, "_try_import_face", lambda: False)

    def fake_cont(path, prev, scene_ref_path=None, regression_ref_path=None):
        return {
            "continuity": 0.85 if str(path).endswith("good.mp4") else 0.15,
            "regression": None,
            "error": "",
        }

    monkeypatch.setattr(cp, "score_scene_continuity", fake_cont)
    cands = [
        {"id": "bad", "url": str(bad), "status": "done", "is_picked": True},
        {"id": "good", "url": str(good), "status": "done", "is_picked": False},
    ]
    wid, out = cp.pick_best_candidate(
        cands, ref_image_path=None, prev_video_path=tmp_path / "prev.mp4"
    )
    assert wid == "good"
    by_id = {c["id"]: c for c in out}
    assert (by_id["good"].get("continuity") or 0) > (by_id["bad"].get("continuity") or 0)


def test_pick_score_includes_continuity_bonus(tmp_path, monkeypatch):
    import app.services.studio.candidate_pick as cp

    ref = tmp_path / "ref.jpg"
    ref.write_bytes(b"x")
    a = tmp_path / "a.mp4"
    b = tmp_path / "b.mp4"
    a.write_bytes(b"1")
    b.write_bytes(b"2")
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)

    def fake_face(path, ref_image_path):
        # 两人脸分相同，连贯分应决出胜负
        return {
            "face_mean": 0.5,
            "sims": [0.5],
            "burnin_penalty": 0.0,
            "ocr_penalty": 0.0,
            "error": "",
        }

    def fake_cont(path, prev, scene_ref_path=None, regression_ref_path=None):
        p = str(path)
        return {"continuity": 0.9 if p.endswith("b.mp4") else 0.1, "regression": None, "error": ""}

    monkeypatch.setattr(cp, "score_video_face", fake_face)
    monkeypatch.setattr(cp, "score_scene_continuity", fake_cont)
    cands = [
        {"id": "a", "url": str(a), "status": "done", "is_picked": True},
        {"id": "b", "url": str(b), "status": "done", "is_picked": False},
    ]
    wid, out = cp.pick_best_candidate(
        cands, ref_image_path=ref, prev_video_path=tmp_path / "prev.mp4"
    )
    assert wid == "b"
    assert out[1]["is_picked"] is True


def test_regression_penalizes_shot0_lookalike(tmp_path, monkeypatch):
    """与镜0首帧过像的回退候选应被连贯/回退分扣掉。"""
    import app.services.studio.candidate_pick as cp

    good = tmp_path / "good.mp4"
    bad = tmp_path / "bad.mp4"
    good.write_bytes(b"g")
    bad.write_bytes(b"b")
    monkeypatch.setattr(cp, "_try_import_face", lambda: False)

    def fake_cont(path, prev, scene_ref_path=None, regression_ref_path=None):
        # bad=像镜0(高 regression)+低连贯；good=高连贯+低 regression
        if str(path).endswith("bad.mp4"):
            return {"continuity": 0.2, "regression": 0.9, "error": ""}
        return {"continuity": 0.8, "regression": 0.2, "error": ""}

    monkeypatch.setattr(cp, "score_scene_continuity", fake_cont)
    cands = [
        {"id": "bad", "url": str(bad), "status": "done", "is_picked": True},
        {"id": "good", "url": str(good), "status": "done", "is_picked": False},
    ]
    wid, out = cp.pick_best_candidate(
        cands,
        ref_image_path=None,
        prev_video_path=tmp_path / "prev.mp4",
        regression_ref_path=tmp_path / "shot0.mp4",
    )
    assert wid == "good"
    by = {c["id"]: c for c in out}
    assert (by["bad"].get("regression") or 0) > (by["good"].get("regression") or 0)


def test_face_gate_rejects_low_face_mean(tmp_path, monkeypatch):
    """face_mean 低于门禁或 null 时必须 CandidatePickError，禁止入选。"""
    import app.services.studio.candidate_pick as cp
    from app.services.studio.candidate_pick import CandidatePickError

    a = tmp_path / "a.mp4"; a.write_bytes(b"x")
    b = tmp_path / "b.mp4"; b.write_bytes(b"y")
    ref = tmp_path / "ref.png"; ref.write_bytes(b"z")

    def fake_face(path, ref_image_path):
        # a=负脸分；b=无人脸
        if str(path).endswith("a.mp4"):
            return {"face_mean": -0.03, "burnin_penalty": 0, "ocr_penalty": 0, "error": ""}
        return {"face_mean": None, "burnin_penalty": 0, "ocr_penalty": 0, "error": "无人脸检出"}

    def fake_cont(path, prev, scene_ref_path=None, regression_ref_path=None):
        return {"continuity": 0.8, "regression": 0.2, "error": ""}

    monkeypatch.setattr(cp, "score_video_face", fake_face)
    monkeypatch.setattr(cp, "score_scene_continuity", fake_cont)
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)

    cands = [
        {"id": "bad", "url": str(a), "status": "done", "is_picked": False},
        {"id": "nullface", "url": str(b), "status": "done", "is_picked": False},
    ]
    with pytest.raises(CandidatePickError, match="无人脸达标"):
        cp.pick_best_candidate(
            cands,
            ref_image_path=ref,
            local_url_resolver=lambda u: u,
            min_face_mean=0.45,
        )
    assert all(not c.get("is_picked") for c in cands)


def test_face_gate_allows_passing_face(tmp_path, monkeypatch):
    import app.services.studio.candidate_pick as cp

    a = tmp_path / "a.mp4"; a.write_bytes(b"x")
    b = tmp_path / "b.mp4"; b.write_bytes(b"y")
    ref = tmp_path / "ref.png"; ref.write_bytes(b"z")

    def fake_face(path, ref_image_path):
        if str(path).endswith("b.mp4"):
            return {"face_mean": 0.62, "burnin_penalty": 0, "ocr_penalty": 0, "error": ""}
        return {"face_mean": 0.2, "burnin_penalty": 0, "ocr_penalty": 0, "error": ""}

    def fake_cont(path, prev, scene_ref_path=None, regression_ref_path=None):
        return {"continuity": 0.5, "regression": 0.2, "error": ""}

    monkeypatch.setattr(cp, "score_video_face", fake_face)
    monkeypatch.setattr(cp, "score_scene_continuity", fake_cont)
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)

    cands = [
        {"id": "low", "url": str(a), "status": "done", "is_picked": False},
        {"id": "ok", "url": str(b), "status": "done", "is_picked": False},
    ]
    wid, out = cp.pick_best_candidate(
        cands,
        ref_image_path=ref,
        local_url_resolver=lambda u: u,
        min_face_mean=0.45,
    )
    assert wid == "ok"
    assert next(c for c in out if c["id"] == "ok")["is_picked"] is True


def test_costume_lock_for_style_ancient():
    s = costume_lock_for_style("ancient_realistic", visual_prompt="Lin Xia black raincoat hoodie", name="林夏")
    low = s.lower()
    assert "jiaoling" in low or "hanfu" in low
    assert "gold" in low or "黑" in s or "棕" in s
    assert "no raincoat" in low and "no hoodie" in low
    assert "no purple" in low or "禁止紫" in s
    # 正向段不得再写雨衣/帽衫/indigo/navy（否定里可写 no indigo）
    positive = low.split("no hood", 1)[0]
    assert "raincoat" not in positive
    assert "hoodie" not in positive
    assert "indigo" not in positive and "navy" not in positive


def test_costume_lock_for_style_anime():
    s = costume_lock_for_style("anime", visual_prompt="girl in hanfu", name="林夏")
    low = s.lower()
    assert "raincoat" in low
    assert "hood down" in low
    assert "no hanfu" in low
    positive = low.split("no hanfu", 1)[0]
    assert "hanfu" not in positive


def test_build_cast_visual_for_style_injects():
    class C:
        name = "林夏"
        visual_prompt = "young woman, black raincoat"
    out = build_cast_visual_for_style([C()], style="ancient_realistic")
    low = out.lower()
    assert "hanfu" in low or "jiaoling" in low
    positive = low.split("no hood", 1)[0]
    assert "raincoat" not in positive


def test_build_c_visual_prompt_with_costume_lock():
    lock = costume_lock_for_style("ancient_realistic", visual_prompt="Lin Xia", name="林夏")
    p = build_c_visual_prompt(
        shot_prompt="rainy ancient courtyard alley",
        cast_visual=lock,
        scene="古风雨夜庭院",
    )
    assert "hanfu" in p.lower() or "jiaoling" in p.lower() or "纯黑" in p
    pos = p.lower().split("no hood", 1)[0]
    assert "indigo" not in pos and "navy" not in pos
    assert "Avoid:" in p


def test_palette_pick_and_zh_color_lock():
    """06:4x：按面积序取服装色，中文色名进正向，紫蓝进反向。"""
    colors = ["#E8C4A8", "#1A1A1E", "#8B7355", "#D4AF37", "#6A5ACD"]
    picked = pick_garment_colors(colors, n=3)
    assert picked[0] == "#1A1A1E"
    assert "#E8C4A8" not in picked
    pos, neg = costume_color_phrases_from_palette(colors)
    assert "纯黑" in pos or "深棕" in pos or "棕色" in pos
    assert "jet black" in pos.lower() or "deep brown" in pos.lower() or "brown" in pos.lower()
    assert "purple" in neg.lower() or "紫" in neg
    s = costume_lock_for_style(
        "ancient_realistic",
        visual_prompt="Lin Xia",
        name="林夏",
        colors=colors,
    )
    assert "纯黑" in s or "深棕" in s or "棕色" in s
    pos = s.lower().split("no purple", 1)[0].split("禁止紫", 1)[0]
    assert "indigo" not in pos and "navy" not in pos
    zh, en = hex_to_zh_en_color("#1A1A1E")
    assert zh == "纯黑" and "black" in en

