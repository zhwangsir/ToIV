"""场景门禁：46635 帧必须判否，v6 37005 帧必须判过。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.studio.scene_gate import decide_scene_gate, gate_frames

FIXTURES = Path(__file__).parent / "fixtures" / "scene_gate"


def _scorer_for_fixtures(frame_path: Path, positive: str, negatives):
    """按夹具路径注入「真实应有」的相对排序：46635 负向更高，37005 正向更高。

    单测不依赖本机 open_clip 权重；live 标记另测真模型。
    """
    name = frame_path.name.lower()
    negs = list(negatives)
    if "46635" in name:
        # 户外近景 / 手部：负向全面压过正向
        pos = 0.12
        neg_scores = {n: 0.35 + 0.02 * i for i, n in enumerate(negs)}
        caption = (
            "a close-up outdoor rain night portrait of a woman with hood up"
            if "t2" in name
            else "hands close-up holding a bottle"
        )
    elif "37005" in name:
        pos = 0.41
        neg_scores = {n: 0.18 + 0.01 * i for i, n in enumerate(negs)}
        caption = "woman in black raincoat inside a convenience store at the checkout counter, medium shot, hood down"
    else:
        pos = 0.2
        neg_scores = {n: 0.2 for n in negs}
        caption = ""
    return {
        "path": str(frame_path),
        "pos_score": pos,
        "neg_scores": neg_scores,
        "pass_clip": all(pos > v for v in neg_scores.values()),
        "caption": caption,
    }


def test_decide_scene_gate_requires_two_frames():
    frames = [
        {"pos_score": 0.5, "neg_scores": {"a": 0.1}, "caption": "indoor store"},
        {"pos_score": 0.2, "neg_scores": {"a": 0.3}, "caption": "outdoor street"},
        {"pos_score": 0.6, "neg_scores": {"a": 0.1}, "caption": "checkout counter"},
    ]
    r = decide_scene_gate(frames, min_pass_frames=2)
    assert r["pass"] is True
    assert r["n_pass_frames"] == 2


def test_decide_rejects_outdoor_caption_even_if_clip_pass():
    frames = [
        {
            "pos_score": 0.9,
            "neg_scores": {"a": 0.1},
            "caption": "woman standing outdoor on a dark street",
        },
        {
            "pos_score": 0.9,
            "neg_scores": {"a": 0.1},
            "caption": "outdoor rain night",
        },
        {
            "pos_score": 0.9,
            "neg_scores": {"a": 0.1},
            "caption": "inside convenience store checkout",
        },
    ]
    r = decide_scene_gate(frames, min_pass_frames=2)
    assert r["pass"] is False
    assert r["n_pass_frames"] == 1


def test_fixture_46635_must_fail():
    frames = sorted(FIXTURES.glob("shot2_46635_*.jpg"))
    assert len(frames) >= 2, frames
    # 缺 t5 时用两帧 + min_pass_frames=2 → 必须全过才过；46635 应全否
    r = gate_frames(frames, min_pass_frames=2, scorer=_scorer_for_fixtures, captioner=lambda p: _scorer_for_fixtures(p, "", [])["caption"])
    assert r["scene_gate"] == "fail"
    assert r["pass"] is False
    assert r["n_pass_frames"] == 0


def test_fixture_37005_must_pass():
    frames = sorted(FIXTURES.glob("v6_c1_seed37005_*.jpg"))
    assert len(frames) >= 2, frames
    r = gate_frames(frames, min_pass_frames=2, scorer=_scorer_for_fixtures, captioner=lambda p: _scorer_for_fixtures(p, "", [])["caption"])
    assert r["scene_gate"] == "pass"
    assert r["pass"] is True
    assert r["n_pass_frames"] >= 2


def test_pick_best_requires_scene_gate(tmp_path, monkeypatch):
    from app.services.studio.candidate_pick import CandidatePickError, pick_best_candidate

    v_bad = tmp_path / "bad.mp4"
    v_good = tmp_path / "good.mp4"
    v_bad.write_bytes(b"x")
    v_good.write_bytes(b"y")
    ref = tmp_path / "ref.jpg"
    ref.write_bytes(b"r")

    def fake_face(path, ref_image_path):
        # 都过人脸
        return {"face_mean": 0.62, "burnin_penalty": 0, "ocr_penalty": 0, "error": ""}

    monkeypatch.setattr(
        "app.services.studio.candidate_pick.score_video_face", fake_face
    )
    monkeypatch.setattr(
        "app.services.studio.candidate_pick._try_import_face", lambda: True
    )

    def fake_gate(path, **kwargs):
        if Path(path).name.startswith("bad"):
            return {"scene_gate": "fail", "pass": False}
        return {"scene_gate": "pass", "pass": True}

    cands = [
        {"id": "a", "status": "done", "url": str(v_bad)},
        {"id": "b", "status": "done", "url": str(v_good)},
    ]
    best, out = pick_best_candidate(
        cands,
        ref_image_path=ref,
        min_face_mean=0.45,
        require_scene_gate=True,
        scene_gate_fn=fake_gate,
    )
    assert best == "b"
    assert next(c for c in out if c["id"] == "a")["scene_gate"] == "fail"
    assert next(c for c in out if c["id"] == "b")["scene_gate"] == "pass"

    only_bad = [{"id": "a", "status": "done", "url": str(v_bad)}]
    with pytest.raises(CandidatePickError, match="场景双门禁"):
        pick_best_candidate(
            only_bad,
            ref_image_path=ref,
            min_face_mean=0.45,
            require_scene_gate=True,
            scene_gate_fn=fake_gate,
        )
