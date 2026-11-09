"""Ray JobRouter emit-gate + kind→adapter dispatch field contract (Cycle 64).

Paper + scratch dry-run: unify JobRouter lifecycle (submit / dispatch /
adapter_tick / cancel / terminal) onto ProgressBus JobEvent kinds with an
explicit emit gate, and catalog kind→adapter (echo / comfy_pool / llm_gateway).
Continues Cycle 63 scheduler↔bus glue into the router surface.

No ray start, no live Redis/Comfy/LLM sockets, flag stays default false.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

from .progress_bus import (
    ACTIVE_STATES,
    TERMINAL_STATES,
    JobEvent,
    JobEventKind,
    ProgressBus,
)
from .ray_scheduler_progress_glue import OP_DEFAULTS as SCHEDULER_OP_DEFAULTS
from .redis_keys import DEFAULT_NAMESPACE, job_events as job_events_key, job_hash as job_hash_key

PRODUCT_PATH = "ray_job_router_emit_gate_contract"
MILESTONE = "ray_job_router_emit_gate_contract_ready"

ROUTER_OPS: frozenset[str] = frozenset(
    {"submit", "dispatch", "adapter_tick", "cancel", "terminal"}
)

ADAPTER_NAMES: frozenset[str] = frozenset(
    {"echo", "comfy_pool", "llm_gateway", "fail"}
)

KIND_TO_ADAPTER: dict[str, str] = {
    "echo": "echo",
    "comfy": "comfy_pool",
    "llm": "llm_gateway",
    "generic": "echo",  # unknown_kind_policy=echo default (JobRouterConfig)
}

GATE_TOP_LEVEL_KEYS: frozenset[str] = frozenset(
    {
        "op",
        "job_id",
        "kind",
        "adapter",
        "state",
        "progress",
        "attempts",
        "node_id",
        "error",
        "retryable",
        "result_uri",
        "thumb_uri",
        "preview_uri",
        "labels",
        "shot_id",
        "seq",
        "emit",
        "bus_kind",
    }
)

PHASE1_GATE_FIELDS: frozenset[str] = frozenset(
    {
        "op",
        "job_id",
        "kind",
        "adapter",
        "bus_kind",
        "state",
        "progress",
        "attempts",
        "emit",
        "events_key",
        "job_hash",
    }
)

# Router lifecycle → default bus_kind / state / emit
# Gap vs live JobRouter._publish: today always JobEvent.updated(); this table
# is the emit-gate checklist to unify under 改码卡.
OP_DEFAULTS: dict[str, dict[str, Any]] = {
    "submit": {
        "bus_kind": JobEventKind.ENQUEUED.value,
        "state": "queued",
        "progress": 0.0,
        "emit": True,
        "notes": "JobRouter.submit → enqueued; align C63 enqueue",
        "scheduler_op": "enqueue",
    },
    "dispatch": {
        "bus_kind": JobEventKind.UPDATED.value,
        "state": "running",
        "progress": 0.05,
        "emit": True,
        "notes": "kind→adapter claim; pre-work running bookkeeping",
        "scheduler_op": "lease",
    },
    "adapter_tick": {
        "bus_kind": JobEventKind.UPDATED.value,
        "state": "running",
        "progress": None,  # shimmer until progress known
        "emit": False,  # silent unless progress/state change (align C63 renew)
        "notes": "ComfyPool/LlmGateway tick; emit only on progress tick",
        "scheduler_op": "renew",
    },
    "cancel": {
        "bus_kind": JobEventKind.TERMINAL.value,
        "state": "cancelled",
        "progress": None,
        "emit": True,
        "notes": "cancel before/during adapter → terminal cancelled",
        "scheduler_op": "terminal",
    },
    "terminal": {
        "bus_kind": JobEventKind.TERMINAL.value,
        "state": "succeeded",
        "progress": 1.0,
        "emit": True,
        "notes": "adapter done → succeeded|failed|cancelled",
        "scheduler_op": "terminal",
    },
}

NO_CYCLE57_LABEL_MAPPING: frozenset[str] = frozenset(
    {"op", "bus_kind", "emit", "adapter", "kind", "events_key", "job_hash"}
)


@dataclass(frozen=True)
class FieldEntry:
    wire_name: str
    bus_attr: str
    redis_target: str
    cycle57_label_key: str
    required: bool
    notes: str = ""


FIELD_CATALOG: tuple[FieldEntry, ...] = (
    FieldEntry("op", "n/a", "n/a", "n/a", True, "Router lifecycle op"),
    FieldEntry("job_id", "job_id", "hash + events", "n/a", True, ""),
    FieldEntry("kind", "labels.kind soft", "hash kind", "n/a", True, "JobKind wire"),
    FieldEntry("adapter", "n/a", "n/a", "n/a", True, "echo|comfy_pool|llm_gateway|fail"),
    FieldEntry("bus_kind", "kind", "events kind", "n/a", True, ""),
    FieldEntry("state", "state", "hash status", "n/a", True, ""),
    FieldEntry("progress", "progress", "hash progress", "n/a", False, ""),
    FieldEntry("attempts", "attempts", "hash attempts", "n/a", False, ""),
    FieldEntry("node_id", "labels.host_id soft", "hash node_id", "host_id", False, ""),
    FieldEntry("emit", "glue gate", "n/a", "n/a", True, "False → silent"),
    FieldEntry("events_key", "n/a", "job:{id}:events", "n/a", True, ""),
    FieldEntry("job_hash", "n/a", "job:{id}", "n/a", True, ""),
)


def field_catalog_rows() -> list[dict[str, Any]]:
    return [
        {
            "wire_name": e.wire_name,
            "bus_attr": e.bus_attr,
            "redis_target": e.redis_target,
            "cycle57_label_key": e.cycle57_label_key,
            "required": e.required,
            "notes": e.notes,
        }
        for e in FIELD_CATALOG
    ]


def catalog_covers_phase1_gate() -> dict[str, Any]:
    names = {e.wire_name for e in FIELD_CATALOG}
    missing = sorted(PHASE1_GATE_FIELDS - names)
    return {
        "ok": not missing,
        "missing": missing,
        "covered": sorted(PHASE1_GATE_FIELDS & names),
        "phase1_fields": sorted(PHASE1_GATE_FIELDS),
    }


def resolve_adapter(kind: str, *, unknown_kind_policy: str = "echo") -> str:
    """Map JobKind wire → adapter name (mirrors JobRouter.route_kind)."""
    k = (kind or "").strip().lower()
    if k in KIND_TO_ADAPTER:
        if k == "generic":
            return "echo" if unknown_kind_policy == "echo" else "fail"
        return KIND_TO_ADAPTER[k]
    return "fail"


def validate_gate_payload(wire: Mapping[str, Any] | None) -> dict[str, Any]:
    """Validate one JobRouter emit-gate wire."""
    errors: list[str] = []
    wire = dict(wire or {})
    unknown = sorted(set(wire) - GATE_TOP_LEVEL_KEYS)
    if unknown:
        errors.append(f"unknown_top_level:{','.join(unknown)}")

    op = wire.get("op")
    if not isinstance(op, str) or op not in ROUTER_OPS:
        errors.append("invalid_or_missing_op")
        op = None

    job_id = wire.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        errors.append("invalid_or_missing_job_id")
        job_id = None

    kind = wire.get("kind")
    if kind is None and op is not None:
        kind = "echo"
    if kind is not None and not isinstance(kind, str):
        errors.append("invalid_kind")
        kind = None
    if isinstance(kind, str):
        kind = kind.strip().lower()

    adapter = wire.get("adapter")
    if adapter is None and isinstance(kind, str):
        adapter = resolve_adapter(kind)
    if adapter is not None:
        if not isinstance(adapter, str) or adapter not in ADAPTER_NAMES:
            errors.append("invalid_adapter")
            adapter = None

    defaults = OP_DEFAULTS.get(op or "", {})
    state = wire.get("state", defaults.get("state"))
    if state is not None and not isinstance(state, str):
        errors.append("invalid_state")
        state = None

    progress = wire.get("progress", defaults.get("progress"))
    if progress is not None:
        if not isinstance(progress, (int, float)):
            errors.append("invalid_progress_type")
            progress = None
        elif not (0.0 <= float(progress) <= 1.0):
            errors.append("progress_out_of_range")

    attempts = wire.get("attempts", 0)
    if not isinstance(attempts, int) or attempts < 0:
        errors.append("invalid_attempts")
        attempts = 0

    seq = wire.get("seq", 0)
    if not isinstance(seq, int) or seq < 0:
        errors.append("invalid_seq")
        seq = 0

    emit = wire.get("emit", defaults.get("emit", True))
    if not isinstance(emit, bool):
        errors.append("invalid_emit")
        emit = bool(defaults.get("emit", True))

    bus_kind = wire.get("bus_kind", defaults.get("bus_kind"))
    if bus_kind is not None and not isinstance(bus_kind, str):
        errors.append("invalid_bus_kind")
        bus_kind = None

    if op == "terminal" and isinstance(state, str) and state not in TERMINAL_STATES:
        errors.append("terminal_requires_terminal_state")
    if op == "cancel" and isinstance(state, str) and state not in TERMINAL_STATES:
        # cancel defaults to cancelled; allow only terminal states
        if state != "cancelled":
            errors.append("cancel_requires_terminal_state")

    if op == "dispatch" and adapter == "fail":
        errors.append("dispatch_adapter_fail")

    ok = not errors
    return {
        "ok": ok,
        "errors": errors,
        "op": op,
        "job_id": job_id,
        "kind": kind,
        "adapter": adapter,
        "state": state,
        "progress": float(progress) if isinstance(progress, (int, float)) else None,
        "attempts": attempts,
        "seq": seq,
        "emit": emit,
        "bus_kind": bus_kind,
        "error": wire.get("error"),
        "retryable": bool(wire.get("retryable", False)),
        "result_uri": wire.get("result_uri"),
        "thumb_uri": wire.get("thumb_uri"),
        "preview_uri": wire.get("preview_uri"),
        "labels": dict(wire.get("labels") or {}) if isinstance(wire.get("labels"), Mapping) else {},
        "shot_id": wire.get("shot_id"),
        "node_id": wire.get("node_id") if isinstance(wire.get("node_id"), str) else None,
        "scheduler_op": defaults.get("scheduler_op"),
    }


def event_from_gate(validation: Mapping[str, Any]) -> JobEvent | None:
    if not validation.get("ok"):
        return None
    kind_s = validation.get("bus_kind") or JobEventKind.UPDATED.value
    try:
        kind = JobEventKind(kind_s)
    except ValueError:
        return None
    state = validation.get("state") or "queued"
    job_id = validation.get("job_id")
    if not isinstance(job_id, str):
        return None
    labels = dict(validation.get("labels") or {})
    node_id = validation.get("node_id")
    if isinstance(node_id, str) and node_id and "host_id" not in labels:
        labels.setdefault("host_id", node_id)
    adapter = validation.get("adapter")
    if isinstance(adapter, str):
        labels.setdefault("adapter", adapter)
    k = validation.get("kind")
    if isinstance(k, str):
        labels.setdefault("kind", k)
    terminal = kind is JobEventKind.TERMINAL or state in TERMINAL_STATES
    return JobEvent(
        kind=kind,
        job_id=job_id,
        state=state,
        progress=validation.get("progress"),
        error=validation.get("error"),
        retryable=bool(validation.get("retryable")),
        result_uri=validation.get("result_uri"),
        thumb_uri=validation.get("thumb_uri"),
        preview_uri=validation.get("preview_uri"),
        labels=labels,
        shot_id=validation.get("shot_id"),
        attempts=int(validation.get("attempts") or 0),
        seq=int(validation.get("seq") or 0),
        terminal=terminal,
    )


@dataclass(frozen=True)
class GateAck:
    accepted: bool
    job_id: str
    op: str | None
    kind: str | None
    adapter: str | None
    reason: str
    bus_kind: str | None = None
    state: str | None = None
    progress: float | None = None
    attempts: int = 0
    emit: bool = False
    emitted: bool = False
    applied: bool = False
    dropped_reason: str | None = None
    events_key_preview: str | None = None
    job_hash_preview: str | None = None
    join_ready: bool = False
    ray_started: bool = False
    validation_ok: bool = False
    errors: tuple[str, ...] = field(default_factory=tuple)
    paper_only: bool = True
    seq: int = 0
    scheduler_op: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def gate_dry_run(
    wire: Mapping[str, Any] | None = None,
    *,
    bus: ProgressBus | None = None,
    prior: Mapping[str, Any] | None = None,
) -> GateAck:
    """Apply one JobRouter emit-gate wire against ProgressBus (paper-only).

    accepted stays false so freeze is never breached.
    """
    wire = dict(wire or {})
    if not wire:
        wire = {
            "op": "submit",
            "job_id": "dry-gate-1",
            "kind": "echo",
            "state": "queued",
            "progress": 0.0,
            "attempts": 0,
            "seq": 1,
        }

    validation = validate_gate_payload(wire)
    errors = list(validation["errors"])
    job_id = str(validation.get("job_id") or "")
    op = validation.get("op") if isinstance(validation.get("op"), str) else None
    errors.append("join_ready_false")
    errors.append("paper_only_no_live_redis")

    bus = bus or ProgressBus()
    dropped: str | None = None
    applied = False
    emitted = False
    emit = bool(validation.get("emit", True))
    proj_progress = validation.get("progress")
    proj_state = validation.get("state")
    proj_attempts = int(validation.get("attempts") or 0)
    proj_seq = int(validation.get("seq") or 0)
    bus_kind = validation.get("bus_kind") if isinstance(validation.get("bus_kind"), str) else None

    if prior and validation["ok"]:
        seed_v = validate_gate_payload(prior)
        if seed_v["ok"]:
            seed_event = event_from_gate(seed_v)
            if seed_event is not None:
                bus.apply(seed_event)

    if validation["ok"] and emit:
        event = event_from_gate(validation)
        if event is not None:
            emitted = True
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
    elif validation["ok"] and not emit:
        pass

    accepted = False
    if not validation["ok"]:
        reason = "validation_failed"
    elif not emit:
        reason = "emit_false_silent"
    elif dropped:
        reason = "bus_rejected"
    else:
        reason = "join_ready_false"

    return GateAck(
        accepted=accepted,
        job_id=job_id,
        op=op,
        kind=validation.get("kind") if isinstance(validation.get("kind"), str) else None,
        adapter=validation.get("adapter") if isinstance(validation.get("adapter"), str) else None,
        reason=reason,
        bus_kind=bus_kind,
        state=proj_state if isinstance(proj_state, str) else None,
        progress=float(proj_progress) if isinstance(proj_progress, (int, float)) else None,
        attempts=proj_attempts,
        emit=emit,
        emitted=emitted,
        applied=applied,
        dropped_reason=dropped,
        events_key_preview=job_events_key(job_id, namespace=DEFAULT_NAMESPACE) if job_id else None,
        job_hash_preview=job_hash_key(job_id, namespace=DEFAULT_NAMESPACE) if job_id else None,
        join_ready=False,
        ray_started=False,
        validation_ok=bool(validation["ok"]),
        errors=tuple(errors),
        paper_only=True,
        seq=proj_seq,
        scheduler_op=validation.get("scheduler_op") if isinstance(validation.get("scheduler_op"), str) else None,
    )


def sample_gate_wire(
    *,
    op: str = "submit",
    job_id: str = "dry-gate-1",
    kind: str = "echo",
    attempts: int = 0,
    seq: int = 1,
) -> dict[str, Any]:
    defaults = OP_DEFAULTS[op]
    adapter = resolve_adapter(kind)
    wire: dict[str, Any] = {
        "op": op,
        "job_id": job_id,
        "kind": kind,
        "adapter": adapter,
        "state": defaults["state"],
        "attempts": attempts,
        "seq": seq,
        "emit": defaults["emit"],
    }
    if defaults["progress"] is not None:
        wire["progress"] = defaults["progress"]
    if op == "dispatch":
        wire["node_id"] = "openclaw01"
    if op == "terminal":
        wire["result_uri"] = f"scratch://{job_id}/out.bin"
    if op == "cancel":
        wire["state"] = "cancelled"
    return wire


def scheduler_op_alignment() -> dict[str, Any]:
    """Show router op → C63 scheduler op emit alignment."""
    rows = []
    for op, d in OP_DEFAULTS.items():
        sop = d.get("scheduler_op")
        sdef = SCHEDULER_OP_DEFAULTS.get(sop or "", {})
        rows.append(
            {
                "router_op": op,
                "scheduler_op": sop,
                "router_emit": d["emit"],
                "scheduler_emit": sdef.get("emit"),
                "emit_aligned": d["emit"] == sdef.get("emit") if sdef else False,
                "router_bus_kind": d["bus_kind"],
                "scheduler_bus_kind": sdef.get("bus_kind"),
            }
        )
    return {
        "rows": rows,
        "all_emit_aligned": all(r["emit_aligned"] for r in rows),
    }


def contract_static_payload() -> dict[str, Any]:
    """Flag-off paper body: JobRouter emit-gate + kind→adapter catalog."""
    cov = catalog_covers_phase1_gate()
    align = scheduler_op_alignment()
    return {
        "product_path": PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "flag_opened": False,
        "ray_started": False,
        "tip_mount": False,
        "scratch_only": True,
        "field_catalog": field_catalog_rows(),
        "field_catalog_count": len(FIELD_CATALOG),
        "phase1_coverage": cov,
        "op_defaults": {
            k: {
                "bus_kind": v["bus_kind"],
                "state": v["state"],
                "progress": v["progress"],
                "emit": v["emit"],
                "notes": v["notes"],
                "scheduler_op": v.get("scheduler_op"),
            }
            for k, v in OP_DEFAULTS.items()
        },
        "router_ops": sorted(ROUTER_OPS),
        "kind_to_adapter": dict(KIND_TO_ADAPTER),
        "adapters": sorted(ADAPTER_NAMES),
        "scheduler_alignment": align,
        "live_gap": "JobRouter._publish always uses JobEvent.updated(); emit-gate table is checklist under 改码卡",
        "no_cycle57_label_mapping": list(NO_CYCLE57_LABEL_MAPPING),
        "allowed_gate_top_level": sorted(GATE_TOP_LEVEL_KEYS),
        "active_states": sorted(ACTIVE_STATES),
        "terminal_states": sorted(TERMINAL_STATES),
        "events_key_fn": "toiv:ray:job:{job_id}:events",
        "job_hash_fn": "toiv:ray:job:{job_id}",
        "join_ready_any": False,
        "adapter_tick_emit_default_false": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "designate Ray head host", "H3 口令"],
        "ties": [
            "C64",
            "C63",
            "JobRouter",
            "LlmGatewayActor",
            "ComfyPoolActor",
            "EchoActor",
            "ProgressBus",
            "JobRouter._publish",
        ],
        "milestone": MILESTONE,
        "ops": sorted(ROUTER_OPS),
    }


def run_job_router_emit_gate_cycle(
    *,
    sample_job_id: str | None = None,
) -> dict[str, Any]:
    """Flag-on dry-run: submit→dispatch→adapter_tick(silent)→tick→regress→terminal."""
    jid = sample_job_id or "dry-gate-1"
    bus = ProgressBus()

    submit = gate_dry_run(sample_gate_wire(op="submit", job_id=jid, kind="llm", seq=1), bus=bus)
    dispatch = gate_dry_run(
        sample_gate_wire(op="dispatch", job_id=jid, kind="llm", seq=2),
        bus=bus,
    )
    silent = gate_dry_run(
        {
            **sample_gate_wire(op="adapter_tick", job_id=jid, kind="llm", seq=3),
            "emit": False,
        },
        bus=bus,
    )
    tick = gate_dry_run(
        {
            "op": "adapter_tick",
            "job_id": jid,
            "kind": "llm",
            "adapter": "llm_gateway",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 4,
            "emit": True,
            "node_id": "spark02",
        },
        bus=bus,
    )
    regress = gate_dry_run(
        {
            "op": "adapter_tick",
            "job_id": jid,
            "kind": "llm",
            "adapter": "llm_gateway",
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 5,
            "emit": True,
            "node_id": "spark02",
        },
        bus=bus,
    )
    terminal = gate_dry_run(
        sample_gate_wire(op="terminal", job_id=jid, kind="llm", attempts=1, seq=6),
        bus=bus,
    )
    cancel_wire = gate_dry_run(
        sample_gate_wire(op="cancel", job_id="dry-gate-cancel", kind="comfy", seq=1),
        bus=ProgressBus(),
    )
    comfy_dispatch = gate_dry_run(
        sample_gate_wire(op="dispatch", job_id="dry-gate-comfy", kind="comfy", seq=1),
        bus=ProgressBus(),
    )

    bad_unknown = validate_gate_payload({"op": "submit", "job_id": jid, "evil": 1})
    bad_op = validate_gate_payload({"op": "nope", "job_id": jid})
    bad_progress = validate_gate_payload(
        {"op": "dispatch", "job_id": jid, "kind": "echo", "state": "running", "progress": 1.5}
    )
    bad_terminal = validate_gate_payload(
        {"op": "terminal", "job_id": jid, "kind": "echo", "state": "running"}
    )
    bad_adapter = validate_gate_payload(
        {"op": "dispatch", "job_id": jid, "kind": "echo", "adapter": "nope"}
    )

    acks = (submit, dispatch, silent, tick, regress, terminal, cancel_wire, comfy_dispatch)
    align = scheduler_op_alignment()
    return {
        "product_path": PRODUCT_PATH,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "flag_opened": False,
        "ray_started": False,
        "tip_mount": False,
        "scratch_only": True,
        "field_catalog": field_catalog_rows(),
        "field_catalog_count": len(FIELD_CATALOG),
        "phase1_coverage": catalog_covers_phase1_gate(),
        "op_defaults": {
            k: {
                "bus_kind": v["bus_kind"],
                "state": v["state"],
                "progress": v["progress"],
                "emit": v["emit"],
                "scheduler_op": v.get("scheduler_op"),
            }
            for k, v in OP_DEFAULTS.items()
        },
        "kind_to_adapter": dict(KIND_TO_ADAPTER),
        "scheduler_alignment": align,
        "sample_submit_ack": submit.to_dict(),
        "sample_dispatch_ack": dispatch.to_dict(),
        "sample_adapter_tick_silent_ack": silent.to_dict(),
        "sample_adapter_tick_ack": tick.to_dict(),
        "sample_regress_ack": regress.to_dict(),
        "sample_terminal_ack": terminal.to_dict(),
        "sample_cancel_ack": cancel_wire.to_dict(),
        "sample_comfy_dispatch_ack": comfy_dispatch.to_dict(),
        "all_accepted_false": all(not a.accepted for a in acks),
        "all_join_ready_false": all(a.join_ready is False for a in acks),
        "submit_applied": submit.applied,
        "dispatch_applied": dispatch.applied,
        "submit_adapter_llm_gateway": submit.adapter == "llm_gateway",
        "comfy_adapter_comfy_pool": comfy_dispatch.adapter == "comfy_pool",
        "adapter_tick_silent_not_emitted": silent.emitted is False and silent.reason == "emit_false_silent",
        "adapter_tick_applied": tick.applied,
        "regress_dropped": regress.applied is False and regress.dropped_reason is not None,
        "terminal_applied": terminal.applied,
        "cancel_applied": cancel_wire.applied,
        "bad_unknown_top_rejected": bad_unknown["ok"] is False,
        "bad_op_rejected": bad_op["ok"] is False,
        "bad_progress_range_rejected": bad_progress["ok"] is False,
        "bad_terminal_state_rejected": bad_terminal["ok"] is False,
        "bad_adapter_rejected": bad_adapter["ok"] is False,
        "join_ready_any": False,
        "sample_events_key": submit.events_key_preview,
        "sample_job_hash": submit.job_hash_preview,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "designate Ray head host", "H3 口令"],
        "ties": [
            "C64",
            "C63",
            "JobRouter",
            "LlmGatewayActor",
            "ComfyPoolActor",
            "EchoActor",
            "ProgressBus",
            "JobRouter._publish",
        ],
        "milestone": MILESTONE,
    }
