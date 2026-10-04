"""c_hybrid 服装状态一致性 + 镜内硬切门禁 + 单一服装描述（2026-10-05 雨夜 shot1 决策 c）。

- 参考图（正/侧戴帽）与首帧（shot0 尾帧帽兜放下）矛盾 → outfit_state.check_refs_vs_first_frame 告警；
  镜头级参考覆盖（apply_ref_overrides）换成帽兜放下版，保留 @图片 标签与顺序，不改角色原图。
- 裁片头后仍有 ≥2 处镜内硬切 → 候选不得入选；prompt 固定「单一连续镜头、无切镜」。
- outfit_desc：外套名词短语统一为「纯黑无 logo 无字的连帽风衣」，只出现一次。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.h3_refs import RefImage
from app.services.studio import candidate_pick as cp
from app.services.studio import hard_cut as hcm
from app.services.studio import outfit_state, prompt_c
from app.services.studio.shot_refs import apply_ref_overrides

FIX = Path(__file__).parent / "fixtures" / "chybrid_logo_hood"
DESC = "纯黑无 logo 无字的连帽风衣"


# ───────────────────────── 硬切门禁 ─────────────────────────


def _stem(path):
    return Path(path).stem.split(hcm.HEAD_TRIM_SUFFIX)[0]


def _setup(monkeypatch, tmp_path, faces, cuts):
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"x")
    vids = {}
    for k in faces:
        p = tmp_path / f"{k}.mp4"
        p.write_bytes(b"v")
        vids[k] = p
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", lambda path, ref_image_path, **kw: {
        "face_mean": faces[_stem(path)], "facecrop_mean": faces[_stem(path)],
        "burnin_penalty": 0.0, "ocr_penalty": 0.0, "error": "", "score_backend": "insightface"})
    monkeypatch.setattr(cp, "score_scene_continuity",
                        lambda *a, **k: {"continuity": None, "regression": None, "error": "skip"})
    monkeypatch.setattr(cp, "garment_brand_ocr_hit", lambda path, **kw: {
        "hit": False, "kind": "", "text": "", "frames_checked": 20, "error": ""})
    monkeypatch.setattr(hcm, "detect_hard_cuts", lambda path: {
        "cuts": [] if hcm.HEAD_TRIM_SUFFIX in Path(path).stem
        else [{"frame": f, "t": f / 24} for f in cuts[_stem(path)]],
        "fps": 24.0, "n_frames": 362, "error": ""})
    return ref, [{"id": k, "status": "done", "url": str(p), "first_frame": "ff.png"} for k, p in vids.items()]


def test_two_late_cuts_ineligible_even_with_best_face(monkeypatch, tmp_path):
    # 931f 实况：face 0.646 但镜内 [79,127,145] 三处硬切
    ref, cands = _setup(monkeypatch, tmp_path, {"cut3": 0.65, "clean": 0.50},
                        {"cut3": [79, 127, 145], "clean": []})
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref, hood_log=False)
    assert win == "clean"
    c3 = next(c for c in out if c["id"] == "cut3")
    assert c3["cut_gate"] == {"blocked": True, "late_cuts": 3, "min": hcm.HARD_CUT_INELIGIBLE_MIN}
    assert "cut_gate=3cuts" in c3["pick_note"] and c3["is_picked"] is False


def test_single_late_cut_still_eligible_with_penalty(monkeypatch, tmp_path):
    ref, cands = _setup(monkeypatch, tmp_path, {"one": 0.65, "clean": 0.50},
                        {"one": [100], "clean": []})
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref, hood_log=False)
    one = next(c for c in out if c["id"] == "one")
    assert win == "one" and one["cut_gate"]["blocked"] is False
    assert one["hard_cut_penalty"] == pytest.approx(hcm.HARD_CUT_LATE_PENALTY)


def test_head_cut_trimmed_not_counted(monkeypatch, tmp_path):
    # 片头切点（锚定区/首 1 秒）走裁片头，不计入镜内硬切；剩 1 处 → 仍可入选
    ref, cands = _setup(monkeypatch, tmp_path, {"head": 0.65, "clean": 0.50},
                        {"head": [9, 150], "clean": []})
    def fake_trim(src, dst, frames, fps):
        Path(dst).write_bytes(b"v")
        return {"frames": frames, "seconds": frames / fps, "fps": fps}

    monkeypatch.setattr(hcm, "trim_video_head", fake_trim)
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref, hood_log=False)
    h = next(c for c in out if c["id"] == "head")
    assert h["head_trim"]["frames"] == 9 and h["cut_gate"]["late_cuts"] == 1
    assert hcm.late_cut_count([{"frame": 9}, {"frame": 150}], 24.0, 12) == 1


def test_all_candidates_multi_cut_raises(monkeypatch, tmp_path):
    ref, cands = _setup(monkeypatch, tmp_path, {"a": 0.65, "b": 0.60},
                        {"a": [79, 127, 145], "b": [102, 157, 184, 210, 241, 308]})
    with pytest.raises(cp.CandidatePickError, match="镜内硬切"):
        cp.pick_best_candidate(cands, ref_image_path=ref, hood_log=False)


def test_pipeline_late_cut_helper(monkeypatch, tmp_path):
    from app.services.studio import pipeline_c_render as pcr

    v = tmp_path / "x.mp4"
    v.write_bytes(b"v")
    monkeypatch.setattr(hcm, "detect_hard_cuts", lambda p: {
        "cuts": [{"frame": 5}, {"frame": 79}, {"frame": 127}], "fps": 24.0, "error": ""})
    assert pcr._late_cuts_for_url(str(v), 12) == 2
    assert pcr._late_cuts_for_url(str(tmp_path / "missing.mp4"), 12) == 0


# ───────────────────────── prompt ─────────────────────────


def _cast_visual():
    return "young East Asian woman Lin Xia, black windbreaker, wet hair on forehead, jet black hair"


def test_single_take_clause_always_present():
    p = prompt_c.build_c_visual_prompt(shot_prompt="Lin Xia walks in the rain, hood down")
    assert "单一连续镜头、无切镜" in p
    assert p.index("单一连续镜头") < p.index("Avoid:")


def test_outfit_desc_single_description_hood_down():
    p = prompt_c.build_c_visual_prompt(
        shot_prompt="medium shot inside convenience store aisle, Lin Xia in a black raincoat, hood down, "
                    "picks a bottle，黑色雨衣",
        cast_visual=_cast_visual(),
        camera="medium shot follow, hood down",
        outfit_desc=DESC,
    )
    body = p.split("Avoid:")[0]
    low = body.lower()
    for w in ("windbreaker", "raincoat", "雨衣", "jacket", "全程戴帽", "hood up"):
        assert w not in low, w
    assert body.count(DESC) == 2  # 正文一次 + 固定无字句一次
    assert "hood down" in low and "hoodie hood down" not in low
    assert "胸口空白无字" in body


def test_outfit_desc_empty_keeps_legacy_text():
    p = prompt_c.build_c_visual_prompt(shot_prompt="aisle, hood down", cast_visual=_cast_visual())
    assert "black windbreaker" in p and prompt_c.C_JACKET_PLAIN in p


def test_text_hood_state():
    assert prompt_c.text_hood_state("hood completely down off the head") == "down"
    assert prompt_c.text_hood_state("外套无 logo、全程戴帽") == "up"
    assert prompt_c.text_hood_state("walks in the rain") is None


# ───────────────────────── 参考图覆盖 + 一致性告警 ─────────────────────────


def test_ref_override_keeps_labels_and_order():
    refs = [RefImage(label="林夏正面身份与服装参考", role="林夏", image_url="/x/front.png"),
            RefImage(label="林夏侧面身份与服装参考", role="林夏", image_url="/x/side.png"),
            RefImage(label="林夏全身身份与服装参考", role="林夏", image_url="/x/full.png")]
    out = apply_ref_overrides(refs, {"front.png": "/y/front_hooddown.png", "/x/side.png": "/y/side_hooddown.png"})
    assert [r.label for r in out] == [r.label for r in refs]
    assert [r.image_url for r in out] == ["/y/front_hooddown.png", "/y/side_hooddown.png", "/x/full.png"]
    assert refs[0].image_url == "/x/front.png"  # 原列表不被改
    assert apply_ref_overrides(refs, None) is refs


def _fake_prob(table):
    return lambda img: table[img]


def test_ref_check_warns_on_mismatch_with_first_frame():
    r = outfit_state.check_refs_vs_first_frame(
        "ff", [{"label": "正面", "url": "f", "image": "up1"}, {"label": "全身", "url": "b", "image": "down1"}],
        prob_fn=_fake_prob({"ff": 0.05, "up1": 0.40, "down1": 0.08}))
    assert r["target"] == "down" and r["action"] == "warn" and r["mismatches"] == ["正面"]
    assert r["reliable"] is False


def test_ref_check_back_view_falls_back_to_text_and_override_clears():
    # shot0 尾帧是背影（无脸 → unknown）→ 目标回落文字口径 hood down
    table = {"ff": None, "up1": 0.40, "dn1": 0.07}
    r = outfit_state.check_refs_vs_first_frame(
        "ff", [{"label": "正面", "url": "f", "image": "up1"}], expected_text="down", prob_fn=_fake_prob(table))
    assert r["first_frame"]["state"] == "unknown" and r["target"] == "down" and r["action"] == "warn"
    r2 = outfit_state.check_refs_vs_first_frame(
        "ff", [{"label": "正面", "url": "f2", "image": "dn1", "overridden": True}],
        expected_text="down", prob_fn=_fake_prob(table))
    assert r2["action"] == "ok" and r2["refs"][0]["overridden"] is True


def test_ref_check_never_raises():
    def boom(_):
        raise RuntimeError("clip down")
    r = outfit_state.check_refs_vs_first_frame("ff", [], prob_fn=boom)
    assert r["action"] == "ok" and "clip down" in r["error"]
