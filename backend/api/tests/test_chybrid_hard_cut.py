"""c_hybrid 硬切规则 + 店招/连锁色带仅记录（2026-10-05 雨夜 shot0 候选2：第 9 帧硬切）。

- 锚定区内 / 首 1 秒内硬切 → 自动裁片头（视频按帧、音频按采样点同步裁），记录 head_trim。
- 1 秒后硬切 → 选优扣分（hard_cut_penalty）。
- 7-Eleven 型橙/绿/红色带：只记录，不拦不扣分。
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

from app.services.studio import candidate_pick as cp  # noqa: E402
from app.services.studio import hard_cut as hcm  # noqa: E402

FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg/ffprobe 不可用")

W, H, FPS = 320, 180, 24


def _scene_a(i: int):
    img = np.zeros((H, W, 3), np.uint8)
    img[:] = (np.linspace(60, 160, W, dtype=np.uint8)[None, :, None] * np.array([1, 0.6, 0.3])).astype(np.uint8)
    cv2.circle(img, (100 + (i % 3), 90), 40, (230, 230, 230), -1)
    return img


def _scene_b(i: int):
    img = np.zeros((H, W, 3), np.uint8)
    img[:] = (np.linspace(40, 200, H, dtype=np.uint8)[:, None, None] * np.array([0.2, 0.5, 1.0])).astype(np.uint8)
    cv2.rectangle(img, (40 + i, 50), (120 + i, 140), (20, 200, 40), -1)
    return img


def _scene_c(i: int):
    img = np.full((H, W, 3), (30, 30, 30), np.uint8)
    cv2.rectangle(img, (180, 20 + (i % 5)), (300, 160), (200, 60, 200), -1)
    return img


def _write_video(path: Path, frames: list, audio: bool = True) -> Path:
    n = len(frames)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000", "-ac", "2"]
    cmd += ["-t", f"{n / FPS:.6f}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"]
    if audio:
        cmd += ["-c:a", "aac", "-ar", "32000"]
    cmd.append(str(path))
    subprocess.run(cmd, input=b"".join(f.tobytes() for f in frames), check=True)
    return path


def _anchor_cut_video(path: Path, cut: int = 9, late_cut: int | None = 40, n: int = 60, audio=True):
    frames = []
    for i in range(n):
        if i < cut:
            frames.append(_scene_a(0))  # 锚定定妆图静止
        elif late_cut is not None and i >= late_cut:
            frames.append(_scene_c(i))
        else:
            frames.append(_scene_b(i - cut))
    return _write_video(path, frames, audio=audio)


# ───────────────────────── 检测 ─────────────────────────


@needs_ffmpeg
def test_detect_anchor_cut_and_late_cut(tmp_path):
    p = _anchor_cut_video(tmp_path / "v.mp4", cut=9, late_cut=40)
    det = hcm.detect_hard_cuts(p)
    assert det["error"] == ""
    assert det["fps"] == pytest.approx(FPS)
    assert [c["frame"] for c in det["cuts"]] == [9, 40]


@needs_ffmpeg
def test_single_frame_flash_is_not_a_cut(tmp_path):
    frames = [_scene_b(i) for i in range(48)]
    frames[30] = np.full((H, W, 3), 255, np.uint8)  # 闪电/闪光单帧
    p = _write_video(tmp_path / "flash.mp4", frames, audio=False)
    det = hcm.detect_hard_cuts(p)
    assert det["cuts"] == []


def test_classify_head_vs_late():
    cuts = [{"frame": 9}, {"frame": 20}, {"frame": 30}, {"frame": 200}]
    head, late = hcm.classify_cuts(cuts, 24.0, anchor_frames=12)
    assert head["frame"] == 20  # 首 1 秒内最后一个切点
    assert [c["frame"] for c in late] == [30, 200]
    head, late = hcm.classify_cuts([{"frame": 30}], 24.0, anchor_frames=36)
    assert head["frame"] == 30  # 锚定区比 1 秒长时按锚定区
    assert late == []


# ───────────────────────── 裁片头 + 音画同步 ─────────────────────────


@needs_ffmpeg
def test_trim_head_keeps_audio_in_sync_and_tail_unchanged(tmp_path):
    src = _anchor_cut_video(tmp_path / "s.mp4", cut=9, late_cut=None, n=72)
    dst = tmp_path / "s_ht9.mp4"
    info = hcm.trim_video_head(src, dst, 9, FPS)
    assert dst.is_file()
    assert info["frames"] == 9
    assert info["seconds"] == pytest.approx(0.375)
    assert info["trimmed_frames"] == info["src_frames"] - 9 == 63
    assert info["audio"] is True
    assert info["trimmed_video_duration"] == pytest.approx(63 / FPS, abs=0.01)
    assert info["trimmed_audio_duration"] == pytest.approx(
        info["src_audio_duration"] - 0.375, abs=1 / FPS + 0.033
    )
    assert abs(info["av_drift_trimmed"] - info["av_drift_src"]) <= 1 / FPS + 1024 / 32000
    assert info["tail_frame_mad"] is not None and info["tail_frame_mad"] <= 3.0
    # 裁后片头无硬切（切点即新首帧）
    assert hcm.detect_hard_cuts(dst)["cuts"] == []


@needs_ffmpeg
def test_apply_rule_trims_head_records_metrics_and_penalizes_late_cut(tmp_path):
    p = _anchor_cut_video(tmp_path / "abc.mp4", cut=9, late_cut=40)
    c = {"id": "c2", "url": "/api/studio/files/abc.mp4", "first_frame": "ff.png"}
    res = hcm.apply_hard_cut_rule(c, p, anchor_frames=12)
    assert c["hard_cuts"] == [9, 40]
    ht = c["head_trim"]
    assert ht["frames"] == 9 and ht["cut_frame"] == 9 and ht["in_anchor_zone"] is True
    assert ht["seconds"] == pytest.approx(9 / FPS)
    assert c["url_untrimmed"] == "/api/studio/files/abc.mp4"
    assert c["url"] == "/api/studio/files/abc_ht9.mp4"
    assert Path(res["path"]).name == "abc_ht9.mp4" and Path(res["path"]).is_file()
    assert res["skip_until_frame"] == 3  # 锚定区剩余 12-9
    assert [x["frame"] for x in c["hard_cut_late"]] == [40]
    assert c["hard_cut_penalty"] == pytest.approx(hcm.HARD_CUT_LATE_PENALTY)
    # 再跑一次不重复裁
    res2 = hcm.apply_hard_cut_rule(c, res["path"], anchor_frames=12)
    assert c["url"] == "/api/studio/files/abc_ht9.mp4"
    assert res2["path"] == Path(res["path"])


@needs_ffmpeg
def test_cut_after_one_second_is_not_trimmed(tmp_path):
    p = _anchor_cut_video(tmp_path / "late.mp4", cut=30, late_cut=None)
    c = {"id": "x", "url": str(p)}
    res = hcm.apply_hard_cut_rule(c, p, anchor_frames=12)
    assert "head_trim" not in c and c["url"] == str(p)
    assert c["hard_cut_penalty"] == pytest.approx(hcm.HARD_CUT_LATE_PENALTY)
    assert res["penalty"] == pytest.approx(hcm.HARD_CUT_LATE_PENALTY)


def test_late_penalty_capped():
    cuts = [{"frame": 30 + 10 * k, "t": 0} for k in range(10)]
    c: dict = {}
    hcm.apply_hard_cut_rule(c, Path("/nonexistent.mp4"),
                            detect_fn=lambda p: {"fps": 24.0, "n_frames": 200, "cuts": cuts, "error": ""})
    assert c["hard_cut_penalty"] == pytest.approx(hcm.HARD_CUT_LATE_PENALTY_CAP)


# ───────────────────────── 选优集成 ─────────────────────────


def _setup_pick(monkeypatch, tmp_path, faces, cuts, seen):
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"x")
    vids = {}
    for k in faces:
        p = tmp_path / f"{k}.mp4"
        p.write_bytes(b"v")
        vids[k] = p

    def fake_face(path, ref_image_path, **kw):
        seen.append((Path(path).name, kw.get("skip_until_frame")))
        stem = Path(path).stem.split(hcm.HEAD_TRIM_SUFFIX)[0]
        o, f = faces[stem]
        return {"face_mean": o, "facecrop_mean": f, "burnin_penalty": 0.0, "ocr_penalty": 0.0,
                "error": "", "score_backend": "insightface"}

    def fake_detect(path):
        stem = Path(path).stem
        if hcm.HEAD_TRIM_SUFFIX in stem:
            return {"fps": 24.0, "n_frames": 100, "cuts": [], "error": ""}
        return {"fps": 24.0, "n_frames": 362, "error": "",
                "cuts": [{"frame": f, "t": f / 24.0} for f in cuts[stem]]}

    def fake_trim(src, dst, frames, fps):
        Path(dst).write_bytes(b"t")
        return {"frames": frames, "seconds": round(frames / fps, 4), "fps": fps,
                "audio": True, "trimmed_frames": 362 - frames}

    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "score_video_face", fake_face)
    monkeypatch.setattr(cp, "score_scene_continuity",
                        lambda *a, **k: {"continuity": None, "regression": None, "error": "skip"})
    monkeypatch.setattr(hcm, "detect_hard_cuts", fake_detect)
    monkeypatch.setattr(hcm, "trim_video_head", fake_trim)
    return ref, vids


def test_pick_trims_winner_head_and_scores_trimmed_file(monkeypatch, tmp_path):
    seen: list = []
    ref, vids = _setup_pick(monkeypatch, tmp_path,
                            {"cand2": (0.78, 0.775), "cand3": (0.504, 0.573)},
                            {"cand2": [9], "cand3": []}, seen)
    cands = [{"id": k, "status": "done", "url": f"/api/studio/files/{k}.mp4", "first_frame": "ff.png"}
             for k in vids]
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref,
                                      local_url_resolver=lambda u: str(tmp_path / Path(u).name))
    assert win == "cand2"
    c2 = next(c for c in out if c["id"] == "cand2")
    assert c2["is_picked"] is True
    assert c2["url"] == "/api/studio/files/cand2_ht9.mp4"
    assert c2["url_untrimmed"] == "/api/studio/files/cand2.mp4"
    assert c2["head_trim"]["frames"] == 9
    assert c2["face_skip_until_frame"] == 3
    assert ("cand2_ht9.mp4", 3) in seen and ("cand3.mp4", 12) in seen
    assert "head_trim=9f" in c2["pick_note"]


def test_pick_penalizes_late_cuts(monkeypatch, tmp_path):
    seen: list = []
    ref, vids = _setup_pick(monkeypatch, tmp_path,
                            {"a": (0.60, 0.60), "b": (0.58, 0.58)},
                            {"a": [100, 200], "b": []}, seen)
    cands = [{"id": k, "status": "done", "url": str(p)} for k, p in vids.items()]
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref)
    a = next(c for c in out if c["id"] == "a")
    assert a["hard_cut_penalty"] == pytest.approx(2 * hcm.HARD_CUT_LATE_PENALTY)
    assert a["pick_score"] == pytest.approx(0.60 - 2 * hcm.HARD_CUT_LATE_PENALTY)
    assert win == "b"


def test_pick_hard_cut_rule_can_be_disabled(monkeypatch, tmp_path):
    seen: list = []
    ref, vids = _setup_pick(monkeypatch, tmp_path, {"a": (0.6, 0.6), "b": (0.5, 0.5)},
                            {"a": [5, 100], "b": []}, seen)
    cands = [{"id": k, "status": "done", "url": str(p)} for k, p in vids.items()]
    win, out = cp.pick_best_candidate(cands, ref_image_path=ref, hard_cut_rule=False)
    assert win == "a" and "head_trim" not in out[0] and "hard_cuts" not in out[0]


# ───────────────────────── 店招 / 连锁色带：只记录 ─────────────────────────


def _seven_eleven_band_frame(y0: int):
    img = np.full((H, W, 3), (70, 60, 50), np.uint8)
    img[y0:y0 + 8] = (0, 120, 255)  # 橙
    img[y0 + 8:y0 + 16] = (40, 160, 0)  # 绿
    img[y0 + 16:y0 + 24] = (0, 0, 220)  # 红
    return img


def test_chain_band_detected_but_never_penalized():
    top = _seven_eleven_band_frame(20)
    r = cp.chain_color_band_frame(top)
    assert r["hit"] is True and r["penalty"] == 0.0
    assert {"orange", "green", "red"} <= set(r["colors"])
    bottom = _seven_eleven_band_frame(H - 40)
    assert cp._burnin_penalty(bottom) == 0.0
    assert cp._ocr_penalty(bottom) == 0.0
    plain = np.full((H, W, 3), (70, 60, 50), np.uint8)
    assert cp.chain_color_band_frame(plain)["hit"] is False


@needs_ffmpeg
def test_text_gate_logs_band_and_sign_without_hit(tmp_path):
    pytest.importorskip("pytesseract")
    if not shutil.which("tesseract"):
        pytest.skip("tesseract 不可用")
    frames = [_seven_eleven_band_frame(20) for _ in range(48)]
    p = _write_video(tmp_path / "band.mp4", frames, audio=False)
    out = cp.garment_brand_ocr_hit(p)
    assert out["hit"] is False
    assert out["band_log"], out
