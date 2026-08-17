"""generate_v2.py 与 quality_gates.py 单元测试。"""
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path
from unittest import mock

import pytest

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import quality_gates as qg
import generate_v2 as g2


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def sample_storyboard() -> dict:
    return {
        "title": "测试短剧",
        "characters": [
            {"name": "林凡", "description": "黑发少年", "voice_tag": "youthful_male", "is_narrator": False},
            {"name": "旁白", "description": "沉稳叙事者", "voice_tag": "narrator", "is_narrator": True},
        ],
        "shots": [
            {
                "id": "s1_1",
                "act": 1,
                "duration": 5,
                "type": "scene",
                "description": "夜色山路",
                "prompt": "A boy walks on a mountain path at night",
                "motion_prompt": "slow tracking shot",
                "characters": ["林凡"],
                "dialogue": None,
                "negative": "blurry",
            },
            {
                "id": "s1_2",
                "act": 1,
                "duration": 4,
                "type": "action",
                "description": "流星划过",
                "prompt": "A shooting star",
                "characters": [],
            },
        ],
        "narration": [
            {"start": 0, "end": 5, "speaker": "narrator", "text": "夜色如墨。"},
            {"start": 5, "end": 9, "speaker": "林凡", "text": "那是流星吗？"},
        ],
    }


@pytest.fixture
def tmp_project(tmp_path: Path) -> Path:
    """返回一个临时项目目录。"""
    return tmp_path / "project"


# ---------------------------------------------------------------------------
# quality_gates 测试
# ---------------------------------------------------------------------------
def test_check_storyboard_pass(sample_storyboard):
    errs = qg.check_storyboard(sample_storyboard)
    assert errs == []


def test_check_storyboard_missing_title():
    errs = qg.check_storyboard({"shots": [], "narration": [], "characters": []})
    assert any("title" in e for e in errs)


def test_check_storyboard_no_shots():
    errs = qg.check_storyboard({
        "title": "T", "characters": [{"name": "A"}], "shots": [], "narration": [],
    })
    assert any("shots" in e for e in errs)


def test_check_storyboard_bad_duration():
    data = {
        "title": "T", "characters": [{"name": "A"}],
        "shots": [{"id": "s1_1", "duration": 0, "prompt": "p"}],
        "narration": [],
    }
    errs = qg.check_storyboard(data)
    assert any("duration" in e for e in errs)


def test_check_storyboard_total_duration_too_long():
    data = {
        "title": "T", "characters": [{"name": "A"}],
        "shots": [{"id": f"s{i}", "duration": 60, "prompt": "p"} for i in range(6)],
        "narration": [],
    }
    errs = qg.check_storyboard(data)
    assert any("总时长" in e or "duration" in e for e in errs)


def test_check_keyframe_valid(tmp_path: Path):
    img = tmp_path / "frame.png"
    g2._make_test_image(img, 1024, 1024, label="test")
    err = qg.check_keyframe(img)
    assert err is None


def test_check_keyframe_too_small(tmp_path: Path):
    img = tmp_path / "small.png"
    g2._make_test_image(img, 512, 512, label="test")
    err = qg.check_keyframe(img)
    assert err is not None and "1024" in err


def test_check_keyframe_not_exists():
    err = qg.check_keyframe(Path("/nonexistent/path.png"))
    assert err is not None


def test_check_video_valid(tmp_path: Path):
    video = tmp_path / "clip.mp4"
    g2._make_test_video(video, {"id": "s1_1", "duration": 2})
    err = qg.check_video(video)
    assert err is None


def test_check_video_not_exists():
    err = qg.check_video(Path("/nonexistent/clip.mp4"))
    assert err is not None


def test_check_audio_valid(tmp_path: Path):
    wav = tmp_path / "audio.wav"
    _make_wav(wav, duration_sec=1.0)
    err = qg.check_audio(wav)
    assert err is None


def test_check_audio_wrong_sample_rate(tmp_path: Path):
    wav = tmp_path / "audio.wav"
    _make_wav(wav, duration_sec=1.0, sample_rate=8000)
    err = qg.check_audio(wav)
    assert err is not None and "22050" in err


def test_check_audio_not_exists():
    err = qg.check_audio(Path("/nonexistent/audio.wav"))
    assert err is not None


def test_check_final_valid(tmp_path: Path):
    video = tmp_path / "final.mp4"
    g2._make_test_video(video, {"id": "final", "duration": 2})
    err = qg.check_final(video, expected_resolution=(832, 480))
    assert err is None


def test_check_final_resolution_mismatch(tmp_path: Path):
    video = tmp_path / "final.mp4"
    g2._make_test_video(video, {"id": "final", "duration": 2})
    err = qg.check_final(video, expected_resolution=(1920, 1080))
    assert err is not None and "分辨率" in err


# ---------------------------------------------------------------------------
# generate_v2 主流程 mock 测试
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_main_stage_order(tmp_path: Path, sample_storyboard, tmp_project: Path):
    """验证 main 按正确顺序调用各阶段函数。"""
    novel_path = tmp_path / "novel.txt"
    novel_path.write_text("夜色如墨，少年林凡背着药篓走在回家的山路上。", encoding="utf-8")

    with (
        mock.patch("generate_v2.novel_to_storyboard", return_value=sample_storyboard) as mock_storyboard,
        mock.patch("generate_v2._generate_character_keyframes", return_value={"林凡": Path("/tmp/linfan.png")}) as mock_chars,
        mock.patch("generate_v2._generate_keyframe", return_value=Path("/tmp/keyframe.png")) as mock_keyframe,
        mock.patch("generate_v2._generate_video_for_shot", return_value=Path("/tmp/clip.mp4")) as mock_video,
        mock.patch("generate_v2._upscale_4k") as mock_upscale,
        mock.patch("generate_v2._generate_audio", return_value=[{"path": "/tmp/000.wav"}]) as mock_audio,
        mock.patch("generate_v2._concat_and_mux", return_value=Path("/tmp/final_v2.mp4")) as mock_mux,
    ):
        result = await g2.main(novel_path, tmp_project, target_4k=False, max_shots=2)

    # 各阶段应被调用
    mock_storyboard.assert_called_once()
    mock_chars.assert_called_once()
    assert mock_keyframe.call_count == len(sample_storyboard["shots"])
    assert mock_video.call_count == len(sample_storyboard["shots"])
    mock_upscale.assert_not_called()
    mock_audio.assert_called_once()
    mock_mux.assert_called_once()

    # 验证产物元数据
    assert result["artifacts"]["final_video"] == str(Path("/tmp/final_v2.mp4"))
    assert "project_json" in result["artifacts"]


@pytest.mark.asyncio
async def test_main_with_4k_upscale(tmp_path: Path, sample_storyboard, tmp_project: Path):
    """验证 target_4k=True 时每个片段调用 4K 超分。"""
    novel_path = tmp_path / "novel.txt"
    novel_path.write_text("test", encoding="utf-8")

    clips = [Path(f"/tmp/clip_{i}.mp4") for i in range(len(sample_storyboard["shots"]))]

    async def _fake_video(shot, keyframe, shots_dir, characters=None):
        return clips.pop(0)

    with (
        mock.patch("generate_v2.novel_to_storyboard", return_value=sample_storyboard),
        mock.patch("generate_v2._generate_character_keyframes", return_value={}),
        mock.patch("generate_v2._generate_keyframe", return_value=Path("/tmp/keyframe.png")),
        mock.patch("generate_v2._generate_video_for_shot", side_effect=_fake_video),
        mock.patch("generate_v2._upscale_4k") as mock_upscale,
        mock.patch("generate_v2._generate_audio", return_value=[]),
        mock.patch("generate_v2._concat_and_mux", return_value=Path("/tmp/final_v2_4k.mp4")),
    ):
        await g2.main(novel_path, tmp_project, target_4k=True, max_shots=2)

    assert mock_upscale.call_count == len(sample_storyboard["shots"])


@pytest.mark.asyncio
async def test_generate_video_for_shot_resume(tmp_path: Path):
    """断点续跑：已存在的 clip 直接返回，不调用真实生成。"""
    shot_dir = tmp_path / "s1_1"
    shot_dir.mkdir(parents=True, exist_ok=True)
    existing_clip = shot_dir / "clip.mp4"
    g2._make_test_video(existing_clip, {"id": "s1_1", "duration": 2})

    shot = {"id": "s1_1", "duration": 2}
    with (
        mock.patch("generate_v2._generate_video_h3") as mock_h3,
        mock.patch("generate_v2._generate_video_longcat") as mock_longcat,
        mock.patch("generate_v2._make_test_video") as mock_make,
    ):
        result = await g2._generate_video_for_shot(shot, Path("/tmp/keyframe.png"), tmp_path)

    assert result == existing_clip
    mock_h3.assert_not_called()
    mock_longcat.assert_not_called()
    mock_make.assert_not_called()


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------
def _make_wav(path: Path, duration_sec: float = 1.0, sample_rate: int = 24000):
    """生成一段静音 WAV。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    num_frames = int(duration_sec * sample_rate)
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(b"\x00" * (num_frames * 2))
