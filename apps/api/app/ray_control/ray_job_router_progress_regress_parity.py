"""JR-R4 ProgressBus regress-drop parity — Cycle 79.

Deepens Cycle 65 JR-R4 / Cycle 63 scheduler regress / Cycle 64 emit-gate /
Cycle 70 adapter_tick AT6 into a dedicated ProgressBus D3/D4 parity contract:
monotonic progress (no flicker regress), attempts-bump retry reset, terminal
bypass, and emit-path / renew-glue path still drop 0.5→0.2.

Does NOT mutate live actors/job_router.py or ProgressBus production callers.
Flag default false; accepted=false; ray_started=false; join_ready=false.
Fills empty Cycles 71–78.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

from .progress_bus import JobEvent, JobEventKind, ProgressBus
from .ray_job_router_emit_gate import gate_dry_run, sample_gate_wire
from .ray_scheduler_progress_glue import glue_dry_run, sample_glue_wire
from .redis_keys import DEFAULT_NAMESPACE, job_events as job_events_key, job_hash as job_hash_key

PRODUCT_PATH = "ray_job_router_progress_regress_parity_contract"
MILESTONE = "ray_job_router_progress_regress_parity_contract_ready"
TICKET = "JR-R4"

REGRESS_REASON_TOKEN = "progress_regress"


@dataclass(frozen=True)
class RegressParityStep:
    """One JR-R4 ProgressBus regress-drop checklist row (PR*)."""

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


REGRESS_PARITY_STEPS: tuple[RegressParityStep, ...] = (
    RegressParityStep(
        id="PR1",
        title="ProgressBus D3 baseline regress drop",
        summary=(
            "Direct ProgressBus.apply: seed progress=0.5 then emit 0.2 with "
            "same attempts, non-terminal → drop with progress_regress."
        ),
        harness_call="bus_apply_regress_pair()",
        acceptance="applied=false; dropped contains progress_regress; prior stays 0.5",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("ProgressBus.D3", "C63", "C64"),
    ),
    RegressParityStep(
        id="PR2",
        title="D4 attempts bump allows progress reset to 0",
        summary=(
            "When attempts increase and progress=0, ProgressBus allows the "
            "reset (retry path) instead of treating it as regress."
        ),
        harness_call="bus_apply_retry_reset()",
        acceptance="attempts+1 + progress=0 → applied; progress becomes 0",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("ProgressBus.D4", "C63-reclaim"),
    ),
    RegressParityStep(
        id="PR3",
        title="Terminal may carry lower progress without regress drop",
        summary=(
            "Terminal succeed/fail/cancel with progress lower than prior still "
            "applies (event.terminal=True bypasses D3)."
        ),
        harness_call="bus_apply_terminal_lower_progress()",
        acceptance="terminal + progress↓ → applied; state terminal",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("JobEvent.updated terminal", "JR-R1"),
    ),
    RegressParityStep(
        id="PR4",
        title="Emit-gate adapter_tick emit path still regress-drops",
        summary=(
            "C64 gate_dry_run + explicit emit on adapter_tick: 0.5→0.2 drops; "
            "aligns Cycle 70 AT6 / JR-R2 emit path."
        ),
        harness_call="gate_dry_run adapter_tick regress pair",
        acceptance="regress → applied=false + dropped_reason contains progress_regress",
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("C64", "C70-AT6", "adapter_tick"),
    ),
    RegressParityStep(
        id="PR5",
        title="Scheduler renew glue path still regress-drops",
        summary=(
            "C63 glue_dry_run renew with emit=true + progress regress still "
            "ProgressBus-drops; parity across scheduler↔router surfaces."
        ),
        harness_call="glue_dry_run renew regress pair",
        acceptance="renew regress → applied=false + progress_regress",
        kouling_blocker=("改码卡",),
        implementable_offline=True,
        ties=("C63", "ray_scheduler_progress_glue"),
    ),
    RegressParityStep(
        id="PR6",
        title="Monotonic advance positive control",
        summary=(
            "0.2→0.5 on same attempts / non-terminal applies (proves drop is "
            "regress-only, not any progress change)."
        ),
        harness_call="bus_apply_monotonic_advance()",
        acceptance="progress↑ → applied; projection.progress=0.5",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("ProgressBus", "competitor monotonic row"),
    ),
    RegressParityStep(
        id="PR7",
        title="accepted=false until 改码卡",
        summary=(
            "All dry-runs keep accepted=false, join_ready=false, ray_started=false; "
            "live JobRouter / ProgressBus callers unchanged."
        ),
        harness_call="run_progress_regress_parity_cycle / contract_static_payload",
        acceptance="all_accepted_false; live_bus_unchanged=true; flag default false",
        kouling_blocker=("改码卡", "Ray LAN（含 head）", "H3 口令"),
        implementable_offline=True,
        ties=("flag", "JR-R4"),
    ),
)


def step_catalog() -> list[dict[str, Any]]:
    return [s.to_dict() for s in REGRESS_PARITY_STEPS]


def get_step(step_id: str) -> RegressParityStep | None:
    for s in REGRESS_PARITY_STEPS:
        if s.id == step_id:
            return s
    return None


@dataclass
class RegressAck:
    accepted: bool
    job_id: str | None
    applied: bool
    dropped_reason: str | None
    progress: float | None = None
    attempts: int = 0
    state: str | None = None
    terminal: bool = False
    surface: str = "progress_bus"
    op: str | None = None
    emit: bool = True
    emitted: bool = False
    live_bus_unchanged: bool = True
    join_ready: bool = False
    ray_started: bool = False
    validation_ok: bool = True
    errors: tuple[str, ...] = field(default_factory=tuple)
    paper_only: bool = True
    seq: int = 0
    events_key_preview: str | None = None
    job_hash_preview: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["errors"] = list(self.errors)
        return d


def _seed_running(bus: ProgressBus, job_id: str, *, progress: float, seq: int, attempts: int = 0) -> None:
    bus.apply(
        JobEvent.enqueued(job_id, state="queued", progress=0.0, attempts=attempts, seq=seq)
    )
    bus.apply(
        JobEvent.updated(
            job_id,
            state="running",
            progress=progress,
            attempts=attempts,
            seq=seq + 1,
        )
    )


def bus_apply_regress_pair(
    *,
    job_id: str = "dry-pr-reg",
    hi: float = 0.5,
    lo: float = 0.2,
) -> RegressAck:
    """PR1: direct ProgressBus D3 regress drop."""
    bus = ProgressBus()
    _seed_running(bus, job_id, progress=hi, seq=1)
    prior = bus.jobs_by_id[job_id]
    result = bus.apply(
        JobEvent.updated(
            job_id,
            state="running",
            progress=lo,
            attempts=prior.attempts,
            seq=prior.seq + 1,
        )
    )
    dropped = None
    if result is None and bus._dropped:
        dropped = str(bus._dropped[-1])
    return RegressAck(
        accepted=False,
        job_id=job_id,
        applied=result is not None,
        dropped_reason=dropped,
        progress=bus.jobs_by_id[job_id].progress if job_id in bus.jobs_by_id else None,
        attempts=bus.jobs_by_id[job_id].attempts if job_id in bus.jobs_by_id else 0,
        state=bus.jobs_by_id[job_id].state if job_id in bus.jobs_by_id else None,
        surface="progress_bus",
        op="apply_regress",
        emit=True,
        emitted=True,
        events_key_preview=job_events_key(job_id, namespace=DEFAULT_NAMESPACE),
        job_hash_preview=job_hash_key(job_id, namespace=DEFAULT_NAMESPACE),
        seq=prior.seq + 1,
    )


def bus_apply_retry_reset(*, job_id: str = "dry-pr-retry") -> RegressAck:
    """PR2: attempts bump + progress=0 applies (D4)."""
    bus = ProgressBus()
    _seed_running(bus, job_id, progress=0.6, seq=1, attempts=0)
    prior = bus.jobs_by_id[job_id]
    result = bus.apply(
        JobEvent.updated(
            job_id,
            state="running",
            progress=0.0,
            attempts=prior.attempts + 1,
            seq=prior.seq + 1,
        )
    )
    dropped = None
    if result is None and bus._dropped:
        dropped = str(bus._dropped[-1])
    proj = bus.jobs_by_id.get(job_id)
    return RegressAck(
        accepted=False,
        job_id=job_id,
        applied=result is not None,
        dropped_reason=dropped,
        progress=proj.progress if proj else None,
        attempts=proj.attempts if proj else 0,
        state=proj.state if proj else None,
        surface="progress_bus",
        op="apply_retry_reset",
        emit=True,
        emitted=True,
        seq=(prior.seq + 1),
        events_key_preview=job_events_key(job_id, namespace=DEFAULT_NAMESPACE),
        job_hash_preview=job_hash_key(job_id, namespace=DEFAULT_NAMESPACE),
    )


def bus_apply_terminal_lower_progress(*, job_id: str = "dry-pr-term") -> RegressAck:
    """PR3: terminal with lower progress still applies."""
    bus = ProgressBus()
    _seed_running(bus, job_id, progress=0.9, seq=1)
    prior = bus.jobs_by_id[job_id]
    result = bus.apply(
        JobEvent.updated(
            job_id,
            state="succeeded",
            progress=0.4,
            attempts=prior.attempts,
            seq=prior.seq + 1,
            result_uri=f"scratch://{job_id}/out.bin",
        )
    )
    dropped = None
    if result is None and bus._dropped:
        dropped = str(bus._dropped[-1])
    proj = bus.jobs_by_id.get(job_id)
    return RegressAck(
        accepted=False,
        job_id=job_id,
        applied=result is not None,
        dropped_reason=dropped,
        progress=proj.progress if proj else None,
        attempts=proj.attempts if proj else 0,
        state=proj.state if proj else None,
        terminal=bool(proj.terminal) if proj else False,
        surface="progress_bus",
        op="apply_terminal",
        emit=True,
        emitted=True,
        seq=prior.seq + 1,
        events_key_preview=job_events_key(job_id, namespace=DEFAULT_NAMESPACE),
        job_hash_preview=job_hash_key(job_id, namespace=DEFAULT_NAMESPACE),
    )


def bus_apply_monotonic_advance(*, job_id: str = "dry-pr-mono") -> RegressAck:
    """PR6: progress increase applies."""
    bus = ProgressBus()
    _seed_running(bus, job_id, progress=0.2, seq=1)
    prior = bus.jobs_by_id[job_id]
    result = bus.apply(
        JobEvent.updated(
            job_id,
            state="running",
            progress=0.5,
            attempts=prior.attempts,
            seq=prior.seq + 1,
        )
    )
    dropped = None
    if result is None and bus._dropped:
        dropped = str(bus._dropped[-1])
    proj = bus.jobs_by_id.get(job_id)
    return RegressAck(
        accepted=False,
        job_id=job_id,
        applied=result is not None,
        dropped_reason=dropped,
        progress=proj.progress if proj else None,
        attempts=proj.attempts if proj else 0,
        state=proj.state if proj else None,
        surface="progress_bus",
        op="apply_monotonic",
        emit=True,
        emitted=True,
        seq=prior.seq + 1,
        events_key_preview=job_events_key(job_id, namespace=DEFAULT_NAMESPACE),
        job_hash_preview=job_hash_key(job_id, namespace=DEFAULT_NAMESPACE),
    )


def emit_gate_regress_pair(*, job_id: str = "dry-pr-gate") -> tuple[Any, Any]:
    """PR4: C64 emit-gate adapter_tick regress on emit path."""
    bus = ProgressBus()
    gate_dry_run(sample_gate_wire(op="submit", job_id=job_id, kind="echo", seq=1), bus=bus)
    gate_dry_run(sample_gate_wire(op="dispatch", job_id=job_id, kind="echo", seq=2), bus=bus)
    hi = gate_dry_run(
        {
            "op": "adapter_tick",
            "job_id": job_id,
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.5,
            "attempts": 0,
            "seq": 3,
            "emit": True,
        },
        bus=bus,
    )
    regress = gate_dry_run(
        {
            "op": "adapter_tick",
            "job_id": job_id,
            "kind": "echo",
            "adapter": "echo",
            "state": "running",
            "progress": 0.2,
            "attempts": 0,
            "seq": 4,
            "emit": True,
        },
        bus=bus,
    )
    return hi, regress


def scheduler_glue_regress_pair(*, job_id: str = "dry-pr-glue") -> tuple[Any, Any]:
    """PR5: C63 renew glue regress drop."""
    bus = ProgressBus()
    glue_dry_run(sample_glue_wire(op="enqueue", job_id=job_id, seq=1), bus=bus)
    glue_dry_run(
        {**sample_glue_wire(op="lease", job_id=job_id, seq=2), "emit": True, "progress": 0.05},
        bus=bus,
    )
    hi = glue_dry_run(
        {
            **sample_glue_wire(op="renew", job_id=job_id, seq=3),
            "emit": True,
            "progress": 0.5,
            "state": "running",
        },
        bus=bus,
    )
    regress = glue_dry_run(
        {
            **sample_glue_wire(op="renew", job_id=job_id, seq=4),
            "emit": True,
            "progress": 0.2,
            "state": "running",
        },
        bus=bus,
    )
    return hi, regress


def catalog_integrity() -> dict[str, Any]:
    ids = [s.id for s in REGRESS_PARITY_STEPS]
    missing = sorted({"PR1", "PR2", "PR3", "PR4", "PR5", "PR6", "PR7"} - set(ids))
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    baseline = bus_apply_regress_pair()
    baseline_ok = (
        baseline.applied is False
        and baseline.dropped_reason is not None
        and REGRESS_REASON_TOKEN in str(baseline.dropped_reason)
        and baseline.progress == 0.5
    )
    mono = bus_apply_monotonic_advance()
    mono_ok = mono.applied is True and mono.progress == 0.5
    return {
        "ok": not missing and not dupes and baseline_ok and mono_ok,
        "step_ids": ids,
        "missing_ids": missing,
        "duplicate_ids": dupes,
        "baseline_regress_ok": baseline_ok,
        "monotonic_ok": mono_ok,
        "live_bus_unchanged": True,
        "ticket": TICKET,
        "product_path": PRODUCT_PATH,
    }


def contract_static_payload() -> dict[str, Any]:
    integ = catalog_integrity()
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
        "step_count": len(REGRESS_PARITY_STEPS),
        "step_ids": [s.id for s in REGRESS_PARITY_STEPS],
        "regress_reason_token": REGRESS_REASON_TOKEN,
        "catalog_integrity": integ,
        "join_ready_any": False,
        "accepted": False,
        "live_bus_unchanged": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C79",
            "C70-AT6",
            "C65-JR-R4",
            "C64",
            "C63",
            "ProgressBus.D3",
            "ProgressBus.D4",
            "adapter_tick",
            "scheduler_renew",
        ],
        "milestone": MILESTONE,
        "ticket": TICKET,
        "fills_empty_cycles": list(range(71, 79)),
    }


def run_progress_regress_parity_cycle(
    *,
    sample_job_id: str | None = None,
) -> dict[str, Any]:
    """Flag-on dry-run: D3/D4 + emit-gate + renew-glue regress parity."""
    prefix = sample_job_id or "dry-pr"
    pr1 = bus_apply_regress_pair(job_id=f"{prefix}-reg")
    pr2 = bus_apply_retry_reset(job_id=f"{prefix}-retry")
    pr3 = bus_apply_terminal_lower_progress(job_id=f"{prefix}-term")
    pr6 = bus_apply_monotonic_advance(job_id=f"{prefix}-mono")
    hi_gate, regress_gate = emit_gate_regress_pair(job_id=f"{prefix}-gate")
    hi_glue, regress_glue = scheduler_glue_regress_pair(job_id=f"{prefix}-glue")

    regress_bus_ok = (
        pr1.applied is False
        and pr1.dropped_reason is not None
        and REGRESS_REASON_TOKEN in str(pr1.dropped_reason)
        and pr1.progress == 0.5
    )
    retry_ok = pr2.applied is True and pr2.progress == 0.0 and pr2.attempts == 1
    terminal_ok = pr3.applied is True and pr3.terminal is True and pr3.state == "succeeded"
    mono_ok = pr6.applied is True and pr6.progress == 0.5
    gate_regress_ok = (
        hi_gate.applied is True
        and regress_gate.applied is False
        and regress_gate.dropped_reason is not None
        and REGRESS_REASON_TOKEN in str(regress_gate.dropped_reason)
    )
    glue_regress_ok = (
        hi_glue.applied is True
        and regress_glue.applied is False
        and regress_glue.dropped_reason is not None
        and REGRESS_REASON_TOKEN in str(regress_glue.dropped_reason)
    )

    acks = (pr1, pr2, pr3, pr6)
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
        "step_count": len(REGRESS_PARITY_STEPS),
        "catalog_integrity": integ,
        "sample_pr1_regress_ack": pr1.to_dict(),
        "sample_pr2_retry_ack": pr2.to_dict(),
        "sample_pr3_terminal_ack": pr3.to_dict(),
        "sample_pr4_gate_hi_ack": hi_gate.to_dict(),
        "sample_pr4_gate_regress_ack": regress_gate.to_dict(),
        "sample_pr5_glue_hi_ack": hi_glue.to_dict(),
        "sample_pr5_glue_regress_ack": regress_glue.to_dict(),
        "sample_pr6_mono_ack": pr6.to_dict(),
        "all_accepted_false": all(not a.accepted for a in acks)
        and hi_gate.accepted is False
        and regress_gate.accepted is False
        and hi_glue.accepted is False
        and regress_glue.accepted is False,
        "all_join_ready_false": all(a.join_ready is False for a in acks),
        "all_live_bus_unchanged": all(a.live_bus_unchanged for a in acks),
        "pr1_regress_dropped": regress_bus_ok,
        "pr2_retry_reset_applied": retry_ok,
        "pr3_terminal_applied": terminal_ok,
        "pr4_gate_regress_dropped": gate_regress_ok,
        "pr5_glue_regress_dropped": glue_regress_ok,
        "pr6_monotonic_applied": mono_ok,
        "regress_parity_ok": all(
            (regress_bus_ok, retry_ok, terminal_ok, gate_regress_ok, glue_regress_ok, mono_ok)
        ),
        "join_ready_any": False,
        "accepted": False,
        "live_bus_unchanged": True,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）", "H3 口令"],
        "ties": [
            "C79",
            "C70-AT6",
            "C65-JR-R4",
            "C64",
            "C63",
            "ProgressBus.D3",
            "ProgressBus.D4",
            "adapter_tick",
            "scheduler_renew",
        ],
        "milestone": MILESTONE,
        "ticket": TICKET,
        "fills_empty_cycles": list(range(71, 79)),
    }
