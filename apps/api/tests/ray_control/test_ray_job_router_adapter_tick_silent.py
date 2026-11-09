"""Cycle 70 — JR-R2 adapter_tick silent + progress-delta gate tests."""

from __future__ import annotations

from app.ray_control.flag import RAY_CONTROL_ENV
from app.ray_control.progress_bus import JobEventKind, ProgressBus
from app.ray_control.ray_job_router_adapter_tick_silent import (
    ADAPTER_TICK_STEPS,
    DELTA_EMIT_REASON,
    MILESTONE,
    NO_DELTA_REASON,
    PRODUCT_PATH,
    SILENT_REASON,
    TICKET,
    adapter_tick_dry_run,
    adapter_tick_op_defaults,
    catalog_integrity,
    contract_static_payload,
    decide_emit_for_tick,
    run_adapter_tick_silent_cycle,
    step_catalog,
)
from app.ray_control.ray_job_router_emit_gate import OP_DEFAULTS, sample_gate_wire
from app.ray_control.routes_stream import ray_job_router_adapter_tick_silent_contract_payload
from app.ray_control.stream_product_paths import get_entry


def test_step_catalog_at1_to_at7() -> None:
    rows = step_catalog()
    assert len(rows) == 7
    assert [r["id"] for r in rows] == ["AT1", "AT2", "AT3", "AT4", "AT5", "AT6", "AT7"]
    assert len(ADAPTER_TICK_STEPS) == 7


def test_catalog_integrity_and_defaults() -> None:
    integ = catalog_integrity()
    assert integ["ok"] is True
    assert integ["missing_ids"] == []
    assert integ["adapter_tick_defaults"]["emit_default_false"] is True
    assert integ["silent_not_emitted"] is True
    assert integ["reuses_c64_op_defaults"] is True
    defaults = adapter_tick_op_defaults()
    assert defaults["emit"] is False
    assert defaults["bus_kind"] == JobEventKind.UPDATED.value
    assert defaults["scheduler_op"] == "renew"
    assert OP_DEFAULTS["adapter_tick"]["emit"] is False


def test_decide_emit_no_delta_silent() -> None:
    d = decide_emit_for_tick(
        prior_progress=0.4,
        prior_state="running",
        next_progress=0.4,
        next_state="running",
    )
    assert d.emit is False
    assert d.reason == NO_DELTA_REASON
    assert d.progress_changed is False
    assert d.state_changed is False


def test_decide_emit_progress_delta() -> None:
    d = decide_emit_for_tick(
        prior_progress=0.1,
        prior_state="running",
        next_progress=0.5,
        next_state="running",
    )
    assert d.emit is True
    assert d.reason == DELTA_EMIT_REASON
    assert d.progress_changed is True


def test_decide_emit_state_delta() -> None:
    d = decide_emit_for_tick(
        prior_progress=0.2,
        prior_state="queued",
        next_progress=0.2,
        next_state="running",
    )
    assert d.emit is True
    assert d.reason == DELTA_EMIT_REASON
    assert d.state_changed is True


def test_decide_emit_no_prior_stays_silent() -> None:
    d = decide_emit_for_tick(next_progress=0.1, next_state="running")
    assert d.emit is False
    assert d.reason == SILENT_REASON


def test_silent_dry_run_default_wire() -> None:
    ack = adapter_tick_dry_run(
        sample_gate_wire(op="adapter_tick", job_id="at-s", kind="echo", seq=1),
        use_delta_gate=False,
    )
    assert ack.emitted is False
    assert ack.reason == SILENT_REASON
    assert ack.accepted is False
    assert ack.live_tick_unchanged is True


def test_no_delta_dry_run() -> None:
    ack = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "at-nd",
            "kind": "comfy",
            "adapter": "comfy_pool",
            "state": "running",
            "progress": 0.3,
            "attempts": 0,
            "seq": 1,
        },
        prior_progress=0.3,
        prior_state="running",
    )
    assert ack.emitted is False
    assert ack.reason == NO_DELTA_REASON
    assert ack.decide_reason == NO_DELTA_REASON
    assert ack.accepted is False


def test_progress_delta_applies() -> None:
    bus = ProgressBus()
    from app.ray_control.ray_job_router_emit_gate import gate_dry_run

    gate_dry_run(sample_gate_wire(op="submit", job_id="at-pd", kind="echo", seq=1), bus=bus)
    gate_dry_run(sample_gate_wire(op="dispatch", job_id="at-pd", kind="echo", seq=2), bus=bus)
    ack = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "at-pd",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 3,
        },
        bus=bus,
        prior_progress=0.05,
        prior_state="running",
    )
    assert ack.emit is True
    assert ack.emitted is True
    assert ack.applied is True
    assert ack.bus_kind == JobEventKind.UPDATED.value
    assert ack.decide_reason == DELTA_EMIT_REASON


def test_regress_dropped_on_emit_path() -> None:
    bus = ProgressBus()
    from app.ray_control.ray_job_router_emit_gate import gate_dry_run

    gate_dry_run(sample_gate_wire(op="submit", job_id="at-rg", kind="echo", seq=1), bus=bus)
    gate_dry_run(sample_gate_wire(op="dispatch", job_id="at-rg", kind="echo", seq=2), bus=bus)
    hi = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "at-rg",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 3,
            "emit": True,
        },
        bus=bus,
        prior_progress=0.05,
        prior_state="running",
    )
    assert hi.applied is True
    regress = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "at-rg",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 4,
            "emit": True,
        },
        bus=bus,
        prior_progress=0.5,
        prior_state="running",
    )
    assert regress.applied is False
    assert regress.dropped_reason is not None
    assert "progress_regress" in str(regress.dropped_reason)


def test_run_cycle_flags() -> None:
    body = run_adapter_tick_silent_cycle()
    assert body["all_accepted_false"] is True
    assert body["all_join_ready_false"] is True
    assert body["ray_started"] is False
    assert body["live_tick_unchanged"] is True
    assert body["adapter_tick_emit_default_false"] is True
    assert body["adapter_tick_silent"] is True
    assert body["no_delta_silent"] is True
    assert body["progress_delta_applied"] is True
    assert body["state_delta_emit"] is True
    assert body["regress_dropped"] is True
    assert body["milestone"] == MILESTONE
    assert body["product_path"] == PRODUCT_PATH
    assert body["ticket"] == TICKET


def test_route_payload_flag_off() -> None:
    body = ray_job_router_adapter_tick_silent_contract_payload(enabled=False)
    assert body["enabled"] is False
    assert body["product_path"] == PRODUCT_PATH
    assert body["flag_default"] is False
    assert body["ray_started"] is False
    assert body["join_ready_any"] is False
    assert body["live_tick_unchanged"] is True
    assert body["step_count"] == 7
    assert "paths" in body
    static = contract_static_payload()
    assert static["milestone"] == MILESTONE
    assert static["reason"] == "ray_control_disabled"
    assert static["ticket"] == TICKET


def test_route_payload_flag_on_dry_run() -> None:
    body = ray_job_router_adapter_tick_silent_contract_payload(
        enabled=True, environ={RAY_CONTROL_ENV: "1"}
    )
    assert body["enabled"] is True
    assert body["all_accepted_false"] is True
    assert body["ray_started"] is False
    assert body["adapter_tick_silent"] is True
    assert body["progress_delta_applied"] is True
    assert body["regress_dropped"] is True


def test_product_path_indexed() -> None:
    entry = get_entry(PRODUCT_PATH)
    assert entry is not None
    assert entry.cycle == 70
    assert entry.product_path == PRODUCT_PATH
    assert entry.family == "catchup"
    assert "ray_job_router_adapter_tick_silent_contract_payload" in entry.helper


def test_flag_default_false_no_ray_start() -> None:
    from app.ray_control.flag import is_enabled

    assert is_enabled({}) is False
    assert is_enabled(None) is False
    body = contract_static_payload()
    assert body["flag_default"] is False
    assert body["ray_started"] is False
    assert body["accepted"] is False
