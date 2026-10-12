"""W0-3:拼接规格归一的判定逻辑(纯单元,不依赖真媒体/ffmpeg)。

背景:`concat_parts` 是 concat demuxer + `-c copy` 纯流拷贝,而各镜成片规格并不保证一致
(视频链 16fps mp4 / 对口型链 25fps h264 / H3 音频采样率未必 48k)。规格不一致时流拷贝会让
后续片段变速或静默,而时长断言照样通过 → 尾部哑音无人发现。
这里锁住三件事:①差异检测覆盖音视频关键字段与「有/无音轨」不一致 ②全一致走 copy 快路径
③有差异走归一并且**不静默**(返回 mode=transcode + diff + normalized 计数)。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.studio import ffmpeg_ops
from app.services.studio.ffmpeg_ops import (
    TARGET_AUDIO_CHANNELS,
    TARGET_AUDIO_SAMPLE_RATE,
    concat_parts_uniform,
    spec_diff_fields,
)


def _spec(w=768, h=1344, fps="24/1", vcodec="h264", sr="48000", ch="2", acodec="aac",
          audio: bool = True) -> dict:
    return {
        "video": {"codec_name": vcodec, "width": w, "height": h, "r_frame_rate": fps},
        "audio": ({"codec_name": acodec, "sample_rate": sr, "channels": ch} if audio else None),
    }


# ---------- ① 差异检测 ----------

def test_identical_specs_report_no_diff():
    assert spec_diff_fields([_spec(), _spec(), _spec()]) == []


def test_single_or_empty_specs_are_safe():
    assert spec_diff_fields([]) == []
    assert spec_diff_fields([_spec()]) == []


@pytest.mark.parametrize("field,value", [
    ("width", 1080),
    ("height", 1920),
    ("r_frame_rate", "25/1"),
    ("codec_name", "hevc"),
])
def test_video_field_mismatch_detected(field, value):
    bad = _spec()
    bad["video"][field] = value
    diff = spec_diff_fields([_spec(), bad])
    assert f"video.{field}" in diff


@pytest.mark.parametrize("field,value", [
    ("sample_rate", "32000"),   # H3 侧实测口径:不是 48000
    ("channels", "1"),
    ("codec_name", "mp3"),
])
def test_audio_field_mismatch_detected(field, value):
    bad = _spec()
    bad["audio"][field] = value
    diff = spec_diff_fields([_spec(), bad])
    assert f"audio.{field}" in diff


def test_missing_audio_track_on_some_clips_is_a_diff():
    """有的片有音轨、有的没有 → 拼接后音轨会断,必须算不一致。"""
    diff = spec_diff_fields([_spec(), _spec(audio=False)])
    assert "audio.presence" in diff


def test_all_clips_without_audio_is_not_a_diff():
    assert spec_diff_fields([_spec(audio=False), _spec(audio=False)]) == []


# ---------- ② / ③ 拼接方式决策 ----------

@pytest.fixture
def patched(monkeypatch, tmp_path):
    """把 probe/concat/normalize 都换成记录型假件,只验决策与调用序列。"""
    calls: dict = {"concat": [], "normalized": [], "specs": []}

    async def fake_concat(parts, out):
        calls["concat"].append([Path(p).name for p in parts])
        Path(out).write_bytes(b"x" * 64)

    async def fake_normalize(src, out, ref, *, timeout=900.0):
        calls["normalized"].append(Path(src).name)
        Path(out).write_bytes(b"y" * 64)
        return Path(out)

    def fake_probe(spec):
        async def _p(path):
            calls["specs"].append(Path(path).name)
            return spec(Path(path).name)
        return _p

    monkeypatch.setattr(ffmpeg_ops, "concat_parts", fake_concat)
    monkeypatch.setattr(ffmpeg_ops, "normalize_clip", fake_normalize)
    return calls, fake_probe


@pytest.mark.asyncio
async def test_uniform_clips_use_stream_copy_fast_path(monkeypatch, patched, tmp_path):
    calls, fake_probe = patched
    monkeypatch.setattr(ffmpeg_ops, "probe_media_spec", fake_probe(lambda name: _spec()))
    parts = [tmp_path / f"c{i}.mp4" for i in range(3)]
    for p in parts:
        p.write_bytes(b"a")
    out = tmp_path / "final.mp4"

    report = await concat_parts_uniform(parts, out)

    assert report["mode"] == "copy"
    assert report["normalized"] == 0
    assert report["diff"] == []
    assert calls["normalized"] == []           # 一致时不该重编码(画质零损失)
    assert calls["concat"] == [["c0.mp4", "c1.mp4", "c2.mp4"]]


@pytest.mark.asyncio
async def test_mixed_specs_transcode_and_report_not_silently(monkeypatch, patched, tmp_path):
    calls, fake_probe = patched
    specs = {"c0.mp4": _spec(), "c1.mp4": _spec(fps="25/1"), "c2.mp4": _spec(sr="32000")}
    monkeypatch.setattr(ffmpeg_ops, "probe_media_spec", fake_probe(lambda name: specs[name]))
    parts = [tmp_path / n for n in ("c0.mp4", "c1.mp4", "c2.mp4")]
    for p in parts:
        p.write_bytes(b"a")
    out = tmp_path / "final.mp4"

    report = await concat_parts_uniform(parts, out)

    assert report["mode"] == "transcode"
    assert "video.r_frame_rate" in report["diff"]
    assert "audio.sample_rate" in report["diff"]
    assert report["normalized"] == 2                     # c1(帧率) + c2(采样率)
    assert sorted(calls["normalized"]) == ["c1.mp4", "c2.mp4"]
    # 参照片 c0 不被无谓重编码;拼接用的是「原片 + 归一片」混合列表
    assert len(calls["concat"][0]) == 3
    assert "c0.mp4" in calls["concat"][0]
    # 归一临时件必须清掉,不留垃圾在成片目录
    assert not list(tmp_path.glob("final-norm*.mp4"))


@pytest.mark.asyncio
async def test_empty_parts_raise(monkeypatch, patched, tmp_path):
    with pytest.raises(ffmpeg_ops.FFmpegError):
        await concat_parts_uniform([], tmp_path / "final.mp4")


def test_platform_audio_target_is_single_sourced():
    """历史上 mux 用 48000 而 routes/assembly.py 用 44100,两个目标采样率并存。
    拼接与归一必须以单一常量为准。"""
    assert TARGET_AUDIO_SAMPLE_RATE == 48000
    assert TARGET_AUDIO_CHANNELS == 2
