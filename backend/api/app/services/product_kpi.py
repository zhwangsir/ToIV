"""F3 / P4：北向 KPI（诚实空→有，禁止伪造）。

四指标（COMPETITIVE L6 / EXECUTION §7.1）：
1. 首集成片率 — 成功合成次数 / 合成尝试次数
2. 不进自由画布完成率 — 成片项目中从未触碰自由画布的占比
3. 一致性返工次数 — consistency_rework 事件计数
4. 本地队列 P50 等待 — queue_wait 样本的中位数毫秒

无样本时对应字段为 null（前端展示「暂无数据」），绝不填假数。
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

from app.models import ProductKpiEvent

EVENT_TYPES = frozenset({
    "episode_assembled",  # payload: {success: bool, surface?: str}
    "path_touch",         # payload: {surface: "drama_workspace"|"free_canvas"|"other"}
    "consistency_rework", # payload: {reason?: str}
    "queue_wait",         # payload: {wait_ms: number}
})

SURFACES = frozenset({"drama_workspace", "free_canvas", "other"})


def _parse_payload(raw: str | None) -> dict[str, Any]:
    try:
        v = json.loads(raw or "{}")
    except (ValueError, TypeError):
        return {}
    return v if isinstance(v, dict) else {}


def record_event(
    session: Session,
    *,
    tenant_id: str,
    user_id: str = "",
    project_id: str = "",
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> ProductKpiEvent:
    et = (event_type or "").strip()
    if et not in EVENT_TYPES:
        raise ValueError(f"未知 event_type:{et}")
    body = dict(payload or {})
    if et == "path_touch":
        surface = str(body.get("surface") or "").strip()
        if surface not in SURFACES:
            raise ValueError("path_touch.surface 须为 drama_workspace|free_canvas|other")
        body["surface"] = surface
    if et == "queue_wait":
        try:
            wait_ms = float(body.get("wait_ms"))
        except (TypeError, ValueError) as e:
            raise ValueError("queue_wait.wait_ms 须为数字") from e
        if wait_ms < 0:
            raise ValueError("queue_wait.wait_ms 不可为负")
        body["wait_ms"] = wait_ms
    if et == "episode_assembled":
        body["success"] = bool(body.get("success"))
    row = ProductKpiEvent(
        tenant_id=tenant_id,
        user_id=user_id or "",
        project_id=project_id or "",
        event_type=et,
        payload_json=json.dumps(body, ensure_ascii=False),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def _percentile_nearest(sorted_vals: list[float], p: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    # nearest-rank
    k = max(1, int(round(p * len(sorted_vals))))
    return float(sorted_vals[min(len(sorted_vals), k) - 1])


def summarize(
    session: Session,
    *,
    tenant_id: str,
    days: int = 30,
) -> dict[str, Any]:
    """聚合北向四指标；无样本字段为 null。"""
    days = max(1, min(int(days or 30), 365))
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    rows = session.exec(
        select(ProductKpiEvent).where(
            ProductKpiEvent.tenant_id == tenant_id,
            ProductKpiEvent.created_at >= since,
        )
    ).all()

    assembled_ok = 0
    assembled_try = 0
    assembled_project_ids: set[str] = set()
    free_canvas_projects: set[str] = set()
    drama_touch_projects: set[str] = set()
    rework = 0
    waits: list[float] = []

    for r in rows:
        payload = _parse_payload(r.payload_json)
        pid = (r.project_id or "").strip()
        if r.event_type == "episode_assembled":
            assembled_try += 1
            if payload.get("success"):
                assembled_ok += 1
                if pid:
                    assembled_project_ids.add(pid)
        elif r.event_type == "path_touch":
            surface = str(payload.get("surface") or "")
            if pid and surface == "free_canvas":
                free_canvas_projects.add(pid)
            if pid and surface == "drama_workspace":
                drama_touch_projects.add(pid)
        elif r.event_type == "consistency_rework":
            rework += 1
        elif r.event_type == "queue_wait":
            try:
                waits.append(float(payload["wait_ms"]))
            except (KeyError, TypeError, ValueError):
                continue

    first_episode_rate: float | None = None
    if assembled_try > 0:
        first_episode_rate = assembled_ok / assembled_try

    no_free_canvas_rate: float | None = None
    if assembled_project_ids:
        without = sum(1 for p in assembled_project_ids if p not in free_canvas_projects)
        no_free_canvas_rate = without / len(assembled_project_ids)

    waits_sorted = sorted(waits)
    queue_p50_ms = _percentile_nearest(waits_sorted, 0.50)
    queue_p50_ms_alt = None
    if waits_sorted:
        queue_p50_ms_alt = float(statistics.median(waits_sorted))

    return {
        "window_days": days,
        "sample_counts": {
            "episode_assembled": assembled_try,
            "episode_assembled_ok": assembled_ok,
            "path_touch": sum(1 for r in rows if r.event_type == "path_touch"),
            "consistency_rework": rework,
            "queue_wait": len(waits),
            "events_total": len(rows),
        },
        "metrics": {
            "first_episode_assemble_rate": first_episode_rate,
            "no_free_canvas_completion_rate": no_free_canvas_rate,
            "consistency_rework_count": (
                rework if any(r.event_type == "consistency_rework" for r in rows) else None
            ),
            "local_queue_wait_p50_ms": queue_p50_ms_alt if queue_p50_ms_alt is not None else queue_p50_ms,
        },
        "notes": {
            "empty_means": "null = 窗口内无足够样本，非 0%",
            "first_episode_assemble_rate": "成功合成 / 合成尝试",
            "no_free_canvas_completion_rate": "成片项目中从未 path_touch=free_canvas 的占比",
            "consistency_rework_count": "consistency_rework 事件绝对次数",
            "local_queue_wait_p50_ms": "queue_wait.wait_ms 样本中位数",
        },
    }


def empty_summary(days: int = 30) -> dict[str, Any]:
    """无租户/无库时的诚实空壳（全 null）。"""
    return {
        "window_days": days,
        "sample_counts": {
            "episode_assembled": 0,
            "episode_assembled_ok": 0,
            "path_touch": 0,
            "consistency_rework": 0,
            "queue_wait": 0,
            "events_total": 0,
        },
        "metrics": {
            "first_episode_assemble_rate": None,
            "no_free_canvas_completion_rate": None,
            "consistency_rework_count": None,
            "local_queue_wait_p50_ms": None,
        },
        "notes": {
            "empty_means": "null = 窗口内无足够样本，非 0%",
            "first_episode_assemble_rate": "成功合成 / 合成尝试",
            "no_free_canvas_completion_rate": "成片项目中从未 path_touch=free_canvas 的占比",
            "consistency_rework_count": "consistency_rework 事件绝对次数",
            "local_queue_wait_p50_ms": "queue_wait.wait_ms 样本中位数",
        },
    }
