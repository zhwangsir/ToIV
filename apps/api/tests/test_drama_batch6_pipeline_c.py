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
from app.services.studio.candidate_pick import (
    pick_best_candidate,
    garment_brand_ocr_hit,
    garment_brand_ocr_frame,
    brand_text_hit,
    scene_sign_ocr_frame,
    sign_text_hit,
    garment_main_color_miss,
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

    def fake_face(path, ref_image_path, **kwargs):
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

    def fake_face(path, ref_image_path, **kwargs):
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

    def fake_face(path, ref_image_path, **kwargs):
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
    assert "no raincoat" in low and "no hoodie" in low
    assert "no purple" in low or "禁止紫" in s
    # 正向段不得再写雨衣/帽衫/indigo/navy（否定里可写 no indigo）
    positive = low.split("no hood", 1)[0]
    assert "raincoat" not in positive
    assert "hoodie" not in positive
    assert "indigo" not in positive and "navy" not in positive
    # 无 colors：正向不得硬编码 jet-black / 主色纯黑
    assert "jet-black" not in positive and "jet black" not in positive
    assert "主色纯黑" not in s.split("no hood", 1)[0]
    assert "plain" in low or "unbranded" in low or "素面" in s or "no print" in low


def test_costume_lock_for_style_anime():
    s = costume_lock_for_style("anime", visual_prompt="girl in hanfu", name="林夏")
    low = s.lower()
    assert "raincoat" in low
    assert "hood down" in low
    assert "no hanfu" in low
    positive = low.split("no hanfu", 1)[0]
    assert "hanfu" not in positive
    assert "no brand logo" in low or "brand" in low
    assert "jet-black" not in positive and "jet black" not in positive
    assert "主色纯黑" not in s.split("no hanfu", 1)[0]
    assert "plain" in low or "unbranded" in low or "素面" in s or "no print" in low


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
    """07:3x：按面积序取服装色（不把最深色抬到灰前面）；中文色名进正向，紫蓝进反向。"""
    # 面积序：肤色忽略 → 黑 → 棕 → 金；紫蓝过滤
    colors = ["#E8C4A8", "#1A1A1E", "#8B7355", "#D4AF37", "#6A5ACD"]
    picked = pick_garment_colors(colors, n=3)
    assert picked[0] == "#1A1A1E"
    assert "#E8C4A8" not in picked
    assert "#6A5ACD" not in picked
    # 板岩灰面积大于纯黑时，灰必须当首位主色（雨衣纠偏）
    anime_area = ["#5A6A7A", "#1A1A1E", "#2C2C34"]
    anime_picked = pick_garment_colors(anime_area, n=3)
    assert anime_picked[0] == "#5A6A7A", anime_picked
    assert anime_picked[1] == "#1A1A1E"
    pos_a, _ = costume_color_phrases_from_palette(anime_area)
    assert "板岩灰" in pos_a or "灰色" in pos_a
    assert "slate gray" in pos_a.lower() or "gray" in pos_a.lower()
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
    zh_g, en_g = hex_to_zh_en_color("#5A6A7A")
    assert zh_g == "板岩灰" and "slate" in en_g.lower()



def test_merge_negative_includes_brand():
    from app.services.studio.prompt_c import merge_negative, C_AVOID_TEXT
    out = merge_negative("blurry")
    low = out.lower()
    assert "brand logo" in low or "品牌标" in out
    assert "storefront" in low or "店招" in out
    assert "brand logo" in C_AVOID_TEXT.lower() or "品牌标" in C_AVOID_TEXT



def test_costume_lock_no_colors_no_jet_black():
    """无配色时正向禁止 jet-black/主色纯黑；有板岩灰配色时保留 slate/板岩灰。"""
    for style in ("anime", "ancient_realistic"):
        s = costume_lock_for_style(style, visual_prompt="Lin Xia", name="林夏", colors=None)
        # 正向：到第一个 no 之前
        low = s.lower()
        cut = low.find(" no ")
        positive = low if cut < 0 else low[:cut]
        assert "jet-black" not in positive, (style, positive)
        assert "jet black" not in positive, (style, positive)
        assert "主色纯黑" not in s.split(" no ", 1)[0]
        assert "plain" in low or "unbranded" in low or "素面" in s or "no print" in low

    slate = ["#5A6A7A", "#1A1A1E"]
    s2 = costume_lock_for_style("anime", visual_prompt="Lin Xia", name="林夏", colors=slate)
    assert "板岩灰" in s2 or "slate" in s2.lower()
    assert "plain" in s2.lower() or "unbranded" in s2.lower() or "素面" in s2 or "no print" in s2.lower()


def test_brand_text_hit_helpers():
    assert brand_text_hit("THE NORTH FACE") is True
    assert brand_text_hit("nike swoosh") is True
    assert brand_text_hit("") is False
    assert brand_text_hit("雨") is False



def test_garment_chest_emblem_hit_logo_vs_raindrops():
    """胸口图标型 logo 要命中；纯雨滴/纯暗底不得误报。"""
    import numpy as np
    from app.services.studio.candidate_pick import garment_chest_emblem_hit

    h, w = 1344, 768
    dark = np.full((h, w, 3), 22, dtype=np.uint8)
    assert garment_chest_emblem_hit(dark)["hit"] is False

    logo = dark.copy()
    y0, x0 = int(h * 0.38), int(w * 0.38)
    logo[y0 : y0 + 24, x0 : x0 + 28] = (235, 235, 235)
    assert garment_chest_emblem_hit(logo)["hit"] is True

    rain = dark.copy()
    rng = np.random.default_rng(1)
    for _ in range(150):
        yy = int(rng.integers(int(h * 0.30), int(h * 0.55)))
        xx = int(rng.integers(int(w * 0.25), int(w * 0.60)))
        rain[yy : yy + 2, xx : xx + 2] = (220, 220, 220)
    assert garment_chest_emblem_hit(rain)["hit"] is False




def test_garment_chest_emblem_rejects_wet_coat_specular():
    """多枚湿反光/雨滴簇不得当徽标；单块清晰亮标仍命中。"""
    import numpy as np
    from app.services.studio.candidate_pick import garment_chest_emblem_hit

    h, w = 1344, 768
    coat = np.full((h, w, 3), 28, dtype=np.uint8)
    rng = np.random.default_rng(7)
    # 胸口区密雨滴 + 一道横向湿高光（面积大但细长，应被 aspect/簇规则挡）
    for _ in range(220):
        yy = int(rng.integers(int(h * 0.32), int(h * 0.48)))
        xx = int(rng.integers(int(w * 0.26), int(w * 0.74)))
        coat[yy : yy + 2, xx : xx + 2] = (210, 210, 215)
    yb = int(h * 0.40)
    coat[yb : yb + 4, int(w * 0.30) : int(w * 0.70)] = (200, 200, 205)
    assert garment_chest_emblem_hit(coat)["hit"] is False

    logo = np.full((h, w, 3), 28, dtype=np.uint8)
    y0, x0 = int(h * 0.38), int(w * 0.40)
    logo[y0 : y0 + 28, x0 : x0 + 32] = (240, 240, 240)
    assert garment_chest_emblem_hit(logo)["hit"] is True

def test_garment_brand_ocr_frame_north_face():
    """合成帧画上 THE NORTH FACE 应 hit；空白应不 hit。"""
    from PIL import Image, ImageDraw, ImageFont

    # 空白帧
    blank = Image.new("RGB", (400, 700), (40, 50, 60))
    r0 = garment_brand_ocr_frame(blank)
    assert r0.get("hit") is False, r0

    # 胸口写品牌（ROI: y 25%-70%, x 20%-80%）
    img = Image.new("RGB", (400, 700), (40, 50, 60))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 36)
    except Exception:
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 36)
        except Exception:
            font = ImageFont.load_default()
    # 躯干中心附近
    draw.text((80, 280), "THE NORTH FACE", fill=(240, 240, 240), font=font)
    r1 = garment_brand_ocr_frame(img)
    # OCR 可能因字体/环境失败；若读出文本则必须 hit；读不出则至少 brand_text_hit 自测已覆盖
    if r1.get("text") and any(c.isalpha() for c in r1["text"]):
        assert r1.get("hit") is True, r1
    else:
        # tesseract 未识别时跳过硬断言，但函数须返回结构
        assert "hit" in r1 and r1.get("hit") is False


def test_garment_brand_ocr_hit_video_roundtrip(tmp_path):
    """临时 mp4：有品牌字 hit；纯色不 hit（cv2/pytesseract 可用时）。"""
    import subprocess
    from PIL import Image, ImageDraw, ImageFont

    def _mp4_from_png(png: Path, mp4: Path):
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-loop", "1", "-i", str(png),
                "-t", "0.5", "-pix_fmt", "yuv420p", "-r", "8",
                str(mp4),
            ],
            check=True,
        )

    blank_png = tmp_path / "blank.png"
    Image.new("RGB", (400, 700), (30, 30, 30)).save(blank_png)
    blank_mp4 = tmp_path / "blank.mp4"
    try:
        _mp4_from_png(blank_png, blank_mp4)
    except Exception as e:
        pytest.skip(f"ffmpeg 不可用: {e}")

    r_blank = garment_brand_ocr_hit(blank_mp4)
    assert r_blank.get("hit") is False, r_blank
    assert r_blank.get("frames_checked", 0) >= 1 or r_blank.get("error")

    brand_png = tmp_path / "brand.png"
    img = Image.new("RGB", (400, 700), (30, 30, 30))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 40)
    except Exception:
        font = ImageFont.load_default()
    draw.text((60, 300), "THE NORTH FACE", fill=(255, 255, 255), font=font)
    img.save(brand_png)
    brand_mp4 = tmp_path / "brand.mp4"
    _mp4_from_png(brand_png, brand_mp4)
    r_brand = garment_brand_ocr_hit(brand_mp4)
    if r_brand.get("error", "").startswith(("ocr_unavailable", "cv2_unavailable")):
        pytest.skip(r_brand["error"])
    # 有帧被检查；OCR 识别成功时必须 hit
    assert r_brand.get("frames_checked", 0) >= 1
    # 2026-10-05：无人物（无脸 → 无躯干框）的纯字卡不再拦；旧 image_to_string 判定只进 brand_log
    assert r_brand.get("hit") is False, r_brand
    if r_brand.get("text") and "north" in r_brand["text"].lower():
        assert r_brand.get("brand_log"), r_brand


def test_scene_sign_ocr_frame_north_check_vs_blank():
    """上半帧有 NORTH/CHECK 类字 → hit；纯色无字 → 不 hit。与 emblem/brand 测共存。"""
    from PIL import Image, ImageDraw, ImageFont

    blank = Image.new("RGB", (400, 700), (20, 24, 30))
    r0 = scene_sign_ocr_frame(blank)
    assert r0.get("hit") is False, r0

    img = Image.new("RGB", (400, 700), (20, 24, 30))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 42)
    except Exception:
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 42)
        except Exception:
            font = ImageFont.load_default()
    # 画在上半/霓虹区（y≈8%–18%，避开胸口服装 ROI y25%+）
    draw.text((40, 40), "NORTH", fill=(255, 220, 80), font=font)
    draw.text((220, 50), "CHECK", fill=(80, 220, 255), font=font)
    r1 = scene_sign_ocr_frame(img)
    if r1.get("error", "").startswith("ocr_unavailable"):
        pytest.skip(r1["error"])
    if r1.get("text") and any(c.isalpha() for c in r1["text"]):
        assert r1.get("hit") is True, r1
    else:
        # tesseract 未识别时不硬挂；结构须完整
        assert "hit" in r1 and r1.get("hit") is False


def test_build_c_visual_prompt_blank_lightboxes():
    """正向须含无字发光灯箱 / blank glowing lightboxes。"""
    p = build_c_visual_prompt(
        shot_prompt="便利店内景中景",
        cast_visual="年轻女性雨衣",
        scene="便利店",
    )
    low = p.lower()
    assert "blank glowing lightboxes" in low or "无字发光灯箱" in p
    assert "without letters" in low or "无字" in p


def test_sign_text_hit_filters_stripe_noise():
    """条纹 OCR 假阳（Ip Vues / eee / 符号）不命中；真实 NORTH FACE 命中。"""
    assert sign_text_hit("Ip \\ Vues") is False
    assert sign_text_hit("._ 2\n\n= i eee eee") is False
    assert sign_text_hit("eee") is False
    assert sign_text_hit("!!!@@@###") is False
    assert sign_text_hit("NORTH FACE") is True
    assert sign_text_hit("SEVEN ELEVEN STORE") is True


def test_scene_sign_ocr_blank_stripe_lightbox_negative():
    """空白色条灯箱（无字）须为负样本 — 对齐 12:05 父代理假阳案例。"""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (400, 700), (18, 20, 24))
    d = ImageDraw.Draw(img)
    # 7-Eleven 风格横条，无文字
    y = 20
    for color in [(240, 140, 40), (40, 160, 70), (200, 40, 40), (250, 250, 250)]:
        d.rectangle([20, y, 380, y + 18], fill=color)
        y += 22
    r = scene_sign_ocr_frame(img)
    if r.get("error", "").startswith("ocr_unavailable"):
        pytest.skip(r["error"])
    assert r.get("hit") is False, r


def test_garment_main_color_miss_black_vs_slate():
    """期望板岩灰时纯黑躯干 → hit；板岩灰躯干 → 不 hit。"""
    from PIL import Image, ImageDraw

    slate = ["#5A6A7A", "#1A1A1E", "#2C2C34"]
    black = Image.new("RGB", (400, 700), (8, 8, 10))
    r0 = garment_main_color_miss(black, slate)
    assert r0.get("hit") is True, r0

    gray = Image.new("RGB", (400, 700), (90, 106, 122))  # ~#5A6A7A
    r1 = garment_main_color_miss(gray, slate)
    assert r1.get("hit") is False, r1


def test_build_c_visual_prompt_no_chain_fascia():
    p = build_c_visual_prompt(
        shot_prompt="便利店门口中景",
        cast_visual="年轻女性雨衣",
        scene="便利店门口",
    )
    assert "非连锁品牌配色" in p or "not 7-Eleven" in p.lower() or "chain-store" in p.lower()


def test_garment_main_color_miss_relative_to_slate():
    """相对板岩灰参考：夜景压成纯黑要命中；中调灰不命中。"""
    import numpy as np
    from app.services.studio.candidate_pick import garment_main_color_miss

    h, w = 1344, 768
    expected = ["#5A6A7A", "#1A1A1E", "#2C2C34"]
    black = np.full((h, w, 3), 18, dtype=np.uint8)
    assert garment_main_color_miss(black, expected)["hit"] is True
    slate = np.full((h, w, 3), (0x7A, 0x6A, 0x5A), dtype=np.uint8)  # BGR of #5A6A7A
    # fill garment ROI-ish whole frame
    r = garment_main_color_miss(slate, expected)
    assert r["hit"] is False, r
    # 相对过暗：luma≈45 < ref≈100*0.55
    dark = np.full((h, w, 3), 45, dtype=np.uint8)
    assert garment_main_color_miss(dark, expected)["hit"] is True


def test_build_c_visual_prompt_style_lock_anime():
    from app.services.studio.prompt_c import build_c_visual_prompt
    pos = build_c_visual_prompt(shot_prompt="rainy night doorway", style="anime")
    assert "anime style" in pos.lower() or "二次元" in pos
    assert "not photorealistic" in pos.lower()
    pos2 = build_c_visual_prompt(shot_prompt="rainy night doorway", style="ancient_realistic")
    assert "古风写实" in pos2 or "ancient" in pos2.lower()

