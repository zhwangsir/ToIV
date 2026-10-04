"""雨夜 shot1 931f3b96（ad4fc303）复核问题回归（2026-10-05 03:01 人工复核）。

1) 胸口乱码「PEB NORTH FACE」：tesseract（躯干框、conf≥60）读不出 → 漏拦。
   修复：躯干框先跑 RapidOCR（DB+CRNN），score≥0.50、≥3 连续字母；选优也执行文字门禁。
2) 镜内硬切（背影→正面，第 79 帧）：hard_cut 能检出；1 秒后只扣分不裁。
3) 帽兜状态跳变：CLIP 头部零样本只记录（hood_log，reliable=False）。
4) H3 Avoid 折进正向 prompt：不得写具体品牌名；外套无 logo 正向；全程戴帽时不得再出现 hood down。
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from app.services.studio import candidate_pick as cp
from app.services.studio import prompt_c

FIX = Path(__file__).parent / "fixtures" / "chybrid_logo_hood"


def _need_rapid_and_face():
    pytest.importorskip("cv2")
    pytest.importorskip("rapidocr_onnxruntime")
    if not cp._try_import_face():
        pytest.skip("insightface 不可用（躯干框需人脸）")
    if cp._get_rapid_ocr() is None:
        pytest.skip("rapidocr 初始化失败")


# ───────────────────────── 1) 胸口 logo ─────────────────────────


@pytest.mark.parametrize("name", ["931f_f145_logo.jpg", "931f_f157_logo.jpg"])
def test_rapidocr_reads_garbled_north_face_on_torso(name):
    _need_rapid_and_face()
    import cv2

    fr = cv2.imread(str(FIX / name))
    r = cp.garment_brand_text_words(fr)
    assert r["hit"] is True, r
    words = {w["text"].upper() for w in r["words"] if w.get("engine") == "rapidocr"}
    assert any("NORTH" in w for w in words), r["words"]
    assert all(w["in_torso"] for w in r["words"])


@pytest.mark.parametrize("name", ["shot0_f90_nologo.jpg", "shot0_f105_nologo.jpg"])
def test_plain_jacket_frames_no_brand_hit(name):
    _need_rapid_and_face()
    import cv2

    r = cp.garment_brand_text_words(cv2.imread(str(FIX / name)))
    assert r["hit"] is False, r


def test_tesseract_alone_misses_logo_documented(monkeypatch):
    """根因佐证：只用 tesseract（旧路径）时该帧不命中。"""
    _need_rapid_and_face()
    if not shutil.which("tesseract"):
        pytest.skip("tesseract 不可用")
    import cv2

    monkeypatch.setattr(cp, "_get_rapid_ocr", lambda: None)
    r = cp.garment_brand_text_words(cv2.imread(str(FIX / "931f_f145_logo.jpg")))
    assert r["hit"] is False


def test_video_gate_blocks_logo_clip():
    _need_rapid_and_face()
    out = cp.garment_brand_ocr_hit(FIX / "931f_logo_f110_196.mp4")
    assert out["hit"] is True and out["kind"] == "brand", {k: out[k] for k in ("hit", "kind", "text", "brand_frames")}
    assert len(out["brand_run"]) >= cp.BRAND_TEXT_MIN_CONSECUTIVE
    words = " ".join(w for r in out["brand_run"] for w in [x["text"] for x in r["words"]]).upper()
    assert any(k in words for k in ("NORTH", "FACE", "NOATE", "NOR")), words


def test_pick_excludes_text_gate_hit(monkeypatch, tmp_path):
    """选优必须执行文字门禁：脸分最高但胸口有字的候选不得入选；全部命中则报错。"""
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"x")
    vids = {}
    for k in ("logo", "plain"):
        p = tmp_path / f"{k}.mp4"
        p.write_bytes(b"v")
        vids[k] = p
    faces = {"logo": 0.70, "plain": 0.55}
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", lambda path, ref_image_path, **kw: {
        "face_mean": faces[Path(path).stem], "facecrop_mean": faces[Path(path).stem],
        "burnin_penalty": 0.0, "ocr_penalty": 0.0, "error": "", "score_backend": "insightface"})
    monkeypatch.setattr(cp, "score_scene_continuity",
                        lambda *a, **k: {"continuity": None, "regression": None, "error": "skip"})
    hits = {"logo": True, "plain": False}
    monkeypatch.setattr(cp, "garment_brand_ocr_hit", lambda path, **kw: {
        "hit": hits[Path(path).stem], "kind": "brand" if hits[Path(path).stem] else "",
        "text": "NORTH FACE" if hits[Path(path).stem] else "", "frames_checked": 20, "error": ""})
    cands = [{"id": k, "status": "done", "url": str(p)} for k, p in vids.items()]
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref, hood_log=False)
    assert win == "plain"
    lg = next(c for c in out if c["id"] == "logo")
    assert lg["text_gate"]["hit"] is True and lg["is_picked"] is False
    assert "text_gate=brand" in lg["pick_note"]
    hits["plain"] = True
    cands = [{"id": k, "status": "done", "url": str(p)} for k, p in vids.items()]
    with pytest.raises(cp.CandidatePickError, match="文字门禁"):
        cp.pick_best_candidate(cands, ref_image_path=ref, hood_log=False)


# ───────────────────────── 2) 镜内硬切 ─────────────────────────


def test_hard_cut_detected_in_931f_back_to_front():
    pytest.importorskip("cv2")
    from app.services.studio import hard_cut as hcm

    det = hcm.detect_hard_cuts(FIX / "931f_cut_f60_99.mp4")
    assert det["error"] == ""
    # 原片第 79 帧 = 夹具第 19 帧（夹具从第 60 帧起）
    assert [c["frame"] for c in det["cuts"]] == [19]
    head, late = hcm.classify_cuts([{"frame": 79, "t": 79 / 24}], 24.0, anchor_frames=12)
    assert head is None and [c["frame"] for c in late] == [79]  # 3.29s > 1s → 扣分不裁


# ───────────────────────── 3) 帽兜状态（仅记录）─────────────────────────


def test_hood_log_is_log_only_and_counts_changes(tmp_path):
    pytest.importorskip("cv2")
    from app.services.studio import outfit_state

    seq = iter([0.05, 0.06, 0.30, 0.35])
    out = outfit_state.hood_state_log(FIX / "931f_cut_f60_99.mp4", samples=4, prob_fn=lambda fr: next(seq))
    assert out["log_only"] is True and out["reliable"] is False
    assert [f["state"] for f in out["frames"]] == ["down", "down", "up", "up"]
    assert out["changes"] == 1


def test_pick_hood_log_never_blocks(monkeypatch, tmp_path):
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"x")
    p = tmp_path / "a.mp4"
    p.write_bytes(b"v")
    q = tmp_path / "b.mp4"
    q.write_bytes(b"v")
    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", lambda path, ref_image_path, **kw: {
        "face_mean": 0.6, "facecrop_mean": 0.6, "burnin_penalty": 0.0, "ocr_penalty": 0.0,
        "error": "", "score_backend": "insightface"})
    monkeypatch.setattr(cp, "score_scene_continuity",
                        lambda *a, **k: {"continuity": None, "regression": None, "error": "skip"})
    from app.services.studio import outfit_state

    monkeypatch.setattr(outfit_state, "hood_state_log",
                        lambda *a, **k: {"changes": 3, "mismatch_prev": True, "log_only": True, "reliable": False})
    win, out = cp.pick_best_candidate(
        [{"id": "a", "status": "done", "url": str(p)}, {"id": "b", "status": "done", "url": str(q)}],
        ref_image_path=ref, text_gate=False)
    assert win in ("a", "b") and out[0]["hood_log"]["changes"] == 3


# ───────────────────────── 4) 提示词 ─────────────────────────


def test_avoid_has_no_concrete_brand_names():
    for brand in ("North Face", "Nike", "Adidas"):
        assert brand not in prompt_c.C_AVOID_TEXT
    p = prompt_c.build_c_visual_prompt(shot_prompt="Lin Xia in store aisle, hood down", negative="blurry")
    assert "North Face" not in p
    assert "外套无 logo" in p
    lock = prompt_c.costume_lock_for_style("anime", colors=["#5A6A7A", "#202020"])
    assert "North Face" not in lock


def test_hood_up_note_overrides_hood_down_phrases():
    p = prompt_c.build_c_visual_prompt(
        shot_prompt="medium shot inside convenience store aisle, hoodie hood down, face visible，外套无 logo、全程戴帽",
        camera="medium shot follow, hood down, 中景跟拍，帽兜放下",
        negative="blurry",
    )
    body = p.split("Avoid:")[0].lower()
    assert "hood down" not in body and "帽兜放下" not in body
    assert "hood up over the head" in body
    assert "全程戴帽" in p


def test_default_hood_down_unchanged():
    p = prompt_c.build_c_visual_prompt(shot_prompt="Lin Xia picks water in store aisle", negative="")
    assert "hoodie hood down" in p.lower()
