"""character_keyframes.py 单元测试。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# 确保能导入同级模块
sys.path.insert(0, str(Path(__file__).parent))

from character_keyframes import (
    _build_pose_prompt,
    _safe_name,
    _VALID_POSES,
    build_shot_keyframe_prompt,
    generate_character_keyframes,
    get_character_keyframe,
)


SAMPLE_CHARACTER = {
    "name": "林凡",
    "description": "年轻山村少年，黑发朴素衣衫，眼神坚毅好奇，背负药篓",
}

SAMPLE_SHOT = {
    "id": "s1_3",
    "prompt": "The young boy looks up in shock, then runs urgently toward the smoky valley, night forest, dynamic motion, fantasy style",
    "characters": ["林凡"],
}

SAMPLE_CHARACTERS = [SAMPLE_CHARACTER, {"name": "旁白", "description": "沉稳叙事者", "is_narrator": True}]


class TestSafeName:
    def test_chinese_name(self):
        assert _safe_name("林凡") == "lin_fan"

    def test_mixed_name(self):
        assert _safe_name("Goku (悟空)") == "goku_wu_kong"

    def test_leading_trailing_punctuation(self):
        assert _safe_name("--Vegeta!!") == "vegeta"

    def test_empty_fallback(self):
        assert _safe_name("!!!") == "character"


class TestBuildPosePrompt:
    def test_valid_poses(self):
        desc = "young boy, black hair"
        for pose in _VALID_POSES:
            prompt = _build_pose_prompt(desc, pose)
            assert desc in prompt
            assert "masterpiece" in prompt

    def test_invalid_pose(self):
        with pytest.raises(ValueError, match="未知姿态"):
            _build_pose_prompt("desc", "invalid_pose")


class TestBuildShotKeyframePrompt:
    def test_injects_character_description(self):
        prompt = build_shot_keyframe_prompt(SAMPLE_SHOT, SAMPLE_CHARACTERS)
        assert "The young boy looks up in shock" in prompt
        assert "年轻山村少年" in prompt
        assert "masterpiece" in prompt

    def test_no_characters(self):
        shot = {"id": "s1_2", "prompt": "meteor falls", "characters": []}
        prompt = build_shot_keyframe_prompt(shot, SAMPLE_CHARACTERS)
        assert "meteor falls" in prompt
        assert "featuring" not in prompt

    def test_missing_character_in_list(self):
        shot = {"id": "sX", "prompt": "scene", "characters": ["不存在角色"]}
        prompt = build_shot_keyframe_prompt(shot, SAMPLE_CHARACTERS)
        assert "scene" in prompt
        assert "不存在角色" not in prompt


class TestGetCharacterKeyframe:
    def test_existing(self, tmp_path):
        project_dir = tmp_path / "project"
        char_dir = project_dir / "output" / "characters" / "lin_fan"
        char_dir.mkdir(parents=True)
        (char_dir / "portrait_front.png").write_text("png")
        path = get_character_keyframe("林凡", "portrait_front", project_dir)
        assert path.exists()
        assert path.name == "portrait_front.png"

    def test_missing(self, tmp_path):
        project_dir = tmp_path / "project"
        with pytest.raises(FileNotFoundError):
            get_character_keyframe("林凡", "portrait_front", project_dir)

    def test_invalid_pose(self, tmp_path):
        with pytest.raises(ValueError, match="未知姿态"):
            get_character_keyframe("林凡", "invalid", tmp_path)


class TestGenerateCharacterKeyframes:
    @pytest.mark.asyncio
    async def test_mock_flow(self, tmp_path):
        """mock 整个 core API 调用链,验证返回值结构。"""
        fake_token = "fake-token"

        def _fake_job(url, handle):
            prompt_id = handle["prompt_id"]
            return {
                "prompt_id": prompt_id,
                "status": "done",
                "results": [f"/api/images?filename={prompt_id}.png&worker=http%3A%2F%2F192.168.71.127%3A8189&type=output"],
            }

        with patch("character_keyframes._login", return_value=fake_token), \
             patch("character_keyframes._submit_txt2img") as mock_submit, \
             patch("character_keyframes._wait_for_job", side_effect=lambda pid, tok, **kw: _fake_job(None, {"prompt_id": pid})), \
             patch("character_keyframes._download_image") as mock_download:

            prompt_ids = []

            def _submit_side_effect(**kwargs):
                nonlocal prompt_ids
                pid = f"prompt-{len(prompt_ids)}"
                prompt_ids.append(pid)
                return {"prompt_id": pid, "worker": "http://192.168.71.127:8189"}

            mock_submit.side_effect = _submit_side_effect
            mock_download.return_value = tmp_path / "dummy.png"

            result = await generate_character_keyframes(
                SAMPLE_CHARACTER, tmp_path, token=fake_token
            )

        assert result["dir"].name.startswith("lin_fan")
        assert set(result["keyframes"].keys()) == _VALID_POSES
        for pose, info in result["keyframes"].items():
            assert info["path"] is not None
            assert info["seed"] is not None
            # prompt 里应包含角色外貌描述(中文描述原样注入)
            assert "年轻山村少年" in info["prompt"]
        assert mock_submit.call_count == 3
        assert mock_download.call_count == 3

    @pytest.mark.asyncio
    async def test_missing_description_raises(self, tmp_path):
        with pytest.raises(ValueError, match="缺少 description"):
            await generate_character_keyframes({"name": "无名"}, tmp_path, token="tok")


class TestPromptQuality:
    def test_prompt_sfw(self):
        for pose in _VALID_POSES:
            prompt = _build_pose_prompt(SAMPLE_CHARACTER["description"], pose)
            assert "nsfw" not in prompt.lower()
            assert "nude" not in prompt.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
