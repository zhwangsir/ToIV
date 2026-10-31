"""作业进度证据的只读健康投影，不推断 worker 存活性或计费健康。"""
from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from typing import Any

from app.services.job_phase import enrich_progress_snap

FRESH_MAX_AGE_SECONDS = 120.0
WATCH_MAX_AGE_SECONDS = 300.0
MAX_FUTURE_SKEW_SECONDS = 30.0
TERMINAL_STATUSES = frozenset({"done", "error", "canceled"})


def _integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _timestamp(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    timestamp = float(value)
    return timestamp if math.isfinite(timestamp) and timestamp > 0 else None


def _created_timestamp(created_at: datetime | None) -> float | None:
    if not isinstance(created_at, datetime):
        return None
    try:
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        timestamp = created_at.timestamp()
    except (OverflowError, OSError, ValueError):
        return None
    return timestamp if math.isfinite(timestamp) else None


def _runtime(
    state: str,
    label: str,
    reason: str,
    evidence: str,
    last_evidence_at: float | None,
    age_seconds: float | None,
) -> dict[str, Any]:
    return {
        "state": state,
        "label": label,
        "reason": reason,
        "last_evidence_at": last_evidence_at,
        "age_seconds": age_seconds,
        "evidence": evidence,
    }


def project_job_health(
    *,
    status: str,
    progress: str | dict[str, Any] | None,
    created_at: datetime | None,
    hold_reason: str = "",
    now: float | None = None,
) -> dict[str, dict[str, Any]]:
    """归一化进度并评估证据新旧；仅做内存计算，无网络或外部调用。"""
    now_ts = time.time() if now is None else float(now)
    if isinstance(progress, str):
        try:
            raw = json.loads(progress) if progress else {}
        except (ValueError, TypeError):
            raw = {}
    else:
        raw = progress
    if not isinstance(raw, dict):
        raw = {}
    snap = enrich_progress_snap(raw, status=status)
    updated_at = _timestamp(snap.get("updated_at"))
    if updated_at is not None and updated_at > now_ts + MAX_FUTURE_SKEW_SECONDS:
        updated_at = None
    normalized = {
        "pct": _integer(snap.get("pct")),
        "step": _integer(snap.get("step")),
        "total": _integer(snap.get("total")),
        "queue_pos": _integer(snap.get("queue_pos")),
        "updated_at": updated_at,
        "phase": snap.get("phase"),
        "phase_label": snap.get("phase_label"),
    }

    st = (status or "").strip().lower()
    progress_age = max(0.0, now_ts - updated_at) if updated_at is not None else None
    progress_evidence = "progress_snapshot" if updated_at is not None else None
    if st in TERMINAL_STATUSES:
        return {
            "progress": normalized,
            "runtime": _runtime(
                "terminal", "已结束", f"作业状态为 {st}",
                progress_evidence or "terminal", updated_at, progress_age,
            ),
        }
    if st == "held":
        return {
            "progress": normalized,
            "runtime": _runtime(
                "waiting", "等待中", hold_reason or "等待资源",
                progress_evidence or "none", updated_at, progress_age,
            ),
        }

    if updated_at is not None and st in ("queued", "running"):
        age = max(0.0, now_ts - updated_at)
        if age <= FRESH_MAX_AGE_SECONDS:
            state, label, reason = "fresh", "进度新鲜", "进度持续更新"
        elif age <= WATCH_MAX_AGE_SECONDS:
            state, label, reason = "watch", "观察中", "进度更新间隔较长，持续观察"
        else:
            state, label, reason = "stalled", "待核查", "进度待核查，不自动中止或重试"
        return {
            "progress": normalized,
            "runtime": _runtime(state, label, reason, "progress_snapshot", updated_at, age),
        }

    created_ts = _created_timestamp(created_at)
    created_age = max(0.0, now_ts - created_ts) if created_ts is not None else None
    if st == "running" and created_age is not None and created_age > WATCH_MAX_AGE_SECONDS:
        runtime = _runtime(
            "stalled", "待核查", "运行已久但仍无有效进度，待核查", "created_at", created_ts, created_age
        )
    else:
        reason = "等待首次进度" if st == "running" else "排队中，健康未知"
        runtime = _runtime(
            "unknown", "健康未知", reason, "created_at" if created_ts is not None else "none",
            created_ts, created_age,
        )
    return {"progress": normalized, "runtime": runtime}
