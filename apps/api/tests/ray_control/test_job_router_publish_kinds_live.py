"""JR-R1/R2 tip merge — live JobRouter._publish(op) 三分 + silent tick smoke."""

from __future__ import annotations

from datetime import datetime, timezone

from app.ray_control.actors.job_router import JobRouter, JobRouterConfig
from app.ray_control.flag import RAY_CONTROL_ENV, is_ray_control_enabled
from app.ray_control.progress_bus import JobEventKind, ProgressBus
from app.ray_control.types import Job, JobKind, JobSpec, JobState, JobStatus


def test_flag_default_false_and_unknown_kind_fail() -> None:
    assert is_ray_control_enabled({}) is False
    assert is_ray_control_enabled({RAY_CONTROL_ENV: ""}) is False
    assert is_ray_control_enabled({RAY_CONTROL_ENV: "0"}) is False
    assert JobRouterConfig().unknown_kind_policy == "fail"


def test_submit_dispatch_terminal_kinds() -> None:
    bus = ProgressBus(coalesce_ms=0.0)
    router = JobRouter(bus=bus)
    router.submit(JobSpec(job_id="s1", kind=JobKind.ECHO, priority=1, payload={"message": "hi"}))
    assert bus.jobs_by_id["s1"].state == "queued"
    job = router.tick()
    assert job is not None
    assert job.state is JobStatus.SUCCEEDED
    assert bus.jobs_by_id["s1"].terminal is True


def test_cancel_publishes_terminal() -> None:
    bus = ProgressBus(coalesce_ms=0.0)
    router = JobRouter(bus=bus)
    router.submit(JobSpec(job_id="c1", kind=JobKind.ECHO, priority=1, payload={}))
    cancelled = router.cancel("c1")
    assert cancelled is not None
    assert cancelled.state is JobStatus.CANCELLED
    assert bus.jobs_by_id["c1"].state == "cancelled"
    assert bus.jobs_by_id["c1"].terminal is True


def test_adapter_tick_silent_by_default() -> None:
    bus = ProgressBus(coalesce_ms=0.0)
    router = JobRouter(bus=bus)
    now = datetime.now(timezone.utc)
    job = Job.from_spec_state(
        JobSpec(job_id="t1", kind=JobKind.ECHO, priority=1, payload={}),
        JobState(status=JobStatus.RUNNING, attempts=1, progress=0.4, updated_at=now),
        created_at=now,
    )
    # No prior → silent
    assert router.adapter_tick_publish(job) is None
    assert router.last_emit_decision is not None
    assert router.last_emit_decision.emit is False
    assert router.last_emit_decision.reason == "emit_false_silent"

    # Progress delta → emit updated
    job2 = Job.from_spec_state(
        JobSpec(job_id="t1", kind=JobKind.ECHO, priority=1, payload={}),
        JobState(status=JobStatus.RUNNING, attempts=1, progress=0.55, updated_at=now),
        created_at=now,
    )
    ev = router.adapter_tick_publish(
        job2, prior_progress=0.4, prior_state="running"
    )
    assert ev is not None
    assert ev.kind is JobEventKind.UPDATED
    assert router.last_emit_decision.emit is True
