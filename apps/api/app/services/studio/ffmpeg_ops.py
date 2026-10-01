"""ffmpeg 助手:进程执行 / 片段拼接。

与 app.routes.assembly 内的实现同源独立演化(服务层自持,不反向依赖路由层)。
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path


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

