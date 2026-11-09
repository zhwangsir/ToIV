"""Narrow ProgressStream payload helpers for JR-R1…R5 contracts.

Full scratch ``routes_stream.py`` (SSE/WS router family) is intentionally NOT
copied. These helpers keep test/product_path names stable while tip stays
unmounted (flag default false; no lifespan wiring).
"""

from __future__ import annotations

from typing import Any

from .flag import is_enabled
from .ray_job_router_adapter_tick_silent import (
    contract_static_payload as _adapter_tick_silent_static,
    run_adapter_tick_silent_cycle as _adapter_tick_silent_run_cycle,
)
from .ray_job_router_emit_gate import (
    contract_static_payload as _emit_gate_static,
    run_job_router_emit_gate_cycle as _emit_gate_run_cycle,
)
from .ray_job_router_kind_adapter_parity import (
    contract_static_payload as _kind_adapter_static,
    run_kind_adapter_parity_cycle as _kind_adapter_run_cycle,
)
from .ray_job_router_progress_regress_parity import (
    contract_static_payload as _progress_regress_static,
    run_progress_regress_parity_cycle as _progress_regress_run_cycle,
)
from .ray_job_router_publish_kind_split import (
    contract_static_payload as _publish_kind_split_static,
    run_publish_kind_split_cycle as _publish_kind_split_run_cycle,
)
from .stream_tip_portal import (
    contract_static_payload as _tip_portal_checklist_static,
    run_tip_portal_cycle as _tip_portal_run_cycle,
)

PROGRESS_WS_PATH_HINT = "/api/ray/progress/ws"
PROGRESS_SSE_PATH_HINT = "/api/ray/progress/stream"


def _paths() -> dict[str, str]:
    return {"sse": PROGRESS_SSE_PATH_HINT, "ws": PROGRESS_WS_PATH_HINT}


def ray_job_router_emit_gate_contract_payload(
    hub=None,
    *,
    environ: dict[str, str] | None = None,
    enabled: bool | None = None,
    sample_job_id: str | None = None,
) -> dict:
    if enabled is None:
        enabled = is_enabled(environ)
    if not enabled:
        body = _emit_gate_static()
        body["paths"] = _paths()
        _ = hub
        return body
    body = _emit_gate_run_cycle(sample_job_id=sample_job_id)
    body["enabled"] = True
    body["reason"] = None
    body["paths"] = _paths()
    _ = hub
    return body


def fe_tip_portal_pseudocode_payload(
    hub=None,
    *,
    environ: dict[str, str] | None = None,
    enabled: bool | None = None,
    surface: str = "create_rail",
    leader_tab: str = "tab-a",
    initial_seqs: dict[str, int] | None = None,
    sample_job_id: str | None = None,
) -> dict:
    if enabled is None:
        enabled = is_enabled(environ)
    if not enabled:
        body = _tip_portal_checklist_static(surface=surface)
        body["paths"] = _paths()
        _ = hub
        return body
    body = _tip_portal_run_cycle(
        surface=surface,
        leader_tab=leader_tab,
        initial_seqs=initial_seqs,
        sample_job_id=sample_job_id or "job-demo-c66",
    )
    body["enabled"] = True
    body["reason"] = None
    body["paths"] = _paths()
    _ = hub
    return body


def ray_job_router_publish_kind_split_contract_payload(
    hub=None,
    *,
    environ: dict[str, str] | None = None,
    enabled: bool | None = None,
    sample_job_id: str | None = None,
) -> dict:
    if enabled is None:
        enabled = is_enabled(environ)
    if not enabled:
        body = _publish_kind_split_static()
        body["paths"] = _paths()
        _ = hub
        return body
    body = _publish_kind_split_run_cycle(sample_job_id=sample_job_id)
    body["enabled"] = True
    body["reason"] = None
    body["paths"] = _paths()
    _ = hub
    return body


def ray_job_router_adapter_tick_silent_contract_payload(
    hub=None,
    *,
    environ: dict[str, str] | None = None,
    enabled: bool | None = None,
    sample_job_id: str | None = None,
) -> dict:
    if enabled is None:
        enabled = is_enabled(environ)
    if not enabled:
        body = _adapter_tick_silent_static()
        body["paths"] = _paths()
        _ = hub
        return body
    body = _adapter_tick_silent_run_cycle(sample_job_id=sample_job_id)
    body["enabled"] = True
    body["reason"] = None
    body["paths"] = _paths()
    _ = hub
    return body


def ray_job_router_progress_regress_parity_contract_payload(
    hub=None,
    *,
    environ: dict[str, str] | None = None,
    enabled: bool | None = None,
    sample_job_id: str | None = None,
) -> dict:
    if enabled is None:
        enabled = is_enabled(environ)
    if not enabled:
        body = _progress_regress_static()
        body["paths"] = _paths()
        _ = hub
        return body
    body = _progress_regress_run_cycle(sample_job_id=sample_job_id)
    body["enabled"] = True
    body["reason"] = None
    body["paths"] = _paths()
    _ = hub
    return body


def ray_job_router_kind_adapter_parity_contract_payload(
    hub=None,
    *,
    environ: dict[str, str] | None = None,
    enabled: bool | None = None,
    sample_job_id: str | None = None,
) -> dict:
    if enabled is None:
        enabled = is_enabled(environ)
    if not enabled:
        body = _kind_adapter_static()
        body["paths"] = _paths()
        _ = hub
        return body
    body = _kind_adapter_run_cycle(sample_job_id=sample_job_id)
    body["enabled"] = True
    body["reason"] = None
    body["paths"] = _paths()
    _ = hub
    return body


# Avoid unused-import lint noise for Any when typing hub loosely
_: Any
