"""FU2b 成片 QA 包:渲染后自评闭环(app/services/qa/self_review)。

合成帧序列测跳帧、合成波形测爆音、字幕遮挡启发式、响度 RMS 降级、
修复建议(adjust EDL 边界/pad)与闭环 3 轮上限/收敛提前停。不依赖 ffmpeg。
"""
from __future__ import annotations

import numpy as np
import pytest

from app.services.qa import self_review as sr

FPS = 10.0


def _gray(value: int, h: int = 24, w: int = 24) -> np.ndarray:
    return np.full((h, w), value, dtype=np.uint8)


def _seq(*values: int) -> list[np.ndarray]:
    return [_gray(v) for v in values]


def _sine(rate: int, amp: float, secs: float = 1.0) -> np.ndarray:
    t = np.arange(int(rate * secs)) / rate
    return amp * np.sin(2 * np.pi * 440 * t)


# ---- 跳帧(帧差突变) ---------------------------------------------------------


def test_detect_jump_frames_on_synthetic_sequence() -> None:
    frames = _seq(30, 30, 30, 30, 220, 220, 220)  # idx3→4 突变
    hits = sr.detect_jump_frames(frames, fps=FPS)
    assert len(hits) == 1
    assert hits[0]["t"] == pytest.approx(4 / FPS)
    assert hits[0]["score"] > 0.5


def test_detect_jump_frames_quiet_and_gradual() -> None:
    assert sr.detect_jump_frames(_seq(30, 30, 30), fps=FPS) == []
    assert sr.detect_jump_frames(_seq(*range(30, 42)), fps=FPS) == []  # 渐变不误报


# ---- 爆音(样本峰值/削波) ---------------------------------------------------


def test_detect_audio_clipping_on_synthetic_waveform() -> None:
    rate = 8000
    wave = _sine(rate, 0.3)
    wave[4000:4050] = 1.0  # 0.5s 处削波
    hits = sr.detect_audio_clipping(wave, rate)
    assert len(hits) == 1
    assert hits[0]["t"] == pytest.approx(0.5, abs=0.01)
    assert sr.detect_audio_clipping(_sine(rate, 0.5), rate) == []


def test_detect_audio_clipping_int16_input() -> None:
    rate = 8000
    s = np.zeros(rate, dtype=np.int16)
    s[100:140] = 32767
    hits = sr.detect_audio_clipping(s, rate)
    assert len(hits) == 1
    assert hits[0]["t"] == pytest.approx(100 / rate)


# ---- 字幕遮挡(底部安全区启发式) --------------------------------------------


def test_detect_subtitle_occlusion_bottom_safe_zone() -> None:
    base = np.full((40, 64), 40, dtype=np.uint8)
    sub = base.copy()
    sub[34:38, 8:56] = 240  # 底部 15% 亮条(文字样)
    hits = sr.detect_subtitle_occlusion([base, sub], fps=FPS, safe_zone=0.28)
    assert len(hits) == 1
    assert hits[0]["t"] == pytest.approx(1 / FPS)
    assert sr.detect_subtitle_occlusion([base, base], fps=FPS) == []


def test_detect_subtitle_occlusion_uniform_white_not_flagged() -> None:
    white = np.full((40, 64), 250, dtype=np.uint8)
    assert sr.detect_subtitle_occlusion([white], fps=FPS) == []


# ---- 响度(ebur128 走 ffmpeg;RMS 降级纯函数) ---------------------------------


def test_rms_lufs_reference_sine() -> None:
    s = _sine(16000, 0.5)
    assert sr.rms_lufs(s) == pytest.approx(20 * np.log10(0.5 / np.sqrt(2)), abs=0.15)


# ---- 综合自评结果 {checks, loudness_lufs, pass} ------------------------------


def test_review_result_shape_and_pass_when_clean() -> None:
    rate = 8000
    res = sr.review_cut_points(
        [0.5], frames=_seq(30, 31, 30, 31, 30),
        samples=_sine(rate, 0.3), sample_rate=rate,
        fps=FPS, loudness_lufs=-14.0,
    )
    assert set(res) == {"checks", "loudness_lufs", "pass"}
    assert res["loudness_lufs"] == -14.0
    assert res["checks"] == []
    assert res["pass"] is True


def test_review_flags_jump_at_cut() -> None:
    res = sr.review_cut_points(
        [0.3], frames=_seq(30, 30, 30, 220, 220, 220),
        fps=FPS, loudness_lufs=-14.0,
    )
    assert res["pass"] is False
    assert "jump_frame" in [c["kind"] for c in res["checks"]]
    for c in res["checks"]:
        assert set(c) == {"t", "kind", "severity", "detail"}


def test_review_flags_audio_clip_and_subtitle() -> None:
    rate = 8000
    wave = _sine(rate, 0.3)
    wave[2400:2460] = 1.0  # 0.3s 处爆音
    base = np.full((40, 64), 40, dtype=np.uint8)
    sub = base.copy()
    sub[34:38, 8:56] = 240
    res = sr.review_cut_points(
        [0.3], frames=[base, sub], samples=wave, sample_rate=rate,
        fps=FPS, loudness_lufs=-14.0,
    )
    kinds = {c["kind"] for c in res["checks"]}
    assert {"audio_clip", "subtitle_occlusion"} <= kinds
    assert res["pass"] is False


def test_review_filters_findings_outside_cut_windows() -> None:
    res = sr.review_cut_points(
        [5.0], frames=_seq(30, 30, 220, 220),  # 跳变在 0.2s,远离剪点
        fps=FPS, window=1.5, loudness_lufs=-14.0,
    )
    assert res["checks"] == []


def test_review_no_audio_graceful() -> None:
    res = sr.review_cut_points([0.2], frames=_seq(30, 30), samples=None, fps=FPS)
    assert res["loudness_lufs"] is None
    assert res["checks"] == []
    assert res["pass"] is True


def test_review_flags_loudness_out_of_band() -> None:
    hot = sr.review_cut_points([0.2], frames=_seq(30), fps=FPS, loudness_lufs=-3.0)
    assert hot["pass"] is False
    assert [c["kind"] for c in hot["checks"]] == ["loudness"]
    ok = sr.review_cut_points([0.2], frames=_seq(30), fps=FPS, loudness_lufs=-14.0)
    assert ok["pass"] is True


def test_review_loudness_falls_back_to_rms() -> None:
    rate = 8000
    res = sr.review_cut_points(
        [0.5], frames=_seq(30), samples=_sine(rate, 0.5), sample_rate=rate, fps=FPS,
    )
    assert res["loudness_lufs"] == pytest.approx(20 * np.log10(0.5 / np.sqrt(2)), abs=0.3)


# ---- 修复建议(adjust EDL item 边界 / pad) -----------------------------------


def test_suggest_fixes_adjusts_edl_boundary_and_pad() -> None:
    review = {
        "checks": [
            {"t": 1.02, "kind": "jump_frame", "severity": "error", "detail": "score=0.8"},
            {"t": 2.0, "kind": "audio_clip", "severity": "error", "detail": "peak=1.0"},
            {"t": 1.5, "kind": "subtitle_occlusion", "severity": "warn", "detail": "frac=0.3"},
        ],
        "loudness_lufs": -14.0,
        "pass": False,
    }
    fixes = sr.suggest_fixes(review, cut_points=[1.0, 2.0], edl_items=[{}, {}, {}])
    assert len(fixes) == 3
    ops = {(f["op"], f.get("field")) for f in fixes}
    assert ("adjust", "start") in ops or ("adjust", "end") in ops
    assert ("pad", "pad_in") in ops or ("pad", "pad_out") in ops
    for f in fixes:
        assert "reason" in f and "t" in f and "item" in f
    # jump 在剪点后 → 修 item1 头;audio_clip 在剪点 → 修 item1 尾
    by_reason = {f["reason"]: f for f in fixes}
    assert by_reason["jump_frame"]["item"] == 1 and by_reason["jump_frame"]["field"] == "start"
    assert by_reason["audio_clip"]["item"] == 1 and by_reason["audio_clip"]["field"] == "pad_out"


# ---- 闭环状态机(evaluate→fix→re-render,最多 3 轮) ---------------------------


class _Steps:
    def __init__(self, passes: list[bool], fix_ok: bool = True) -> None:
        self.passes = list(passes)
        self.fix_ok = fix_ok
        self.evals = 0
        self.fixes = 0
        self.renders = 0
        self.last_suggestions: list | None = None

    def evaluate(self) -> dict:
        p = self.passes[min(self.evals, len(self.passes) - 1)]
        self.evals += 1
        checks = [] if p else [
            {"t": 1.0, "kind": "jump_frame", "severity": "error", "detail": "score=0.8"},
        ]
        return {"checks": checks, "loudness_lufs": -14.0, "pass": p}

    def fix(self, suggestions: list) -> bool:
        self.fixes += 1
        self.last_suggestions = suggestions
        return self.fix_ok

    def render(self) -> str:
        self.renders += 1
        return f"out{self.renders}.mp4"


def test_review_loop_caps_at_three_rounds() -> None:
    st = _Steps(passes=[False])
    res = sr.run_review_loop(st, max_rounds=3, cut_points=[1.0])
    assert st.evals == 3 and st.fixes == 2 and st.renders == 2
    assert res["ok"] is False and res["rounds"] == 3 and res["reason"] == "max_rounds"


def test_review_loop_early_stop_on_convergence() -> None:
    st = _Steps(passes=[False, True])
    res = sr.run_review_loop(st, max_rounds=3, cut_points=[1.0])
    assert st.evals == 2 and st.fixes == 1 and st.renders == 1
    assert res["ok"] is True and res["rounds"] == 2 and res["reason"] == "converged"
    assert st.last_suggestions  # fix 收到修复建议


def test_review_loop_stops_when_fix_rejected() -> None:
    st = _Steps(passes=[False], fix_ok=False)
    res = sr.run_review_loop(st, max_rounds=3, cut_points=[1.0])
    assert st.evals == 1 and st.renders == 0
    assert res["ok"] is False and res["reason"] == "fix_rejected"


def test_review_loop_stops_without_suggestions() -> None:
    def evaluate() -> dict:
        return {"checks": [], "loudness_lufs": -14.0, "pass": False}

    res = sr.run_review_loop({"evaluate": evaluate}, max_rounds=3, cut_points=[1.0])
    assert res["ok"] is False and res["reason"] == "no_fix" and res["rounds"] == 1


def test_review_loop_rejects_bad_max_rounds() -> None:
    with pytest.raises(ValueError):
        sr.run_review_loop(_Steps(passes=[True]), max_rounds=0)
