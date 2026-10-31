"""Batch7: 对口型前配音 pad 静音 + 合成时长断言。

覆盖:
  · pad_audio_to_video_length: 短配音被补到视频时长
  · pad 跳过: 配音已够长不重编码
  · assemble assert_clip_durations_match_source: 截断成片报错
  · assemble 时长合格时可通过断言
"""
from __future__ import annotations

import struct
import subprocess
import wave
from pathlib import Path

import pytest

from app.services.studio import assemble as assemble_svc
from app.services.studio import lipsync as ls
from app.services.studio.ffmpeg_ops import pad_audio_to_duration, probe_duration


def _have_ffmpeg() -> bool:
    import shutil
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _make_silent_wav(path: Path, duration_sec: float, rate: int = 16000) -> None:
    n = int(rate * duration_sec)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * n)


def _make_color_mp4(path: Path, duration_sec: float, *, color: str = "black") -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", f"color=c={color}:s=320x240:d={duration_sec}:r=24",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
            str(path),
        ],
        check=True, capture_output=True,
    )


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_pad_audio_to_video_length_extends_short_voice(tmp_path):
    video = tmp_path / "v.mp4"
    audio = tmp_path / "a.wav"
    _make_color_mp4(video, 3.0)
    _make_silent_wav(audio, 1.2)
    out = await ls.pad_audio_to_video_length(video.read_bytes(), audio.read_bytes())
    padded = tmp_path / "padded.wav"
    padded.write_bytes(out)
    dur = await probe_duration(padded)
    assert dur == pytest.approx(3.0, abs=0.15)


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_pad_audio_skips_when_already_long(tmp_path):
    video = tmp_path / "v.mp4"
    audio = tmp_path / "a.wav"
    _make_color_mp4(video, 2.0)
    _make_silent_wav(audio, 2.1)
    raw = audio.read_bytes()
    out = await ls.pad_audio_to_video_length(video.read_bytes(), raw)
    assert out == raw  # 不重编码


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_assemble_rejects_truncated_clip(tmp_path, monkeypatch):
    """成片远短于源视频 → AssembleError。"""
    monkeypatch.setattr(assemble_svc, "drama_output_root", lambda: tmp_path)
    studio = tmp_path / "studio"
    studio.mkdir()
    src = studio / "src.mp4"
    clip = studio / "clip.mp4"
    _make_color_mp4(src, 5.0)
    _make_color_mp4(clip, 1.4)  # 对口型截断典型值

    class _S:
        idx = 0
        video_url = "/api/studio/files/src.mp4"
        final_clip_url = "/api/studio/files/clip.mp4"
        duration_sec = 5

    with pytest.raises(assemble_svc.AssembleError, match="截断|时长"):
        await assemble_svc.assert_clip_durations_match_source([_S()])


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_assemble_duration_ok_when_close(tmp_path, monkeypatch):
    monkeypatch.setattr(assemble_svc, "drama_output_root", lambda: tmp_path)
    studio = tmp_path / "studio"
    studio.mkdir()
    src = studio / "src.mp4"
    clip = studio / "clip.mp4"
    _make_color_mp4(src, 4.0)
    _make_color_mp4(clip, 4.1)

    class _S:
        idx = 0
        video_url = "/api/studio/files/src.mp4"
        final_clip_url = "/api/studio/files/clip.mp4"
        duration_sec = 4

    await assemble_svc.assert_clip_durations_match_source([_S()])


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_pad_audio_to_duration_helper(tmp_path):
    src = tmp_path / "in.wav"
    out = tmp_path / "out.wav"
    _make_silent_wav(src, 0.8)
    await pad_audio_to_duration(src, 2.5, out)
    assert await probe_duration(out) == pytest.approx(2.5, abs=0.12)


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_mux_audio_into_video_adds_audio_stream(tmp_path):
    """无音轨 mp4 + wav → 产物含 audio。"""
    from app.services.studio.ffmpeg_ops import mux_audio_into_video, probe_has_audio

    video = tmp_path / "v.mp4"
    audio = tmp_path / "a.wav"
    out = tmp_path / "out.mp4"
    _make_color_mp4(video, 2.0)
    _make_silent_wav(audio, 1.5)
    await mux_audio_into_video(video, audio, out)
    assert await probe_has_audio(out)
    assert await probe_duration(out) == pytest.approx(1.5, abs=0.2)  # -shortest 跟较短音


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_mux_voice_into_clip_bytes(tmp_path):
    video = tmp_path / "v.mp4"
    audio = tmp_path / "a.wav"
    _make_color_mp4(video, 2.0)
    _make_silent_wav(audio, 2.0)
    out = await ls.mux_voice_into_clip(video.read_bytes(), audio.read_bytes())
    outp = tmp_path / "m.mp4"
    outp.write_bytes(out)
    from app.services.studio.ffmpeg_ops import probe_has_audio
    assert await probe_has_audio(outp)


@pytest.mark.skipif(not _have_ffmpeg(), reason="需要 ffmpeg/ffprobe")
@pytest.mark.asyncio
async def test_assemble_rejects_clip_without_audio(tmp_path, monkeypatch):
    """成片无音轨 → AssembleError。"""
    monkeypatch.setattr(assemble_svc, "drama_output_root", lambda: tmp_path)
    studio = tmp_path / "studio"
    studio.mkdir()
    src = studio / "src.mp4"
    clip = studio / "clip.mp4"
    _make_color_mp4(src, 2.0)
    _make_color_mp4(clip, 2.0)  # 无音轨

    class _S:
        idx = 0
        video_url = "/api/studio/files/src.mp4"
        final_clip_url = "/api/studio/files/clip.mp4"
        duration_sec = 2

    with pytest.raises(assemble_svc.AssembleError, match="缺音轨"):
        await assemble_svc.assert_clips_have_audio([_S()])

