"""FE stream reconnect / catch-up dry-run harness (Cycle 46).

Closes checklist S5 from Cycle 45: disconnect keeps next_seq watermark;
reconnect catch-up uses ProgressStreamHub.list_since; optional note of
SubscribePlan.catchup_product_paths (Cycle 44 ALL_ENTRIES only).

Paper + scratch dry-run — flag default false, no tip EventSource mount.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .progress_stream import ProgressStreamHub, StreamFrame
from .stream_subscribe import SubscribePlan, plan_for

RECONNECT_PRODUCT_PATH = "fe_stream_reconnect"


@dataclass
class ReconnectState:
    """Client-side reconnect watermark + connection bookkeeping."""

    surface: str
    since_seq: int = 0
    last_error: str | None = None
    connected: bool = True
    frames_applied: int = 0
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["needs_kouling"] = list(self.needs_kouling)
        # Alias watermark = since_seq (next_seq client cursor)
        d["watermark"] = self.since_seq
        return d


def simulate_disconnect(state: ReconnectState, *, error: str = "disconnect") -> ReconnectState:
    """Mark disconnected; preserve since_seq / watermark."""
    state.connected = False
    state.last_error = error
    return state


def catch_up(
    hub: ProgressStreamHub,
    state: ReconnectState,
    *,
    limit: int = 200,
) -> list[StreamFrame]:
    """Fetch frames with seq > state.since_seq via hub.list_since."""
    since = int(state.since_seq or 0)
    lim = max(1, min(int(limit or 200), 2000))
    return hub.list_since(since, limit=lim)


def apply_frames(state: ReconnectState, frames: list[StreamFrame]) -> ReconnectState:
    """Advance watermark to max seq; never invent progress=100; null stays null.

    Frames are applied for watermark bookkeeping only — progress values are
    left untouched (no fake completion).
    """
    if not frames:
        return state
    # Sanity: never mutate frame progress (read-only check for dry-run)
    for f in frames:
        # Explicit guard: harness must not rewrite null → 100
        if f.progress is None:
            continue
        # Leave as-is; no clamp-to-100 invention
    max_seq = max(int(f.seq) for f in frames)
    if max_seq > int(state.since_seq or 0):
        state.since_seq = max_seq
    state.frames_applied += len(frames)
    return state


def reconnect_cycle(
    plan: SubscribePlan,
    hub: ProgressStreamHub,
    state: ReconnectState,
    *,
    limit: int = 200,
    error: str = "disconnect",
) -> dict[str, Any]:
    """disconnect → catch-up → apply → reconnect payload (scratch dry-run)."""
    simulate_disconnect(state, error=error)
    watermark_before = int(state.since_seq or 0)
    frames = catch_up(hub, state, limit=limit)
    apply_frames(state, frames)
    state.connected = True
    state.last_error = None

    # Catch-up product paths: only from plan (Cycle 44 ALL_ENTRIES); do not invent
    catchup_paths = list(plan.catchup_product_paths)

    rows = [f.to_dict() for f in frames]
    # Ensure no harness-invented 100% on null-progress frames
    for row, frame in zip(rows, frames):
        if frame.progress is None:
            row["progress"] = None

    return {
        "product_path": RECONNECT_PRODUCT_PATH,
        "surface": plan.surface,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "live_frames": True,
        "needs_kouling": ["改码卡"],
        "watermark_before": watermark_before,
        "since_seq": watermark_before,
        "next_seq": int(state.since_seq or 0),
        "frames": rows,
        "count": len(rows),
        "frames_applied": state.frames_applied,
        "connected": state.connected,
        "catchup_product_paths": catchup_paths,
        "catchup_via": "hub.list_since",
        "plan": plan.to_dict(),
        "state": state.to_dict(),
        "notes": (
            "S5 dry-run: disconnect keeps watermark; catch-up = hub list_since; "
            "task_center may overlay D-R4 jobs_list_since from catchup_product_paths"
        ),
    }


def initial_state(surface: str, *, since_seq: int = 0) -> ReconnectState:
    return ReconnectState(surface=surface, since_seq=int(since_seq or 0))


def plan_or_raise(surface: str) -> SubscribePlan:
    plan = plan_for(surface)
    if plan is None:
        raise ValueError(f"unknown_surface:{surface}")
    return plan
