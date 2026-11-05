"""Cycle 79 — JR-R4 ProgressBus regress-drop parity tests."""

from __future__ import annotations

from app.ray_control.flag import RAY_CONTROL_ENV
from app.ray_control.ray_job_router_progress_regress_parity import (
    MILESTONE,
    PRODUCT_PATH,
    REGRESS_PARITY_STEPS,
    REGRESS_REASON_TOKEN,
    TICKET,
    bus_apply_monotonic_advance,
    bus_apply_regress_pair,
    bus_apply_retry_reset,
    bus_apply_terminal_lower_progress,
    catalog_integrity,
    contract_static_payload,
    emit_gate_regress_pair,
    run_progress_regress_parity_cycle,
    scheduler_glue_regress_pair,
    step_catalog,
)
from app.ray_control.routes_stream import ray_job_router_progress_regress_parity_contract_payload
from app.ray_control.stream_product_paths import get_entry


def test_step_catalog_pr1_to_pr7() -> None:
    rows = step_catalog()
    assert len(rows) == 7
    assert [r["id"] for r in rows] == ["PR1", "PR2", "PR3", "PR4", "PR5", "PR6", "PR7"]
    assert len(REGRESS_PARITY_STEPS) == 7


def test_catalog_integrity() -> None:
    integ = catalog_integrity()
    assert integ["ok"] is True
    assert integ["missing_ids"] == []
    assert integ["baseline_regress_ok"] is True
    assert integ["monotonic_ok"] is True
    assert integ["ticket"] == TICKET
    assert integ["product_path"] == PRODUCT_PATH


def test_pr1_bus_regress_drop() -> None:
    ack = bus_apply_regress_pair()
    assert ack.applied is False
    assert ack.dropped_reason is not None
    assert REGRESS_REASON_TOKEN in str(ack.dropped_reason)
    assert ack.progress == 0.5
    assert ack.accepted is False


def test_pr2_retry_reset_applies() -> None:
    ack = bus_apply_retry_reset()
    assert ack.applied is True
    assert ack.progress == 0.0
    assert ack.attempts == 1


def test_pr3_terminal_lower_progress_applies() -> None:
    ack = bus_apply_terminal_lower_progress()
    assert ack.applied is True
    assert ack.terminal is True
    assert ack.state == "succeeded"
    assert ack.progress == 0.4


def test_pr4_emit_gate_regress() -> None:
    hi, regress = emit_gate_regress_pair()
    assert hi.applied is True
    assert regress.applied is False
    assert regress.dropped_reason is not None
    assert REGRESS_REASON_TOKEN in str(regress.dropped_reason)
    assert regress.accepted is False


def test_pr5_scheduler_glue_regress() -> None:
    hi, regress = scheduler_glue_regress_pair()
    assert hi.applied is True
    assert regress.applied is False
    assert regress.dropped_reason is not None
    assert REGRESS_REASON_TOKEN in str(regress.dropped_reason)


def test_pr6_monotonic_advance() -> None:
    ack = bus_apply_monotonic_advance()
    assert ack.applied is True
    assert ack.progress == 0.5


def test_run_cycle_parity_ok() -> None:
    body = run_progress_regress_parity_cycle()
    assert body["regress_parity_ok"] is True
    assert body["pr1_regress_dropped"] is True
    assert body["pr2_retry_reset_applied"] is True
    assert body["pr3_terminal_applied"] is True
    assert body["pr4_gate_regress_dropped"] is True
    assert body["pr5_glue_regress_dropped"] is True
    assert body["pr6_monotonic_applied"] is True
    assert body["all_accepted_false"] is True
    assert body["accepted"] is False
    assert body["ray_started"] is False
    assert body["join_ready_any"] is False
    assert body["live_bus_unchanged"] is True
    assert body["milestone"] == MILESTONE
    assert body["ticket"] == TICKET
    assert body["fills_empty_cycles"] == list(range(71, 79))


def test_contract_static_payload_flag_off() -> None:
    body = contract_static_payload()
    assert body["enabled"] is False
    assert body["reason"] == "ray_control_disabled"
    assert body["flag_default"] is False
    assert body["step_count"] == 7
    assert body["accepted"] is False
    assert "改码卡" in body["needs_kouling"]


def test_route_payload_flag_off_and_on(monkeypatch) -> None:
    off = ray_job_router_progress_regress_parity_contract_payload()
    assert off["enabled"] is False
    assert off["product_path"] == PRODUCT_PATH
    assert off["paths"]["sse"]
    assert off["paths"]["ws"]

    on = ray_job_router_progress_regress_parity_contract_payload(
        enabled=True, sample_job_id="route-pr"
    )
    assert on["enabled"] is True
    assert on["regress_parity_ok"] is True
    assert on["accepted"] is False

    monkeypatch.setenv(RAY_CONTROL_ENV, "1")
    env_on = ray_job_router_progress_regress_parity_contract_payload(
        environ={RAY_CONTROL_ENV: "1"}
    )
    assert env_on["enabled"] is True
    assert env_on["regress_parity_ok"] is True


def test_product_path_indexed() -> None:
    entry = get_entry(PRODUCT_PATH)
    assert entry is not None
    assert entry.cycle == 79
    assert entry.helper.endswith("ray_job_router_progress_regress_parity_contract_payload")
    assert entry.product_path == PRODUCT_PATH
