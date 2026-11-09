"""Cycle 67 — JR-R1 _publish kind 三分 (enqueued / updated / terminal) tests."""

from __future__ import annotations

from app.ray_control.flag import RAY_CONTROL_ENV
from app.ray_control.progress_bus import JobEventKind, ProgressBus
from app.ray_control.ray_job_router_emit_gate import OP_DEFAULTS, ROUTER_OPS, sample_gate_wire
from app.ray_control.ray_job_router_publish_kind_split import (
    MILESTONE,
    PRODUCT_PATH,
    PUBLISH_KIND_STEPS,
    build_publish_event,
    catalog_integrity,
    contract_static_payload,
    kind_split_dry_run,
    live_publish_gap_report,
    op_bus_kind_map,
    publish_kind_for,
    run_publish_kind_split_cycle,
    step_catalog,
)
from app.ray_control.routes_stream import ray_job_router_publish_kind_split_contract_payload
from app.ray_control.stream_product_paths import get_entry


def test_step_catalog_pk1_to_pk6() -> None:
    rows = step_catalog()
    assert len(rows) == 6
    assert [r["id"] for r in rows] == ["PK1", "PK2", "PK3", "PK4", "PK5", "PK6"]
    assert len(PUBLISH_KIND_STEPS) == 6


def test_catalog_integrity_and_op_map() -> None:
    integ = catalog_integrity()
    assert integ["ok"] is True
    assert integ["missing_ids"] == []
    assert integ["reuses_c64_op_defaults"] is True
    assert integ["map_matches_expected_三分"] is True
    op_map = op_bus_kind_map()
    assert op_map["submit"] == JobEventKind.ENQUEUED.value
    assert op_map["dispatch"] == JobEventKind.UPDATED.value
    assert op_map["adapter_tick"] == JobEventKind.UPDATED.value
    assert op_map["cancel"] == JobEventKind.TERMINAL.value
    assert op_map["terminal"] == JobEventKind.TERMINAL.value
    for op in ROUTER_OPS:
        assert op_map[op] == OP_DEFAULTS[op]["bus_kind"]


def test_live_gap_always_updated() -> None:
    """Post JR-R1 tip merge: _publish(op) 三分 is applied (gap closed)."""
    gap = live_publish_gap_report()
    assert gap["jr_r1_applied"] is True
    assert gap["live_always_updated"] is False
    assert gap["has_job_event_updated_call"] is True
    assert gap["has_job_event_enqueued_call"] is True
    assert gap["has_op_param"] is True
    assert gap["mutated_this_cycle"] is True
    assert gap["intentional_kouling_gate"] is False
    assert gap["live_publish_unchanged"] is False
    assert "JR-R1" in gap["summary"]


def test_publish_kind_for_三分() -> None:
    assert publish_kind_for("submit") == "job.enqueued"
    assert publish_kind_for("dispatch") == "job.updated"
    assert publish_kind_for("adapter_tick") == "job.updated"
    assert publish_kind_for("cancel") == "job.terminal"
    assert publish_kind_for("terminal") == "job.terminal"
    assert publish_kind_for("submit", state="succeeded") == "job.terminal"
    assert publish_kind_for("nope") is None


def test_dry_run_kind_selection_submit_dispatch_terminal_cancel() -> None:
    bus = ProgressBus()
    submit = kind_split_dry_run(
        sample_gate_wire(op="submit", job_id="pk-a", kind="llm", seq=1), bus=bus
    )
    assert submit.validation_ok is True
    assert submit.actual_kind == "job.enqueued"
    assert submit.applied is True
    assert submit.accepted is False
    assert submit.accepted is False  # dry-run ack; tip source already merged

    dispatch = kind_split_dry_run(
        sample_gate_wire(op="dispatch", job_id="pk-a", kind="llm", seq=2), bus=bus
    )
    assert dispatch.actual_kind == "job.updated"
    assert dispatch.applied is True

    terminal = kind_split_dry_run(
        sample_gate_wire(op="terminal", job_id="pk-a", kind="llm", seq=3), bus=bus
    )
    assert terminal.actual_kind == "job.terminal"
    assert terminal.applied is True

    cancel = kind_split_dry_run(
        sample_gate_wire(op="cancel", job_id="pk-b", kind="comfy", seq=1)
    )
    assert cancel.actual_kind == "job.terminal"
    assert cancel.state == "cancelled"
    assert cancel.accepted is False


def test_wrong_kind_dropped() -> None:
    ack = kind_split_dry_run(
        sample_gate_wire(op="submit", job_id="pk-wrong", kind="echo", seq=1),
        force_bus_kind=JobEventKind.UPDATED.value,
    )
    assert ack.wrong_kind is True
    assert ack.applied is False
    assert ack.dropped_reason == "wrong_kind"
    assert ack.reason == "wrong_kind"
    assert ack.accepted is False


def test_build_publish_event_enqueued_vs_live_updated() -> None:
    built = build_publish_event(op="submit", job_id="pk-build", kind="echo", seq=1)
    assert built["expected_kind"] == "job.enqueued"
    assert built["event"] is not None
    assert built["event"].kind is JobEventKind.ENQUEUED
    assert built["wrong_kind"] is False


def test_run_cycle_flags_and_kinds() -> None:
    body = run_publish_kind_split_cycle()
    assert body["all_accepted_false"] is True
    assert body["all_join_ready_false"] is True
    assert body["ray_started"] is False
    assert body["live_publish_unchanged"] is False
    assert body.get("jr_r1_applied") is True
    assert body["live_always_updated"] is False
    assert body["submit_kind_enqueued"] is True
    assert body["dispatch_kind_updated"] is True
    assert body["terminal_kind_terminal"] is True
    assert body["cancel_kind_terminal"] is True
    assert body["wrong_kind_dropped"] is True
    assert body["adapter_tick_silent"] is True
    assert body["regress_dropped"] is True
    assert body["milestone"] == MILESTONE
    assert body["product_path"] == PRODUCT_PATH
    assert body["ticket"] == "JR-R1"


def test_route_payload_flag_off() -> None:
    body = ray_job_router_publish_kind_split_contract_payload(enabled=False)
    assert body["enabled"] is False
    assert body["product_path"] == PRODUCT_PATH
    assert body["flag_default"] is False
    assert body["ray_started"] is False
    assert body["join_ready_any"] is False
    assert body.get("jr_r1_applied") is True
    assert body["live_always_updated"] is False
    assert body["live_publish_unchanged"] is False
    assert body["step_count"] == 6
    assert "paths" in body
    static = contract_static_payload()
    assert static["milestone"] == MILESTONE
    assert static["reason"] == "ray_control_disabled"


def test_route_payload_flag_on_dry_run() -> None:
    body = ray_job_router_publish_kind_split_contract_payload(
        enabled=True, environ={RAY_CONTROL_ENV: "1"}
    )
    assert body["enabled"] is True
    assert body["all_accepted_false"] is True
    assert body["ray_started"] is False
    assert body["submit_kind_enqueued"] is True
    assert body["wrong_kind_dropped"] is True


def test_product_path_indexed() -> None:
    entry = get_entry(PRODUCT_PATH)
    assert entry is not None
    assert entry.cycle == 67
    assert entry.product_path == PRODUCT_PATH
    assert entry.family == "catchup"
    assert "ray_job_router_publish_kind_split_contract_payload" in entry.helper
    assert entry.tip_mount is False


def test_flag_default_false_no_ray_start() -> None:
    from app.ray_control.flag import is_enabled

    assert is_enabled({}) is False
    assert is_enabled(None) is False
    body = contract_static_payload()
    assert body["flag_default"] is False
    assert body["ray_started"] is False
    assert body["accepted"] is False
