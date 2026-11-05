"""Cycle 81 — JR-R3 kind→adapter table parity tests."""

from __future__ import annotations

from app.ray_control.flag import RAY_CONTROL_ENV
from app.ray_control.ray_job_router_kind_adapter_parity import (
    HELPER_RESOLVE_DEFAULT,
    KIND_ADAPTER_STEPS,
    LIVE_CONFIG_DEFAULT,
    MILESTONE,
    PRODUCT_PATH,
    TICKET,
    catalog_integrity,
    contract_static_payload,
    generic_policy_matrix,
    live_default_policy_gap_report,
    live_route_kind_parity,
    resolve_known_kinds,
    run_kind_adapter_parity_cycle,
    step_catalog,
    table_integrity,
    unknown_kind_resolves_fail,
)
from app.ray_control.routes_stream import ray_job_router_kind_adapter_parity_contract_payload
from app.ray_control.stream_product_paths import get_entry


def test_step_catalog_ka1_to_ka7() -> None:
    rows = step_catalog()
    assert len(rows) == 7
    assert [r["id"] for r in rows] == ["KA1", "KA2", "KA3", "KA4", "KA5", "KA6", "KA7"]
    assert len(KIND_ADAPTER_STEPS) == 7


def test_catalog_integrity() -> None:
    integ = catalog_integrity()
    assert integ["ok"] is True
    assert integ["missing_ids"] == []
    assert integ["ticket"] == TICKET
    assert integ["product_path"] == PRODUCT_PATH
    assert integ["milestone"] == MILESTONE


def test_ka1_table_integrity() -> None:
    t = table_integrity()
    assert t["ok"] is True
    assert t["kind_to_adapter"]["echo"] == "echo"
    assert t["kind_to_adapter"]["comfy"] == "comfy_pool"
    assert t["kind_to_adapter"]["llm"] == "llm_gateway"
    assert t["kind_to_adapter"]["generic"] == "echo"


def test_ka2_resolve_known_kinds() -> None:
    t = resolve_known_kinds()
    assert t["ok"] is True


def test_ka3_generic_policy_matrix() -> None:
    t = generic_policy_matrix()
    assert t["ok"] is True
    assert t["echo_policy"] == "echo"
    assert t["fail_policy"] == "fail"


def test_ka4_live_route_kind_parity() -> None:
    t = live_route_kind_parity()
    assert t["ok"] is True
    assert all(r["match"] for r in t["rows"])


def test_ka5_live_default_policy_gap() -> None:
    gap = live_default_policy_gap_report()
    assert gap["live_config_default"] == LIVE_CONFIG_DEFAULT == "fail"
    assert gap["helper_resolve_default_policy"] == HELPER_RESOLVE_DEFAULT == "echo"
    assert gap["gap_documented"] is True
    assert gap["mutated_this_cycle"] is False
    assert gap["config_source_default_fail"] is True
    assert gap["live_source_has_echo_comfy_llm_branches"] is True


def test_ka6_unknown_kind_fail() -> None:
    t = unknown_kind_resolves_fail()
    assert t["ok"] is True


def test_ka7_cycle_freeze_gates() -> None:
    body = run_kind_adapter_parity_cycle()
    assert body["accepted"] is False
    assert body["ray_started"] is False
    assert body["join_ready_any"] is False
    assert body["live_route_kind_unchanged"] is True
    assert body["kind_adapter_parity_ok"] is True
    assert body["fills_empty_cycles"] == [75, 80]
    assert body["ticket"] == TICKET
    assert body["milestone"] == MILESTONE


def test_route_payload_flag_off() -> None:
    body = ray_job_router_kind_adapter_parity_contract_payload(enabled=False)
    assert body["enabled"] is False
    assert body["accepted"] is False
    assert body["flag_default"] is False
    assert body["product_path"] == PRODUCT_PATH
    assert "paths" in body


def test_route_payload_flag_on_still_accepted_false(monkeypatch) -> None:
    monkeypatch.setenv(RAY_CONTROL_ENV, "1")
    body = ray_job_router_kind_adapter_parity_contract_payload(enabled=True)
    assert body["enabled"] is True
    assert body["accepted"] is False
    assert body["kind_adapter_parity_ok"] is True
    assert body["live_route_kind_unchanged"] is True


def test_static_payload_shape() -> None:
    body = contract_static_payload()
    assert body["enabled"] is False
    assert body["reason"] == "flag_default_off"
    assert body["step_count"] == 7
    assert body["fills_empty_cycles"] == [75, 80]


def test_product_path_indexed() -> None:
    entry = get_entry(PRODUCT_PATH)
    assert entry is not None
    assert entry.product_path == PRODUCT_PATH
    assert entry.cycle == 81
    assert "kind_adapter" in entry.helper or "kind_adapter" in entry.helper
