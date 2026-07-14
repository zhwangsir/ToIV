"""防线 2: 场景变化检查器。

检测镜头尺寸单一性、连续相同镜头、通用化语言黑名单,确保分镜有足够的视觉变化。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class VariationIssue:
    """单个变化性问题。"""
    severity: str  # error | warning
    message: str
    shot_indices: list[int] = field(default_factory=list)


@dataclass
class VariationReport:
    """场景变化检查报告。"""
    passed: bool
    error_count: int
    warning_count: int
    issues: list[VariationIssue]
    shot_size_diversity: float  # 0-1, 越高越好
    lazy_phrase_count: int

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "issues": [
                {"severity": i.severity, "message": i.message, "shot_indices": i.shot_indices}
                for i in self.issues
            ],
            "shot_size_diversity": round(self.shot_size_diversity, 2),
            "lazy_phrase_count": self.lazy_phrase_count,
        }


# 构图尺寸关键词分类
_SHOT_SIZE_MAP = {
    "close-up": "close",
    "close up": "close",
    "特写": "close",
    "upper body": "medium",
    "半身": "medium",
    "medium shot": "medium",
    "full body": "full",
    "全身": "full",
    "wide shot": "wide",
    "全景": "wide",
    "far shot": "wide",
    "cowboy shot": "medium",
}

# 通用化语言黑名单(懒惰措辞)
_LAZY_PHRASES = {
    "beautiful", "modern", "cutting-edge", "stunning", "amazing",
    "incredible", "gorgeous", "breathtaking", "spectacular", "magnificent",
    "beautifully", "stunningly", "amazingly", "perfect", "perfectly",
    "very aesthetic", "highly detailed",
}


def _classify_shot_size(shot: dict) -> str:
    """从镜头描述/运镜中推断镜头尺寸类别。"""
    desc = (shot.get("description", "") + " " + shot.get("camera", "")).lower()
    for keyword, size in _SHOT_SIZE_MAP.items():
        if keyword in desc:
            return size
    return "unknown"


def _check_shot_size_diversity(shots: list[dict]) -> tuple[float, VariationIssue | None]:
    """检测镜头尺寸单一性。>50% 相同 = 违规。"""
    if not shots:
        return 1.0, None

    sizes = [_classify_shot_size(s) for s in shots]
    size_counts: dict[str, int] = {}
    for size in sizes:
        size_counts[size] = size_counts.get(size, 0) + 1

    total = len(sizes)
    max_ratio = max(size_counts.values()) / total

    diversity = 1.0 - max_ratio  # 0=完全单一, 1=完全分散

    if max_ratio > 0.6:
        dominant = max(size_counts, key=size_counts.get)
        issue = VariationIssue(
            severity="error",
            message=f"镜头尺寸过于单一:{dominant}占比{max_ratio:.0%}(超过60%阈值)",
            shot_indices=[i for i, s in enumerate(sizes) if s == dominant],
        )
        return diversity, issue
    elif max_ratio > 0.5:
        dominant = max(size_counts, key=size_counts.get)
        issue = VariationIssue(
            severity="warning",
            message=f"镜头尺寸偏单一:{dominant}占比{max_ratio:.0%}",
            shot_indices=[i for i, s in enumerate(sizes) if s == dominant],
        )
        return diversity, issue

    return diversity, None


def _check_consecutive_identical(shots: list[dict]) -> VariationIssue | None:
    """检测连续相同镜头(>=3 连续 = 违规, >=2 = 警告)。"""
    if len(shots) < 2:
        return None

    consecutive = 1
    max_consecutive = 1
    start_idx = 0

    for i in range(1, len(shots)):
        desc_prev = shots[i - 1].get("description", "").lower().strip()
        desc_curr = shots[i].get("description", "").lower().strip()
        if desc_prev and desc_prev == desc_curr:
            consecutive += 1
            max_consecutive = max(max_consecutive, consecutive)
        else:
            consecutive = 1

    if max_consecutive >= 3:
        return VariationIssue(
            severity="error",
            message=f"连续{max_consecutive}镜描述完全相同,严重缺乏变化",
        )
    elif max_consecutive >= 2:
        return VariationIssue(
            severity="warning",
            message=f"连续{max_consecutive}镜描述相同,建议增加变化",
        )
    return None


def _check_lazy_phrases(shots: list[dict]) -> tuple[int, list[VariationIssue]]:
    """检测通用化语言黑名单。"""
    count = 0
    issues: list[VariationIssue] = []

    for i, s in enumerate(shots):
        # 只检查 scene 和 camera 字段,不检查 description(danbooru 标签里有画质词是正常的)
        text = (s.get("scene", "") + " " + s.get("camera", "")).lower()
        found = _LAZY_PHRASES & set(text.replace(",", " ").split())
        if found:
            count += len(found)
            if len(issues) < 5:
                issues.append(VariationIssue(
                    severity="warning",
                    message=f"镜头{i+1}:使用了懒惰措辞{found}",
                    shot_indices=[i],
                ))

    return count, issues


def _check_static_overuse(shots: list[dict]) -> VariationIssue | None:
    """检测静态镜头过度使用(>70% 静态 = 警告)。"""
    if not shots:
        return None

    motion_indicators = {"zoom", "pan", "tilt", "dolly", "tracking", "following",
                         "rotate", "push", "pull", "摇", "推", "拉", "移"}
    static_count = 0

    for s in shots:
        camera = s.get("camera", "").lower()
        if not any(m in camera for m in motion_indicators):
            static_count += 1

    ratio = static_count / len(shots)
    if ratio > 0.7:
        return VariationIssue(
            severity="warning",
            message=f"静态镜头占比{ratio:.0%}(超过70%),建议增加运动镜头",
        )
    return None


def evaluate_variation(shots: list[dict]) -> VariationReport:
    """对分镜列表执行场景变化检查。

    Args:
        shots: 分镜列表。

    Returns:
        VariationReport 含是否通过、错误/警告数、详细问题列表。
    """
    issues: list[VariationIssue] = []

    # 1. 镜头尺寸多样性
    diversity, size_issue = _check_shot_size_diversity(shots)
    if size_issue:
        issues.append(size_issue)

    # 2. 连续相同镜头
    consec_issue = _check_consecutive_identical(shots)
    if consec_issue:
        issues.append(consec_issue)

    # 3. 懒惰措辞
    lazy_count, lazy_issues = _check_lazy_phrases(shots)
    issues.extend(lazy_issues)

    # 4. 静态镜头过度使用
    static_issue = _check_static_overuse(shots)
    if static_issue:
        issues.append(static_issue)

    error_count = sum(1 for i in issues if i.severity == "error")
    warning_count = sum(1 for i in issues if i.severity == "warning")
    passed = error_count == 0

    return VariationReport(
        passed=passed,
        error_count=error_count,
        warning_count=warning_count,
        issues=issues,
        shot_size_diversity=diversity,
        lazy_phrase_count=lazy_count,
    )
