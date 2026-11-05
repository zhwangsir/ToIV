"""FE stream subscribe plans from Cycle 44 product_path index (Cycle 45).

Turns the unified stream/catch-up/toast index into machine-readable subscribe
maps for create-rail / task-center / export-toast surfaces. Paper + scratch
dry-run only — flag default false, no tip EventSource/WebSocket mount.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .stream_product_paths import (
    ALL_ENTRIES,
    CATCHUP_ENTRIES,
    SSE_PATH_HINT,
    STREAM_ENTRIES,
    TOAST_ENTRIES,
    WS_PATH_HINT,
    get_entry,
    list_product_paths,
)

SUBSCRIBE_PRODUCT_PATH = "fe_stream_subscribe"

SurfaceName = str  # create_rail | task_center | export_toast | catalog


@dataclass(frozen=True)
class SubscribePlan:
    """One FE surface's subscribe wiring plan."""

    surface: str
    product_paths: tuple[str, ...]
    channels: tuple[str, ...]
    sse_path_hint: str = SSE_PATH_HINT
    ws_path_hint: str = WS_PATH_HINT
    catchup_product_paths: tuple[str, ...] = ()
    filter_hint: str = ""
    flag_default: bool = False
    tip_mount: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["product_paths"] = list(self.product_paths)
        d["channels"] = list(self.channels)
        d["catchup_product_paths"] = list(self.catchup_product_paths)
        d["needs_kouling"] = list(self.needs_kouling)
        return d


def _stream_paths() -> tuple[str, ...]:
    return tuple(e.product_path for e in STREAM_ENTRIES)


def _assert_known(paths: tuple[str, ...]) -> None:
    for p in paths:
        if get_entry(p) is None:
            raise AssertionError(f"subscribe plan references unknown product_path {p!r}")


def _build_plans() -> dict[str, SubscribePlan]:
    stream_paths = _stream_paths()
    export_paths = (
        "export_stream_hub",
        "create_rail_export_toast",
    )
    create_rail = SubscribePlan(
        surface="create_rail",
        product_paths=stream_paths,
        channels=("progress", "toast"),
        catchup_product_paths=(),
        filter_hint="channel=progress → row; progress=null → shimmer; never fake 100%",
        notes="Right rail 320; subscribe stream family; map toast for focus job only",
    )
    task_center = SubscribePlan(
        surface="task_center",
        product_paths=stream_paths,
        channels=("progress", "task_center"),
        catchup_product_paths=("jobs_list_since",),
        filter_hint="same stream + optional jobs_list_since catch-up overlay",
        notes="/tasks or queue page; reconnect: hub list_since OR D-R4 jobs_list_since",
    )
    export_toast = SubscribePlan(
        surface="export_toast",
        product_paths=export_paths,
        channels=("toast", "progress"),
        catchup_product_paths=(),
        filter_hint="channel=toast + filter export: / kind=export; companion create_rail_export_toast",
        notes="Create-rail export toast surface; may dual-read export_stream_hub",
    )
    catalog = SubscribePlan(
        surface="catalog",
        product_paths=tuple(list_product_paths()),
        channels=("progress", "toast", "task_center"),
        catchup_product_paths=tuple(e.product_path for e in CATCHUP_ENTRIES),
        filter_hint="bootstrap once via stream_product_path_index; do not hardcode beyond path hints",
        notes="Call index payload once; FE should not duplicate path constants",
        sse_path_hint=SSE_PATH_HINT,
        ws_path_hint=WS_PATH_HINT,
    )
    plans = {
        "create_rail": create_rail,
        "task_center": task_center,
        "export_toast": export_toast,
        "catalog": catalog,
    }
    for plan in plans.values():
        # catalog product_paths are all ALL_ENTRIES — already known
        known = plan.product_paths + plan.catchup_product_paths
        # catalog includes every path; others must exist in index
        if plan.surface != "catalog":
            _assert_known(known)
        else:
            _assert_known(tuple(e.product_path for e in ALL_ENTRIES))
            # toast companions already in ALL_ENTRIES
            _assert_known(tuple(e.product_path for e in TOAST_ENTRIES))
    return plans


_PLANS: dict[str, SubscribePlan] = _build_plans()


def plan_for(surface: str) -> SubscribePlan | None:
    return _PLANS.get(surface)


def all_plans() -> list[SubscribePlan]:
    # Stable order: primary surfaces first, catalog last
    order = ("create_rail", "task_center", "export_toast", "catalog")
    return [_PLANS[k] for k in order if k in _PLANS]


def list_surfaces() -> list[str]:
    return [p.surface for p in all_plans()]


def subscribe_index_dict(*, surface: str | None = None) -> dict[str, Any]:
    """Serializable FE subscribe catalog (flag-agnostic static map)."""
    if surface is not None:
        plan = plan_for(surface)
        plans = [plan] if plan is not None else []
    else:
        plans = all_plans()
    return {
        "product_path": SUBSCRIBE_PRODUCT_PATH,
        "count": len(plans),
        "surfaces": [p.surface for p in plans],
        "sse_path_hint": SSE_PATH_HINT,
        "ws_path_hint": WS_PATH_HINT,
        "tip_mount": False,
        "flag_default": False,
        "plans": [p.to_dict() for p in plans],
        "source_index": "stream_product_path_index",
        "needs_kouling": ["改码卡"],
    }
