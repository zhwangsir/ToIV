"""c_hybrid 选优规则 + 衣物英文字严格门禁（2026-10-05 雨夜 shot0 后续）。

- 写实选优：face_rank = min(线上 face_mean, facecrop_mean)，打分与门禁（≥min_face_rank）都用它；
  候选带 first_frame 时人脸评分跳过第 0..ANCHORED_FIRST_FRAME_SKIP_FRAMES 帧。
- 衣物英文字：tesseract 词 conf≥60、≥3 连续字母、词框在人物躯干框内、≥2 连续采样帧才拦；
  旧 image_to_string 无置信度判定只进 brand_log。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.studio import candidate_pick as cp

FIX = Path(__file__).parent / "fixtures" / "chybrid_text_gate"


# ───────────────────────── 选优规则 ─────────────────────────


def _setup_pick(monkeypatch, tmp_path, faces: dict, seen: list):
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"x")
    vids = {}
    for k in faces:
        p = tmp_path / f"{k}.mp4"
        p.write_bytes(b"v")
        vids[k] = p

    def fake_face(path, ref_image_path, **kw):
        seen.append((Path(path).stem, kw.get("skip_until_frame"), kw.get("with_facecrop")))
        return dict(faces[Path(path).stem])

    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", fake_face)
    monkeypatch.setattr(
        cp, "score_scene_continuity",
        lambda *a, **k: {"continuity": None, "regression": None, "error": "skip"},
    )
    return ref, vids


def _cands(vids, first_frame="toiv_c_ff_x.png"):
    return [
        {"id": k, "status": "done", "url": str(p), "first_frame": first_frame}
        for k, p in vids.items()
    ]


def _rs(online, facecrop):
    return {"face_mean": online, "facecrop_mean": facecrop, "burnin_penalty": 0.0,
            "ocr_penalty": 0.0, "error": "", "score_backend": "insightface"}


def test_online_only_high_does_not_beat_balanced_candidate(monkeypatch, tmp_path):
    """候选2 型（online 0.563 / facecrop 0.129）不得胜过候选3 型（0.428 / 0.491）。"""
    seen: list = []
    ref, vids = _setup_pick(
        monkeypatch, tmp_path, {"cand2": _rs(0.563, 0.129), "cand3": _rs(0.428, 0.491)}, seen
    )
    win, scored = cp.pick_best_candidate(_cands(vids), ref_image_path=ref)
    assert win == "cand3"
    by = {c["id"]: c for c in scored}
    assert by["cand2"]["face_rank"] == pytest.approx(0.129)
    assert by["cand3"]["face_rank"] == pytest.approx(0.428)
    assert by["cand2"]["face_mean"] == pytest.approx(0.563)  # 展示仍为线上分
    assert by["cand3"]["is_picked"] and not by["cand2"]["is_picked"]


def test_face_rank_gate_requires_both_scores(monkeypatch, tmp_path):
    seen: list = []
    ref, vids = _setup_pick(
        monkeypatch, tmp_path, {"a": _rs(0.70, 0.20), "b": _rs(0.30, 0.80), "c": _rs(0.60, None)}, seen
    )
    with pytest.raises(cp.CandidatePickError, match="min\\(online,facecrop\\)"):
        cp.pick_best_candidate(_cands(vids), ref_image_path=ref)


def test_anchored_candidates_skip_first_frames_in_face_scoring(monkeypatch, tmp_path):
    seen: list = []
    ref, vids = _setup_pick(monkeypatch, tmp_path, {"a": _rs(0.6, 0.6)}, seen)
    cp.pick_best_candidate(_cands(vids), ref_image_path=ref)
    assert seen == [("a", cp.ANCHORED_FIRST_FRAME_SKIP_FRAMES, True)]
    seen.clear()
    cp.pick_best_candidate(_cands(vids, first_frame=""), ref_image_path=ref)
    assert seen == [("a", 0, True)]


def test_legacy_scorer_without_facecrop_keeps_face_mean_rule(monkeypatch, tmp_path):
    """评分函数未返回 facecrop_mean（CLIP/旧 mock）→ 仍按 face_mean≥min_face_mean。"""
    seen: list = []
    legacy = {"face_mean": 0.62, "burnin_penalty": 0, "ocr_penalty": 0, "error": ""}
    ref, vids = _setup_pick(monkeypatch, tmp_path, {"a": legacy}, seen)
    win, scored = cp.pick_best_candidate(_cands(vids), ref_image_path=ref)
    assert win == "a" and "face_rank" not in scored[0]


def test_score_video_face_skip_filters_sample_indices(monkeypatch, tmp_path):
    """真视频：skip_until_frame=12 时不读第 0..12 帧。"""
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    if not cp._try_import_face():
        pytest.skip("insightface 不可用")
    vid = tmp_path / "v.avi"
    vw = cv2.VideoWriter(str(vid), cv2.VideoWriter_fourcc(*"MJPG"), 24.0, (64, 64))
    for _ in range(40):
        vw.write(np.zeros((64, 64, 3), np.uint8))
    vw.release()
    read: list[int] = []
    real_vc = cv2.VideoCapture

    class VC:
        def __init__(self, p):
            self._c = real_vc(p)
            self._pos = 0

        def get(self, k):
            return self._c.get(k)

        def set(self, k, v):
            self._pos = int(v)
            return self._c.set(k, v)

        def read(self):
            read.append(self._pos)
            return self._c.read()

        def release(self):
            self._c.release()

    monkeypatch.setattr(cv2, "VideoCapture", VC)
    monkeypatch.setattr(cp, "_ocr_penalty", lambda f: 0.0)
    out = cp.score_video_face(vid, FIX / "first_frame_linxia_full.jpg", skip_until_frame=12)
    assert read and min(read) > 12, read
    assert out.get("skip_until_frame") == 12


def test_ocr_penalty_ignores_noise_without_subtitle_line(monkeypatch):
    np = pytest.importorskip("numpy")
    monkeypatch.setattr(cp, "subtitle_ocr_frame", lambda f: {"hit": False, "lines": [{"text": "~~V4"}]})
    assert cp._ocr_penalty(np.zeros((10, 10, 3), np.uint8)) == 0.0
    monkeypatch.setattr(cp, "subtitle_ocr_frame", lambda f: {"hit": True, "lines": []})
    assert cp._ocr_penalty(np.zeros((10, 10, 3), np.uint8)) == 0.5


# ───────────────────────── 衣物英文字严格门禁 ─────────────────────────


def _need_ocr_face():
    pytest.importorskip("cv2")
    pytest.importorskip("pytesseract")
    if not cp._try_import_face():
        pytest.skip("insightface 不可用")


def _video(tmp_path, frames, name="v.avi"):
    import cv2

    h, w = frames[0].shape[:2]
    out = tmp_path / name
    vw = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"MJPG"), 24.0, (w, h))
    for f in frames:
        vw.write(f)
    vw.release()
    return out


def test_brand_text_on_torso_frame_detected():
    _need_ocr_face()
    import cv2

    r = cp.garment_brand_text_words(cv2.imread(str(FIX / "brand_on_torso.jpg")))
    assert r["hit"] is True, r
    words = [w for w in r["words"] if w["in_torso"]]
    assert {"NORTH", "FACE"} & {w["text"] for w in words}
    assert all(w["conf"] >= cp.BRAND_TEXT_MIN_CONF for w in words)


def test_brand_text_off_torso_not_hit():
    _need_ocr_face()
    import cv2

    r = cp.garment_brand_text_words(cv2.imread(str(FIX / "brand_off_torso.jpg")))
    # 字在人物躯干框外（右上背景）→ 躯干框 OCR 读不到，不判
    assert r["hit"] is False, r
    assert r["torso"] is not None
    assert not any("NORTH" in w["text"].upper() for w in r["words"]), r


def test_brand_text_video_needs_two_consecutive_frames(tmp_path):
    _need_ocr_face()
    import cv2

    on = cv2.imread(str(FIX / "brand_on_torso.jpg"))
    clean = cv2.imread(str(FIX / "first_frame_linxia_full.jpg"))
    r = cp.garment_brand_ocr_hit(_video(tmp_path, [on] * 32, "on.avi"))
    assert r["hit"] is True and r["kind"] == "brand", r
    assert len(r["brand_run"]) >= cp.BRAND_TEXT_MIN_CONSECUTIVE
    frames = [clean] * 32
    frames[10] = on  # 采样步长 2：仅 1 个采样帧
    r1 = cp.garment_brand_ocr_hit(_video(tmp_path, frames, "one.avi"))
    assert r1["hit"] is False, r1
    assert [f["frame"] for f in r1["brand_frames"]] == [10]


def test_rain_fixtures_no_brand_hit():
    _need_ocr_face()
    import cv2

    for name in ("first_frame_linxia_full.jpg", "cand1_f180_emblem_fp.jpg",
                 "cand2_f0_emblem_fp.jpg", "cand2_f48_shop_sign.jpg"):
        assert cp.garment_brand_text_words(cv2.imread(str(FIX / name)))["hit"] is False, name
