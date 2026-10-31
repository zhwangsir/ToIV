"""FU2 渲染件真渲染测试(本机 ffmpeg):先校验后渲染、30ms 淡入淡出、无损 concat。"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from app.services import edit_render as er
from app.services.edit_edl import Edl, EdlRange

WORDS = [
    {"start": 0.5, "end": 0.9, "word": "a"},
    {"start": 1.5, "end": 1.9, "word": "b"},
    {"start": 2.5, "end": 2.9, "word": "c"},
    {"start": 3.5, "end": 3.8, "word": "d"},
]


@pytest.fixture()
def clip(tmp_path: Path) -> Path:
    src = tmp_path / "src.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True)
    return src


def _dur(p: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", p],
        capture_output=True, text=True, check=True).stdout
    return float(json.loads(out)["format"]["duration"])


def test_render_edl_draft_concat(clip, tmp_path):
    edl = Edl(sources={"t": str(clip)}, ranges=[
        EdlRange(source="t", start=1.0, end=2.0, beat="b1", reason="test"),
        EdlRange(source="t", start=3.0, end=3.4),
    ])
    res = er.render_edl(edl, {"t": WORDS}, lambda u: Path(u), tmp_path, draft=True)
    assert res["ok"], res["issues"]
    assert len(res["segments"]) == 2
    # seg1=0.95..2.08(1.13s) + seg2=2.95..3.48(0.53s) ≈ 1.66s(容器误差容 ±0.35)
    assert 1.3 < _dur(res["out"]) < 2.0
    assert not list(tmp_path.glob("*.concat.txt"))  # 清单用完即删


def test_render_refuses_midword_and_writes_nothing(clip, tmp_path):
    edl = Edl(sources={"t": str(clip)}, ranges=[EdlRange(source="t", start=0.7, end=2.0)])
    res = er.render_edl(edl, {"t": WORDS}, lambda u: Path(u), tmp_path, draft=True)
    assert not res["ok"]
    assert any(i["kind"] == "midword_cut" for i in res["issues"])
    assert not (tmp_path / "draft.mp4").exists()
    assert not list(tmp_path.glob("clips_draft/*.mp4"))


def test_probe_fps_reads_source(clip):
    assert er.probe_fps(clip) == "24"
