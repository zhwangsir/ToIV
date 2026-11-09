"""Ray PriorityScheduler ↔ ProgressBus glue field contract (Cycle 63).

Paper + scratch dry-run: map scheduler lifecycle ops (enqueue / lease / renew /
reclaim / terminal) onto ProgressBus JobEvent kinds + fields. No ray start,
no live Redis write, flag stays default false.

Competitive pattern (summary only): task-center row updates as the queue
leases, heartbeats, reclaims, and finishes work.
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
from .redis_keys import DEFAULT_NAMESPACE, job_events as job_events_key, job_hash as job_hash_key

PRODUCT_PATH = "ray_scheduler_progress_glue_contract"
MILESTONE = "ray_scheduler_progress_glue_contract_ready"

# Lifecycle ops the PriorityScheduler surface can emit into the bus.
SCHEDULER_OPS: frozenset[str] = frozenset(
    {"enqueue", "lease", "renew", "reclaim", "terminal"}
)

# Strict top-level for glue wire (scheduler op → bus event request).
GLUE_TOP_LEVEL_KEYS: frozenset[str] = frozenset(
    {
        "op",
        "job_id",
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
        "lease_token",
        "emit",
        "kind",
    }
)

PHASE1_GLUE_FIELDS: frozenset[str] = frozenset(
    {
        "op",
        "job_id",
        "bus_kind",
        "state",
        "progress",
        "attempts",
        "node_id",
        "emit",
        "events_key",
        "job_hash",
    }
)

# op → default ProgressBus kind + default state + whether to emit by default
OP_DEFAULTS: dict[str, dict[str, Any]] = {
    "enqueue": {
        "bus_kind": JobEventKind.ENQUEUED.value,
        "state": "queued",
        "progress": 0.0,
        "emit": True,
        "notes": "Admission → rail/task-center queued row",
    },
    "lease": {
        "bus_kind": JobEventKind.UPDATED.value,
        "state": "leased",
        "progress": None,  # keep prior; dry-run may set 0.0
        "emit": True,
        "notes": "Claim → leased|running; node_id required for live path",
    },
    "renew": {
        "bus_kind": JobEventKind.UPDATED.value,
        "state": "leased",  # or running; TTL-only by default
        "progress": None,
        "emit": False,  # heartbeat silent unless progress tick
        "notes": "TTL refresh; emit=false unless progress/state change",
    },
    "reclaim": {
        "bus_kind": JobEventKind.UPDATED.value,
        "state": "queued",
        "progress": 0.0,
        "emit": True,
        "notes": "Expired lease → requeue; attempts+1 unlocks progress reset",
    },
    "terminal": {
        "bus_kind": JobEventKind.TERMINAL.value,
        "state": "succeeded",
        "progress": 1.0,
        "emit": True,
        "notes": "succeeded|failed|cancelled; terminal=true",
    },
}


@dataclass(frozen=True)
class FieldEntry:
    """One row of scheduler op → ProgressBus → Redis 对照."""

    wire_name: str
    bus_attr: str
    redis_target: str
    cycle57_label_key: str
    required: bool
    notes: str = ""
    surface: str = "glue"  # glue | bus | both

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


FIELD_CATALOG: tuple[FieldEntry, ...] = (
    FieldEntry(
        wire_name="op",
        bus_attr="n/a (scheduler lifecycle)",
        redis_target="n/a",
        cycle57_label_key="n/a",
        required=True,
        notes="enqueue|lease|renew|reclaim|terminal",
        surface="glue",
    ),
    FieldEntry(
        wire_name="job_id",
        bus_attr="JobEvent.job_id",
        redis_target="hash id + events key suffix",
        cycle57_label_key="n/a",
        required=True,
        notes="Stable identity across scheduler ↔ bus",
        surface="both",
    ),
    FieldEntry(
        wire_name="bus_kind",
        bus_attr="JobEvent.kind",
        redis_target="events entry kind",
        cycle57_label_key="n/a",
        required=True,
        notes="Derived from op via OP_DEFAULTS",
        surface="bus",
    ),
    FieldEntry(
        wire_name="state",
        bus_attr="JobEvent.state / JobProjection.state",
        redis_target="hash status",
        cycle57_label_key="n/a",
        required=True,
        notes="queued|leased|running|succeeded|failed|cancelled",
        surface="both",
    ),
    FieldEntry(
        wire_name="progress",
        bus_attr="JobEvent.progress",
        redis_target="hash progress",
        cycle57_label_key="n/a",
        required=False,
        notes="enqueue/reclaim→0; terminal→1; renew usually omit",
        surface="both",
    ),
    FieldEntry(
        wire_name="attempts",
        bus_attr="JobEvent.attempts",
        redis_target="hash attempts",
        cycle57_label_key="n/a",
        required=False,
        notes="reclaim bumps; unlocks progress reset (D4)",
        surface="both",
    ),
    FieldEntry(
        wire_name="node_id",
        bus_attr="labels/host soft; JobState.node_id",
        redis_target="hash node_id",
        cycle57_label_key="host_id",
        required=False,
        notes="lease/renew carry worker host; soft Cycle57 map",
        surface="both",
    ),
    FieldEntry(
        wire_name="emit",
        bus_attr="n/a (glue gate)",
        redis_target="n/a",
        cycle57_label_key="n/a",
        required=True,
        notes="renew default false; others default true",
        surface="glue",
    ),
    FieldEntry(
        wire_name="lease_token",
        bus_attr="n/a (scheduler-only)",
        redis_target="job:{id}:lease",
        cycle57_label_key="n/a",
        required=False,
        notes="Not projected to ProgressBus; lease/renew/reclaim only",
        surface="glue",
    ),
    FieldEntry(
        wire_name="error",
        bus_attr="JobEvent.error",
        redis_target="hash error",
        cycle57_label_key="n/a",
        required=False,
        notes="terminal failed path",
        surface="both",
    ),
    FieldEntry(
        wire_name="result_uri",
        bus_attr="JobEvent.result_uri",
        redis_target="hash result_ref",
        cycle57_label_key="n/a",
        required=False,
        notes="terminal succeeded path",
        surface="both",
    ),
    FieldEntry(
        wire_name="seq",
        bus_attr="JobEvent.seq",
        redis_target="events id / journal",
        cycle57_label_key="n/a",
        required=False,
        notes="Bus assigns if 0",
        surface="bus",
    ),
    FieldEntry(
        wire_name="events_key",
        bus_attr="n/a",
        redis_target="job:{id}:events",
        cycle57_label_key="n/a",
        required=True,
        notes="Hot-path event stream key preview",
        surface="glue",
    ),
    FieldEntry(
        wire_name="job_hash",
        bus_attr="n/a",
        redis_target="job:{id}",
        cycle57_label_key="n/a",
        required=True,
        notes="Job hash key preview",
        surface="glue",
    ),
    FieldEntry(
        wire_name="labels",
        bus_attr="JobEvent.labels",
        redis_target="labels_json",
        cycle57_label_key="*",
        required=False,
        notes="Soft Cycle57 canonical label map",
        surface="both",
    ),
    FieldEntry(
        wire_name="kind",
        bus_attr="optional override of bus_kind",
        redis_target="events entry kind",
        cycle57_label_key="n/a",
        required=False,
        notes="Wire may override derived bus_kind; must be valid JobEventKind",
        surface="glue",
    ),
)

# Fields with no Cycle57 worker-label mapping (scheduler/bus surface).
NO_CYCLE57_LABEL_MAPPING: frozenset[str] = frozenset(
    {
        "op",
        "job_id",
        "bus_kind",
        "state",
        "progress",
        "attempts",
        "emit",
        "lease_token",
        "error",
        "result_uri",
        "seq",
        "events_key",
        "job_hash",
        "kind",
    }
)


def field_catalog_rows() -> list[dict[str, Any]]:
    return [e.to_dict() for e in FIELD_CATALOG]


def catalog_covers_phase1_glue() -> dict[str, Any]:
    wires = {e.wire_name for e in FIELD_CATALOG}
    missing = sorted(PHASE1_GLUE_FIELDS - wires)
    ops_covered = sorted(OP_DEFAULTS.keys())
    return {
        "ok": not missing,
        "missing_glue_fields": missing,
        "covered_ops": ops_covered,
        "ops_count": len(ops_covered),
        "field_catalog_count": len(FIELD_CATALOG),
        "phase1_count": len(PHASE1_GLUE_FIELDS),
    }


def validate_glue_payload(wire: Mapping[str, Any]) -> dict[str, Any]:
    """Strict top-level validate for scheduler→bus glue wire."""
    errors: list[str] = []
    unknown = sorted(set(wire.keys()) - GLUE_TOP_LEVEL_KEYS)
    if unknown:
        errors.append(f"unknown_top_level:{','.join(unknown)}")

    op = wire.get("op")
    if not isinstance(op, str) or op not in SCHEDULER_OPS:
        errors.append("invalid_op")
        op = None

    job_id = wire.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        errors.append("missing_job_id")
        job_id = None

    defaults = OP_DEFAULTS.get(op or "", {})
    state = wire.get("state", defaults.get("state"))
    if state is not None and not isinstance(state, str):
        errors.append("invalid_state_type")
        state = None
    if isinstance(state, str):
        allowed = ACTIVE_STATES | TERMINAL_STATES
        if state not in allowed:
            errors.append("invalid_state")

    progress = wire.get("progress", defaults.get("progress"))
    if progress is not None:
        if not isinstance(progress, (int, float)) or isinstance(progress, bool):
            errors.append("invalid_progress_type")
            progress = None
        elif not (0.0 <= float(progress) <= 1.0):
            errors.append("progress_out_of_range")

    attempts = wire.get("attempts", 0)
    if not isinstance(attempts, int) or isinstance(attempts, bool) or attempts < 0:
        errors.append("invalid_attempts")
        attempts = 0

    kind = wire.get("kind", defaults.get("bus_kind"))
    allowed_kinds = {k.value for k in JobEventKind}
    if kind is not None and kind not in allowed_kinds:
        errors.append("invalid_kind")

    emit = wire.get("emit", defaults.get("emit", True))
    if not isinstance(emit, bool):
        errors.append("invalid_emit")
        emit = bool(defaults.get("emit", True))

    # reclaim must bump attempts relative to implied prior when progress resets
    if op == "reclaim" and progress == 0.0 and attempts < 1:
        # allow explicit attempts=0 only if caller will set prior; warn as soft rule
        pass

    if op == "terminal" and isinstance(state, str) and state not in TERMINAL_STATES:
        errors.append("terminal_op_requires_terminal_state")

    if op == "lease" and not wire.get("node_id") and "node_id" not in wire:
        # soft: live path wants node_id; paper dry-run may omit
        pass

    return {
        "ok": not errors,
        "errors": errors,
        "unknown_top_level": unknown,
        "op": op,
        "job_id": job_id,
        "state": state if isinstance(state, str) else None,
        "progress": float(progress) if isinstance(progress, (int, float)) and not isinstance(progress, bool) else None,
        "attempts": attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else 0,
        "node_id": wire.get("node_id") if isinstance(wire.get("node_id"), str) else None,
        "bus_kind": kind if isinstance(kind, str) else None,
        "emit": emit,
        "error": wire.get("error") if isinstance(wire.get("error"), str) else None,
        "retryable": bool(wire.get("retryable", False)),
        "result_uri": wire.get("result_uri") if isinstance(wire.get("result_uri"), str) else None,
        "thumb_uri": wire.get("thumb_uri") if isinstance(wire.get("thumb_uri"), str) else None,
        "preview_uri": wire.get("preview_uri") if isinstance(wire.get("preview_uri"), str) else None,
        "labels": dict(wire["labels"]) if isinstance(wire.get("labels"), dict) else {},
        "shot_id": wire.get("shot_id") if isinstance(wire.get("shot_id"), str) else None,
        "seq": int(wire["seq"]) if isinstance(wire.get("seq"), int) and not isinstance(wire.get("seq"), bool) else 0,
        "lease_token": wire.get("lease_token") if isinstance(wire.get("lease_token"), str) else None,
    }


def event_from_glue(validation: Mapping[str, Any]) -> JobEvent | None:
    """Build JobEvent from a successful validate_glue_payload result."""
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
class GlueAck:
    accepted: bool
    job_id: str
    op: str | None
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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def glue_dry_run(
    wire: Mapping[str, Any] | None = None,
    *,
    bus: ProgressBus | None = None,
    prior: Mapping[str, Any] | None = None,
) -> GlueAck:
    """Apply one scheduler→bus glue wire against ProgressBus (paper-only).

    accepted stays false (join_ready_false / paper_only) so freeze is never breached.
    """
    wire = dict(wire or {})
    if not wire:
        wire = {
            "op": "enqueue",
            "job_id": "dry-glue-1",
            "state": "queued",
            "progress": 0.0,
            "attempts": 0,
            "seq": 1,
        }

    validation = validate_glue_payload(wire)
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
        seed_v = validate_glue_payload(prior)
        if seed_v["ok"]:
            # Force emit for seed so bus has prior projection
            seed_v = dict(seed_v)
            seed_event = event_from_glue(seed_v)
            if seed_event is not None:
                bus.apply(seed_event)

    if validation["ok"] and emit:
        event = event_from_glue(validation)
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
        # Silent renew path: validated but not emitted
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

    return GlueAck(
        accepted=accepted,
        job_id=job_id,
        op=op,
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
    )


def sample_glue_wire(
    *,
    op: str = "enqueue",
    job_id: str = "dry-glue-1",
    attempts: int = 0,
    seq: int = 1,
) -> dict[str, Any]:
    defaults = OP_DEFAULTS[op]
    wire: dict[str, Any] = {
        "op": op,
        "job_id": job_id,
        "state": defaults["state"],
        "attempts": attempts,
        "seq": seq,
        "emit": defaults["emit"],
    }
    if defaults["progress"] is not None:
        wire["progress"] = defaults["progress"]
    if op in ("lease", "renew"):
        wire["node_id"] = "openclaw01"
        wire["lease_token"] = "lease-dry-1"
    if op == "reclaim":
        wire["attempts"] = max(1, attempts)
        wire["progress"] = 0.0
        wire["lease_token"] = "lease-dry-1"
    if op == "terminal":
        wire["result_uri"] = f"scratch://{job_id}/out.mp4"
    return wire


def contract_static_payload() -> dict[str, Any]:
    """Flag-off paper body: scheduler↔bus glue catalog + Phase1 coverage."""
    cov = catalog_covers_phase1_glue()
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
            }
            for k, v in OP_DEFAULTS.items()
        },
        "scheduler_ops": sorted(SCHEDULER_OPS),
        "no_cycle57_label_mapping": list(NO_CYCLE57_LABEL_MAPPING),
        "allowed_glue_top_level": sorted(GLUE_TOP_LEVEL_KEYS),
        "active_states": sorted(ACTIVE_STATES),
        "terminal_states": sorted(TERMINAL_STATES),
        "events_key_fn": "toiv:ray:job:{job_id}:events",
        "job_hash_fn": "toiv:ray:job:{job_id}",
        "join_ready_any": False,
        "renew_emit_default_false": True,
        "reclaim_resets_progress": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "designate Ray head host", "H3 口令"],
        "ties": [
            "C63",
            "C62",
            "C61",
            "C60",
            "C59",
            "PriorityScheduler",
            "ProgressBus",
            "JobRouter._publish",
            "redis_keys.job_events",
        ],
        "milestone": MILESTONE,
        "ops": sorted(SCHEDULER_OPS),
    }


def run_scheduler_progress_glue_cycle(
    *,
    sample_job_id: str | None = None,
) -> dict[str, Any]:
    """Flag-on dry-run: enqueue→lease→renew(silent)→reclaim→terminal (no live Redis)."""
    jid = sample_job_id or "dry-glue-1"
    bus = ProgressBus()

    enq = glue_dry_run(sample_glue_wire(op="enqueue", job_id=jid, seq=1), bus=bus)
    lease = glue_dry_run(
        {
            **sample_glue_wire(op="lease", job_id=jid, seq=2),
            "state": "running",
            "progress": 0.1,
        },
        bus=bus,
    )
    # Silent renew: emit=false
    renew = glue_dry_run(
        {
            **sample_glue_wire(op="renew", job_id=jid, seq=3),
            "state": "running",
            "emit": False,
        },
        bus=bus,
    )
    # Progress tick via lease-like update (optional renew with emit)
    tick = glue_dry_run(
        {
            "op": "renew",
            "job_id": jid,
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 4,
            "emit": True,
            "node_id": "openclaw01",
            "lease_token": "lease-dry-1",
        },
        bus=bus,
    )
    # Regress should drop
    regress = glue_dry_run(
        {
            "op": "renew",
            "job_id": jid,
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 5,
            "emit": True,
            "node_id": "openclaw01",
        },
        bus=bus,
    )
    # Reclaim: attempts bump + progress 0
    reclaim = glue_dry_run(
        sample_glue_wire(op="reclaim", job_id=jid, attempts=1, seq=6),
        bus=bus,
    )
    terminal = glue_dry_run(
        sample_glue_wire(op="terminal", job_id=jid, attempts=1, seq=7),
        bus=bus,
    )

    bad_unknown = validate_glue_payload(
        {"op": "enqueue", "job_id": jid, "evil": 1}
    )
    bad_op = validate_glue_payload({"op": "nope", "job_id": jid})
    bad_progress = validate_glue_payload(
        {"op": "lease", "job_id": jid, "state": "running", "progress": 1.5}
    )
    bad_terminal_state = validate_glue_payload(
        {"op": "terminal", "job_id": jid, "state": "running"}
    )

    acks = (enq, lease, renew, tick, regress, reclaim, terminal)
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
        "phase1_coverage": catalog_covers_phase1_glue(),
        "op_defaults": {
            k: {
                "bus_kind": v["bus_kind"],
                "state": v["state"],
                "progress": v["progress"],
                "emit": v["emit"],
            }
            for k, v in OP_DEFAULTS.items()
        },
        "sample_enqueue_ack": enq.to_dict(),
        "sample_lease_ack": lease.to_dict(),
        "sample_renew_silent_ack": renew.to_dict(),
        "sample_renew_tick_ack": tick.to_dict(),
        "sample_regress_ack": regress.to_dict(),
        "sample_reclaim_ack": reclaim.to_dict(),
        "sample_terminal_ack": terminal.to_dict(),
        "all_accepted_false": all(not a.accepted for a in acks),
        "all_join_ready_false": all(a.join_ready is False for a in acks),
        "enqueue_applied": enq.applied,
        "lease_applied": lease.applied,
        "renew_silent_not_emitted": renew.emitted is False and renew.reason == "emit_false_silent",
        "renew_tick_applied": tick.applied,
        "regress_dropped": regress.applied is False and regress.dropped_reason is not None,
        "reclaim_applied": reclaim.applied,
        "terminal_applied": terminal.applied,
        "bad_unknown_top_rejected": bad_unknown["ok"] is False,
        "bad_op_rejected": bad_op["ok"] is False,
        "bad_progress_range_rejected": bad_progress["ok"] is False,
        "bad_terminal_state_rejected": bad_terminal_state["ok"] is False,
        "join_ready_any": False,
        "sample_events_key": enq.events_key_preview,
        "sample_job_hash": enq.job_hash_preview,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "designate Ray head host", "H3 口令"],
        "ties": [
            "C63",
            "C62",
            "C61",
            "C60",
            "C59",
            "PriorityScheduler",
            "ProgressBus",
            "JobRouter._publish",
            "redis_keys.job_events",
        ],
        "milestone": MILESTONE,
    }
