"""L2 质量门决策层 — 打分 → 三态决策(直通/带评语重生成/升级人工)。

设计依据(docs/2026-08-13-competitive-research-roadmap.md 方向五):
双阈值三态漏斗——≥τ_high 直通;τ_low~τ_high 带评语重生成(best-of-K,≤N 轮);
<τ_low 或重试耗竭 → 升级人工。打分器不可用时一律降级直通(不阻塞主流程),
与 scoring.py 的容错策略一致。
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from enum import Enum

from app.agent import llm
from app.scoring import (
    ScoreResult,
    Scorer,
    ScorerUnavailable,
    ScoringService,
    get_scoring_service,
)

logger = logging.getLogger(__name__)


class QualityDecision(str, Enum):
    """三态决策。"""

    PASS = "pass"  # ≥τ_high 直通
    REGENERATE = "regenerate"  # 中间带,带评语重生成
    ESCALATE = "escalate"  # <τ_low 或重试耗竭,升级人工


@dataclass
class Thresholds:
    """质量门阈值。环境变量:TOIV_QUALITY_TAU_HIGH / TAU_LOW / MAX_ATTEMPTS。"""

    tau_high: float = 0.65
    tau_low: float = 0.40
    max_attempts: int = 2

    @classmethod
    def from_env(cls) -> "Thresholds":
        def _f(key: str, default: float) -> float:
            try:
                return float(os.environ.get(key, "") or default)
            except ValueError:
                return default

        def _i(key: str, default: int) -> int:
            try:
                return int(os.environ.get(key, "") or default)
            except ValueError:
                return default

        return cls(
            tau_high=_f("TOIV_QUALITY_TAU_HIGH", 0.65),
            tau_low=_f("TOIV_QUALITY_TAU_LOW", 0.40),
            max_attempts=_i("TOIV_QUALITY_MAX_ATTEMPTS", 2),
        )


def decide(score: float, attempt: int, th: Thresholds) -> QualityDecision:
    """三态判定。attempt 为已重生成次数(0=首次产出)。"""
    if score >= th.tau_high:
        return QualityDecision.PASS
    if score < th.tau_low or attempt >= th.max_attempts:
        return QualityDecision.ESCALATE
    return QualityDecision.REGENERATE


@dataclass
class GateResult:
    """质量门结果。score=None 表示打分器降级(此时 decision 恒为 PASS)。"""

    decision: QualityDecision
    score: float | None = None
    critique: str | None = None
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "decision": self.decision.value,
            "score": self.score,
            "critique": self.critique,
            "note": self.note,
        }


async def evaluate_image(
    image_url: str,
    prompt: str | None = None,
    *,
    attempt: int = 0,
    scorer: Scorer | ScoringService | None = None,
    thresholds: Thresholds | None = None,
) -> GateResult:
    """图像质量门:ImageReward 系打分器 → 三态决策。

    打分器未安装/不可用 → 降级直通(note=scorer_unavailable),不阻塞生成主流程。
    """
    th = thresholds or Thresholds.from_env()
    svc = scorer or get_scoring_service()
    try:
        res: ScoreResult = await svc.score(image_url, prompt)
    except ScorerUnavailable as e:
        logger.info("evaluate_image 降级直通:%s", e)
        return GateResult(QualityDecision.PASS, note=f"scorer_unavailable:{e}")
    return GateResult(
        decision=decide(res.total, attempt, th),
        score=res.total,
        critique=res.critique,
    )


# ── 文案忠实度门(L2 文本)─────────────────────────────────────────────────

_FAITH_SYSTEM = """你是文案质检员。判定「产出文案」是否忠实于「原始需求」。
只输出 JSON:{"faithfulness": 0.0-1.0, "issues": ["中文问题描述"]}
评分锚点:1.0=完全忠实无编造;0.7=基本忠实有少量发挥;0.4=明显偏离或遗漏关键要求;0.0=编造/跑题。"""


def _extract_json(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


async def evaluate_text_faithfulness(
    premise: str,
    output_text: str,
    *,
    attempt: int = 0,
    thresholds: Thresholds | None = None,
) -> GateResult:
    """文案忠实度门(L2):LLM rubric 打分 → 三态决策。

    LLM 不可用/返回不可解析 → 降级直通(note=judge_unavailable)。
    """
    th = thresholds or Thresholds.from_env()
    try:
        msg = await llm.chat_layered(
            [
                {"role": "system", "content": _FAITH_SYSTEM},
                {
                    "role": "user",
                    "content": f"原始需求:\n{premise}\n\n产出文案:\n{output_text}",
                },
            ],
            layer="L2",
            max_tokens=1000,
        )
    except llm.LLMError as e:
        logger.info("evaluate_text_faithfulness 降级直通:%s", e)
        return GateResult(QualityDecision.PASS, note=f"judge_unavailable:{e}")

    obj = _extract_json((msg.get("content") or "").strip())
    if not obj:
        return GateResult(QualityDecision.PASS, note="judge_unavailable:unparseable")
    try:
        score = max(0.0, min(1.0, float(obj.get("faithfulness"))))
    except (ValueError, TypeError):
        return GateResult(QualityDecision.PASS, note="judge_unavailable:no_score")
    issues = obj.get("issues")
    critique = ";".join(str(i) for i in issues) if isinstance(issues, list) else None
    return GateResult(
        decision=decide(score, attempt, th),
        score=score,
        critique=critique,
    )
