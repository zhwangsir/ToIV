"""12:48：动漫镜人脸分改 CLIP 图相似；参考图无脸不得空分放行。

正样本：1052 / 1205 attempt1 帧；负样本：换人（haokun）帧。
单测注入确定性 embedder，不依赖本机 open_clip 权重。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.studio import candidate_pick as cp

FIX = Path(__file__).resolve().parent / "fixtures" / "anime_face_clip"
REF = FIX / "ref_anime_portrait.png"
POS_1052 = FIX / "pos_1052_f03.jpg"
POS_1205 = FIX / "pos_1205_a1_f03.jpg"
NEG = FIX / "neg_haokun.jpg"


def _hist_embed(pil: Image.Image) -> np.ndarray:
    """轻量确定性伪 CLIP：HSV 直方图（单测用；生产走 open_clip）。"""
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


def test_anime_clip_1052_positive_above_gate(tmp_path):
    """1052 正样本相对设定卡立绘：hist 伪 CLIP ≥ 0.60。"""
    assert REF.is_file() and POS_1052.is_file()
    vid = _make_video_from_jpg(POS_1052, tmp_path / "pos_1052.mp4")
    out = cp.score_video_face_clip(vid, REF, embedder=_hist_embed)
    assert out.get("face_mean") is not None, out
    assert float(out["face_mean"]) >= 0.60, out["face_mean"]
    assert out.get("score_backend") == "clip"


def test_anime_clip_1205_ranks_above_negative(tmp_path):
    """1205 attempt1 与换人负样本：同人分须高于换人（颜色直方图在夜景上绝对值偏低）。"""
    assert REF.is_file() and POS_1205.is_file() and NEG.is_file()
    pos_vid = _make_video_from_jpg(POS_1205, tmp_path / "pos_1205.mp4")
    neg_vid = _make_video_from_jpg(NEG, tmp_path / "neg.mp4")
    pos = cp.score_video_face_clip(pos_vid, REF, embedder=_hist_embed)
    neg = cp.score_video_face_clip(neg_vid, REF, embedder=_hist_embed)
    assert pos.get("face_mean") is not None and neg.get("face_mean") is not None
    # 允许绝对值偏低，但正样本不得低于负样本
    assert float(pos["face_mean"]) >= float(neg["face_mean"]) - 0.02


def test_anime_clip_negative_below_gate(tmp_path):
    assert REF.is_file() and NEG.is_file()
    vid = _make_video_from_jpg(NEG, tmp_path / "neg_haokun.mp4")
    out = cp.score_video_face_clip(vid, REF, embedder=_hist_embed)
    assert out.get("face_mean") is not None, out
    assert float(out["face_mean"]) < 0.60, out["face_mean"]


def test_auto_mode_anime_uses_clip_not_empty(tmp_path, monkeypatch):
    """ref_style=anime 必须走 CLIP；不得 face_mean=None 空放行。"""
    vid = _make_video_from_jpg(POS_1052, tmp_path / "a.mp4")
    monkeypatch.setattr(cp, "_try_import_face", lambda: False)
    out = cp.score_video_face(
        vid, REF, mode="auto", ref_style="anime", clip_embedder=_hist_embed
    )
    assert out.get("face_mean") is not None, out
    assert out.get("score_backend") == "clip"
    assert float(out["face_mean"]) >= 0.60


def test_insightface_no_ref_face_falls_back_to_clip(tmp_path, monkeypatch):
    """写实模式：参考图 insightface 无脸 → 回退 CLIP，禁止仅返回 error。"""
    vid = _make_video_from_jpg(POS_1052, tmp_path / "b.mp4")

    class _FakeApp:
        def get(self, img):
            return []

    monkeypatch.setattr(cp, "_try_import_face", lambda: True)
    monkeypatch.setattr(cp, "_get_face_app", lambda: _FakeApp())
    out = cp.score_video_face(
        vid,
        REF,
        mode="insightface",
        ref_style="ancient_realistic",
        clip_embedder=_hist_embed,
    )
    assert out.get("face_mean") is not None, out
    assert out.get("score_backend") == "clip"
    assert out.get("fallback_from") == "insightface_no_ref_face"


def test_pick_best_anime_gate_060(tmp_path, monkeypatch):
    pos = _make_video_from_jpg(POS_1205, tmp_path / "pos.mp4")
    neg = _make_video_from_jpg(NEG, tmp_path / "neg.mp4")
    cands = [
        {"id": "c_pos", "status": "done", "url": str(pos)},
        {"id": "c_neg", "status": "done", "url": str(neg)},
    ]

    def fake_face(path, ref, **kw):
        p = Path(path)
        if p.name.startswith("pos"):
            return {
                "face_mean": 0.72,
                "burnin_penalty": 0,
                "ocr_penalty": 0,
                "error": "",
                "score_backend": "clip",
            }
        return {
            "face_mean": 0.41,
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
    wid, out = cp.pick_best_candidate(
        cands,
        ref_image_path=REF,
        face_score_mode="clip",
        ref_style="anime",
        min_face_mean=0.60,
    )
    assert wid == "c_pos"
    assert all(c.get("is_picked") for c in out if c["id"] == "c_pos")


def test_want_clip_face_helpers():
    assert cp._want_clip_face("clip", None) is True
    assert cp._want_clip_face("auto", "anime") is True
    assert cp._want_clip_face("auto", "ancient_realistic") is False
    assert cp._want_clip_face("insightface", "anime") is False
