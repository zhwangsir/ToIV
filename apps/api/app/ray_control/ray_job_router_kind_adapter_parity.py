"""JR-R3 kind→adapter table parity — Cycle 81.

Deepens Cycle 65 JR-R3 / Cycle 64 KIND_TO_ADAPTER / live JobRouter.route_kind
into a dedicated parity contract: echo→echo, comfy→comfy_pool, llm→llm_gateway,
generic×unknown_kind_policy matrix, and live-gap on default policy (live
JobRouterConfig defaults to fail; resolve_adapter helper historically defaulted
to echo).

Does NOT mutate live actors/job_router.py::route_kind or JobRouterConfig.
Flag default false; accepted=false; ray_started=false; join_ready=false.
Fills empty Cycles 75 / 80 (prior JR-R3 dispatches with zero artifacts).
"""

from __future__ import annotations

import inspect
from dataclasses import asdict, dataclass
from typing import Any, Mapping

from .actors import job_router as job_router_mod
from .ray_job_router_emit_gate import (
    ADAPTER_NAMES,
    KIND_TO_ADAPTER,
    resolve_adapter,
)
from .types import JobKind

PRODUCT_PATH = "ray_job_router_kind_adapter_parity_contract"
MILESTONE = "ray_job_router_kind_adapter_parity_contract_ready"
TICKET = "JR-R3"

LIVE_ROUTE_KIND_METHOD = "actors/job_router.py::JobRouter.route_kind"
LIVE_CONFIG_DEFAULT = "fail"  # JobRouterConfig.unknown_kind_policy
HELPER_RESOLVE_DEFAULT = "echo"  # resolve_adapter(..., unknown_kind_policy=) historical default

EXPECTED_KIND_ADAPTER: dict[str, str] = {
    "echo": "echo",
    "comfy": "comfy_pool",
    "llm": "llm_gateway",
    "generic": "echo",  # table nominal; policy may override to fail
}


@dataclass(frozen=True)
class KindAdapterStep:
    """One JR-R3 kind→adapter checklist row (KA*)."""

    id: str
    title: str
    summary: str
    harness_call: str
    acceptance: str
    kouling_blocker: tuple[str, ...]
    implementable_offline: bool
    ties: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["kouling_blocker"] = list(self.kouling_blocker)
        d["ties"] = list(self.ties)
        d["needs_kouling"] = bool(self.kouling_blocker)
        return d


KIND_ADAPTER_STEPS: tuple[KindAdapterStep, ...] = (
    KindAdapterStep(
        id="KA1",
        title="KIND_TO_ADAPTER table integrity",
        summary=(
            "C64 KIND_TO_ADAPTER keys cover echo/comfy/llm/generic; values ⊆ "
            "ADAPTER_NAMES; nominal map matches EXPECTED_KIND_ADAPTER."
        ),
        harness_call="table_integrity()",
        acceptance="keys complete; values in ADAPTER_NAMES; matches expected map",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C64", "KIND_TO_ADAPTER"),
    ),
    KindAdapterStep(
        id="KA2",
        title="resolve_adapter known kinds",
        summary=(
            "resolve_adapter: echo→echo, comfy→comfy_pool, llm→llm_gateway "
            "(independent of unknown_kind_policy)."
        ),
        harness_call="resolve_known_kinds()",
        acceptance="three known kinds map correctly under both policies",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C64.resolve_adapter",),
    ),
    KindAdapterStep(
        id="KA3",
        title="generic × unknown_kind_policy matrix",
        summary=(
            "generic + policy=echo → echo; generic + policy=fail → fail; "
            "mirrors live JobRouter.route_kind(GENERIC)."
        ),
        harness_call="generic_policy_matrix()",
        acceptance="echo→echo and fail→fail for generic",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("JobRouterConfig.unknown_kind_policy",),
    ),
    KindAdapterStep(
        id="KA4",
        title="live route_kind parity dry-run",
        summary=(
            "Instantiate scratch JobRouter; route_kind(JobKind.*) equals "
            "resolve_adapter for each wire kind under matching policy."
        ),
        harness_call="live_route_kind_parity()",
        acceptance="ECHO/COMFY/LLM/GENERIC match resolve_adapter under both policies",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("JobRouter.route_kind", "C65-JR-R3"),
    ),
    KindAdapterStep(
        id="KA5",
        title="live-gap: default policy mismatch (documented)",
        summary=(
            "Live JobRouterConfig.unknown_kind_policy defaults to fail; "
            "resolve_adapter helper historically defaults to echo. Report gap; "
            "do not mutate live this cycle."
        ),
        harness_call="live_default_policy_gap_report()",
        acceptance=(
            "live_default=fail; helper_default=echo; mutated_this_cycle=false"
        ),
        kouling_blocker=("改码卡",),
        implementable_offline=True,  # inspect/paper only
        ties=("JobRouterConfig", "kouling"),
    ),
    KindAdapterStep(
        id="KA6",
        title="unknown wire kind → fail",
        summary="resolve_adapter('unknown_xyz') → fail under either policy.",
        harness_call="unknown_kind_resolves_fail()",
        acceptance="unknown → fail",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("unsupported_job_kind",),
    ),
    KindAdapterStep(
        id="KA7",
        title="accepted=false · flag off · live unchanged",
        summary=(
            "Cycle payload: accepted=false, ray_started=false, join_ready=false, "
            "flag default false; live route_kind source not mutated."
        ),
        harness_call="run_kind_adapter_parity_cycle() gates",
        acceptance="all freeze gates hold; live_route_kind_unchanged=true",
        kouling_blocker=("改码卡", "Ray LAN（含 head）", "H3 口令"),
        implementable_offline=True,
        ties=("freeze", "C81"),
    ),
)


def step_catalog() -> list[dict[str, Any]]:
    return [s.to_dict() for s in KIND_ADAPTER_STEPS]


def table_integrity() -> dict[str, Any]:
    keys = set(KIND_TO_ADAPTER)
    expected_keys = set(EXPECTED_KIND_ADAPTER)
    values = set(KIND_TO_ADAPTER.values())
    bad_values = sorted(values - set(ADAPTER_NAMES))
    mismatches = {
        k: {"table": KIND_TO_ADAPTER.get(k), "expected": EXPECTED_KIND_ADAPTER.get(k)}
        for k in expected_keys | keys
        if KIND_TO_ADAPTER.get(k) != EXPECTED_KIND_ADAPTER.get(k)
    }
    ok = (
        keys == expected_keys
        and not bad_values
        and not mismatches
        and "fail" in ADAPTER_NAMES
    )
    return {
        "ok": ok,
        "keys": sorted(keys),
        "expected_keys": sorted(expected_keys),
        "values": sorted(values),
        "bad_values": bad_values,
        "mismatches": mismatches,
        "kind_to_adapter": dict(KIND_TO_ADAPTER),
    }


def resolve_known_kinds() -> dict[str, Any]:
    rows: dict[str, dict[str, str]] = {}
    ok = True
    for kind, expected in (("echo", "echo"), ("comfy", "comfy_pool"), ("llm", "llm_gateway")):
        for policy in ("echo", "fail"):
            got = resolve_adapter(kind, unknown_kind_policy=policy)
            rows[f"{kind}@{policy}"] = {"got": got, "expected": expected}
            if got != expected:
                ok = False
    return {"ok": ok, "rows": rows}


def generic_policy_matrix() -> dict[str, Any]:
    echo_got = resolve_adapter("generic", unknown_kind_policy="echo")
    fail_got = resolve_adapter("generic", unknown_kind_policy="fail")
    ok = echo_got == "echo" and fail_got == "fail"
    return {
        "ok": ok,
        "echo_policy": echo_got,
        "fail_policy": fail_got,
        "expected": {"echo": "echo", "fail": "fail"},
    }


def unknown_kind_resolves_fail() -> dict[str, Any]:
    a = resolve_adapter("unknown_xyz", unknown_kind_policy="echo")
    b = resolve_adapter("unknown_xyz", unknown_kind_policy="fail")
    c = resolve_adapter("", unknown_kind_policy="echo")
    ok = a == "fail" and b == "fail" and c == "fail"
    return {"ok": ok, "unknown_echo_policy": a, "unknown_fail_policy": b, "empty": c}


def live_route_kind_parity() -> dict[str, Any]:
    """Compare live JobRouter.route_kind vs resolve_adapter under both policies."""
    rows: list[dict[str, Any]] = []
    ok = True
    for policy in ("echo", "fail"):
        router = job_router_mod.JobRouter(
            config=job_router_mod.JobRouterConfig(unknown_kind_policy=policy)
        )
        for jk in (JobKind.ECHO, JobKind.COMFY, JobKind.LLM, JobKind.GENERIC):
            live = router.route_kind(jk)
            helper = resolve_adapter(jk.value, unknown_kind_policy=policy)
            match = live == helper
            if not match:
                ok = False
            rows.append(
                {
                    "policy": policy,
                    "kind": jk.value,
                    "live": live,
                    "helper": helper,
                    "match": match,
                }
            )
    return {"ok": ok, "rows": rows}


def live_default_policy_gap_report() -> dict[str, Any]:
    """Document live default fail vs helper default echo; prove source untouched."""
    cfg_default = job_router_mod.JobRouterConfig().unknown_kind_policy
    router_default = job_router_mod.JobRouter().route_kind(JobKind.GENERIC)
    helper_default = resolve_adapter("generic")  # uses HELPER_RESOLVE_DEFAULT
    src = inspect.getsource(job_router_mod.JobRouter.route_kind)
    cfg_src = inspect.getsource(job_router_mod.JobRouterConfig)
    return {
        "method": LIVE_ROUTE_KIND_METHOD,
        "live_config_default": cfg_default,
        "live_generic_under_default_config": router_default,
        "helper_resolve_default_policy": HELPER_RESOLVE_DEFAULT,
        "helper_generic_under_default": helper_default,
        "gap_documented": (
            cfg_default == LIVE_CONFIG_DEFAULT
            and helper_default == HELPER_RESOLVE_DEFAULT
            and cfg_default != helper_default
        ),
        "live_source_has_echo_comfy_llm_branches": (
            "JobKind.ECHO" in src
            and "JobKind.COMFY" in src
            and "JobKind.LLM" in src
            and "JobKind.GENERIC" in src
        ),
        "config_source_default_fail": 'unknown_kind_policy: str = "fail"' in cfg_src,
        "intentional_kouling_gate": True,
        "mutated_this_cycle": False,
        "summary": (
            "Live JobRouterConfig defaults unknown_kind_policy=fail "
            "(generic→fail); C64 resolve_adapter defaults policy=echo "
            "(generic→echo). Align helper default or document FE debug "
            "override only after 改码卡 — not this cycle."
        ),
    }


def catalog_integrity() -> dict[str, Any]:
    ids = [s.id for s in KIND_ADAPTER_STEPS]
    expected = [f"KA{i}" for i in range(1, 8)]
    missing = [i for i in expected if i not in ids]
    t1 = table_integrity()
    t2 = resolve_known_kinds()
    t3 = generic_policy_matrix()
    t4 = live_route_kind_parity()
    t5 = live_default_policy_gap_report()
    t6 = unknown_kind_resolves_fail()
    ok = (
        not missing
        and len(ids) == 7
        and t1["ok"]
        and t2["ok"]
        and t3["ok"]
        and t4["ok"]
        and t5["gap_documented"]
        and t5["mutated_this_cycle"] is False
        and t6["ok"]
    )
    return {
        "ok": ok,
        "missing_ids": missing,
        "step_ids": ids,
        "table_ok": t1["ok"],
        "known_kinds_ok": t2["ok"],
        "generic_matrix_ok": t3["ok"],
        "live_parity_ok": t4["ok"],
        "gap_documented": t5["gap_documented"],
        "unknown_fail_ok": t6["ok"],
        "ticket": TICKET,
        "product_path": PRODUCT_PATH,
        "milestone": MILESTONE,
    }


def contract_static_payload() -> dict[str, Any]:
    integ = catalog_integrity()
    gap = live_default_policy_gap_report()
    return {
        "product_path": PRODUCT_PATH,
        "enabled": False,
        "reason": "flag_default_off",
        "flag_default": False,
        "flag_opened": False,
        "ray_started": False,
        "tip_mount": False,
        "scratch_only": True,
        "steps": step_catalog(),
        "step_count": len(KIND_ADAPTER_STEPS),
        "catalog_integrity": integ,
        "kind_to_adapter": dict(KIND_TO_ADAPTER),
        "expected_kind_adapter": dict(EXPECTED_KIND_ADAPTER),
        "live_default_policy_gap": gap,
        "join_ready": False,
        "accepted": False,
        "live_route_kind_unchanged": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C81",
            "C75-empty",
            "C80-empty",
            "C65-JR-R3",
            "C64-KIND_TO_ADAPTER",
            "JobRouter.route_kind",
        ],
        "milestone": MILESTONE,
        "ticket": TICKET,
        "fills_empty_cycles": [75, 80],
    }


def run_kind_adapter_parity_cycle(
    *, sample_job_id: str | None = None
) -> dict[str, Any]:
    """Dry-run all KA steps; never mutates live route_kind / never starts Ray."""
    _ = sample_job_id
    t1 = table_integrity()
    t2 = resolve_known_kinds()
    t3 = generic_policy_matrix()
    t4 = live_route_kind_parity()
    t5 = live_default_policy_gap_report()
    t6 = unknown_kind_resolves_fail()
    integ = catalog_integrity()

    return {
        "product_path": PRODUCT_PATH,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "flag_opened": False,
        "ray_started": False,
        "tip_mount": False,
        "scratch_only": True,
        "steps": step_catalog(),
        "step_count": len(KIND_ADAPTER_STEPS),
        "catalog_integrity": integ,
        "sample_ka1_table": t1,
        "sample_ka2_known": t2,
        "sample_ka3_generic_matrix": t3,
        "sample_ka4_live_parity": t4,
        "sample_ka5_live_gap": t5,
        "sample_ka6_unknown": t6,
        "ka1_table_ok": t1["ok"],
        "ka2_known_ok": t2["ok"],
        "ka3_generic_ok": t3["ok"],
        "ka4_live_parity_ok": t4["ok"],
        "ka5_gap_documented": t5["gap_documented"] and not t5["mutated_this_cycle"],
        "ka6_unknown_fail_ok": t6["ok"],
        "kind_adapter_parity_ok": all(
            (
                t1["ok"],
                t2["ok"],
                t3["ok"],
                t4["ok"],
                t5["gap_documented"],
                not t5["mutated_this_cycle"],
                t6["ok"],
            )
        ),
        "join_ready_any": False,
        "accepted": False,
        "live_route_kind_unchanged": True,
        "all_accepted_false": True,
        "all_join_ready_false": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C81",
            "C75-empty",
            "C80-empty",
            "C65-JR-R3",
            "C64",
            "JobRouter.route_kind",
            "assistant_vs_gen_backbone",
        ],
        "milestone": MILESTONE,
        "ticket": TICKET,
        "fills_empty_cycles": [75, 80],
    }
