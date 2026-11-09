"""Cycle 64 — JobRouter emit-gate + kind→adapter contract tests."""

from __future__ import annotations

from app.ray_control.flag import RAY_CONTROL_ENV
from app.ray_control.progress_bus import ProgressBus
from app.ray_control.ray_job_router_emit_gate import (
    MILESTONE,
    PRODUCT_PATH,
    FIELD_CATALOG,
    KIND_TO_ADAPTER,
    catalog_covers_phase1_gate,
    contract_static_payload,
    gate_dry_run,
    resolve_adapter,
    run_job_router_emit_gate_cycle,
    sample_gate_wire,
    scheduler_op_alignment,
    validate_gate_payload,
)
from app.ray_control.routes_stream import ray_job_router_emit_gate_contract_payload
from app.ray_control.stream_product_paths import get_entry


def test_phase1_gate_coverage() -> None:
    cov = catalog_covers_phase1_gate()
    assert cov["ok"] is True
    assert cov["missing"] == []


def test_resolve_adapter_kinds() -> None:
    assert resolve_adapter("echo") == "echo"
    assert resolve_adapter("comfy") == "comfy_pool"
    assert resolve_adapter("llm") == "llm_gateway"
    assert resolve_adapter("generic") == "echo"
    assert resolve_adapter("generic", unknown_kind_policy="fail") == "fail"
    assert resolve_adapter("nope") == "fail"
    assert KIND_TO_ADAPTER["llm"] == "llm_gateway"


def test_validate_rejects_unknown_top_and_bad_op() -> None:
    bad = validate_gate_payload({"op": "submit", "job_id": "j1", "evil": 1})
    assert bad["ok"] is False
    assert any("unknown_top_level" in e for e in bad["errors"])
    bad_op = validate_gate_payload({"op": "nope", "job_id": "j1"})
    assert bad_op["ok"] is False


def test_validate_progress_and_terminal() -> None:
    bad_p = validate_gate_payload(
        {"op": "dispatch", "job_id": "j1", "kind": "echo", "state": "running", "progress": 1.5}
    )
    assert bad_p["ok"] is False
    bad_t = validate_gate_payload(
        {"op": "terminal", "job_id": "j1", "kind": "echo", "state": "running"}
    )
    assert bad_t["ok"] is False


def test_validate_bad_adapter() -> None:
    bad = validate_gate_payload(
        {"op": "dispatch", "job_id": "j1", "kind": "echo", "adapter": "nope"}
    )
    assert bad["ok"] is False


def test_submit_dispatch_llm_gateway() -> None:
    bus = ProgressBus()
    submit = gate_dry_run(sample_gate_wire(op="submit", kind="llm", seq=1), bus=bus)
    assert submit.validation_ok is True
    assert submit.adapter == "llm_gateway"
    assert submit.applied is True
    assert submit.accepted is False
    assert submit.emit is True
    dispatch = gate_dry_run(sample_gate_wire(op="dispatch", kind="llm", seq=2), bus=bus)
    assert dispatch.adapter == "llm_gateway"
    assert dispatch.applied is True
    assert dispatch.state == "running"


def test_comfy_pool_adapter() -> None:
    ack = gate_dry_run(sample_gate_wire(op="dispatch", kind="comfy", seq=1))
    assert ack.adapter == "comfy_pool"
    assert ack.applied is True


def test_adapter_tick_silent_default() -> None:
    bus = ProgressBus()
    gate_dry_run(sample_gate_wire(op="submit", kind="echo", seq=1), bus=bus)
    gate_dry_run(sample_gate_wire(op="dispatch", kind="echo", seq=2), bus=bus)
    silent = gate_dry_run(
        {**sample_gate_wire(op="adapter_tick", kind="echo", seq=3), "emit": False},
        bus=bus,
    )
    assert silent.emitted is False
    assert silent.reason == "emit_false_silent"
    assert silent.accepted is False


def test_adapter_tick_progress_then_regress() -> None:
    bus = ProgressBus()
    gate_dry_run(sample_gate_wire(op="submit", kind="llm", seq=1), bus=bus)
    gate_dry_run(sample_gate_wire(op="dispatch", kind="llm", seq=2), bus=bus)
    tick = gate_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-gate-1",
            "kind": "llm",
            "adapter": "llm_gateway",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 3,
            "emit": True,
        },
        bus=bus,
    )
    assert tick.applied is True
    regress = gate_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-gate-1",
            "kind": "llm",
            "adapter": "llm_gateway",
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 4,
            "emit": True,
        },
        bus=bus,
    )
    assert regress.applied is False
    assert regress.dropped_reason is not None
    assert "progress_regress" in (regress.dropped_reason or "")


def test_cancel_and_terminal() -> None:
    cancel = gate_dry_run(sample_gate_wire(op="cancel", kind="comfy", job_id="c1"))
    assert cancel.applied is True
    assert cancel.state == "cancelled"
    assert cancel.bus_kind == "job.terminal"
    term = gate_dry_run(sample_gate_wire(op="terminal", kind="echo", job_id="t1"))
    assert term.applied is True
    assert term.state == "succeeded"


def test_scheduler_emit_alignment() -> None:
    align = scheduler_op_alignment()
    assert align["all_emit_aligned"] is True


def test_run_cycle_all_accepted_false() -> None:
    body = run_job_router_emit_gate_cycle()
    assert body["all_accepted_false"] is True
    assert body["all_join_ready_false"] is True
    assert body["ray_started"] is False
    assert body["submit_applied"] is True
    assert body["dispatch_applied"] is True
    assert body["submit_adapter_llm_gateway"] is True
    assert body["comfy_adapter_comfy_pool"] is True
    assert body["adapter_tick_silent_not_emitted"] is True
    assert body["adapter_tick_applied"] is True
    assert body["regress_dropped"] is True
    assert body["terminal_applied"] is True
    assert body["cancel_applied"] is True
    assert body["milestone"] == MILESTONE
    assert body["product_path"] == PRODUCT_PATH


def test_route_payload_flag_off() -> None:
    body = ray_job_router_emit_gate_contract_payload(enabled=False)
    assert body["enabled"] is False
    assert body["product_path"] == PRODUCT_PATH
    assert body["flag_default"] is False
    assert body["ray_started"] is False
    assert body["join_ready_any"] is False
    assert body["field_catalog_count"] == len(FIELD_CATALOG)
    assert "paths" in body
    static = contract_static_payload()
    assert static["adapter_tick_emit_default_false"] is True


def test_route_payload_flag_on_dry_run() -> None:
    body = ray_job_router_emit_gate_contract_payload(
        enabled=True, environ={RAY_CONTROL_ENV: "1"}
    )
    assert body["enabled"] is True
    assert body["all_accepted_false"] is True
    assert body["ray_started"] is False


def test_product_path_indexed() -> None:
    entry = get_entry(PRODUCT_PATH)
    assert entry is not None
    assert entry.cycle == 64
    assert entry.product_path == PRODUCT_PATH
    assert "ray_job_router_emit_gate_contract_payload" in entry.helper
