"""成片验收：1fps OCR 文字门禁。"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.services.studio.ffmpeg_ops import detect_burned_text

def _has_pytesseract():
    try:
        import pytesseract  # noqa: F401
        return True
    except Exception:
        return False

pytestmark = [
    pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="no ffmpeg"),
    pytest.mark.skipif(not _has_pytesseract(), reason="no pytesseract"),
]


def _mp4_from_frames(frames: list[Path], out: Path, fps: int = 1) -> None:
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.as_posix()}'\nduration 1\n" for p in frames), encoding="utf-8")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-r", str(fps),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True,
    )
    lst.unlink(missing_ok=True)


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="no tesseract")
def test_detect_burned_text_flags_letters(tmp_path):
    frames = []
    for i in range(3):
        im = Image.new("RGB", (320, 180), (30, 30, 30))
        d = ImageDraw.Draw(im)
        if i == 1:
            d.text((40, 70), "DCHS BrE", fill=(255, 255, 255))
        fp = tmp_path / f"f{i}.jpg"
        im.save(fp)
        frames.append(fp)
    mp4 = tmp_path / "t.mp4"
    _mp4_from_frames(frames, mp4)
    r = detect_burned_text(mp4, fps=1.0)
    assert r["ok"] is False
    assert r["hits"], r


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="no tesseract")
def test_detect_burned_text_clean_pass(tmp_path):
    frames = []
    for i in range(3):
        im = Image.new("RGB", (320, 180), (40, 60, 80))
        d = ImageDraw.Draw(im)
        d.ellipse((100, 40, 220, 140), fill=(200, 180, 160))
        fp = tmp_path / f"c{i}.jpg"
        im.save(fp)
        frames.append(fp)
    mp4 = tmp_path / "c.mp4"
    _mp4_from_frames(frames, mp4)
    r = detect_burned_text(mp4, fps=1.0)
    assert r["error"] == ""
    assert r["ok"] is True, r
