"""novel_to_storyboard.py 与 storyboard_schema 单元测试。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import mock

import pytest

# 把 drama/scripts 加入路径（pytest 默认已在文件目录，但显式保证）
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from storyboard_schema import Character, NarrationCue, Shot, Storyboard
from novel_to_storyboard import (
    _build_user_prompt,
    _chunk_text,
    _extract_json,
    _merge_chunk_outputs,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def sample_storyboard() -> dict:
    return {
        "title": "测试短剧",
        "characters": [
            {
                "name": "林凡",
                "description": "黑发少年",
                "voice_tag": "youthful_male",
                "is_narrator": False,
            }
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
            }
        ],
        "narration": [
            {"start": 0, "end": 5, "speaker": "narrator", "text": "夜色如墨。"}
        ],
    }


# ---------------------------------------------------------------------------
# Schema 验证
# ---------------------------------------------------------------------------
def test_character_schema():
    c = Character(name="A", description="desc", voice_tag="v", is_narrator=True)
    assert c.name == "A"
    assert c.is_narrator is True


def test_shot_schema():
    s = Shot(
        id="s1_1",
        act=1,
        duration=5,
        type="action",
        description="desc",
        prompt="English prompt",
        motion_prompt="motion",
        characters=["A"],
        dialogue={"speaker": "A", "text": "hello"},
    )
    assert s.id == "s1_1"
    assert s.duration == 5
    assert s.dialogue.speaker == "A"


def test_narration_cue_end_after_start():
    with pytest.raises(ValueError):
        NarrationCue(start=5, end=5, speaker="narrator", text="x")


def test_storyboard_roundtrip(tmp_path: Path, sample_storyboard: dict):
    sb = Storyboard.from_dict(sample_storyboard)
    p = tmp_path / "sb.json"
    sb.to_json_file(p)
    loaded = Storyboard.from_json_file(p)
    assert loaded.title == sb.title
    assert len(loaded.shots) == len(sb.shots)


# ---------------------------------------------------------------------------
# Prompt 构造
# ---------------------------------------------------------------------------
def test_build_user_prompt_single_chunk():
    text = "小说片段"
    prompt = _build_user_prompt(text, max_shots=12, chunk_index=0, total_chunks=1)
    assert "小说片段" in prompt
    assert "12" in prompt
    assert "第 1/1 段" not in prompt  # 单段不显示上下文提示


def test_build_user_prompt_multi_chunk():
    text = "小说片段"
    prompt = _build_user_prompt(text, max_shots=12, chunk_index=1, total_chunks=3)
    assert "第 2/3 段" in prompt


# ---------------------------------------------------------------------------
# 文本分段
# ---------------------------------------------------------------------------
def test_chunk_text_short():
    assert _chunk_text("abc", chunk_size=2000) == ["abc"]


def test_chunk_text_long():
    text = "。".join([f"第{i}句" for i in range(1000)])
    chunks = _chunk_text(text, chunk_size=200, overlap=20)
    assert len(chunks) > 1
    for c in chunks:
        assert len(c) <= 200 + 50  # 允许在句号处略微超出


# ---------------------------------------------------------------------------
# JSON 提取
# ---------------------------------------------------------------------------
def test_extract_json_plain():
    raw = '{"title": "T", "shots": []}'
    assert _extract_json(raw) == {"title": "T", "shots": []}


def test_extract_json_markdown():
    raw = '```json\n{"title": "T", "shots": []}\n```'
    assert _extract_json(raw) == {"title": "T", "shots": []}


def test_extract_json_with_prefix():
    raw = 'Here is the result:\n```json\n{"title": "T"}\n```'
    assert _extract_json(raw) == {"title": "T"}


# ---------------------------------------------------------------------------
# 多段合并
# ---------------------------------------------------------------------------
def test_merge_chunk_outputs_basic():
    chunk1 = {
        "title": "C1",
        "characters": [{"name": "A", "description": "a"}],
        "shots": [{"duration": 5, "prompt": "p1", "negative": ""}],
        "narration": [{"start": 0, "end": 5, "speaker": "narrator", "text": "x"}],
    }
    merged = _merge_chunk_outputs([chunk1], max_shots=5)
    assert merged["title"] == "C1"
    assert len(merged["shots"]) == 1
    assert merged["shots"][0]["id"] == "s1_1"
    assert merged["narration"][0]["start"] == 0


def test_merge_chunk_outputs_multi_chunk():
    chunk1 = {
        "title": "C1",
        "characters": [{"name": "A", "description": "a"}],
        "shots": [{"duration": 5, "prompt": "p1", "negative": ""}],
        "narration": [{"start": 0, "end": 5, "speaker": "narrator", "text": "x"}],
    }
    chunk2 = {
        "title": "C2",
        "characters": [{"name": "B", "description": "b"}],
        "shots": [{"duration": 4, "prompt": "p2", "negative": ""}],
        "narration": [{"start": 0, "end": 4, "speaker": "narrator", "text": "y"}],
    }
    merged = _merge_chunk_outputs([chunk1, chunk2], max_shots=10)
    assert len(merged["characters"]) == 2
    assert len(merged["shots"]) == 2
    assert merged["shots"][1]["start"] == 5
    assert merged["narration"][1]["start"] == 5


def test_merge_chunk_outputs_respects_max_shots():
    chunk = {
        "title": "C",
        "characters": [],
        "shots": [{"duration": 5, "prompt": "p", "negative": ""} for _ in range(10)],
        "narration": [],
    }
    merged = _merge_chunk_outputs([chunk], max_shots=3)
    assert len(merged["shots"]) == 3


# ---------------------------------------------------------------------------
# JSON 加载回退（config.load_storyboard）
# ---------------------------------------------------------------------------
def test_load_storyboard_success(tmp_path: Path, sample_storyboard: dict):
    from config import load_storyboard

    p = tmp_path / "storyboard.json"
    p.write_text(json.dumps(sample_storyboard), encoding="utf-8")
    data = load_storyboard(p)
    assert data["title"] == "测试短剧"
    assert len(data["shots"]) == 1


def test_load_storyboard_missing_file():
    from config import load_storyboard

    assert load_storyboard(Path("/nonexistent/storyboard.json")) is None


def test_load_storyboard_invalid_json(tmp_path: Path):
    from config import load_storyboard

    p = tmp_path / "bad.json"
    p.write_text("not json", encoding="utf-8")
    assert load_storyboard(p) is None


def test_load_storyboard_bad_shape(tmp_path: Path):
    from config import load_storyboard

    p = tmp_path / "bad_shape.json"
    p.write_text(json.dumps({"title": "x", "shots": "not-list"}), encoding="utf-8")
    assert load_storyboard(p) is None


# ---------------------------------------------------------------------------
# 端到端 mock：验证 novel_to_storyboard 主流程
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_novel_to_storyboard_mocked(tmp_path: Path):
    from novel_to_storyboard import novel_to_storyboard

    llm_response = {
        "title": "Mock Drama",
        "characters": [
            {"name": "Hero", "description": "A hero", "voice_tag": "male", "is_narrator": False}
        ],
        "shots": [
            {
                "id": "s1_1",
                "act": 1,
                "duration": 5,
                "type": "scene",
                "description": "A scene",
                "prompt": "English visual prompt",
                "motion_prompt": "motion",
                "characters": ["Hero"],
                "dialogue": None,
                "negative": "blurry",
            }
        ],
        "narration": [{"start": 0, "end": 5, "speaker": "narrator", "text": "Hello"}],
    }

    with mock.patch(
        "novel_to_storyboard._call_llm_http",
        return_value={"content": json.dumps(llm_response, ensure_ascii=False)},
    ):
        result = await novel_to_storyboard(
            "A short novel text.",
            max_shots=10,
            save=False,
        )

    assert result["title"] == "Mock Drama"
    assert len(result["shots"]) == 1
    assert result["shots"][0]["prompt"] == "English visual prompt"
    assert len(result["characters"]) == 1
    assert len(result["narration"]) == 1
