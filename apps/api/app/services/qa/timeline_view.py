"""按需视觉下钻:胶片条+波形+词标签 单张复合 PNG(FU2b 成片 QA 包)。

ported from video-use (MIT, Copyright (c) 2026 Browser Use) helpers/timeline_view.py,
按 ToIV 改造:
- 不逐帧喂模型;只在歧义时间点生成一张复合 PNG 字节,供 VLM 一次看;
- 输入=视频路径+词级转写+歧义时间点,输出=PNG 字节(不落盘);
- 缺音频时优雅降级为纯胶片条(+时间标尺/歧义标注),不报错。

帧抽取走 ffmpeg;音频波形走 ffmpeg 抽 wav + wave 模块读样;合成用 PIL+numpy。
"""
from __future__ import annotations

import io
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---- 布局常量(composite_height 与合成共用;测试按此断言尺寸) ----
HEADER_H = 52
FILMSTRIP_H = 180
LABEL_H = 26
WAVE_H = 160
RULER_H = 34
FOOTER_H = 40
GAP = 8
MARGIN = 24

# 歧义点默认取窗 ±1.5s(与 self_review 剪点自检窗一致)
AMBIGUITY_WINDOW = 1.5

BG = (18, 18, 22)
FG = (235, 235, 235)
DIM = (110, 110, 120)
ACCENT = (255, 140, 60)
SILENCE = (50, 80, 120, 120)
WAVE = (140, 180, 255)


def composite_height(has_audio: bool) -> int:
    """复合图总高:有音频=胶片条+词标签+波形带;无音频=纯胶片条。"""
    h = HEADER_H + FILMSTRIP_H + GAP + RULER_H + GAP + FOOTER_H
    if has_audio:
        h += LABEL_H + WAVE_H + GAP
    return h


# ---- 帧抽取(ffmpeg) ---------------------------------------------------------


def extract_frames(video: Path | str, start: float, end: float, n: int) -> list[Image.Image]:
    """在 (start, end) 内均匀抽 n 帧,返回 PIL 图(顺序)。

    取样点取每格中点,避免 end 贴视频末尾时越界抽空;单帧失败跳过,
    全部失败才报错(容窗外时间戳)。
    """
    n = max(1, int(n))
    step = (end - start) / n
    times = [start + (i + 0.5) * step for i in range(n)]
    imgs: list[Image.Image] = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, t in enumerate(times):
            out = Path(tmp) / f"f_{i:03d}.jpg"
            cmd = [
                "ffmpeg", "-y", "-ss", f"{t:.3f}", "-i", str(video),
                "-frames:v", "1", "-q:v", "4", "-vf", "scale=320:-2", str(out),
            ]
            try:
                subprocess.run(
                    cmd, check=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
                )
                imgs.append(Image.open(out).convert("RGB"))
            except (subprocess.SubprocessError, OSError):
                continue
    if not imgs:
        raise RuntimeError(f"抽帧失败: {video} [{start}, {end}]")
    return imgs


# ---- 音频包络(ffmpeg 抽 wav + wave 读样;缺音频→None 优雅降级) ---------------


def extract_audio_envelope(
    video: Path | str, start: float, end: float, samples: int = 2000,
) -> np.ndarray | None:
    """返回 [start,end] 段的 RMS 包络(归一化到 [0,1],长度=samples)。

    无音轨/抽取失败返回 None(调用方降级为纯胶片条)。
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav = Path(f.name)
    try:
        cmd = [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(video),
            "-t", f"{max(end - start, 0.01):.3f}",
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
        ]
        r = subprocess.run(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
        )
        if r.returncode != 0 or not wav.exists() or wav.stat().st_size == 0:
            return None
        import wave

        with wave.open(str(wav), "rb") as w:
            frames = w.readframes(w.getnframes())
        pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if pcm.size == 0:
            return None
        n = pcm.size
        window = max(1, n // samples)
        usable = (n // window) * window
        env = np.sqrt(np.mean(pcm[:usable].reshape(-1, window) ** 2, axis=1))
        if env.size < samples:
            env = np.pad(env, (0, samples - env.size))
        else:
            env = env[:samples]
        if env.max() > 0:
            env = env / env.max()
        return env
    except (subprocess.SubprocessError, OSError):
        return None
    finally:
        wav.unlink(missing_ok=True)


# ---- 词级转写工具(移植自 upstream) ------------------------------------------


def words_in_window(words: Sequence[dict], start: float, end: float) -> list[dict]:
    out: list[dict] = []
    for w in words or []:
        ws, we = w.get("start"), w.get("end")
        if ws is None or we is None:
            continue
        if we <= start or ws >= end:
            continue
        out.append(w)
    return out


def find_silences(
    words: Sequence[dict], start: float, end: float, threshold: float = 0.4,
) -> list[tuple[float, float]]:
    """[start,end] 内词间隙 ≥ threshold 秒的区间(按 upstream 规则)。"""
    gaps: list[tuple[float, float]] = []
    prev_end = start
    for w in words or []:
        if w.get("type") == "spacing":
            continue
        ws = max(start, float(w.get("start", start)))
        if ws - prev_end >= threshold:
            gaps.append((prev_end, ws))
        prev_end = max(prev_end, float(w.get("end", ws)))
    if end - prev_end >= threshold:
        gaps.append((prev_end, end))
    return gaps


# ---- 字体 -------------------------------------------------------------------


FONT_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
]


def load_font(size: int) -> ImageFont.ImageFont:
    for fp in FONT_CANDIDATES:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ---- 合成(纯函数:帧/包络/词/歧义点 → PNG 字节) ------------------------------


def _word_text(w: dict) -> str:
    return str(w.get("text") or w.get("word") or "").strip()


def compose_timeline(
    frames: Sequence[Image.Image],
    words: Sequence[dict],
    *,
    start: float,
    end: float,
    envelope: np.ndarray | None = None,
    ambiguity_points: Sequence[float] = (),
    width: int = 1280,
) -> bytes:
    """合成单张复合 PNG 并返回字节。envelope=None → 纯胶片条降级。"""
    if not frames:
        raise ValueError("frames 不能为空")
    if end <= start:
        raise ValueError("end 必须 > start")
    has_audio = envelope is not None
    height = composite_height(has_audio)
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas, "RGBA")
    header_font = load_font(20)
    label_font = load_font(14)
    small_font = load_font(12)

    x0, x1 = MARGIN, width - MARGIN
    span = x1 - x0

    def time_to_x(t: float) -> int:
        frac = (float(t) - start) / max(1e-6, end - start)
        frac = min(1.0, max(0.0, frac))
        return int(x0 + frac * span)

    draw.text((MARGIN, 14), f"{start:.2f}s → {end:.2f}s  ({end - start:.2f}s, {len(frames)} frames)", fill=FG, font=header_font)

    # 胶片条:等宽格子,帧按原比例信箱式缩放
    n = len(frames)
    gap = 4
    cell_w = max(1, (span - (n - 1) * gap) // n)
    cursor = x0
    for img in frames:
        img = img.convert("RGB")
        scale = min(cell_w / img.width, FILMSTRIP_H / img.height)
        nw, nh = max(1, int(img.width * scale)), max(1, int(img.height * scale))
        scaled = img.resize((nw, nh), Image.LANCZOS)
        cell = Image.new("RGB", (cell_w, FILMSTRIP_H), BG)
        cell.paste(scaled, ((cell_w - nw) // 2, (FILMSTRIP_H - nh) // 2))
        canvas.paste(cell, (cursor, HEADER_H))
        cursor += cell_w + gap

    y = HEADER_H + FILMSTRIP_H + GAP

    # 词标签行 + 波形带(仅有音频)
    if has_audio:
        last_label_x = -9999
        for w in words_in_window(words, start, end):
            if w.get("type") == "spacing":
                continue
            ws, we = w.get("start"), w.get("end")
            text = _word_text(w)
            if not text or ws is None or we is None or (we - ws) < 0.05:
                continue
            cx = (time_to_x(ws) + time_to_x(we)) // 2
            if cx - last_label_x < 28:
                continue
            draw.text((cx + 2, y), text, fill=FG, font=small_font)
            last_label_x = cx
        y += LABEL_H

        wave_y = y
        draw.rectangle((x0, wave_y, x1, wave_y + WAVE_H), fill=(28, 28, 34))
        for a, b in find_silences(words_in_window(words, start, end), start, end):
            draw.rectangle((time_to_x(a), wave_y, time_to_x(b), wave_y + WAVE_H), fill=SILENCE)
        env = np.asarray(envelope, dtype=np.float64).ravel()
        if env.size < 2:
            env = np.resize(env, 2) if env.size else np.zeros(2)
        xs = np.linspace(x0, x1, num=span + 1)
        vals = np.interp(
            np.linspace(0.0, 1.0, num=xs.size),
            np.linspace(0.0, 1.0, num=env.size),
            env,
        )
        mid_y = wave_y + WAVE_H // 2
        max_amp = WAVE_H // 2 - 8
        top = [(int(xi), int(mid_y - v * max_amp)) for xi, v in zip(xs, vals)]
        bot = [(int(xi), int(mid_y + v * max_amp)) for xi, v in zip(xs, vals)]
        draw.line(top, fill=WAVE, width=1, joint="curve")
        draw.line(bot, fill=WAVE, width=1, joint="curve")
        draw.polygon(top + list(reversed(bot)), fill=(*WAVE, 60))
        y = wave_y + WAVE_H + GAP

    # 时间标尺
    ruler_y = y
    n_ticks = 6
    for i in range(n_ticks + 1):
        frac = i / n_ticks
        t = start + frac * (end - start)
        xi = x0 + int(frac * span)
        draw.line((xi, ruler_y, xi, ruler_y + 6), fill=DIM, width=1)
        draw.text((xi - 20, ruler_y + 8), f"{t:.2f}s", fill=DIM, font=label_font)

    # 歧义时间点标注(贯穿胶片条到标尺的竖线 + 顶部三角)
    for pt in ambiguity_points or ():
        if pt < start or pt > end:
            continue
        xi = time_to_x(pt)
        draw.line((xi, HEADER_H, xi, ruler_y), fill=ACCENT, width=2)
        draw.polygon([(xi - 6, HEADER_H), (xi + 6, HEADER_H), (xi, HEADER_H + 8)], fill=ACCENT)

    # 页脚图例
    footer_y = ruler_y + RULER_H + GAP
    notes = []
    if has_audio and find_silences(words_in_window(words, start, end), start, end):
        notes.append("shaded bands = silences ≥ 400ms")
    if any(start <= pt <= end for pt in ambiguity_points or ()):
        notes.append("orange lines = ambiguity points")
    if not has_audio:
        notes.append("no audio track — filmstrip only")
    if notes:
        draw.text((MARGIN, footer_y + 10), "  ·  ".join(notes), fill=DIM, font=label_font)

    bio = io.BytesIO()
    canvas.save(bio, "PNG", optimize=True)
    return bio.getvalue()


def timeline_png_bytes(
    video: Path | str,
    words: Sequence[dict],
    *,
    ambiguity_points: Sequence[float] = (),
    start: float | None = None,
    end: float | None = None,
    n_frames: int = 8,
    width: int = 1280,
) -> bytes:
    """主入口:视频路径+词级转写+歧义时间点 → 复合 PNG 字节。

    未显式给 [start,end] 时按歧义点 ±AMBIGUITY_WINDOW 自动取窗;
    两者都缺时报 ValueError。
    """
    if start is None and end is None:
        if not ambiguity_points:
            raise ValueError("需要 start/end 或至少一个歧义时间点")
        start = max(0.0, min(ambiguity_points) - AMBIGUITY_WINDOW)
        end = max(ambiguity_points) + AMBIGUITY_WINDOW
    elif start is None or end is None:
        raise ValueError("start/end 必须同时给定")
    frames = extract_frames(video, start, end, n_frames)
    envelope = extract_audio_envelope(video, start, end)
    return compose_timeline(
        frames, words, start=start, end=end,
        envelope=envelope, ambiguity_points=ambiguity_points, width=width,
    )
