"""FU2b 成片 QA 包:按需视觉下钻复合图(app/services/qa/timeline_view)。

合成帧/波形断言,不依赖 ffmpeg;真视频 e2e 用例缺 ffmpeg 时 skip。
"""
from __future__ import annotations

import io
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services.qa import timeline_view as tv

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _frames(n: int = 6, w: int = 64, h: int = 36) -> list[Image.Image]:
    out = []
    for i in range(n):
        arr = np.full((h, w, 3), 20 + (i * 30) % 200, dtype=np.uint8)
        out.append(Image.fromarray(arr))
    return out


def _png_size(data: bytes) -> tuple[int, int]:
    assert data[:8] == PNG_MAGIC, "非 PNG 字节头"
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def test_composite_png_header_and_size() -> None:
    env = np.linspace(0.0, 1.0, 200)
    words = [
        {"word": "甲", "start": 0.3, "end": 0.7},
        {"word": "乙", "start": 1.2, "end": 1.6},
    ]
    data = tv.compose_timeline(
        _frames(), words, start=0.0, end=2.0, envelope=env,
        ambiguity_points=[1.0], width=640,
    )
    assert isinstance(data, (bytes, bytearray)) and len(data) > 0
    w, h = _png_size(bytes(data))
    assert w == 640
    assert h == tv.composite_height(has_audio=True)


def test_no_audio_degrades_to_filmstrip() -> None:
    data = tv.compose_timeline(
        _frames(), [], start=0.0, end=2.0, envelope=None,
        ambiguity_points=[1.0], width=640,
    )
    w, h = _png_size(bytes(data))
    assert w == 640
    assert h == tv.composite_height(has_audio=False)
    assert h < tv.composite_height(has_audio=True)
    Image.open(io.BytesIO(bytes(data))).load()  # 可正常解码


def test_find_silences_ported_rules() -> None:
    words = [
        {"word": "a", "start": 0.1, "end": 0.3},
        {"word": "b", "start": 1.0, "end": 1.2},
    ]
    gaps = tv.find_silences(words, 0.0, 1.6, threshold=0.4)
    assert gaps == [(0.3, 1.0), (1.2, 1.6)]


def test_words_in_window_filters_by_overlap() -> None:
    words = [
        {"word": "a", "start": 0.0, "end": 0.2},
        {"word": "b", "start": 0.9, "end": 1.1},
        {"word": "c", "start": 3.0, "end": 3.2},
    ]
    got = tv.words_in_window(words, 0.5, 2.0)
    assert [w["word"] for w in got] == ["b"]


def test_timeline_png_bytes_uses_extractors(monkeypatch) -> None:
    monkeypatch.setattr(tv, "extract_frames", lambda video, start, end, n: _frames(n))
    monkeypatch.setattr(
        tv, "extract_audio_envelope",
        lambda video, start, end: np.linspace(0.0, 1.0, 100),
    )
    data = tv.timeline_png_bytes(
        "fake.mp4", [{"word": "甲", "start": 0.2, "end": 0.5}],
        ambiguity_points=[0.4], n_frames=5, width=320,
    )
    w, h = _png_size(bytes(data))
    assert (w, h) == (320, tv.composite_height(has_audio=True))


def test_timeline_png_bytes_window_from_ambiguity_points(monkeypatch) -> None:
    seen: dict[str, float] = {}

    def fake_frames(video, start, end, n):
        seen["start"], seen["end"] = start, end
        return _frames(n)

    monkeypatch.setattr(tv, "extract_frames", fake_frames)
    monkeypatch.setattr(tv, "extract_audio_envelope", lambda *a, **k: None)
    data = tv.timeline_png_bytes("fake.mp4", [], ambiguity_points=[4.0], width=320)
    assert seen["start"] == pytest.approx(2.5)  # 4.0 - AMBIGUITY_WINDOW
    assert seen["end"] == pytest.approx(5.5)
    assert _png_size(bytes(data))[1] == tv.composite_height(has_audio=False)


def test_timeline_png_bytes_requires_window() -> None:
    with pytest.raises(ValueError):
        tv.timeline_png_bytes("fake.mp4", [])


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="需要 ffmpeg")
def test_timeline_png_bytes_real_video(tmp_path: Path) -> None:
    src = tmp_path / "v.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True)
    data = tv.timeline_png_bytes(
        src, [{"word": "甲", "start": 0.3, "end": 0.7}],
        ambiguity_points=[0.5], n_frames=4, width=640,
    )
    w, h = _png_size(bytes(data))
    assert w == 640 and h == tv.composite_height(has_audio=True)
