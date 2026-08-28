"""质量门决策层测试:三态判定矩阵、阈值环境变量、图像门/文案门降级与打分路径。"""
from __future__ import annotations

import json

import pytest

from app.quality import decision
from app.scoring import ScoreResult, ScorerUnavailable


class _FakeScorer:
    def __init__(self, total: float):
        self._total = total

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        return ScoreResult(total=self._total, breakdown={"aesthetic": self._total})


class _UnavailableScorer:
    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        raise ScorerUnavailable("not installed")


def _th() -> decision.Thresholds:
    return decision.Thresholds(tau_high=0.65, tau_low=0.40, max_attempts=2)


# ── decide 三态矩阵 ────────────────────────────────────────────────────────


def test_decide_pass_above_high():
    assert decision.decide(0.8, 0, _th()) == decision.QualityDecision.PASS
    assert decision.decide(0.65, 0, _th()) == decision.QualityDecision.PASS


def test_decide_regenerate_in_middle_band():
    assert decision.decide(0.5, 0, _th()) == decision.QualityDecision.REGENERATE
    assert decision.decide(0.4, 1, _th()) == decision.QualityDecision.REGENERATE


def test_decide_escalate_below_low_or_attempts_exhausted():
    assert decision.decide(0.2, 0, _th()) == decision.QualityDecision.ESCALATE
    assert decision.decide(0.5, 2, _th()) == decision.QualityDecision.ESCALATE


def test_thresholds_from_env(monkeypatch):
    monkeypatch.setenv("TOIV_QUALITY_TAU_HIGH", "0.8")
    monkeypatch.setenv("TOIV_QUALITY_TAU_LOW", "0.3")
    monkeypatch.setenv("TOIV_QUALITY_MAX_ATTEMPTS", "3")
    th = decision.Thresholds.from_env()
    assert th.tau_high == 0.8 and th.tau_low == 0.3 and th.max_attempts == 3
    monkeypatch.setenv("TOIV_QUALITY_TAU_HIGH", "not-a-float")
    assert decision.Thresholds.from_env().tau_high == 0.65  # 非法值 → 回退默认


# ── 图像质量门 ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_evaluate_image_scorer_unavailable_degrades_pass():
    res = await decision.evaluate_image("http://x/img.png", "p", scorer=_UnavailableScorer(), thresholds=_th())
    assert res.decision == decision.QualityDecision.PASS
    assert res.score is None
    assert "scorer_unavailable" in res.note


@pytest.mark.asyncio
async def test_evaluate_image_scored_paths():
    high = await decision.evaluate_image("u", "p", scorer=_FakeScorer(0.9), thresholds=_th())
    assert high.decision == decision.QualityDecision.PASS and high.score == 0.9

    mid = await decision.evaluate_image("u", "p", scorer=_FakeScorer(0.5), thresholds=_th())
    assert mid.decision == decision.QualityDecision.REGENERATE

    low = await decision.evaluate_image("u", "p", scorer=_FakeScorer(0.1), thresholds=_th())
    assert low.decision == decision.QualityDecision.ESCALATE


# ── 文案忠实度门 ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_text_faithfulness_scored(monkeypatch):
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        assert layer == "L2"
        return {"role": "assistant", "content": json.dumps(
            {"faithfulness": 0.5, "issues": ["遗漏了结尾要求"]})}

    monkeypatch.setattr(decision.llm, "chat_layered", fake_chat_layered)
    res = await decision.evaluate_text_faithfulness("需求", "产出", thresholds=_th())
    assert res.decision == decision.QualityDecision.REGENERATE
    assert res.score == 0.5 and res.critique == "遗漏了结尾要求"


@pytest.mark.asyncio
async def test_text_faithfulness_llm_down_degrades_pass(monkeypatch):
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        raise decision.llm.LLMError("down")

    monkeypatch.setattr(decision.llm, "chat_layered", fake_chat_layered)
    res = await decision.evaluate_text_faithfulness("需求", "产出", thresholds=_th())
    assert res.decision == decision.QualityDecision.PASS
    assert "judge_unavailable" in res.note


@pytest.mark.asyncio
async def test_text_faithfulness_bad_json_degrades_pass(monkeypatch):
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        return {"role": "assistant", "content": "无法评判"}

    monkeypatch.setattr(decision.llm, "chat_layered", fake_chat_layered)
    res = await decision.evaluate_text_faithfulness("需求", "产出", thresholds=_th())
    assert res.decision == decision.QualityDecision.PASS
    assert res.note.endswith("unparseable")


@pytest.mark.asyncio
async def test_text_faithfulness_score_clamped(monkeypatch):
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5, enable_thinking=None):
        return {"role": "assistant", "content": json.dumps({"faithfulness": 7.0, "issues": []})}

    monkeypatch.setattr(decision.llm, "chat_layered", fake_chat_layered)
    res = await decision.evaluate_text_faithfulness("需求", "产出", thresholds=_th())
    assert res.score == 1.0 and res.decision == decision.QualityDecision.PASS
