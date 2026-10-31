"""13:20：CLIP/人脸门禁缺依赖时 fail-closed（未通过-需复核），禁止空分放行。"""
from __future__ import annotations

import pytest

from app.services.studio import candidate_pick as cp
from app.services.studio.scene_gate import SceneGateError, score_frames_clip


def test_score_video_face_clip_missing_openclip_fail_closed(monkeypatch, tmp_path):
    monkeypatch.setattr(cp, "_openclip_image_embedder", lambda: None)
    # 最小假视频：无真实帧也可，因 embedder 先失败
    vid = tmp_path / "empty.mp4"
    vid.write_bytes(b"not-a-real-video")
    ref = tmp_path / "ref.png"
    from PIL import Image
    Image.new("RGB", (64, 64), (120, 130, 140)).save(ref)
    out = cp.score_video_face_clip(vid, ref)
    assert out.get("face_mean") is None
    assert out.get("gate_status") == cp.GATE_NEEDS_REVIEW
    assert out.get("pass") is False
    assert "不可用" in (out.get("error") or "")


def test_pick_best_fail_closed_when_scorer_unavailable():
    cands = [
        {"id": "a", "status": "done", "url": "/tmp/nope.mp4"},
        {"id": "b", "status": "done", "url": "/tmp/nope2.mp4"},
    ]
    with pytest.raises(cp.CandidatePickError) as ei:
        cp.pick_best_candidate(
            cands,
            ref_image_path=None,
            min_face_mean=0.45,
        )
    assert cp.GATE_NEEDS_REVIEW in str(ei.value) or any(
        c.get("gate_status") == cp.GATE_NEEDS_REVIEW for c in cands
    )
    assert all(not c.get("is_picked") for c in cands)


def test_scene_gate_missing_openclip_raises_needs_review(monkeypatch, tmp_path):
    import builtins
    real_import = builtins.__import__

    def _block_open_clip(name, *a, **k):
        if name == "open_clip" or name.startswith("open_clip."):
            raise ImportError("blocked for test")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _block_open_clip)
    frame = tmp_path / "f.jpg"
    from PIL import Image
    Image.new("RGB", (32, 32), (10, 10, 10)).save(frame)
    with pytest.raises(SceneGateError) as ei:
        score_frames_clip([frame])
    assert "未通过-需复核" in str(ei.value)
