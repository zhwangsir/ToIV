"""Cycle 66 — FE tip portal pseudocode deepen tests."""

from __future__ import annotations

from app.ray_control.flag import RAY_CONTROL_ENV, is_enabled
from app.ray_control.ray_job_router_emit_gate import OP_DEFAULTS
from app.ray_control.routes_stream import fe_tip_portal_pseudocode_payload
from app.ray_control.stream_product_paths import get_entry
from app.ray_control.stream_tip_portal import (
    MILESTONE,
    PORTAL_ANCHORS,
    PORTAL_HOSTS,
    PORTAL_STEPS,
    PRODUCT_PATH,
    TERMINAL_PORTAL_MAP,
    competitor_pattern_rows,
    contract_static_payload,
    get_portal_step,
    kouling_step_ids,
    offline_step_ids,
    portal_checklist,
    project_open_close_intents,
    role_aware_tip_samples,
    run_tip_portal_cycle,
    terminal_to_portal_intent,
)
from app.ray_control.stream_readonly_shell_tip_mount import TIP_MOUNT_PRODUCT_PATH, TipBinding


def test_checklist_seven_steps_ordered() -> None:
    rows = portal_checklist()
    assert len(rows) == 7
    assert [r["id"] for r in rows] == [
        "TP1",
        "TP2",
        "TP3",
        "TP4",
        "TP5",
        "TP6",
        "TP7",
    ]
    assert len(PORTAL_STEPS) == 7
    assert offline_step_ids() == ["TP1", "TP2", "TP3", "TP4", "TP5"]
    assert kouling_step_ids() == ["TP6", "TP7"]
    tp6 = get_portal_step("TP6")
    assert tp6 is not None
    assert "改码卡" in tp6.kouling_blocker
    assert "Ray LAN（含 head）" in tp6.kouling_blocker
    tp7 = get_portal_step("TP7")
    assert tp7 is not None
    assert tp7.implementable_offline is False


def test_hosts_and_anchors() -> None:
    assert list(PORTAL_HOSTS) == ["create_rail", "task_center"]
    ids = [a.id for a in PORTAL_ANCHORS]
    assert ids == [
        "cta_button",
        "soft_action",
        "banner",
        "badge",
        "task_row",
        "toast_focus",
    ]


def test_role_flip_tips() -> None:
    role = role_aware_tip_samples()
    assert role["leader_is_领导可写"] is True
    assert role["follower_starts_with_跟随页不可"] is True
    assert role["soft_has_跟随可查看"] is True
    assert role["soft_never_请切到领导标签"] is True
    assert role["create_job_leader"] == "领导可写"
    assert role["c55_product_path"] == TIP_MOUNT_PRODUCT_PATH


def test_terminal_to_portal_intent() -> None:
    for state in ("succeeded", "failed", "cancelled"):
        body = terminal_to_portal_intent(state, job_id="j1")
        assert body["ok"] is True
        assert body["tip_mount"] is False
        assert body["accepted"] is False
        assert body["ray_started"] is False
        assert body["join_ready"] is False
        assert body["c64_bus_kind_ok"] is True
        assert len(body["intents"]) == 2
        kinds = {i["kind"] for i in body["intents"]}
        assert kinds == {"terminal_toast", "terminal_tip"}
        assert all(i["tip_mount"] is False for i in body["intents"])
        assert all(i["accepted"] is False for i in body["intents"])
    bad = terminal_to_portal_intent("running")
    assert bad["ok"] is False
    assert bad["reason"] == "unknown_terminal_state"
    assert set(TERMINAL_PORTAL_MAP) == {"succeeded", "failed", "cancelled"}


def test_open_close_intents_tip_mount_false() -> None:
    bindings = [
        TipBinding(
            tab_id="tab-a",
            action_id="create_job",
            mode="interactive",
            tip_zh="领导可写",
            mount_target="cta_button",
            tip_delay_ms=280,
            locked=False,
            cursor="pointer",
        )
    ]
    intents = project_open_close_intents(bindings)
    assert len(intents) == 2
    assert {i["kind"] for i in intents} == {"open", "close"}
    assert all(i["tip_mount"] is False for i in intents)
    assert all(i["accepted"] is False for i in intents)
    open_i = next(i for i in intents if i["kind"] == "open")
    assert open_i["delay_ms"] == 280
    assert open_i["phase"] == "delay"


def test_run_cycle_honesty_flags() -> None:
    body = run_tip_portal_cycle()
    assert body["product_path"] == PRODUCT_PATH
    assert body["milestone"] == MILESTONE
    assert body["tip_mount"] is False
    assert body["accepted"] is False
    assert body["ray_started"] is False
    assert body["join_ready"] is False
    assert body["all_accepted_false"] is True
    assert body["all_tip_mount_false"] is True
    assert body["c64_terminal_bus_ok"] is True
    assert body["bad_terminal_rejected"] is True
    assert body["failover_ok"] is True
    assert body["tp6_blocked"] is True
    assert body["tp7_blocked"] is True
    assert body["binding_count"] > 0
    assert body["all_open_intents_tip_mount_false"] is True
    assert "改码卡" in body["needs_kouling"]
    assert len(body["checklist"]) == 7
    assert body["steps_dry_runnable"] == ["TP1", "TP2", "TP3", "TP4", "TP5"]


def test_competitor_patterns() -> None:
    rows = competitor_pattern_rows()
    assert len(rows) == 6
    assert any(r["toiv_step"] == "TP6" for r in rows)
    assert any(r["toiv_step"] == "TP7" for r in rows)


def test_flag_default_false() -> None:
    assert is_enabled({}) is False
    assert is_enabled({RAY_CONTROL_ENV: ""}) is False
    assert is_enabled({RAY_CONTROL_ENV: "false"}) is False
    assert OP_DEFAULTS["terminal"]["bus_kind"] == "job.terminal"
    assert OP_DEFAULTS["terminal"]["emit"] is True
    assert OP_DEFAULTS["adapter_tick"]["emit"] is False


def test_route_payload_flag_off() -> None:
    body = fe_tip_portal_pseudocode_payload(enabled=False)
    assert body["enabled"] is False
    assert body["product_path"] == PRODUCT_PATH
    assert body["milestone"] == MILESTONE
    assert body["flag_default"] is False
    assert body["tip_mount"] is False
    assert body["accepted"] is False
    assert body["ray_started"] is False
    assert body["join_ready"] is False
    assert body["reason"] == "ray_control_disabled"
    assert len(body["checklist"]) == 7
    assert "TP6" in body["steps_need_kouling"]
    assert "paths" in body
    static = contract_static_payload()
    assert static["milestone"] == MILESTONE
    assert static["tip_mount"] is False


def test_route_payload_flag_on_still_unmounted() -> None:
    body = fe_tip_portal_pseudocode_payload(
        enabled=True, environ={RAY_CONTROL_ENV: "1"}
    )
    assert body["enabled"] is True
    assert body["tip_mount"] is False
    assert body["accepted"] is False
    assert body["ray_started"] is False
    assert body["join_ready"] is False
    assert body["all_accepted_false"] is True
    assert body["failover_ok"] is True


def test_product_path_indexed() -> None:
    entry = get_entry(PRODUCT_PATH)
    assert entry is not None
    assert entry.cycle == 66
    assert entry.product_path == PRODUCT_PATH
    assert entry.family == "catchup"
    assert "fe_tip_portal_pseudocode_payload" in entry.helper
    assert entry.tip_mount is False


def test_no_ray_start_constants() -> None:
    body = run_tip_portal_cycle()
    assert body["ray_started"] is False
    assert body["join_ready_any"] is False
    off = fe_tip_portal_pseudocode_payload(environ={RAY_CONTROL_ENV: "0"})
    assert off["ray_started"] is False
    assert off["join_ready"] is False
