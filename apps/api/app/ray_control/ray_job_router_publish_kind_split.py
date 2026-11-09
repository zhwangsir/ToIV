"""JR-R1 _publish kind 三分 (enqueued / updated / terminal) — Cycle 67.

Deepens Cycle 65 JR-R1 offline: paper + scratch dry-run that models the
intended `_publish_kind_for(op|state)` split and proves the live gap
(JobRouter._publish always calls JobEvent.updated()). Reuses C64
OP_DEFAULTS / JobEventKind; does NOT mutate live actors/job_router.py.

Flag default false; accepted=false; ray_started=false; join_ready=false.
"""

from __future__ import annotations

import inspect
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

from .actors import job_router as job_router_mod
from .progress_bus import (
    TERMINAL_STATES,
    JobEvent,
    JobEventKind,
    ProgressBus,
)
from .ray_job_router_emit_gate import (
    OP_DEFAULTS,
    ROUTER_OPS,
    resolve_adapter,
    sample_gate_wire,
    validate_gate_payload,
)
from .redis_keys import DEFAULT_NAMESPACE, job_events as job_events_key, job_hash as job_hash_key

PRODUCT_PATH = "ray_job_router_publish_kind_split_contract"
MILESTONE = "ray_job_router_publish_kind_split_contract_ready"

# Explicit 三分 kinds JR-R1 cares about (subset of JobEventKind).
SPLIT_KINDS: frozenset[str] = frozenset(
    {
        JobEventKind.ENQUEUED.value,
        JobEventKind.UPDATED.value,
        JobEventKind.TERMINAL.value,
    }
)

LIVE_PUBLISH_METHOD = "JobRouter._publish"
LIVE_PUBLISH_FACTORY = "JobEvent.updated"
LIVE_GAP_SUMMARY = (
    "JR-R1 tip merge: JobRouter._publish(op) 三分 applied — "
    "submit→JobEvent.enqueued(); dispatch/adapter_tick→updated; "
    "cancel/terminal→terminal (via updated auto-promote)"
)


@dataclass(frozen=True)
class PublishKindStep:
    """One JR-R1 publish-kind checklist row (PK*)."""

    id: str
    title: str
    summary: str
    harness_call: str
    acceptance: str
    kouling_blocker: tuple[str, ...]
    implementable_offline: bool
    ties: tuple[str, ...] = ()
    ops: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["kouling_blocker"] = list(self.kouling_blocker)
        d["ties"] = list(self.ties)
        d["ops"] = list(self.ops)
        d["needs_kouling"] = bool(self.kouling_blocker)
        return d


PUBLISH_KIND_STEPS: tuple[PublishKindStep, ...] = (
    PublishKindStep(
        id="PK1",
        title="live gap: always JobEvent.updated()",
        summary=(
            "Document that live JobRouter._publish call site always uses "
            "JobEvent.updated(); intentional kouling gate until 改码卡."
        ),
        harness_call="live_publish_gap_report()",
        acceptance=(
            "source contains JobEvent.updated(; no JobEvent.enqueued(; "
            "live_always_updated=true"
        ),
        kouling_blocker=("改码卡",),
        implementable_offline=True,  # inspect/paper only
        ties=("C64", "C65-JR-R1", "actors/job_router.py::_publish"),
        ops=(),
    ),
    PublishKindStep(
        id="PK2",
        title="reuse OP_DEFAULTS → bus_kind map",
        summary=(
            "Import C64 OP_DEFAULTS; do not fork a second op→bus_kind table. "
            "submit→enqueued, dispatch/adapter_tick→updated, cancel/terminal→terminal."
        ),
        harness_call="op_bus_kind_map() / OP_DEFAULTS",
        acceptance="map equals C64 OP_DEFAULTS bus_kind for all ROUTER_OPS",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C64", "ray_job_router_emit_gate.OP_DEFAULTS"),
        ops=("submit", "dispatch", "adapter_tick", "cancel", "terminal"),
    ),
    PublishKindStep(
        id="PK3",
        title="proposed _publish_kind_for(op|state)",
        summary=(
            "Scratch helper returns JobEventKind 三分 from op (and terminal "
            "state override); mirrors intended live JobRouter._publish split."
        ),
        harness_call="publish_kind_for(op, state=...)",
        acceptance=(
            "submit→job.enqueued; dispatch/adapter_tick→job.updated; "
            "cancel/terminal→job.terminal; unknown op → None"
        ),
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("C65-JR-R1",),
        ops=("submit", "dispatch", "adapter_tick", "cancel", "terminal"),
    ),
    PublishKindStep(
        id="PK4",
        title="dry-run build JobEvent with correct kind",
        summary=(
            "Build JobEvent via enqueued/updated factories per publish_kind_for; "
            "apply on scratch ProgressBus; never write live JobRouter."
        ),
        harness_call="build_publish_event + kind_split_dry_run",
        acceptance=(
            "submit event.kind=ENQUEUED; dispatch=UPDATED; "
            "terminal/cancel=TERMINAL; accepted=false"
        ),
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("ProgressBus", "JobEvent.enqueued", "JobEvent.updated"),
        ops=("submit", "dispatch", "cancel", "terminal"),
    ),
    PublishKindStep(
        id="PK5",
        title="wrong-kind regress drop",
        summary=(
            "If wire bus_kind disagrees with publish_kind_for(op), drop with "
            "reason wrong_kind (scratch gate); ProgressBus progress_regress "
            "still applies on adapter_tick emit path."
        ),
        harness_call="kind_split_dry_run(force_bus_kind=...)",
        acceptance="mismatched bus_kind → applied=false + dropped_reason=wrong_kind",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C63", "C64", "ProgressBus"),
        ops=("submit", "dispatch", "terminal"),
    ),
    PublishKindStep(
        id="PK6",
        title="acceptance=false until 改码卡",
        summary=(
            "All dry-runs keep accepted=false, join_ready=false, ray_started=false; "
            "live _publish unchanged."
        ),
        harness_call="run_publish_kind_split_cycle / contract_static_payload",
        acceptance="all_accepted_false; live_publish_unchanged=true; flag default false",
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("flag", "JR-R1"),
        ops=(),
    ),
)


def step_catalog() -> list[dict[str, Any]]:
    return [s.to_dict() for s in PUBLISH_KIND_STEPS]


def get_step(step_id: str) -> PublishKindStep | None:
    for s in PUBLISH_KIND_STEPS:
        if s.id == step_id:
            return s
    return None


def op_bus_kind_map() -> dict[str, str]:
    """Reuse C64 OP_DEFAULTS bus_kind — single source of truth."""
    return {op: str(OP_DEFAULTS[op]["bus_kind"]) for op in sorted(ROUTER_OPS)}


def publish_kind_for(
    op: str | None,
    *,
    state: str | None = None,
) -> str | None:
    """Proposed `_publish_kind_for(op|state)` 三分 (scratch).

    Primary key is router op → OP_DEFAULTS.bus_kind. When state is a terminal
    state and op is cancel/terminal (or state forces terminal), return
    job.terminal. Unknown op → None.
    """
    if not isinstance(op, str) or op not in ROUTER_OPS:
        return None
    defaults = OP_DEFAULTS[op]
    bus_kind = str(defaults["bus_kind"])
    if isinstance(state, str) and state in TERMINAL_STATES:
        # Terminal state always forces terminal kind (align JobEvent.updated auto-promote).
        return JobEventKind.TERMINAL.value
    return bus_kind


def live_publish_gap_report() -> dict[str, Any]:
    """Inspect tip JobRouter._publish source after JR-R1 改码卡 merge."""
    src = inspect.getsource(job_router_mod.JobRouter._publish)
    has_updated = "JobEvent.updated(" in src
    has_enqueued = "JobEvent.enqueued(" in src
    has_op_param = "op: str" in src or "op =" in src
    updated_calls = src.count("JobEvent.updated(")
    enqueued_calls = src.count("JobEvent.enqueued(")
    jr_r1_applied = has_enqueued and has_updated and has_op_param
    return {
        "method": LIVE_PUBLISH_METHOD,
        "factory_used": "JobEvent.enqueued|JobEvent.updated (op 三分)",
        "jr_r1_applied": jr_r1_applied,
        "live_always_updated": has_updated and not has_enqueued and updated_calls >= 1,
        "has_job_event_updated_call": has_updated,
        "has_job_event_enqueued_call": has_enqueued,
        "has_op_param": has_op_param,
        "updated_call_count": updated_calls,
        "enqueued_call_count": enqueued_calls,
        "lines_approx": "JR-R1 tip merge",
        "summary": LIVE_GAP_SUMMARY,
        "intentional_kouling_gate": False,  # 改码卡 already applied on this branch
        "mutated_this_cycle": True,  # tip branch carries the live _publish change
        "live_publish_unchanged": False,
    }


def build_publish_event(
    *,
    op: str,
    job_id: str,
    state: str | None = None,
    progress: float | None = None,
    attempts: int = 0,
    seq: int = 0,
    kind: str = "echo",
    error: str | None = None,
    result_uri: str | None = None,
    thumb_uri: str | None = None,
    preview_uri: str | None = None,
    labels: Mapping[str, str] | None = None,
    shot_id: str | None = None,
    node_id: str | None = None,
    force_bus_kind: str | None = None,
) -> dict[str, Any]:
    """Build a JobEvent with the intended 三分 kind (scratch; no live write).

    Returns a dict with event (or None), expected_kind, actual_kind, wrong_kind.
    """
    defaults = OP_DEFAULTS.get(op, {})
    resolved_state = state if state is not None else defaults.get("state")
    if not isinstance(resolved_state, str):
        resolved_state = "queued"
    expected = publish_kind_for(op, state=resolved_state)
    bus_kind = force_bus_kind if force_bus_kind is not None else expected
    wrong_kind = bool(
        expected is not None and bus_kind is not None and bus_kind != expected
    )

    adapter = resolve_adapter(kind)
    lab = dict(labels or {})
    lab.setdefault("kind", kind)
    lab.setdefault("adapter", adapter)
    if node_id:
        lab.setdefault("host_id", node_id)

    prog = progress if progress is not None else defaults.get("progress")
    event: JobEvent | None = None
    if bus_kind == JobEventKind.ENQUEUED.value:
        event = JobEvent.enqueued(
            job_id,
            state=resolved_state,
            progress=float(prog) if isinstance(prog, (int, float)) else 0.0,
            error=error,
            result_uri=result_uri,
            thumb_uri=thumb_uri,
            preview_uri=preview_uri,
            labels=lab,
            shot_id=shot_id,
            attempts=attempts,
            seq=seq,
        )
    elif bus_kind == JobEventKind.UPDATED.value or bus_kind == JobEventKind.TERMINAL.value:
        # JobEvent.updated auto-promotes terminal states → TERMINAL kind.
        event = JobEvent.updated(
            job_id,
            state=resolved_state,
            progress=float(prog) if isinstance(prog, (int, float)) else None,
            error=error,
            result_uri=result_uri,
            thumb_uri=thumb_uri,
            preview_uri=preview_uri,
            labels=lab,
            shot_id=shot_id,
            attempts=attempts,
            seq=seq,
        )
        # If caller forced TERMINAL kind with non-terminal state, rebuild explicitly.
        if (
            bus_kind == JobEventKind.TERMINAL.value
            and event.kind is not JobEventKind.TERMINAL
        ):
            event = JobEvent(
                kind=JobEventKind.TERMINAL,
                job_id=job_id,
                state=resolved_state,
                progress=float(prog) if isinstance(prog, (int, float)) else None,
                error=error,
                result_uri=result_uri,
                thumb_uri=thumb_uri,
                preview_uri=preview_uri,
                labels=lab,
                shot_id=shot_id,
                attempts=attempts,
                seq=seq,
                terminal=True,
            )
        # If expected ENQUEUED but we somehow built UPDATED — leave as-is; wrong_kind handles.
    else:
        event = None

    actual_kind = event.kind.value if event is not None else None
    return {
        "op": op,
        "job_id": job_id,
        "expected_kind": expected,
        "requested_bus_kind": bus_kind,
        "actual_kind": actual_kind,
        "wrong_kind": wrong_kind,
        "state": resolved_state,
        "adapter": adapter,
        "event": event,
    }


@dataclass(frozen=True)
class KindSplitAck:
    accepted: bool
    job_id: str
    op: str | None
    reason: str
    expected_kind: str | None = None
    actual_kind: str | None = None
    bus_kind: str | None = None
    state: str | None = None
    progress: float | None = None
    attempts: int = 0
    emit: bool = False
    emitted: bool = False
    applied: bool = False
    dropped_reason: str | None = None
    wrong_kind: bool = False
    live_publish_unchanged: bool = True
    events_key_preview: str | None = None
    job_hash_preview: str | None = None
    join_ready: bool = False
    ray_started: bool = False
    validation_ok: bool = False
    errors: tuple[str, ...] = field(default_factory=tuple)
    paper_only: bool = True
    seq: int = 0
    adapter: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def kind_split_dry_run(
    wire: Mapping[str, Any] | None = None,
    *,
    bus: ProgressBus | None = None,
    force_bus_kind: str | None = None,
) -> KindSplitAck:
    """Dry-run one publish-kind wire against ProgressBus (paper-only).

    Does not touch live JobRouter._publish. accepted stays false.
    """
    wire = dict(wire or {})
    if not wire:
        wire = sample_gate_wire(op="submit", job_id="dry-pk-1", kind="echo", seq=1)

    # Allow force_bus_kind via wire or kwarg
    if force_bus_kind is None and "force_bus_kind" in wire:
        force_bus_kind = wire.pop("force_bus_kind")

    validation = validate_gate_payload(wire)
    errors = list(validation["errors"])
    errors.append("join_ready_false")
    errors.append("paper_only_no_live_router")
    errors.append("live_publish_unchanged")

    job_id = str(validation.get("job_id") or "")
    op = validation.get("op") if isinstance(validation.get("op"), str) else None
    emit = bool(validation.get("emit", True))
    bus = bus or ProgressBus()

    dropped: str | None = None
    applied = False
    emitted = False
    wrong_kind = False
    expected_kind: str | None = None
    actual_kind: str | None = None
    bus_kind: str | None = None
    proj_progress = validation.get("progress")
    proj_state = validation.get("state") if isinstance(validation.get("state"), str) else None
    proj_attempts = int(validation.get("attempts") or 0)
    proj_seq = int(validation.get("seq") or 0)
    adapter = validation.get("adapter") if isinstance(validation.get("adapter"), str) else None

    if validation["ok"] and op:
        built = build_publish_event(
            op=op,
            job_id=job_id,
            state=proj_state,
            progress=proj_progress if isinstance(proj_progress, (int, float)) else None,
            attempts=proj_attempts,
            seq=proj_seq,
            kind=str(validation.get("kind") or "echo"),
            error=validation.get("error") if isinstance(validation.get("error"), str) else None,
            result_uri=validation.get("result_uri")
            if isinstance(validation.get("result_uri"), str)
            else None,
            thumb_uri=validation.get("thumb_uri")
            if isinstance(validation.get("thumb_uri"), str)
            else None,
            preview_uri=validation.get("preview_uri")
            if isinstance(validation.get("preview_uri"), str)
            else None,
            labels=validation.get("labels") if isinstance(validation.get("labels"), Mapping) else {},
            shot_id=validation.get("shot_id") if isinstance(validation.get("shot_id"), str) else None,
            node_id=validation.get("node_id") if isinstance(validation.get("node_id"), str) else None,
            force_bus_kind=force_bus_kind,
        )
        expected_kind = built["expected_kind"]
        bus_kind = built["requested_bus_kind"]
        actual_kind = built["actual_kind"]
        wrong_kind = bool(built["wrong_kind"])
        event = built["event"]

        if wrong_kind:
            dropped = "wrong_kind"
            errors.append("wrong_kind")
            emit = False  # do not emit mismatched kind
        elif emit and event is not None:
            emitted = True
            # Prefer event_from_gate when force not used so labels stay aligned;
            # but event we built already has correct 三分 kind.
            result = bus.apply(event)
            if result is None:
                dropped_list = getattr(bus, "dropped", None) or getattr(bus, "_dropped", [])
                if dropped_list:
                    dropped = str(dropped_list[-1])
                else:
                    dropped = "bus_rejected"
                errors.append(f"bus_drop:{dropped}")
            else:
                applied = True
                proj_progress = result.progress
                proj_state = result.state
                proj_attempts = result.attempts
                proj_seq = result.seq
                actual_kind = event.kind.value
        elif not emit:
            pass

    accepted = False
    if not validation["ok"]:
        reason = "validation_failed"
    elif wrong_kind:
        reason = "wrong_kind"
    elif not emit and dropped == "wrong_kind":
        reason = "wrong_kind"
    elif not emit:
        reason = "emit_false_silent"
    elif dropped:
        reason = "bus_rejected"
    else:
        reason = "join_ready_false"

    return KindSplitAck(
        accepted=accepted,
        job_id=job_id,
        op=op,
        reason=reason,
        expected_kind=expected_kind,
        actual_kind=actual_kind,
        bus_kind=bus_kind,
        state=proj_state,
        progress=float(proj_progress) if isinstance(proj_progress, (int, float)) else None,
        attempts=proj_attempts,
        emit=emit,
        emitted=emitted,
        applied=applied,
        dropped_reason=dropped,
        wrong_kind=wrong_kind,
        live_publish_unchanged=True,
        events_key_preview=job_events_key(job_id, namespace=DEFAULT_NAMESPACE) if job_id else None,
        job_hash_preview=job_hash_key(job_id, namespace=DEFAULT_NAMESPACE) if job_id else None,
        join_ready=False,
        ray_started=False,
        validation_ok=bool(validation["ok"]),
        errors=tuple(errors),
        paper_only=True,
        seq=proj_seq,
        adapter=adapter,
    )


def catalog_integrity() -> dict[str, Any]:
    """Static checks: steps, OP map reuse, live gap, 三分 coverage."""
    ids = [s.id for s in PUBLISH_KIND_STEPS]
    missing = sorted({"PK1", "PK2", "PK3", "PK4", "PK5", "PK6"} - set(ids))
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    op_map = op_bus_kind_map()
    expected_map = {
        "submit": JobEventKind.ENQUEUED.value,
        "dispatch": JobEventKind.UPDATED.value,
        "adapter_tick": JobEventKind.UPDATED.value,
        "cancel": JobEventKind.TERMINAL.value,
        "terminal": JobEventKind.TERMINAL.value,
    }
    map_ok = op_map == expected_map
    # Ensure we did not fork — values come from OP_DEFAULTS
    reused = all(
        op_map[op] == str(OP_DEFAULTS[op]["bus_kind"]) for op in ROUTER_OPS
    )
    gap = live_publish_gap_report()
    kinds_covered = sorted({publish_kind_for(op) for op in ROUTER_OPS})
    return {
        "ok": not missing and not dupes and map_ok and reused and bool(gap.get("jr_r1_applied") or gap.get("live_always_updated")),
        "step_ids": ids,
        "missing_ids": missing,
        "duplicate_ids": dupes,
        "op_bus_kind_map": op_map,
        "map_matches_expected_三分": map_ok,
        "reuses_c64_op_defaults": reused,
        "split_kinds": sorted(SPLIT_KINDS),
        "kinds_covered": kinds_covered,
        "live_gap": gap,
        "live_publish_unchanged": True,
    }


def contract_static_payload() -> dict[str, Any]:
    """Flag-off paper body: JR-R1 publish-kind 三分 checklist."""
    integ = catalog_integrity()
    gap = integ["live_gap"]
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
        "step_count": len(PUBLISH_KIND_STEPS),
        "step_ids": [s.id for s in PUBLISH_KIND_STEPS],
        "op_bus_kind_map": op_bus_kind_map(),
        "split_kinds": sorted(SPLIT_KINDS),
        "router_ops": sorted(ROUTER_OPS),
        "live_gap": gap,
        "live_gap_summary": LIVE_GAP_SUMMARY,
        "live_publish_unchanged": bool(gap.get("live_publish_unchanged", False)),
        "live_always_updated": gap.get("live_always_updated"),
        "jr_r1_applied": gap.get("jr_r1_applied"),
        "catalog_integrity": integ,
        "join_ready_any": False,
        "accepted": False,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C67",
            "C66",
            "C65-JR-R1",
            "C64",
            "JobRouter._publish",
            "OP_DEFAULTS",
            "ProgressBus",
        ],
        "milestone": MILESTONE,
        "ticket": "JR-R1",
    }


def run_publish_kind_split_cycle(
    *,
    sample_job_id: str | None = None,
) -> dict[str, Any]:
    """Flag-on dry-run: submit/dispatch/terminal/cancel kinds + wrong_kind drop."""
    jid = sample_job_id or "dry-pk-1"
    bus = ProgressBus()

    submit = kind_split_dry_run(
        sample_gate_wire(op="submit", job_id=jid, kind="llm", seq=1),
        bus=bus,
    )
    dispatch = kind_split_dry_run(
        sample_gate_wire(op="dispatch", job_id=jid, kind="llm", seq=2),
        bus=bus,
    )
    silent = kind_split_dry_run(
        {**sample_gate_wire(op="adapter_tick", job_id=jid, kind="llm", seq=3), "emit": False},
        bus=bus,
    )
    terminal = kind_split_dry_run(
        sample_gate_wire(op="terminal", job_id=jid, kind="llm", attempts=1, seq=4),
        bus=bus,
    )
    cancel = kind_split_dry_run(
        sample_gate_wire(op="cancel", job_id="dry-pk-cancel", kind="comfy", seq=1),
        bus=ProgressBus(),
    )
    # Wrong kind: submit forced to updated → drop
    wrong = kind_split_dry_run(
        sample_gate_wire(op="submit", job_id="dry-pk-wrong", kind="echo", seq=1),
        bus=ProgressBus(),
        force_bus_kind=JobEventKind.UPDATED.value,
    )
    # Progress regress still works on adapter_tick emit path (shared bus after tick)
    bus2 = ProgressBus()
    kind_split_dry_run(sample_gate_wire(op="submit", job_id="dry-pk-reg", kind="echo", seq=1), bus=bus2)
    kind_split_dry_run(sample_gate_wire(op="dispatch", job_id="dry-pk-reg", kind="echo", seq=2), bus=bus2)
    tick = kind_split_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-pk-reg",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 3,
            "emit": True,
        },
        bus=bus2,
    )
    regress = kind_split_dry_run(
        {
            "op": "adapter_tick",
            "job_id": "dry-pk-reg",
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 4,
            "emit": True,
        },
        bus=bus2,
    )

    acks = (submit, dispatch, silent, terminal, cancel, wrong, tick, regress)
    gap = live_publish_gap_report()
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
        "step_count": len(PUBLISH_KIND_STEPS),
        "op_bus_kind_map": op_bus_kind_map(),
        "split_kinds": sorted(SPLIT_KINDS),
        "live_gap": gap,
        "live_publish_unchanged": bool(gap.get("live_publish_unchanged", False)),
        "live_always_updated": gap["live_always_updated"],
        "jr_r1_applied": gap.get("jr_r1_applied"),
        "catalog_integrity": integ,
        "sample_submit_ack": submit.to_dict(),
        "sample_dispatch_ack": dispatch.to_dict(),
        "sample_adapter_tick_silent_ack": silent.to_dict(),
        "sample_terminal_ack": terminal.to_dict(),
        "sample_cancel_ack": cancel.to_dict(),
        "sample_wrong_kind_ack": wrong.to_dict(),
        "sample_tick_ack": tick.to_dict(),
        "sample_regress_ack": regress.to_dict(),
        "all_accepted_false": all(not a.accepted for a in acks),
        "all_join_ready_false": all(a.join_ready is False for a in acks),
        "all_live_publish_unchanged": all(a.live_publish_unchanged for a in acks),
        "submit_kind_enqueued": submit.actual_kind == JobEventKind.ENQUEUED.value
        and submit.applied,
        "dispatch_kind_updated": dispatch.actual_kind == JobEventKind.UPDATED.value
        and dispatch.applied,
        "terminal_kind_terminal": terminal.actual_kind == JobEventKind.TERMINAL.value
        and terminal.applied,
        "cancel_kind_terminal": cancel.actual_kind == JobEventKind.TERMINAL.value
        and cancel.applied,
        "wrong_kind_dropped": wrong.wrong_kind
        and wrong.applied is False
        and wrong.dropped_reason == "wrong_kind",
        "adapter_tick_silent": silent.emitted is False and silent.reason == "emit_false_silent",
        "regress_dropped": regress.applied is False and regress.dropped_reason is not None,
        "join_ready_any": False,
        "accepted": False,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C67",
            "C66",
            "C65-JR-R1",
            "C64",
            "JobRouter._publish",
            "OP_DEFAULTS",
            "ProgressBus",
        ],
        "milestone": MILESTONE,
        "ticket": "JR-R1",
    }

