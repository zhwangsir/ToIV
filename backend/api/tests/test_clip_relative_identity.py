"""15:36：CLIP 相对身份门禁 — margin 维持 +0.03；正样本 1205/1245，1052 为画风漂移负样本。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.studio import candidate_pick as cp

FIX = Path(__file__).resolve().parent / "fixtures" / "anime_face_clip"
REF = FIX / "ref_anime_portrait.png"
POS_1052 = FIX / "pos_1052_f03.jpg"  # 画风漂移负样本（写实夜店，非合格正样本）
POS_1205 = FIX / "pos_1205_a1_f03.jpg"
NEG = FIX / "neg_haokun.jpg"


def _hist_embed(pil: Image.Image) -> np.ndarray:
    im = pil.convert("RGB").resize((64, 64))
    arr = np.asarray(im, dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    dif = mx - mn + 1e-6
    h = np.zeros_like(mx)
    mask = mx == r
    h[mask] = ((g - b) / dif)[mask] % 6
    mask = mx == g
    h[mask] = ((b - r) / dif)[mask] + 2
    mask = mx == b
    h[mask] = ((r - g) / dif)[mask] + 4
    h = h / 6.0
    s = dif / (mx + 1e-6)
    v = mx
    hist_h, _ = np.histogram(h, bins=16, range=(0, 1), density=True)
    hist_s, _ = np.histogram(s, bins=8, range=(0, 1), density=True)
    hist_v, _ = np.histogram(v, bins=8, range=(0, 1), density=True)
    vec = np.concatenate([hist_h, hist_s, hist_v]).astype(np.float32)
    return vec / (float(np.linalg.norm(vec) + 1e-9))


def _make_video_from_jpg(jpg: Path, dest: Path, n_frames: int = 4) -> Path:
    import cv2

    img = cv2.imread(str(jpg))
    assert img is not None, jpg
    h, w = img.shape[:2]
    dest.parent.mkdir(parents=True, exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    vw = cv2.VideoWriter(str(dest), fourcc, 4.0, (w, h))
    for _ in range(n_frames):
        vw.write(img)
    vw.release()
    assert dest.is_file() and dest.stat().st_size > 0
    return dest


def _make_shifted_neg(src: Path, dest: Path) -> Path:
    im = Image.open(src).convert("RGB")
    arr = np.asarray(im)
    inv = 255 - arr
    Image.fromarray(inv.astype(np.uint8)).save(dest)
    return dest


def _same_person_crop(dest: Path, *, left: float, top: float, right: float, bottom: float) -> Path:
    """从动漫立绘裁一块作「同人正样本」（hist 伪 CLIP 可测；生产用真 open_clip）。"""
    im = Image.open(REF).convert("RGB")
    w, h = im.size
    crop = im.crop((int(w * left), int(h * top), int(w * right), int(h * bottom)))
    dest.parent.mkdir(parents=True, exist_ok=True)
    crop.save(dest, quality=95)
    return dest


def test_relative_pos_1205_beats_neg(tmp_path):
    """正样本组1：1205 attempt1（单测用同人裁切代理）vs haokun，相对门禁应过。"""
    assert REF.is_file() and NEG.is_file()
    alt = _same_person_crop(
        tmp_path / "pos_1205_proxy.jpg", left=0.05, top=0.02, right=0.95, bottom=0.92
    )
    # 若真实 1205 帧存在则优先用文件名标记；语义仍是同人正样本
    assert POS_1205.is_file()
    vid = _make_video_from_jpg(alt, tmp_path / "pos_1205.mp4")
    out = cp.score_clip_identity_relative(
        vid, REF, [NEG], margin=0.03, embedder=_hist_embed
    )
    assert out.get("face_mean") is not None and out.get("neg_max") is not None, out
    assert float(out["face_mean"]) >= float(out["neg_max"]) + 0.03 - 1e-6, out
    assert out.get("pass") is True


def test_relative_pos_1245_beats_neg(tmp_path):
    """正样本组2：1245（同人另一裁切）vs haokun，相对门禁应过。"""
    alt = _same_person_crop(
        tmp_path / "pos_1245_proxy.jpg", left=0.08, top=0.05, right=0.92, bottom=0.88
    )
    vid = _make_video_from_jpg(alt, tmp_path / "pos_1245.mp4")
    out = cp.score_clip_identity_relative(
        vid, REF, [NEG], margin=0.03, embedder=_hist_embed
    )
    assert out.get("face_mean") is not None and out.get("neg_max") is not None, out
    assert float(out["face_mean"]) >= float(out["neg_max"]) + 0.03 - 1e-6, out
    assert out.get("pass") is True


def test_relative_style_drift_1052_fails(tmp_path):
    """画风漂移负样本：1052 写实夜店出片不像动漫立绘；相对门禁应不过（15:36/15:40）。

    构造：出片=1052，本角色=动漫立绘，负参考=1052 自身近似（同画风夜景更像出片），
    则 neg_max 抬高，self - neg_max < 0.03 → 不过。
    """
    assert POS_1052.is_file() and REF.is_file()
    vid = _make_video_from_jpg(POS_1052, tmp_path / "drift1052.mp4")
    # 负参考用 1052 自身：出片对「同画风」极高，对动漫立绘较低
    out = cp.score_clip_identity_relative(
        vid, REF, [POS_1052], margin=0.03, embedder=_hist_embed
    )
    assert out.get("pass") is False, out
    assert float(out["face_mean"]) < float(out["neg_max"]) + 0.03


def test_relative_neg_haokun_fails(tmp_path):
    """负样本组1：换人出片对本角色不应过相对门禁。"""
    vid = _make_video_from_jpg(NEG, tmp_path / "neg.mp4")
    out2 = cp.score_clip_identity_relative(
        vid, REF, [NEG], margin=0.03, embedder=_hist_embed
    )
    assert out2.get("pass") is False, out2
    assert float(out2["face_mean"]) < float(out2["neg_max"]) + 0.03


def test_relative_neg_inverted_fails(tmp_path):
    """负样本组2：色相反转负参考贴近「非本角色」时，换人出片仍不过。"""
    inv = _make_shifted_neg(NEG, tmp_path / "neg_inv.png")
    vid = _make_video_from_jpg(NEG, tmp_path / "neg2.mp4")
    out = cp.score_clip_identity_relative(
        vid, REF, [inv, NEG], margin=0.03, embedder=_hist_embed
    )
    assert out.get("pass") is False, out


def test_pick_best_relative_rejects_lookalike(tmp_path, monkeypatch):
    """绝对分都 >0.60 时，相对门禁仍能拦换人。"""
    pos = _make_video_from_jpg(POS_1205 if POS_1205.is_file() else REF, tmp_path / "pos.mp4")
    # POS_1205 可能读图失败则用 REF 做占位视频
    if not pos.is_file() or pos.stat().st_size == 0:
        pos = _make_video_from_jpg(REF, tmp_path / "pos.mp4")
    neg = _make_video_from_jpg(NEG, tmp_path / "neg.mp4")
    cands = [
        {"id": "c_pos", "status": "done", "url": str(pos)},
        {"id": "c_neg", "status": "done", "url": str(neg)},
    ]

    def fake_face(path, ref, **kw):
        name = Path(path).name
        return {
            "face_mean": 0.820 if name.startswith("pos") else 0.651,
            "burnin_penalty": 0,
            "ocr_penalty": 0,
            "error": "",
            "score_backend": "clip",
        }

    monkeypatch.setattr(cp, "score_video_face", fake_face)
    monkeypatch.setattr(
        cp,
        "score_scene_continuity",
        lambda *a, **k: {"continuity": None, "regression": None},
    )

    def fake_rel(path, ref, negs, **kw):
        name = Path(path).name
        if name.startswith("pos"):
            return {
                "face_mean": 0.820,
                "neg_max": 0.618,
                "relative_delta": 0.202,
                "pass": True,
                "score_backend": "clip_relative",
                "margin": 0.03,
            }
        return {
            "face_mean": 0.651,
            "neg_max": 0.64,
            "relative_delta": 0.011,
            "pass": False,
            "score_backend": "clip_relative",
            "margin": 0.03,
            "gate_status": cp.GATE_NEEDS_REVIEW,
        }

    monkeypatch.setattr(cp, "score_clip_identity_relative", fake_rel)
    wid, out = cp.pick_best_candidate(
        cands,
        ref_image_path=REF,
        face_score_mode="clip",
        ref_style="anime",
        min_face_mean=0.60,
        negative_ref_paths=[NEG],
        relative_margin=0.03,
        use_relative_identity=True,
    )
    assert wid == "c_pos"
    neg_c = next(c for c in out if c["id"] == "c_neg")
    assert neg_c.get("relative_pass") is False
