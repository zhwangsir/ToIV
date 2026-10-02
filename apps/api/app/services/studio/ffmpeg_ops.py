from __future__ import annotations
import subprocess
from typing import Iterable
import asyncio
import shutil
from pathlib import Path

"""ffmpeg 助手:进程执行 / 片段拼接。

与 app.routes.assembly 内的实现同源独立演化(服务层自持,不反向依赖路由层)。
"""

class FFmpegError(RuntimeError):
    pass


def ensure_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise FFmpegError("服务端未安装 ffmpeg")
    return exe


async def run_ffmpeg(cmd: list[str], timeout: float = 600.0) -> None:
    """执行 ffmpeg,非零退出抛 FFmpegError 并附 stderr 尾部。"""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        proc.kill()
        raise FFmpegError(f"ffmpeg 超时({timeout}s)") from e
    if proc.returncode != 0:
        tail = (stderr or b"").decode(errors="replace")[-500:]
        raise FFmpegError(f"ffmpeg 失败(code={proc.returncode}): {tail}")


async def concat_parts(parts: list[Path], out: Path) -> None:
    """无损拼接同规格片段(concat demuxer + copy)。"""
    ensure_ffmpeg()
    list_file = out.with_suffix(".concat.txt")
    list_file.write_text(
        "".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8"
    )
    try:
        await run_ffmpeg(
            [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", list_file.as_posix(), "-c", "copy", out.as_posix(),
            ]
        )
    finally:
        list_file.unlink(missing_ok=True)


async def probe_duration(path: Path) -> float:
    """ffprobe 测媒体时长(秒);失败抛 FFmpegError(不静默估时)。"""
    if shutil.which("ffprobe") is None:
        raise FFmpegError("服务端未安装 ffprobe")
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        tail = (err or b"").decode(errors="replace")[-200:]
        raise FFmpegError(f"ffprobe 失败: {tail}")
    try:
        dur = float((out or b"").decode().strip())
    except (ValueError, AttributeError) as e:
        raise FFmpegError("ffprobe 时长解析失败") from e
    if dur <= 0:
        raise FFmpegError(f"非法时长: {dur}")
    return dur


async def pad_audio_to_duration(
    audio_path: Path, target_sec: float, out_path: Path
) -> Path:
    """将配音补静音到 target_sec(秒)。已够长则裁到目标时长。

    LatentSync 输出时长跟音轨走;短配音会把成片砍到台词长度。
    """
    if target_sec <= 0:
        raise FFmpegError(f"非法目标时长: {target_sec}")
    ensure_ffmpeg()
    # apad 补静音; -t 截到视频原长(防止配音过长拖长视频)
    await run_ffmpeg(
        [
            "ffmpeg", "-y", "-i", audio_path.as_posix(),
            "-af", f"apad=whole_dur={target_sec:.6f}",
            "-t", f"{target_sec:.6f}",
            "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            out_path.as_posix(),
        ],
        timeout=120.0,
    )
    if not out_path.is_file() or out_path.stat().st_size < 16:
        raise FFmpegError("配音 pad 静音产物无效")
    return out_path


async def probe_has_audio(path: Path) -> bool:
    """ffprobe 是否含音轨;无 ffprobe 视为 False(保守,避免静音成片)。"""
    if shutil.which("ffprobe") is None:
        return False
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return False
    return b"audio" in (out or b"")


async def mux_audio_into_video(
    video_path: Path, audio_path: Path, out_path: Path
) -> Path:
    """把音轨 mux 进视频(替换/补上音轨)。视频 copy,音频 aac。

    LatentSync 常吐无音轨 mp4;对口型后必须把配音 wav 合回去。
    """
    ensure_ffmpeg()
    await run_ffmpeg(
        [
            "ffmpeg", "-y",
            "-i", video_path.as_posix(),
            "-i", audio_path.as_posix(),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-ar", "48000", "-ac", "2",
            "-shortest", "-movflags", "+faststart",
            out_path.as_posix(),
        ],
        timeout=300.0,
    )
    if not out_path.is_file() or out_path.stat().st_size < 32:
        raise FFmpegError("mux 音轨产物无效")
    return out_path


def window_mean_volume_db(path: str | Path, starts: Iterable[float], win: float = 2.0) -> list[dict]:
    """Return mean_volume dB for each [start, start+win) window via ffmpeg volumedetect."""
    path = Path(path)
    rows: list[dict] = []
    for s in starts:
        cmd = [
            "ffmpeg", "-hide_banner",
            "-ss", f"{float(s):.3f}", "-t", f"{float(win):.3f}",
            "-i", str(path), "-af", "volumedetect", "-f", "null", "-",
        ]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        mean = None
        for line in (p.stderr or "").splitlines():
            if "mean_volume:" in line:
                mean = float(line.split("mean_volume:")[1].split("dB")[0].strip())
                break
        if mean is None:
            raise RuntimeError(f"no mean_volume for {path} @ {s}")
        rows.append({"t": float(s), "mean_db": mean})
    return rows


def compare_window_loudness(
    old_path: str | Path,
    new_path: str | Path,
    *,
    starts: Iterable[float] | None = None,
    win: float = 2.0,
    max_abs_diff_db: float = 4.0,
) -> dict:
    """成片验收：2 秒窗响度对比。默认 0–12s 每 2s 一窗，|new-old|≤max_abs_diff_db 才过。"""
    if starts is None:
        starts = list(range(0, 14, 2))
    else:
        starts = list(starts)
    old_rows = window_mean_volume_db(old_path, starts, win=win)
    new_rows = window_mean_volume_db(new_path, starts, win=win)
    windows = []
    ok = True
    for a, b in zip(old_rows, new_rows):
        diff = b["mean_db"] - a["mean_db"]
        passed = abs(diff) <= max_abs_diff_db
        if not passed:
            ok = False
        windows.append(
            {
                "t": a["t"],
                "old": a["mean_db"],
                "new": b["mean_db"],
                "diff": round(diff, 2),
                "pass": passed,
            }
        )
    return {"ok": ok, "max_abs_diff_db": max_abs_diff_db, "windows": windows}


def detect_burned_text(
    video_path: str | Path,
    *,
    fps: float = 1.0,
    max_t: float | None = None,
    langs: str = "chi_sim+eng",
    allowlist: Iterable[str] | None = None,
    min_chars: int = 2,
) -> dict:
    """成片验收：按 fps 抽帧 OCR，检出可读/乱码烧录字即不过。

    优先 RapidOCR（中文烧录字幕）；失败回落 tesseract。
    每帧除整图外，另对底部字幕区放大 OCR（父代理 17:00：字幕区放大+中文模型）。
    allowlist 内店名（如「夜灯便利」）不计命中。
    """
    import json as _json
    import re
    import subprocess
    import tempfile
    from pathlib import Path as _P

    video_path = _P(video_path)
    alnum = re.compile("[" + "A-Za-z0-9" + "\u4e00-\u9fff" + "]")
    allow = {re.sub(r"\s+", "", x) for x in (allowlist or ("夜灯便利",))}
    try:
        from PIL import Image
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "hits": [], "n_frames": 0, "error": f"ocr_deps_missing:{e}"}

    rapid = None
    try:
        from rapidocr_onnxruntime import RapidOCR
        import numpy as np  # noqa: F401

        rapid = RapidOCR()
    except Exception:
        rapid = None

    try:
        import pytesseract
    except Exception:
        pytesseract = None  # type: ignore

    if rapid is None and pytesseract is None:
        return {"ok": False, "hits": [], "n_frames": 0, "error": "ocr_deps_missing:no_engine"}

    def _norm(s: str) -> str:
        return "".join(alnum.findall(s or ""))

    def _allowed(txt: str) -> bool:
        if not txt:
            return True
        if txt in allow:
            return True
        for a in allow:
            if not a:
                continue
            if a in txt and _norm(txt.replace(a, "")) == "":
                return True
            # 店招碎片（便利/夜灯）也放行
            if len(txt) >= 2 and (txt in a or a.startswith(txt) or a.endswith(txt)):
                return True
        store_chars = set("夜灯便利店招牌霓虹火光")
        if ("夜" in txt and len(txt) <= 4) or (set(txt) <= store_chars and len(txt) <= 4):
            return True
        return False

    def _prep_variants(im: Image.Image) -> list[Image.Image]:
        """Contrast / invert / upscale variants to catch thin burned Chinese subs."""
        from PIL import ImageEnhance, ImageOps

        base = im.convert("RGB")
        outs = [base]
        try:
            outs.append(ImageEnhance.Contrast(base).enhance(2.2))
            outs.append(ImageEnhance.Contrast(base).enhance(3.0))
            outs.append(ImageOps.autocontrast(base))
            gray = ImageOps.grayscale(base)
            outs.append(ImageOps.autocontrast(gray).convert("RGB"))
            outs.append(ImageOps.invert(ImageOps.autocontrast(gray)).convert("RGB"))
        except Exception:
            pass
        big = []
        for o in outs:
            big.append(o)
            big.append(o.resize((max(32, o.width * 3), max(32, o.height * 3)), Image.Resampling.LANCZOS))
            big.append(o.resize((max(32, o.width * 5), max(32, o.height * 5)), Image.Resampling.LANCZOS))
        return big

    def _ocr_image(im: Image.Image) -> list[str]:
        texts: list[str] = []
        if rapid is not None:
            import numpy as np

            for cand in _prep_variants(im):
                try:
                    result, _ = rapid(np.asarray(cand.convert("RGB")))
                except Exception:
                    result = None
                if result:
                    for row in result:
                        if isinstance(row, (list, tuple)) and len(row) >= 2:
                            texts.append(str(row[1]))
        if pytesseract is not None:
            for cand in _prep_variants(im)[:6]:
                try:
                    raw = pytesseract.image_to_string(cand, lang=langs) or ""
                    if raw.strip():
                        texts.append(raw)
                except Exception:
                    pass
        return texts

    def _frame_texts(fp: _P) -> list[str]:
        im = Image.open(fp).convert("RGB")
        w, h = im.size
        out: list[str] = []
        out.extend(_ocr_image(im))
        # 烧录字幕通常贴在下巴下方窄带；裁太松 RapidOCR 会漏（17:00 t10「好困」）
        bands = [
            (0.70, 0.76, 0.28, 0.73),
            (0.71, 0.755, 0.30, 0.70),
            (0.69, 0.77, 0.25, 0.75),
            (0.60, 0.80, 0.20, 0.80),
        ]
        for ya, yb, xa, xb in bands:
            y0, y1, x0, x1 = int(h * ya), int(h * yb), int(w * xa), int(w * xb)
            if y1 <= y0 or x1 <= x0:
                continue
            crop = im.crop((x0, y0, x1, y1))
            if crop.width < 8 or crop.height < 8:
                continue
            up = crop.resize(
                (max(32, crop.width * 4), max(32, crop.height * 4)),
                Image.Resampling.LANCZOS,
            )
            out.extend(_ocr_image(up))
        return out

    probe = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video_path),
        ],
        text=True,
        timeout=30,
    )
    dur = float(_json.loads(probe)["format"]["duration"])
    end = dur if max_t is None else min(dur, float(max_t))
    step = 1.0 / float(fps) if fps > 0 else 1.0
    hits: list[dict] = []
    t = 0.0
    n = 0
    with tempfile.TemporaryDirectory(prefix="toiv_ocr_") as td:
        td_p = _P(td)
        while t < end - 0.01:
            fp = td_p / f"f_{n:04d}.jpg"
            p = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{t:.3f}",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                    str(fp),
                ],
                capture_output=True,
                timeout=60,
            )
            if p.returncode != 0 or not fp.is_file():
                t += step
                continue
            n += 1
            for raw in _frame_texts(fp):
                txt = _norm(raw)
                has_cjk = any("一" <= ch <= "鿿" for ch in txt)
                # 拉丁噪声需≥3；汉字≥1
                if has_cjk:
                    if len(txt) < 1:
                        continue
                elif len(txt) < max(3, min_chars):
                    continue
                if _allowed(txt):
                    continue
                hits.append({"t": round(t, 2), "text": txt[:80]})
                break
            t += step
    return {
        "ok": len(hits) == 0,
        "hits": hits,
        "n_frames": n,
        "error": "",
        "engine": "rapid" if rapid else "tesseract",
    }
