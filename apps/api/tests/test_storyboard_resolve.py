"""storyboard 指代消解后处理测试:LLM 受约束重写、拒收校验、确定性注入兜底。"""
from __future__ import annotations

import json

import pytest

from app.services.studio import storyboard
from app.services.studio.schemas import CharacterDraft, ShotDraft


def _characters():
    return [
        CharacterDraft(name="楚生", description="落魄青年", visual_prompt="1boy, black hair, worn jacket"),
        CharacterDraft(name="林晚", description="富家千金", visual_prompt="1girl, long hair, red dress"),
    ]


def _shot(prompt: str, chars: list[str]) -> ShotDraft:
    return ShotDraft(scene="雨夜", prompt=prompt, characters=chars, render_mode="video")


@pytest.mark.asyncio
async def test_resolve_no_pronouns_no_llm_call(monkeypatch):
    """无代词 → 不触发重写 LLM 调用。"""
    calls = []

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        calls.append(layer)
        return {"role": "assistant", "content": "{}"}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    shots = [_shot("楚生 walks into rainy alley, neon lights", ["楚生"])]
    await storyboard.resolve_references(_characters(), shots)
    assert calls == []
    assert shots[0].prompt == "楚生 walks into rainy alley, neon lights"


@pytest.mark.asyncio
async def test_resolve_llm_rewrite_applied(monkeypatch):
    """有未消解代词 → L2 层受约束重写被采纳。"""
    layers = []

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        layers.append(layer)
        return {
            "role": "assistant",
            "content": json.dumps({"rewrites": [
                {"index": 0, "prompt": "楚生, 1boy, black hair, worn jacket, walks into rainy alley"}
            ]}),
        }

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    shots = [_shot("he walks into the rainy alley", ["楚生"])]
    await storyboard.resolve_references(_characters(), shots)
    assert layers == ["L2"]
    assert "楚生" in shots[0].prompt and "he " not in shots[0].prompt + " "


@pytest.mark.asyncio
async def test_resolve_rejects_rewrite_still_with_pronoun(monkeypatch):
    """重写后仍含代词 → 拒收,走确定性注入兜底。"""
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        return {
            "role": "assistant",
            "content": json.dumps({"rewrites": [{"index": 0, "prompt": "he runs faster"}]}),
        }

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    shots = [_shot("he walks into the rainy alley", ["楚生"])]
    await storyboard.resolve_references(_characters(), shots)
    # 兜底注入:角色名+视觉 token 前缀
    assert shots[0].prompt.startswith("楚生 (1boy, black hair, worn jacket), ")
    assert "he walks" in shots[0].prompt  # 原 prompt 保留在注入前缀之后


@pytest.mark.asyncio
async def test_resolve_llm_failure_fallback_injection(monkeypatch):
    """LLM 不可用 → 确定性注入兜底,不抛异常。"""
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        raise storyboard.llm.LLMError("down")

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    shots = [_shot("she turns around slowly", ["林晚"])]
    await storyboard.resolve_references(_characters(), shots)
    assert shots[0].prompt.startswith("林晚 (1girl, long hair, red dress), ")


@pytest.mark.asyncio
async def test_parse_script_integrates_resolve(monkeypatch):
    """parse_script 全链路:L3 拆解产出含代词分镜 → L2 重写被应用。"""
    layers = []
    payload = {
        "characters": [
            {"name": "楚生", "description": "落魄青年", "visual_prompt": "1boy, worn jacket"}
        ],
        "shots": [
            {"scene": "雨夜", "prompt": "he walks alone in rain", "characters": ["楚生"],
             "render_mode": "video"},
        ],
    }

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        layers.append(layer)
        if layer == "L3":
            return {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)}
        return {"role": "assistant", "content": json.dumps({"rewrites": [
            {"index": 0, "prompt": "楚生, 1boy, worn jacket, walks alone in rain"}
        ]})}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    chars, shots = await storyboard.parse_script("雨夜独行", num_shots=4)
    assert layers == ["L3", "L2"]
    assert shots[0].prompt.startswith("楚生")
    assert chars[0].name == "楚生"
