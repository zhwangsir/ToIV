"""FU2 件 4/5:视觉下钻合成图 + 渲染后自评闭环(真 ffmpeg)。"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app.services import edit_grade as eg
from app.services import edit_view as ev

WORDS = [{"start": 0.3, "end": 0.7, "word": "甲"}, {"start": 1.2, "end": 1.6, "word": "乙"}]


@pytest.fixture()
def clip(tmp_path: Path) -> Path:
    src = tmp_path / "v.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-af", "volume=0.2",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True)
    return src


@pytest.fixture()
def black_tail_clip(tmp_path: Path) -> Path:
    src = tmp_path / "vb.mp4"
    subprocess.run(
        ["ffmpeg", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=1.5",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
         "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=0.6",
         "-f", "lavfi", "-i", "anullsrc=d=0.6",
         "-filter_complex", "[1:a]volume=0.2[a1];[0:v][a1][2:v][3:a]concat=n=2:v=1:a=1[v][a]",
         "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast",
         "-c:a", "aac", str(src)],
        check=True, capture_output=True)
    return src


def test_timeline_view_composite(clip, tmp_path):
    out = tmp_path / "tl.png"
    ev.build_timeline_view(clip, WORDS, out, frames=8, width=640)
    assert out.exists() and out.stat().st_size > 0
    from PIL import Image
    w, h = Image.open(out).size
    assert w == 640 and h > 100


def test_qa_flags_black_span(black_tail_clip):
    m = eg.qa_render(black_tail_clip)
    assert (m["loudness_i"] is not None) or (m["mean_db"] is not None)
    assert any(f["kind"] == "black_span" for f in m["findings"])


def test_qa_clean_clip_has_no_black(clip):
    m = eg.qa_render(clip)
    assert not [f for f in m["findings"] if f["kind"] == "black_span"]


def test_self_review_loop_stops_when_clean():
    calls = {"n": 0}

    def render():
        calls["n"] += 1
        return f"out{calls['n']}.mp4"

    def qa(out):
        findings = [] if calls["n"] > 1 else [{"kind": "loudness_out_of_band", "value": -3}]
        return {"findings": findings, "loudness_i": -3}

    def fix(out, findings, metrics):
        return True  # 声称已修(如加增益重渲)

    res = eg.self_review_loop(render, qa, fix, max_rounds=3)
    assert res["ok"] is True and len(res["rounds"]) == 2


def test_self_review_loop_gives_up_at_cap():
    def render():
        return "o.mp4"

    def qa(out):
        return {"findings": [{"kind": "black_span", "span": [0.0, 0.5]}]}

    res = eg.self_review_loop(render, qa, fix=lambda *a: True, max_rounds=2)
    assert res["ok"] is False and len(res["rounds"]) == 2


def test_self_review_loop_unfixable_reports_once():
    def qa(out):
        return {"findings": [{"kind": "freeze", "at": 1.0}]}

    res = eg.self_review_loop(lambda: "o.mp4", qa, fix=lambda *a: False, max_rounds=3)
    assert res["ok"] is False and len(res["rounds"]) == 1
