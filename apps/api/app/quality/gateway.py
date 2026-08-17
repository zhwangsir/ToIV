"""质量防线统一入口 — 反 PPT 三重防线 + 指代消解/转场链 advisory。

执行顺序:
1. slideshow_risk  — 幻灯片风险评分(rating >= fail 时阻断)
2. variation_checker — 场景变化检查(error 时阻断)
3. scene_pacing    — 场景节奏验证(error 时阻断)
4. coreference     — 指代消解检测(advisory,不阻断;供前端提示与 storyboard 后处理对照)
5. transition_chain — 转场链锚点连续性评估(R5.1 接入,advisory 不阻断;
   同步热路径只用确定性预检,不注入 LLM judge;无 seam 声明的分镜全链不计分)
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.quality.coreference import CorefReport, check_shots
from app.quality.scene_pacing import ScenePacingReport, evaluate_pacing
from app.quality.slideshow_risk import SlideshowRiskReport, evaluate_shots
from app.quality.transition_chain import score_transition_chain
from app.quality.variation_checker import VariationReport, evaluate_variation


@dataclass
class QualityReport:
    """三重防线综合报告 + 指代消解/转场链 advisory。"""

    passed: bool  # 三重防线全过 = True(coref/transitions 为 advisory 不参与)
    risk: SlideshowRiskReport
    variation: VariationReport
    pacing: ScenePacingReport
    coref: CorefReport
    blocking_reason: str = ""
    transitions: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "blocking_reason": self.blocking_reason,
            "risk": self.risk.to_dict(),
            "variation": self.variation.to_dict(),
            "pacing": self.pacing.to_dict(),
            "coref": self.coref.to_dict(),
            "transitions": self.transitions,
        }


def run_quality_checks(shots: list[dict]) -> QualityReport:
    """对分镜列表执行质量检查。

    Args:
        shots: 分镜列表,每镜为 dict 含 scene/description/camera/dialogue/motion/
               duration_sec;若含 characters 名单则指代检测以其为实体注册表。

    Returns:
        QualityReport 含三重防线结果 + 指代 advisory + 综合是否通过。
    """
    risk = evaluate_shots(shots)
    variation = evaluate_variation(shots)
    pacing = evaluate_pacing(shots)
    coref = check_shots(shots)
    # R5.1:转场链锚点连续性(advisory)。确定性预检零 LLM,热路径无额外开销;
    # 分镜无 seam 声明时全链不计分(anchor_match_rate=1.0),不影响既有调用方。
    transitions = score_transition_chain(shots)

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
        coref=coref,
        blocking_reason=blocking_reason,
        transitions=transitions,
    )
