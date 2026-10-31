"""LLM 剧本拆解测试:角色+分镜草稿解析、render_mode 建议、容错。"""
from __future__ import annotations

import json

import pytest

from app.services.studio import storyboard


@pytest.mark.asyncio
async def test_parse_script_ok(monkeypatch):
    payload = {
        "characters": [
            {"name": "楚生", "description": "落魄青年", "visual_prompt": "1boy, black hair, worn jacket"}
        ],
        "shots": [
            {"scene": "雨夜小巷", "prompt": "rainy alley, neon", "camera": "推镜",
             "dialogue": "我回来了。", "speaker": "楚生", "duration_sec": 6,
             "characters": ["楚生"], "render_mode": "video"},
            {"scene": "旧照片特写", "prompt": "old photo on table", "camera": "静止",
             "dialogue": "", "speaker": "", "duration_sec": 3,
             "characters": [], "render_mode": "image_motion"},
        ],
    }

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        assert layer == "L3"
        return {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    chars, shots = await storyboard.parse_script("一段雨夜重逢的故事", num_shots=8)
    assert chars[0].name == "楚生"
    assert len(shots) == 2
    assert shots[0].render_mode == "video"
    assert shots[1].render_mode == "image_motion"


@pytest.mark.asyncio
async def test_parse_script_bad_json(monkeypatch):
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        return {"role": "assistant", "content": "这不是 JSON"}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    with pytest.raises(storyboard.StoryboardError):
        await storyboard.parse_script("x", num_shots=4)


@pytest.mark.asyncio
async def test_parse_script_render_mode_fallback(monkeypatch):
    """LLM 未给 render_mode 或给非法值时,回退 video。"""
    payload = {"characters": [], "shots": [
        {"scene": "追逐", "prompt": "chase", "render_mode": "unknown_value"},
        {"scene": "空镜", "prompt": "sky"},
    ]}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        return {"role": "assistant", "content": json.dumps(payload)}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    _, shots = await storyboard.parse_script("x", num_shots=4)
    assert shots[0].render_mode == "video"  # 非法值回退
    assert shots[1].render_mode == "video"  # 缺省回退
