"""成片验收：1fps OCR 文字门禁。"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.services.studio.ffmpeg_ops import detect_burned_text

def _has_ocr_engine():
    try:
        from rapidocr_onnxruntime import RapidOCR  # noqa: F401
        return True
    except Exception:
        pass
    try:
        import pytesseract  # noqa: F401
        return shutil.which("tesseract") is not None
    except Exception:
        return False

pytestmark = [
    pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="no ffmpeg"),
    pytest.mark.skipif(not _has_ocr_engine(), reason="no OCR engine"),
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


def test_detect_burned_text_allowlists_store_sign(tmp_path):
    frames = []
    font = None
    for fp in (
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
    ):
        if Path(fp).is_file():
            try:
                font = ImageFont.truetype(fp, 36)
                break
            except Exception:
                pass
    for i in range(2):
        im = Image.new("RGB", (384, 672), (20, 20, 30))
        d = ImageDraw.Draw(im)
        d.rectangle((40, 80, 340, 160), fill=(40, 40, 50))
        d.text((70, 100), "夜灯便利", fill=(240, 220, 80), font=font)
        fp = tmp_path / f"s{i}.jpg"
        im.save(fp)
        frames.append(fp)
    mp4 = tmp_path / "store.mp4"
    _mp4_from_frames(frames, mp4)
    r = detect_burned_text(mp4, fps=1.0, allowlist=["夜灯便利"])
    assert r["ok"] is True, r


def test_detect_burned_text_flags_haokun_subtitle_fixture():
    """17:00：第10秒烧录「好困/好*」必须检出。"""
    fixture = Path(__file__).resolve().parents[3] / "apps/api/tests/fixtures/rain_shot0_t10_haokun.jpg"
    alt = Path("/home/merlin/toiv/tmp/toiv_report_rain_v5_splice/shot0_t10.jpg")
    mate = Path.home() / "Desktop/ALLProject/toiv_report_rain_v5_splice/shot0_t10.jpg"
    src = next((p for p in (fixture, alt, mate) if p.is_file()), None)
    if src is None:
        pytest.skip("no shot0_t10 fixture")
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        td_p = Path(td)
        frame = td_p / "f.jpg"
        frame.write_bytes(src.read_bytes())
        mp4 = td_p / "t10.mp4"
        _mp4_from_frames([frame, frame], mp4)
        r = detect_burned_text(mp4, fps=1.0, min_chars=1)
    assert r["ok"] is False, r
    assert r["hits"], r
    joined = "".join(h.get("text", "") for h in r["hits"])
    assert "好" in joined, r  # 17:00：必须至少检出「好」
    joined = "".join(h["text"] for h in r["hits"])
    assert any("好" in h["text"] for h in r["hits"]), joined
