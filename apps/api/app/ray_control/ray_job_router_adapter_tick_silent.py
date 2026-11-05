"""JR-R2 adapter_tick silent + progress-delta gate — Cycle 70.

Deepens Cycle 65 JR-R2 / Cycle 64 emit-gate / Cycle 67 JR-R1 offline:
paper + scratch dry-run proving adapter_tick defaults to emit=false
(reason=emit_false_silent) and only opens emit when progress or state
actually changes vs prior projection. Aligns C63 renew silence.
Does NOT mutate live actors/job_router.py.

Flag default false; accepted=false; ray_started=false; join_ready=false.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

from .progress_bus import JobEventKind, ProgressBus
from .ray_job_router_emit_gate import (
    OP_DEFAULTS,
    ROUTER_OPS,
    gate_dry_run,
    sample_gate_wire,
)
from .ray_job_router_publish_kind_split import publish_kind_for
from .redis_keys import DEFAULT_NAMESPACE, job_events as job_events_key, job_hash as job_hash_key

PRODUCT_PATH = "ray_job_router_adapter_tick_silent_contract"
MILESTONE = "ray_job_router_adapter_tick_silent_contract_ready"
TICKET = "JR-R2"

SILENT_REASON = "emit_false_silent"
NO_DELTA_REASON = "no_progress_or_state_delta"
DELTA_EMIT_REASON = "progress_or_state_delta"


@dataclass(frozen=True)
class AdapterTickStep:
    """One JR-R2 adapter_tick silent checklist row (AT*)."""

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


ADAPTER_TICK_STEPS: tuple[AdapterTickStep, ...] = (
    AdapterTickStep(
        id="AT1",
        title="OP_DEFAULTS adapter_tick emit=false",
        summary=(
            "Reuse C64 OP_DEFAULTS['adapter_tick']['emit'] is False; "
            "bus_kind=job.updated; scheduler_op=renew; do not fork table."
        ),
        harness_call="adapter_tick_op_defaults() / OP_DEFAULTS",
        acceptance="emit is False; bus_kind=job.updated; scheduler_op=renew",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C64", "OP_DEFAULTS", "C63-renew"),
    ),
    AdapterTickStep(
        id="AT2",
        title="silent dry-run reason=emit_false_silent",
        summary=(
            "Default adapter_tick wire (emit from OP_DEFAULTS) → gate_dry_run "
            "emitted=false + reason=emit_false_silent; accepted=false."
        ),
        harness_call="gate_dry_run(sample_gate_wire(op='adapter_tick'))",
        acceptance=f"emitted=false; reason={SILENT_REASON}; accepted=false",
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("C64-gate", "C65-JR-R2", "C67"),
    ),
    AdapterTickStep(
        id="AT3",
        title="decide_emit_for_tick: no delta → silent",
        summary=(
            "Scratch helper: same progress+state vs prior → emit=false "
            f"(reason={NO_DELTA_REASON}); heartbeat must not spam UI."
        ),
        harness_call="decide_emit_for_tick(prior, next)",
        acceptance="identical progress/state → emit=False + no_delta reason",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("competitor silent adapter ticks", "C63"),
    ),
    AdapterTickStep(
        id="AT4",
        title="progress delta → open emit",
        summary=(
            "When progress increases (or changes) vs prior, decide_emit opens "
            "emit=true; dry-run applies job.updated on ProgressBus."
        ),
        harness_call="decide_emit_for_tick + adapter_tick_dry_run(emit=True, progress↑)",
        acceptance="progress 0.1→0.5 → emit=True + applied; bus_kind=job.updated",
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("ProgressBus", "JR-R1 kind=updated"),
    ),
    AdapterTickStep(
        id="AT5",
        title="state delta → open emit",
        summary=(
            "State change with same progress still opens emit "
            "(e.g. running→running is no-op; only real state string change)."
        ),
        harness_call="decide_emit_for_tick(state change)",
        acceptance="state change → emit=True even if progress equal",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C64",),
    ),
    AdapterTickStep(
        id="AT6",
        title="regress drop still on emit path",
        summary=(
            "Explicit emit + progress 0.5→0.2 (no attempts bump) still "
            "ProgressBus-regress-drops; aligns JR-R4 / C63 / C64."
        ),
        harness_call="adapter_tick_dry_run regress pair",
        acceptance="regress → applied=false + dropped_reason contains progress_regress",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("JR-R4", "C63", "C64", "ProgressBus"),
    ),
    AdapterTickStep(
        id="AT7",
        title="accepted=false until 改码卡",
        summary=(
            "All dry-runs keep accepted=false, join_ready=false, ray_started=false; "
            "live JobRouter adapter tick unchanged."
        ),
        harness_call="run_adapter_tick_silent_cycle / contract_static_payload",
        acceptance="all_accepted_false; live_tick_unchanged=true; flag default false",
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("flag", "JR-R2"),
    ),
)


def step_catalog() -> list[dict[str, Any]]:
    return [s.to_dict() for s in ADAPTER_TICK_STEPS]


def get_step(step_id: str) -> AdapterTickStep | None:
    for s in ADAPTER_TICK_STEPS:
        if s.id == step_id:
            return s
    return None


def adapter_tick_op_defaults() -> dict[str, Any]:
    d = OP_DEFAULTS["adapter_tick"]
    return {
        "op": "adapter_tick",
        "bus_kind": d["bus_kind"],
        "state": d["state"],
        "progress": d["progress"],
        "emit": d["emit"],
        "scheduler_op": d.get("scheduler_op"),
        "notes": d.get("notes"),
        "emit_default_false": d["emit"] is False,
        "bus_kind_updated": d["bus_kind"] == JobEventKind.UPDATED.value,
        "scheduler_op_renew": d.get("scheduler_op") == "renew",
        "publish_kind": publish_kind_for("adapter_tick"),
        "reuses_c64_op_defaults": True,
    }


@dataclass(frozen=True)
class EmitDecision:
    emit: bool
    reason: str
    prior_progress: float | None
    prior_state: str | None
    next_progress: float | None
    next_state: str | None
    progress_changed: bool
    state_changed: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _norm_progress(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _norm_state(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def decide_emit_for_tick(
    *,
    prior_progress: float | None = None,
    prior_state: str | None = None,
    next_progress: float | None = None,
    next_state: str | None = None,
    force_emit: bool | None = None,
    default_emit: bool | None = None,
) -> EmitDecision:
    """JR-R2 progress/state delta gate for adapter_tick.

    Default policy (when force_emit is None):
    - Open emit only when progress or state differs from prior.
    - No prior snapshot → stay silent (heartbeat with unknown baseline).
    force_emit overrides the decision when not None (tests / explicit wire).
    """
    pp = _norm_progress(prior_progress)
    np = _norm_progress(next_progress)
    ps = _norm_state(prior_state)
    ns = _norm_state(next_state)

    progress_changed = pp != np
    state_changed = ps != ns
    has_prior = pp is not None or ps is not None

    if force_emit is not None:
        emit = bool(force_emit)
        reason = DELTA_EMIT_REASON if emit else SILENT_REASON
        if emit and not (progress_changed or state_changed):
            # Forced emit without delta still labeled as forced silent-bypass
            reason = "force_emit"
        elif not emit:
            reason = SILENT_REASON
        return EmitDecision(
            emit=emit,
            reason=reason,
            prior_progress=pp,
            prior_state=ps,
            next_progress=np,
            next_state=ns,
            progress_changed=progress_changed,
            state_changed=state_changed,
        )

    base_default = (
        bool(default_emit)
        if default_emit is not None
        else bool(OP_DEFAULTS["adapter_tick"]["emit"])
    )
    # OP default is false; open only on real delta when we have a prior.
    if has_prior and (progress_changed or state_changed):
        return EmitDecision(
            emit=True,
            reason=DELTA_EMIT_REASON,
            prior_progress=pp,
            prior_state=ps,
            next_progress=np,
            next_state=ns,
            progress_changed=progress_changed,
            state_changed=state_changed,
        )

    if has_prior and not progress_changed and not state_changed:
        return EmitDecision(
            emit=False,
            reason=NO_DELTA_REASON,
            prior_progress=pp,
            prior_state=ps,
            next_progress=np,
            next_state=ns,
            progress_changed=False,
            state_changed=False,
        )

    # No prior → keep OP default (silent heartbeat)
    return EmitDecision(
        emit=base_default,
        reason=SILENT_REASON if not base_default else DELTA_EMIT_REASON,
        prior_progress=pp,
        prior_state=ps,
        next_progress=np,
        next_state=ns,
        progress_changed=progress_changed,
        state_changed=state_changed,
    )


@dataclass
class AdapterTickAck:
    accepted: bool
    job_id: str | None
    op: str | None
    reason: str | None
    bus_kind: str | None = None
    state: str | None = None
    progress: float | None = None
    attempts: int = 0
    emit: bool = False
    emitted: bool = False
    applied: bool = False
    dropped_reason: str | None = None
    decide_reason: str | None = None
    progress_changed: bool | None = None
    state_changed: bool | None = None
    live_tick_unchanged: bool = True
    events_key_preview: str | None = None
    job_hash_preview: str | None = None
    join_ready: bool = False
    ray_started: bool = False
    validation_ok: bool = True
    errors: tuple[str, ...] = field(default_factory=tuple)
    paper_only: bool = True
    seq: int = 0
    adapter: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["errors"] = list(self.errors)
        return d


def adapter_tick_dry_run(
    wire: Mapping[str, Any],
    *,
    bus: ProgressBus | None = None,
    prior_progress: float | None = None,
    prior_state: str | None = None,
    use_delta_gate: bool = True,
) -> AdapterTickAck:
    """Dry-run one adapter_tick through C64 gate + JR-R2 delta gate."""
    w = dict(wire)
    op = w.get("op") or "adapter_tick"
    if op != "adapter_tick":
        w["op"] = "adapter_tick"

    decision: EmitDecision | None = None
    if use_delta_gate:
        force = w["emit"] if "emit" in w and w.get("_force_emit_override") else None
        # If caller set emit explicitly without override flag, treat as force.
        force_emit = None
        if "emit" in wire:
            force_emit = bool(wire["emit"])
        decision = decide_emit_for_tick(
            prior_progress=prior_progress,
            prior_state=prior_state,
            next_progress=_norm_progress(w.get("progress")),
            next_state=_norm_state(w.get("state")),
            force_emit=force_emit,
        )
        w["emit"] = decision.emit
    elif "emit" not in w:
        w["emit"] = bool(OP_DEFAULTS["adapter_tick"]["emit"])

    gate_ack = gate_dry_run(w, bus=bus)
    errors = list(gate_ack.errors)

    reason = gate_ack.reason
    if decision is not None and not decision.emit and decision.reason == NO_DELTA_REASON:
        reason = NO_DELTA_REASON
    elif decision is not None and not gate_ack.emit:
        reason = decision.reason if decision.reason else SILENT_REASON

    return AdapterTickAck(
        accepted=False,
        job_id=gate_ack.job_id,
        op="adapter_tick",
        reason=reason,
        bus_kind=gate_ack.bus_kind,
        state=gate_ack.state,
        progress=gate_ack.progress,
        attempts=gate_ack.attempts,
        emit=gate_ack.emit,
        emitted=gate_ack.emitted,
        applied=gate_ack.applied,
        dropped_reason=gate_ack.dropped_reason,
        decide_reason=decision.reason if decision else None,
        progress_changed=decision.progress_changed if decision else None,
        state_changed=decision.state_changed if decision else None,
        live_tick_unchanged=True,
        events_key_preview=gate_ack.events_key_preview,
        job_hash_preview=gate_ack.job_hash_preview,
        join_ready=False,
        ray_started=False,
        validation_ok=gate_ack.validation_ok,
        errors=tuple(errors),
        paper_only=True,
        seq=gate_ack.seq,
        adapter=gate_ack.adapter,
    )


def catalog_integrity() -> dict[str, Any]:
    ids = [s.id for s in ADAPTER_TICK_STEPS]
    missing = sorted({"AT1", "AT2", "AT3", "AT4", "AT5", "AT6", "AT7"} - set(ids))
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    defaults = adapter_tick_op_defaults()
    silent = gate_dry_run(sample_gate_wire(op="adapter_tick", job_id="at-integ", kind="echo", seq=1))
    silent_ok = silent.emitted is False and silent.reason == SILENT_REASON
    return {
        "ok": not missing and not dupes and defaults["emit_default_false"] and silent_ok,
        "step_ids": ids,
        "missing_ids": missing,
        "duplicate_ids": dupes,
        "adapter_tick_defaults": defaults,
        "silent_ack_reason": silent.reason,
        "silent_not_emitted": silent_ok,
        "reuses_c64_op_defaults": True,
        "publish_kind_adapter_tick": publish_kind_for("adapter_tick"),
        "live_tick_unchanged": True,
        "router_ops_contains_adapter_tick": "adapter_tick" in ROUTER_OPS,
    }


def contract_static_payload() -> dict[str, Any]:
    integ = catalog_integrity()
    defaults = adapter_tick_op_defaults()
    return {
        "product_path": PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "flag_opened": False,
        "ray_started": False,
        "tip_mount": False,
        "scratch_only": True,
        "steps": step_catalog(),
        "step_count": len(ADAPTER_TICK_STEPS),
        "step_ids": [s.id for s in ADAPTER_TICK_STEPS],
        "adapter_tick_defaults": defaults,
        "silent_reason": SILENT_REASON,
        "no_delta_reason": NO_DELTA_REASON,
        "delta_emit_reason": DELTA_EMIT_REASON,
        "catalog_integrity": integ,
        "join_ready_any": False,
        "accepted": False,
        "live_tick_unchanged": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C70",
            "C67",
            "C65-JR-R2",
            "C64",
            "C63",
            "OP_DEFAULTS",
            "ProgressBus",
            "adapter_tick",
        ],
        "milestone": MILESTONE,
        "ticket": TICKET,
    }


def run_adapter_tick_silent_cycle(
    *,
    sample_job_id: str | None = None,
) -> dict[str, Any]:
    """Flag-on dry-run: silent / no-delta / progress-delta / state-delta / regress."""
    jid = sample_job_id or "dry-at-1"
    bus = ProgressBus()

    # Seed job via submit+dispatch so ProgressBus has baseline for regress path
    from .ray_job_router_emit_gate import gate_dry_run as _g

    _g(sample_gate_wire(op="submit", job_id=jid, kind="llm", seq=1), bus=bus)
    _g(sample_gate_wire(op="dispatch", job_id=jid, kind="llm", seq=2), bus=bus)

    # AT2: default silent (no emit key → OP default false; no prior for delta)
    silent = adapter_tick_dry_run(
        sample_gate_wire(op="adapter_tick", job_id=jid, kind="llm", seq=3),
        bus=bus,
        use_delta_gate=False,
    )

    # AT3: no delta with prior
    no_delta = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": jid,
            "kind": "llm",
            "adapter": "llm_gateway",
            "state": "running",
            "progress": 0.3,
            "attempts": 0,
            "seq": 4,
        },
        bus=bus,
        prior_progress=0.3,
        prior_state="running",
        use_delta_gate=True,
    )

    # AT4: progress delta
    tick = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": jid,
            "kind": "llm",
            "adapter": "llm_gateway",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 5,
        },
        bus=bus,
        prior_progress=0.3,
        prior_state="running",
        use_delta_gate=True,
    )

    # AT5: state delta (same progress)
    state_delta = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-at-state",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.1,
            "attempts": 0,
            "seq": 1,
        },
        bus=ProgressBus(),
        prior_progress=0.1,
        prior_state="queued",
        use_delta_gate=True,
    )

    # AT6: regress on emit path
    bus2 = ProgressBus()
    _g(sample_gate_wire(op="submit", job_id="dry-at-reg", kind="echo", seq=1), bus=bus2)
    _g(sample_gate_wire(op="dispatch", job_id="dry-at-reg", kind="echo", seq=2), bus=bus2)
    hi = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-at-reg",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 3,
            "emit": True,
        },
        bus=bus2,
        prior_progress=0.05,
        prior_state="running",
        use_delta_gate=True,
    )
    regress = adapter_tick_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-at-reg",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 4,
            "emit": True,
        },
        bus=bus2,
        prior_progress=0.5,
        prior_state="running",
        use_delta_gate=True,
    )

    acks = (silent, no_delta, tick, state_delta, hi, regress)
    integ = catalog_integrity()
    defaults = adapter_tick_op_defaults()

    regress_dropped = (
        regress.applied is False
        and regress.dropped_reason is not None
        and "progress_regress" in str(regress.dropped_reason)
    )

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
        "step_count": len(ADAPTER_TICK_STEPS),
        "adapter_tick_defaults": defaults,
        "catalog_integrity": integ,
        "sample_silent_ack": silent.to_dict(),
        "sample_no_delta_ack": no_delta.to_dict(),
        "sample_progress_delta_ack": tick.to_dict(),
        "sample_state_delta_ack": state_delta.to_dict(),
        "sample_tick_hi_ack": hi.to_dict(),
        "sample_regress_ack": regress.to_dict(),
        "all_accepted_false": all(not a.accepted for a in acks),
        "all_join_ready_false": all(a.join_ready is False for a in acks),
        "all_live_tick_unchanged": all(a.live_tick_unchanged for a in acks),
        "adapter_tick_emit_default_false": defaults["emit_default_false"],
        "adapter_tick_silent": silent.emitted is False and silent.reason == SILENT_REASON,
        "no_delta_silent": (
            no_delta.emitted is False
            and no_delta.reason == NO_DELTA_REASON
            and no_delta.decide_reason == NO_DELTA_REASON
        ),
        "progress_delta_applied": tick.emitted is True and tick.applied is True,
        "state_delta_emit": state_delta.emit is True and state_delta.decide_reason == DELTA_EMIT_REASON,
        "regress_dropped": regress_dropped,
        "join_ready_any": False,
        "accepted": False,
        "live_tick_unchanged": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C70",
            "C67",
            "C65-JR-R2",
            "C64",
            "C63",
            "OP_DEFAULTS",
            "ProgressBus",
            "adapter_tick",
        ],
        "milestone": MILESTONE,
        "ticket": TICKET,
    }
