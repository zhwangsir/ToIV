"""orchestrator.py 与 M5 视觉质量门单元测试。"""
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

import generate_v2 as g2
import orchestrator as orch
import quality_gates as qg


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def sample_storyboard() -> dict:
    return {
        "title": "测试短剧",
        "characters": [
            {"name": "林凡", "description": "黑发少年", "voice_tag": "youthful_male", "is_narrator": False},
        ],
        "shots": [
            {
                "id": "s1_1", "act": 1, "duration": 5, "type": "scene",
                "description": "夜色山路",
                "prompt": "A boy walks on a mountain path at night",
                "motion_prompt": "slow tracking shot",
                "characters": ["林凡"], "dialogue": None, "negative": "blurry",
            },
        ],
        "narration": [
            {"start": 0, "end": 5, "speaker": "narrator", "text": "夜色如墨。"},
        ],
    }


@pytest.fixture
def novel_file(tmp_path: Path) -> Path:
    p = tmp_path / "novel.txt"
    p.write_text("夜色如墨，少年林凡背着药篓走在回家的山路上。", encoding="utf-8")
    return p


def _mock_stages(sample_storyboard: dict, tmp_path: Path):
    """返回一组 patch，替换 orchestrator 各阶段内的重量级调用。"""
    kf = tmp_path / "kf.png"
    clip = tmp_path / "clip.mp4"
    final = tmp_path / "final_v2.mp4"
    return (
        mock.patch("orchestrator.g2.novel_to_storyboard", return_value=sample_storyboard),
        mock.patch("orchestrator.g2._generate_character_keyframes", return_value={}),
        mock.patch("orchestrator.g2._generate_keyframe", return_value=kf),
        mock.patch("orchestrator.g2._generate_video_for_shot", return_value=clip),
        mock.patch("orchestrator.g2._generate_audio", return_value=[]),
        mock.patch("orchestrator.g2._build_subtitle_ass"),
        mock.patch("orchestrator.g2._concat_and_mux", return_value=final),
        mock.patch("orchestrator.qg.check_video", return_value=None),
        mock.patch("orchestrator.qg.check_final", return_value=None),
        mock.patch("orchestrator.qg.check_keyframe", return_value=None),
        mock.patch("orchestrator.qg.check_blur", return_value=None),
    )


def _enter(patches):
    """启动一组 patch 的上下文管理器（替代超长 with 语句）。"""
    import contextlib

    @contextlib.contextmanager
    def _cm():
        for p in patches:
            p.start()
        try:
            yield
        finally:
            for p in reversed(patches):
                p.stop()

    return _cm()


# ---------------------------------------------------------------------------
# 状态持久化
# ---------------------------------------------------------------------------
def test_state_save_load(tmp_path: Path):
    st = orch.PipelineState(tmp_path)
    st.mark("storyboard", "running")
    st.mark("storyboard", "done")
    st.approve("storyboard")

    loaded = orch.PipelineState.load(tmp_path)
    assert loaded.status("storyboard") == "done"
    assert loaded.approved("storyboard")
    assert loaded.status("final") == "pending"
    assert loaded.data["stages"]["storyboard"]["finished_at"] is not None


def test_state_load_corrupted(tmp_path: Path):
    (tmp_path / orch.STATE_FILE).write_text("{invalid json", encoding="utf-8")
    st = orch.PipelineState.load(tmp_path)
    # 损坏时回退到全新状态
    assert st.status("storyboard") == "pending"


# ---------------------------------------------------------------------------
# 全自动模式
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_auto_full_pipeline(novel_file, sample_storyboard, tmp_path):
    out = tmp_path / "proj"
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        result = await orch.run_pipeline(novel_file, out, review_after_stage=False)

    assert result["status"] == "done"
    state = orch.PipelineState.load(out)
    # 未开 4K 时 upscale 阶段保持 pending 且不执行
    assert state.status("storyboard") == "done"
    assert state.status("shots") == "done"
    assert state.status("upscale") == "pending"
    assert state.status("final") == "done"
    # project.json 已生成
    assert (out / "project.json").exists()


# ---------------------------------------------------------------------------
# 审核门控模式：暂停 → 拒绝未审核继续 → 审核通过继续
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_review_pauses_after_first_stage(novel_file, sample_storyboard, tmp_path):
    out = tmp_path / "proj"
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        result = await orch.run_pipeline(novel_file, out, review_after_stage=True)

    assert result["status"] == "awaiting_review"
    assert result["stage"] == "storyboard"
    state = orch.PipelineState.load(out)
    assert state.status("storyboard") == "awaiting_review"
    assert state.status("characters") == "pending"


@pytest.mark.asyncio
async def test_review_continue_without_approve_blocked(novel_file, sample_storyboard, tmp_path):
    out = tmp_path / "proj"
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        await orch.run_pipeline(novel_file, out, review_after_stage=True)
        # 未 approve 直接 continue：仍停在 storyboard
        result = await orch.run_pipeline(
            novel_file, out, review_after_stage=True, resume=True
        )
    assert result["status"] == "awaiting_review"
    assert result["stage"] == "storyboard"


@pytest.mark.asyncio
async def test_review_approve_advances_to_next_stage(novel_file, sample_storyboard, tmp_path):
    out = tmp_path / "proj"
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        await orch.run_pipeline(novel_file, out, review_after_stage=True)
        result = await orch.run_pipeline(
            novel_file, out, review_after_stage=True, resume=True, approve="storyboard"
        )

    # storyboard 通过审核后，应跑到 characters 阶段再暂停
    assert result["status"] == "awaiting_review"
    assert result["stage"] == "characters"
    state = orch.PipelineState.load(out)
    assert state.status("storyboard") == "done"
    assert state.approved("storyboard")


@pytest.mark.asyncio
async def test_approve_wrong_stage_fails(novel_file, sample_storyboard, tmp_path):
    out = tmp_path / "proj"
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        await orch.run_pipeline(novel_file, out, review_after_stage=True)
        result = await orch.run_pipeline(
            novel_file, out, review_after_stage=True, resume=True, approve="final"
        )
    assert result["status"] == "failed"
    assert "final" in result["error"]


@pytest.mark.asyncio
async def test_review_full_approval_chain(novel_file, sample_storyboard, tmp_path):
    """逐阶段审核直至完成。"""
    out = tmp_path / "proj"
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        result = await orch.run_pipeline(novel_file, out, review_after_stage=True)
        # 无 4K 时阶段序列不含 upscale
        for stage in ["storyboard", "characters", "shots", "audio", "final"]:
            assert result["status"] == "awaiting_review"
            assert result["stage"] == stage
            result = await orch.run_pipeline(
                novel_file, out, review_after_stage=True, resume=True, approve=stage
            )
    assert result["status"] == "done"


# ---------------------------------------------------------------------------
# 质量门失败路径
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_gate_failure_marks_stage_failed(novel_file, sample_storyboard, tmp_path):
    out = tmp_path / "proj"
    bad_storyboard = dict(sample_storyboard)
    bad_storyboard["title"] = ""  # 触发 check_storyboard 错误
    patches = _mock_stages(bad_storyboard, tmp_path)
    with _enter(patches):
        result = await orch.run_pipeline(novel_file, out)

    assert result["status"] == "failed"
    assert result["stage"] == "storyboard"
    assert result["gate_errors"]
    state = orch.PipelineState.load(out)
    assert state.status("storyboard") == "failed"


@pytest.mark.asyncio
async def test_failed_stage_reruns_on_continue(novel_file, sample_storyboard, tmp_path):
    """失败阶段修复后 --continue 应重跑该阶段。"""
    out = tmp_path / "proj"
    bad = dict(sample_storyboard)
    bad["title"] = ""
    patches = _mock_stages(bad, tmp_path)
    with _enter(patches):
        result = await orch.run_pipeline(novel_file, out)
    assert result["status"] == "failed"

    # 修复后重跑：storyboard 阶段重新执行并通过
    patches = _mock_stages(sample_storyboard, tmp_path)
    with _enter(patches):
        result = await orch.run_pipeline(novel_file, out, resume=True)
    assert result["status"] == "done"


# ---------------------------------------------------------------------------
# shots 阶段视觉质量门
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_shots_stage_blur_gate(novel_file, sample_storyboard, tmp_path):
    """关键帧模糊时 shots 阶段质量门报错。"""
    out = tmp_path / "proj"
    kf = tmp_path / "kf.png"
    clip = tmp_path / "clip.mp4"
    with (
        mock.patch("orchestrator.g2.novel_to_storyboard", return_value=sample_storyboard),
        mock.patch("orchestrator.g2._generate_character_keyframes", return_value={}),
        mock.patch("orchestrator.g2._generate_keyframe", return_value=kf),
        mock.patch("orchestrator.g2._generate_video_for_shot", return_value=clip),
        mock.patch("orchestrator.g2._generate_audio", return_value=[]),
        mock.patch("orchestrator.g2._build_subtitle_ass"),
        mock.patch("orchestrator.g2._concat_and_mux", return_value=tmp_path / "f.mp4"),
        mock.patch("orchestrator.qg.check_keyframe", return_value=None),
        mock.patch("orchestrator.qg.check_blur", return_value="图像模糊(Laplacian 方差 12.0 < 100.0)"),
        mock.patch("orchestrator.qg.check_video", return_value=None),
        mock.patch("orchestrator.qg.check_final", return_value=None),
    ):
        result = await orch.run_pipeline(novel_file, out)

    assert result["status"] == "failed"
    assert result["stage"] == "shots"
    assert any("模糊" in e for e in result["gate_errors"])


# ---------------------------------------------------------------------------
# upscale 阶段
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_upscale_stage_rewrites_video_file(novel_file, sample_storyboard, tmp_path):
    """4K 模式下 upscale 阶段执行并把 video_file 改写为 4K 片段。"""
    out = tmp_path / "proj"
    kf = tmp_path / "kf.png"
    clip = tmp_path / "clip.mp4"

    def _fake_upscale(src, dst):
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(b"fake4k")
        return dst

    captured: dict = {}

    def _fake_concat(shots, narration, audio_dir, final_dir, target_4k):
        captured["shots"] = [dict(s) for s in shots]
        return tmp_path / "final_4k.mp4"

    async def _fake_video(shot, keyframe, shots_dir, characters=None):
        clip.parent.mkdir(parents=True, exist_ok=True)
        clip.write_bytes(b"fakeclip")
        shot["video_file"] = str(clip)
        return clip

    with (
        mock.patch("orchestrator.g2.novel_to_storyboard", return_value=sample_storyboard),
        mock.patch("orchestrator.g2._generate_character_keyframes", return_value={}),
        mock.patch("orchestrator.g2._generate_keyframe", return_value=kf),
        mock.patch("orchestrator.g2._generate_video_for_shot", side_effect=_fake_video),
        mock.patch("orchestrator.g2._generate_audio", return_value=[]),
        mock.patch("orchestrator.g2._build_subtitle_ass"),
        mock.patch("orchestrator.g2._concat_and_mux", side_effect=_fake_concat),
        mock.patch("orchestrator.qg.check_keyframe", return_value=None),
        mock.patch("orchestrator.qg.check_blur", return_value=None),
        mock.patch("orchestrator.qg.check_video", return_value=None),
        mock.patch("orchestrator.qg.check_resolution", return_value=None),
        mock.patch("orchestrator.qg.check_final", return_value=None),
        mock.patch("orchestrator._upscale_clip", side_effect=_fake_upscale),
    ):
        result = await orch.run_pipeline(novel_file, out, target_4k=True)

    assert result["status"] == "done"
    state = orch.PipelineState.load(out)
    assert state.status("upscale") == "done"
    # 拼接拿到的 video_file 应指向 clip_4k.mp4
    vf = captured["shots"][0]["video_file"]
    assert vf.endswith("clip_4k.mp4")


# ---------------------------------------------------------------------------
# M5 视觉质量门函数
# ---------------------------------------------------------------------------
def _make_pil_image(path: Path, size=(64, 64), sharp: bool = True) -> Path:
    from PIL import Image, ImageDraw, ImageFilter

    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    for i in range(0, size[0], 4):
        d.line([(i, 0), (i, size[1])], fill="black")
    if not sharp:
        img = img.filter(ImageFilter.GaussianBlur(radius=8))
    img.save(path)
    return path


def test_blur_score_sharp_vs_blurred(tmp_path: Path):
    sharp = _make_pil_image(tmp_path / "sharp.png", sharp=True)
    blurred = _make_pil_image(tmp_path / "blurred.png", sharp=False)
    s_sharp = qg.blur_score(sharp)
    s_blur = qg.blur_score(blurred)
    assert s_sharp is not None and s_blur is not None
    assert s_sharp > s_blur
    assert qg.check_blur(sharp) is None
    assert qg.check_blur(blurred, threshold=50.0) is not None


def test_blur_missing_file():
    assert qg.check_blur(Path("/nonexistent.png")) is not None


def test_check_resolution_image(tmp_path: Path):
    big = _make_pil_image(tmp_path / "big.png", size=(2000, 1200))
    small = _make_pil_image(tmp_path / "small.png", size=(800, 600))
    assert qg.check_resolution(big, 1024, 1024) is None
    err = qg.check_resolution(small, 1024, 1024)
    assert err is not None and "800" in err


def test_check_resolution_video(tmp_path: Path):
    video = tmp_path / "v.mp4"
    g2._make_test_video(video, {"id": "s", "duration": 1})  # 832×480
    assert qg.check_resolution(video, 800, 400) is None
    assert qg.check_resolution(video, 1024, 1024) is not None


def _fake_requests_module(post_side_effect=None, post_return=None):
    """构造一个假的 requests 模块（本机可能未安装 requests）。"""
    fake = mock.MagicMock()
    if post_side_effect is not None:
        fake.post.side_effect = post_side_effect
    else:
        fake.post.return_value = post_return
    return fake


def _vlm_response(answer: str):
    resp = mock.Mock()
    resp.json.return_value = {"prompt": answer}
    resp.raise_for_status = lambda: None
    return resp


def test_character_consistency_vlm_yes(tmp_path: Path):
    a = _make_pil_image(tmp_path / "a.png")
    b = _make_pil_image(tmp_path / "b.png")
    fake = _fake_requests_module(
        post_return=_vlm_response("Consistent: yes. Reason: same face and hair.")
    )
    with mock.patch.dict(sys.modules, {"requests": fake}):
        assert qg.check_character_consistency(a, b, vlm_url="http://fake/v1/reverse") is None


def test_character_consistency_vlm_no(tmp_path: Path):
    a = _make_pil_image(tmp_path / "a.png")
    b = _make_pil_image(tmp_path / "b.png")
    fake = _fake_requests_module(
        post_return=_vlm_response("Consistent: no. Reason: different clothing.")
    )
    with mock.patch.dict(sys.modules, {"requests": fake}):
        err = qg.check_character_consistency(a, b, vlm_url="http://fake/v1/reverse")
    assert err is not None and "不一致" in err


def test_character_consistency_vlm_unreachable_soft(tmp_path: Path):
    a = _make_pil_image(tmp_path / "a.png")
    b = _make_pil_image(tmp_path / "b.png")
    fake = _fake_requests_module(post_side_effect=ConnectionError("refused"))
    with mock.patch.dict(sys.modules, {"requests": fake}):
        # 默认软通过
        assert qg.check_character_consistency(a, b, vlm_url="http://fake/v1/reverse") is None
        # strict 模式报错
        assert qg.check_character_consistency(
            a, b, vlm_url="http://fake/v1/reverse", strict=True
        ) is not None


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _make_wav(path: Path, duration_sec: float = 1.0, sample_rate: int = 24000):
    path.parent.mkdir(parents=True, exist_ok=True)
    num_frames = int(duration_sec * sample_rate)
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(b"\x00" * (num_frames * 2))
