"""按需视觉下钻：胶片条+波形+词标签 合成单图（FU2 件 4）。

移植自 video-use(MIT, Copyright (c) 2026 Browser Use) helpers/timeline_view.py 的理念：
不逐帧喂模型；歧义点才生成一张复合 PNG（帧条+波形+词级标签）给 VLM 看一次。
实现按 ToIV 现状改编：ffmpeg 出帧条与波形，PIL 合成与画词标签（api venv 已有 Pillow）。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

COLS = 4


def probe_duration(video: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video)],
        capture_output=True, text=True, check=True, timeout=60).stdout
    return float(json.loads(out)["format"]["duration"])


def _filmstrip(video: Path, out_png: Path, frames: int, duration: float, cell_w: int) -> None:
    fps = frames / max(duration, 0.1)
    rows = (frames + COLS - 1) // COLS
    vf = f"fps={fps:.4f},scale={cell_w}:-2,tile={COLS}x{rows}"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-vf", vf, "-frames:v", "1", str(out_png)],
        check=True, capture_output=True, timeout=300)


def _waveform(video: Path, out_png: Path, width: int, height: int) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video),
         "-filter_complex", f"showwavespic=s={width}x{height}:colors=0x66ccff",
         "-frames:v", "1", str(out_png)],
        check=True, capture_output=True, timeout=300)


def build_timeline_view(video: Path, words: list[dict], out_png: Path, *,
                        frames: int = 12, width: int = 1280,
                        window: tuple[float, float] | None = None) -> Path:
    """合成 帧条+波形+词标签 单图。window=(t0,t1) 给定时只画该窗内的词标签。"""
    duration = probe_duration(video)
    tmp = out_png.parent / f".{out_png.stem}_parts"
    tmp.mkdir(parents=True, exist_ok=True)
    strip_png, wave_png = tmp / "strip.png", tmp / "wave.png"
    cell_w = width // COLS
    _filmstrip(video, strip_png, frames, duration, cell_w)
    wave_h = 140
    _waveform(video, wave_png, width, wave_h)
    label_h = 46
    strip = Image.open(strip_png).convert("RGB")
    wave = Image.open(wave_png).convert("RGB")
    if strip.width != width:
        strip = strip.resize((width, int(strip.height * width / strip.width)))
    if wave.width != width:
        wave = wave.resize((width, wave_h))
    canvas = Image.new("RGB", (width, strip.height + wave_h + label_h), (16, 16, 20))
    canvas.paste(strip, (0, 0))
    canvas.paste(wave, (0, strip.height))
    draw = ImageDraw.Draw(canvas)
    t0, t1 = window or (0.0, duration)
    for w in words or []:
        s = w.get("start")
        if s is None or not (t0 <= s <= t1):
            continue
        x = int(width * (s / duration)) if duration > 0 else 0
        y = strip.height + wave_h + 4
        draw.line((x, strip.height, x, strip.height + wave_h), fill=(255, 200, 60), width=1)
        draw.text((min(x + 2, width - 90), y), (w.get("text") or "")[:12], fill=(235, 235, 235))
    canvas.save(out_png)
    for f in (strip_png, wave_png):
        f.unlink(missing_ok=True)
    tmp.rmdir()
    return out_png
