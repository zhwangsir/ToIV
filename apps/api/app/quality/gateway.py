"""质量防线统一入口 — 反 PPT 三重防线。

执行顺序:
1. slideshow_risk  — 幻灯片风险评分(rating >= fail 时阻断)
2. variation_checker — 场景变化检查(error 时阻断)
3. scene_pacing    — 场景节奏验证(error 时阻断)
"""
from __future__ import annotations

from dataclasses import dataclass

from app.quality.scene_pacing import ScenePacingReport, evaluate_pacing
from app.quality.slideshow_risk import SlideshowRiskReport, evaluate_shots
from app.quality.variation_checker import VariationReport, evaluate_variation


@dataclass
class QualityReport:
    """三重防线综合报告。"""
    passed: bool  # 三重防线全过 = True
    risk: SlideshowRiskReport
    variation: VariationReport
    pacing: ScenePacingReport
    blocking_reason: str = ""

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "blocking_reason": self.blocking_reason,
            "risk": self.risk.to_dict(),
            "variation": self.variation.to_dict(),
            "pacing": self.pacing.to_dict(),
        }


def run_quality_checks(shots: list[dict]) -> QualityReport:
    """对分镜列表执行三重防线质量检查。

    Args:
        shots: 分镜列表,每镜为 dict 含 scene/description/camera/dialogue/motion/duration_sec。

    Returns:
        QualityReport 含三重防线各自结果 + 综合是否通过。
    """
    risk = evaluate_shots(shots)
    variation = evaluate_variation(shots)
    pacing = evaluate_pacing(shots)

    blocking_reason = ""
    if risk.rating == "fail":
        blocking_reason = f"幻灯片风险评分{risk.overall_score:.1f}(>=4.0):{risk.recommendation}"
    elif not variation.passed:
        blocking_reason = f"场景变化检查未通过:{variation.error_count}个错误"
    elif not pacing.passed:
        blocking_reason = f"场景节奏验证未通过:{pacing.error_count}个错误"

    return QualityReport(
        passed=not blocking_reason,
        risk=risk,
        variation=variation,
        pacing=pacing,
        blocking_reason=blocking_reason,
    )
