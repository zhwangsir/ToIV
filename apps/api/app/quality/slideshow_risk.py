"""防线 1: 幻灯片风险评分器。

6 维评分(0-5,越低越好),检测分镜脚本是否会产出"PPT 式"幻灯片内容。
评级: <2.0 strong / <3.0 acceptable / <4.0 revise / >=4.0 fail(不允许进入合成)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class RiskDimension:
    """单个风险维度的评分结果。"""
    name: str
    score: float  # 0-5,越低越好
    reasons: list[str] = field(default_factory=list)


@dataclass
class SlideshowRiskReport:
    """幻灯片风险报告。"""
    overall_score: float  # 6 维加权平均
    rating: str  # strong | acceptable | revise | fail
    dimensions: list[RiskDimension]
    recommendation: str = ""

    def to_dict(self) -> dict:
        return {
            "overall_score": round(self.overall_score, 2),
            "rating": self.rating,
            "dimensions": [
                {"name": d.name, "score": d.score, "reasons": d.reasons}
                for d in self.dimensions
            ],
            "recommendation": self.recommendation,
        }


# 通用化语言黑名单(懒惰措辞,使用就扣分)
_LAZY_PHRASES = {
    "beautiful", "modern", "cutting-edge", "stunning", "amazing",
    "incredible", "gorgeous", "breathtaking", "spectacular", "magnificent",
    "beautifully", "stunningly", "amazingly", "perfect", "perfectly",
    "high quality", "best quality", "masterpiece", "absurdres",  # danbooru 画质标签不在此列,只检 scene/description 叙述
}

# 拼贴/多格禁用词
_MONTAGE_TERMS = {
    "montage", "collage", "split screen", "multiple panels", "various scenes",
    "multi-panel", "grid", "comparison", "side by side", "before and after",
}


def _check_repetition(shots: list[dict]) -> RiskDimension:
    """维度 1: 重复性 — 检测分镜间描述/场景/运镜的重复。"""
    reasons = []
    if len(shots) < 2:
        return RiskDimension("repetition", 0.0, reasons)

    descriptions = [s.get("description", "").lower().strip() for s in shots]
    scenes = [s.get("scene", "").lower().strip() for s in shots]
    cameras = [s.get("camera", "").lower().strip() for s in shots]

    # 描述相似度(简单词集重叠)
    desc_sets = [set(d.replace(",", " ").split()) for d in descriptions]
    high_overlap = 0
    for i in range(len(desc_sets)):
        for j in range(i + 1, len(desc_sets)):
            if not desc_sets[i] or not desc_sets[j]:
                continue
            overlap = len(desc_sets[i] & desc_sets[j]) / max(
                len(desc_sets[i] | desc_sets[j]), 1
            )
            if overlap > 0.7:
                high_overlap += 1
                reasons.append(f"镜头{i+1}与{j+1}描述高度相似(重叠{overlap:.0%})")

    # 连续相同场景
    consec_scene = 0
    for i in range(1, len(scenes)):
        if scenes[i] and scenes[i] == scenes[i - 1]:
            consec_scene += 1
    if consec_scene >= 3:
        reasons.append(f"连续{consec_scene}镜使用相同场景")
    elif consec_scene >= 2:
        reasons.append(f"连续{consec_scene}镜场景相同,建议变化")

    # 连续相同运镜
    consec_cam = sum(
        1 for i in range(1, len(cameras)) if cameras[i] and cameras[i] == cameras[i - 1]
    )
    if consec_cam >= len(shots) * 0.5:
        reasons.append(f"超过半数镜头运镜相同({cameras[0]})")

    # 评分:高重叠越多分越高(越差)
    score = min(5.0, high_overlap * 1.5 + max(consec_scene - 2, 0) * 0.8 + max(consec_cam - 2, 0) * 0.5)
    return RiskDimension("repetition", score, reasons[:5])


def _check_decorative_visuals(shots: list[dict]) -> RiskDimension:
    """维度 2: 装饰性视觉 — 检测描述是否只是堆砌视觉标签而非叙事。"""
    reasons = []
    score = 0.0

    for i, s in enumerate(shots):
        desc = s.get("description", "").lower()
        dialogue = s.get("dialogue", "")

        # 纯画质标签堆砌(没有叙事元素)
        narrative_words = {"running", "walking", "sitting", "standing", "fighting",
                          "talking", "looking", "holding", "reaching", "falling",
                          "jumping", "turning", "pointing", "raising", "opening"}
        desc_words = set(desc.replace(",", " ").split())
        has_narrative = bool(desc_words & narrative_words)

        if not has_narrative and len(desc_words) > 10:
            score += 0.5
            if len(reasons) < 3:
                reasons.append(f"镜头{i+1}:描述偏重视觉标签,缺乏动作叙事")

        # 检查是否只是"角色+画质标签"没有实际内容
        if dialogue and not has_narrative:
            score += 0.3

    return RiskDimension("decorative_visuals", min(5.0, score), reasons[:5])


def _check_weak_motion(shots: list[dict]) -> RiskDimension:
    """维度 3: 弱运动 — 检测是否有足够运动提示词支撑视频生成。"""
    reasons = []
    static_count = 0
    motion_words = {"zoom", "pan", "tilt", "dolly", "tracking", "following",
                    "rotating", "pushing", "pulling", "close-up", "wide shot"}

    for i, s in enumerate(shots):
        camera = s.get("camera", "").lower()
        motion = s.get("motion", "").lower()
        combined = camera + " " + motion

        has_motion = any(w in combined for w in motion_words)
        if not has_motion and s.get("duration_sec", 3) >= 3:
            static_count += 1
            if len(reasons) < 3:
                reasons.append(f"镜头{i+1}:缺少运动/运镜提示,静态时长{s.get('duration_sec',3)}秒")

    score = min(5.0, static_count * 0.8)
    return RiskDimension("weak_motion", score, reasons[:5])


def _check_weak_shot_intent(shots: list[dict]) -> RiskDimension:
    """维度 4: 弱镜头意图 — 检测镜头是否有明确的叙事目的。"""
    reasons = []
    weak_count = 0

    for i, s in enumerate(shots):
        scene = s.get("scene", "").strip()
        dialogue = s.get("dialogue", "").strip()
        desc = s.get("description", "").strip()

        if not scene and not dialogue and len(desc) < 30:
            weak_count += 1
            if len(reasons) < 3:
                reasons.append(f"镜头{i+1}:缺少场景/台词/描述,镜头意图不明确")

    score = min(5.0, weak_count * 1.0)
    return RiskDimension("weak_shot_intent", score, reasons[:5])


def _check_typography_overreliance(shots: list[dict]) -> RiskDimension:
    """维度 5: 排版过度依赖 — 检测是否过度依赖文字/字幕而非视觉叙事。"""
    reasons = []
    text_heavy = 0

    for i, s in enumerate(shots):
        dialogue = s.get("dialogue", "")
        desc = s.get("description", "").lower()

        # 台词过长(>100 字符)且描述很短 → 依赖文字
        if len(dialogue) > 100 and len(desc) < 50:
            text_heavy += 1
            if len(reasons) < 3:
                reasons.append(f"镜头{i+1}:台词过长({len(dialogue)}字符)但视觉描述不足")

        # 检查是否用文字描述而非视觉标签
        if "text" in desc or "title" in desc or "subtitle" in desc or "caption" in desc:
            text_heavy += 0.5
            if len(reasons) < 3:
                reasons.append(f"镜头{i+1}:描述含文字/标题,依赖字幕叙事")

    score = min(5.0, text_heavy * 0.8)
    return RiskDimension("typography_overreliance", score, reasons[:5])


def _check_unsupported_cinematic_claims(shots: list[dict]) -> RiskDimension:
    """维度 6: 无支撑的电影感声明 — 检测是否用了电影术语但没有视觉支撑。"""
    reasons = []
    score = 0.0

    cinematic_terms = {
        "cinematic", "film noir", "widescreen", "letterbox",
        "depth of field", "bokeh", "anamorphic", "imax",
    }
    visual_support = {
        "close-up", "wide shot", "from above", "from below", "from side",
        "low angle", "high angle", "dutch angle", "over the shoulder",
    }

    for i, s in enumerate(shots):
        desc = s.get("description", "").lower()
        camera = s.get("camera", "").lower()
        combined = desc + " " + camera

        has_cinematic = bool(cinematic_terms & set(combined.split()))
        has_visual_support = bool(visual_support & set(combined.split()))

        if has_cinematic and not has_visual_support:
            score += 0.5
            if len(reasons) < 3:
                terms = cinematic_terms & set(combined.split())
                reasons.append(f"镜头{i+1}:使用了电影术语{terms}但缺少具体运镜支撑")

        # 检测拼贴禁用词
        montage_found = _MONTAGE_TERMS & set(combined.split())
        if montage_found:
            score += 2.0
            reasons.append(f"镜头{i+1}:使用了拼贴禁用词{montage_found}")

    return RiskDimension("unsupported_cinematic_claims", min(5.0, score), reasons[:5])


# 维度权重(总和 = 1.0)
_WEIGHTS = {
    "repetition": 0.20,
    "decorative_visuals": 0.15,
    "weak_motion": 0.20,
    "weak_shot_intent": 0.15,
    "typography_overreliance": 0.15,
    "unsupported_cinematic_claims": 0.15,
}


def evaluate_shots(shots: list[dict]) -> SlideshowRiskReport:
    """对分镜列表执行 6 维幻灯片风险评分。

    Args:
        shots: 分镜列表,每镜为 dict 含 scene/description/camera/dialogue/motion/duration_sec 等字段。

    Returns:
        SlideshowRiskReport 含总分、评级、各维度详情。
    """
    if not shots:
        return SlideshowRiskReport(
            overall_score=0.0,
            rating="strong",
            dimensions=[],
            recommendation="无分镜可评估",
        )

    dims = [
        _check_repetition(shots),
        _check_decorative_visuals(shots),
        _check_weak_motion(shots),
        _check_weak_shot_intent(shots),
        _check_typography_overreliance(shots),
        _check_unsupported_cinematic_claims(shots),
    ]

    overall = sum(d.score * _WEIGHTS.get(d.name, 0) for d in dims)

    if overall < 2.0:
        rating = "strong"
        recommendation = "分镜质量优秀,可进入下一阶段"
    elif overall < 3.0:
        rating = "acceptable"
        recommendation = "分镜质量可接受,有改进空间"
    elif overall < 4.0:
        rating = "revise"
        recommendation = "分镜存在幻灯片风险,建议修改后再出图"
    else:
        rating = "fail"
        recommendation = "分镜存在严重幻灯片风险,不允许进入合成阶段"

    return SlideshowRiskReport(
        overall_score=overall,
        rating=rating,
        dimensions=dims,
        recommendation=recommendation,
    )
