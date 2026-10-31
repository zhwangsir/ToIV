"""防线 3: 场景节奏验证器。

验证分镜的时长、节奏、对白与画面的对齐,容差 ±1 秒。
确保终端场景步骤与旁白时间轴合理对齐。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PacingIssue:
    """节奏问题。"""
    severity: str  # error | warning
    message: str
    shot_index: int | None = None


@dataclass
class ScenePacingReport:
    """场景节奏验证报告。"""
    passed: bool
    total_duration: float  # 预计总时长(秒)
    error_count: int
    warning_count: int
    issues: list[PacingIssue] = field(default_factory=list)
    pacing_score: float = 0.0  # 0-5, 越低越好

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "total_duration": round(self.total_duration, 1),
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "issues": [
                {"severity": i.severity, "message": i.message, "shot_index": i.shot_index}
                for i in self.issues
            ],
            "pacing_score": round(self.pacing_score, 2),
        }


def _estimate_dialogue_duration(text: str) -> float:
    """估算中文对白时长(字/秒,约 3.5 字/秒)。"""
    if not text:
        return 0.0
    # 中文字符按 3.5 字/秒,英文按 2.5 词/秒
    chinese_chars = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other_chars = len(text) - chinese_chars
    return chinese_chars / 3.5 + other_chars / 15.0  # 标点/空格按 15 字符/秒


def _check_duration_alignment(shots: list[dict]) -> list[PacingIssue]:
    """检测对白时长与分镜时长的对齐(容差 ±1 秒)。"""
    issues: list[PacingIssue] = []

    for i, s in enumerate(shots):
        dialogue = s.get("dialogue", "")
        duration = s.get("duration_sec", 3)

        if not dialogue:
            continue

        est_dialogue_dur = _estimate_dialogue_duration(dialogue)

        if est_dialogue_dur > duration + 1:
            issues.append(PacingIssue(
                severity="error",
                message=f"镜头{i+1}:对白预计{est_dialogue_dur:.1f}秒,超出分镜时长{duration}秒",
                shot_index=i,
            ))
        elif est_dialogue_dur > duration:
            issues.append(PacingIssue(
                severity="warning",
                message=f"镜头{i+1}:对白预计{est_dialogue_dur:.1f}秒,略超分镜时长{duration}秒",
                shot_index=i,
            ))
        elif est_dialogue_dur < duration * 0.3 and est_dialogue_dur > 0:
            issues.append(PacingIssue(
                severity="warning",
                message=f"镜头{i+1}:对白仅{est_dialogue_dur:.1f}秒,分镜时长{duration}秒过长",
                shot_index=i,
            ))

    return issues


def _check_pacing_flow(shots: list[dict]) -> list[PacingIssue]:
    """检测节奏流畅性 — 连续短镜头/长镜头的节奏问题。"""
    issues: list[PacingIssue] = []

    if len(shots) < 3:
        return issues

    durations = [s.get("duration_sec", 3) for s in shots]

    # 连续短镜头(< 2 秒 × 3+)
    short_streak = 0
    for i, d in enumerate(durations):
        if d < 2:
            short_streak += 1
            if short_streak >= 3:
                issues.append(PacingIssue(
                    severity="warning",
                    message=f"镜头{i-2}-{i+1}:连续{short_streak}个短镜头(<2秒),节奏过快",
                    shot_index=i,
                ))
        else:
            short_streak = 0

    # 连续长镜头(> 8 秒 × 3+)
    long_streak = 0
    for i, d in enumerate(durations):
        if d > 8:
            long_streak += 1
            if long_streak >= 3:
                issues.append(PacingIssue(
                    severity="warning",
                    message=f"连续{long_streak}个长镜头(>8秒),节奏拖沓",
                    shot_index=i,
                ))
        else:
            long_streak = 0

    # 检测突兀的时长跳跃(前镜 2 秒 → 后镜 8+ 秒)
    for i in range(1, len(durations)):
        if durations[i - 1] <= 2 and durations[i] >= 8:
            issues.append(PacingIssue(
                severity="warning",
                message=f"镜头{i}→{i+1}:时长从{durations[i-1]}秒突跳到{durations[i]}秒",
                shot_index=i,
            ))

    return issues


def _check_total_duration(shots: list[dict]) -> list[PacingIssue]:
    """检测总时长合理性。"""
    issues: list[PacingIssue] = []
    total = sum(s.get("duration_sec", 3) for s in shots)

    if total < 5:
        issues.append(PacingIssue(
            severity="error",
            message=f"总时长仅{total}秒,太短无法构成完整内容",
        ))
    elif total > 300:
        issues.append(PacingIssue(
            severity="warning",
            message=f"总时长{total}秒(5分钟+),建议分段制作",
        ))

    return issues


def evaluate_pacing(shots: list[dict]) -> ScenePacingReport:
    """对分镜列表执行场景节奏验证。

    Args:
        shots: 分镜列表。

    Returns:
        ScenePacingReport 含是否通过、总时长、节奏评分、问题列表。
    """
    all_issues: list[PacingIssue] = []
    all_issues.extend(_check_duration_alignment(shots))
    all_issues.extend(_check_pacing_flow(shots))
    all_issues.extend(_check_total_duration(shots))

    error_count = sum(1 for i in all_issues if i.severity == "error")
    warning_count = sum(1 for i in all_issues if i.severity == "warning")

    total_duration = sum(s.get("duration_sec", 3) for s in shots)

    # 节奏评分:错误越多分越高(越差)
    pacing_score = min(5.0, error_count * 1.5 + warning_count * 0.5)

    return ScenePacingReport(
        passed=error_count == 0,
        total_duration=total_duration,
        error_count=error_count,
        warning_count=warning_count,
        issues=all_issues[:10],
        pacing_score=pacing_score,
    )
