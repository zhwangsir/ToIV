"""作业相位文案(02:41 父代理):区分「正在加载模型」与「生成中」。

冷启动 ~110s 是用户最痛等待;排队提示必须说清是在加载模型还是在采样。
纯函数 + 进度快照字段,供 tracker / SSE / /jobs/active 共用。
"""
from __future__ import annotations

from typing import Any

PHASE_QUEUED = "queued"
PHASE_LOADING = "loading_model"
PHASE_GENERATING = "generating"
PHASE_HELD = "held"

PHASE_LABELS: dict[str, str] = {
    PHASE_QUEUED: "排队中",
    PHASE_LOADING: "正在加载模型（约 2 分钟）",
    PHASE_GENERATING: "生成中",
    PHASE_HELD: "资源排队中",
}


def phase_label(phase: str | None) -> str:
    """相位 → 用户可见短句;未知相位回退排队中。"""
    if not phase:
        return PHASE_LABELS[PHASE_QUEUED]
    return PHASE_LABELS.get(str(phase), PHASE_LABELS[PHASE_QUEUED])


def resolve_phase(
    *,
    status: str,
    queue_pos: int | None = None,
    has_step_progress: bool = False,
    saw_executing: bool = False,
) -> str:
    """由作业状态推导相位。

    - held → held
    - 有采样步进度 → generating
    - 已收到 executing(node) 但尚无步进度 → loading_model
    - 排队位 >0 → queued
    - running 且尚无步进度 → loading_model(冷载常见)
    - 其余 queued → queued
    """
    st = (status or "").strip().lower()
    if st == "held":
        return PHASE_HELD
    if has_step_progress:
        return PHASE_GENERATING
    if saw_executing or st == "running":
        return PHASE_LOADING
    if isinstance(queue_pos, int) and queue_pos > 0:
        return PHASE_QUEUED
    return PHASE_QUEUED


def enrich_progress_snap(snap: dict[str, Any] | None, *, status: str) -> dict[str, Any]:
    """给 progress 快照补 phase / phase_label(不改其它键)。"""
    out = dict(snap or {})
    has_step = isinstance(out.get("step"), int) and isinstance(out.get("total"), int) and int(out.get("total") or 0) > 0
    qpos = out.get("queue_pos")
    qpos_i = qpos if isinstance(qpos, int) else None
    explicit = out.get("phase")
    if explicit in PHASE_LABELS:
        phase = str(explicit)
    else:
        phase = resolve_phase(
            status=status,
            queue_pos=qpos_i,
            has_step_progress=has_step,
            saw_executing=bool(out.get("saw_executing")),
        )
    out["phase"] = phase
    out["phase_label"] = phase_label(phase)
    return out
