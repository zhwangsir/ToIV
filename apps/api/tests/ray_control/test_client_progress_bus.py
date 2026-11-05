"""Cycle 11: flag-gated client + progress bus dedupe."""

from __future__ import annotations

from datetime import datetime, timezone

from app.ray_control.client import DisabledResult, RayControlClient, get_client, is_disabled
from app.ray_control.flag import RAY_CONTROL_ENV
from app.ray_control.progress_bus import JobEvent, ProgressBus
from app.ray_control.types import JobKind, JobSpec, JobStatus


def test_client_disabled_by_default():
    c = get_client(environ={})
    assert c.enabled() is False
    out = c.enqueue(
        JobSpec(job_id="j1", kind=JobKind.ECHO, priority=1),
    )
    assert isinstance(out, DisabledResult)
    assert is_disabled(out)
    assert c.get("j1").reason == "ray_control_disabled"  # type: ignore[union-attr]
    assert c.cancel("j1").enabled is False  # type: ignore[union-attr]
    assert c.list_jobs().reason == "ray_control_disabled"  # type: ignore[union-attr]


def test_client_enqueue_get_cancel_when_enabled():
    env = {RAY_CONTROL_ENV: "true"}
    c = RayControlClient(environ=env)
    job = c.enqueue(JobSpec(job_id="echo-1", kind=JobKind.ECHO, priority=3))
    assert not is_disabled(job)
    assert job.id == "echo-1"  # type: ignore[union-attr]
    assert job.state is JobStatus.QUEUED  # type: ignore[union-attr]
    assert job.progress == 0.0  # type: ignore[union-attr]

    got = c.get("echo-1")
    assert got is not None and not is_disabled(got)
    assert got.id == "echo-1"  # type: ignore[union-attr]

    cancelled = c.cancel("echo-1")
    assert cancelled.state is JobStatus.CANCELLED  # type: ignore[union-attr]
    active = c.list_jobs(bucket="active")
    assert active == []  # type: ignore[comparison-overlap]
    done = c.list_jobs(bucket="done")
    assert len(done) == 1  # type: ignore[arg-type]


def test_progress_bus_dedupe_and_toast_focus():
    bus = ProgressBus(coalesce_ms=100.0)
    t0 = datetime(2026, 11, 5, 3, 0, 0, tzinfo=timezone.utc)

    p1 = bus.apply(
        JobEvent.updated(
            "job-a",
            state="running",
            progress=0.2,
            shot_id="SHOT03",
            seq=1,
            updated_at=t0,
        )
    )
    assert p1 is not None
    assert bus.active_job_id == "job-a"
    assert bus.toast_target().progress == 0.2  # type: ignore[union-attr]

    # D3: progress regression dropped
    dropped = bus.apply(
        JobEvent.updated(
            "job-a",
            state="running",
            progress=0.1,
            attempts=0,
            seq=2,
            updated_at=t0,
        )
    )
    assert dropped is None
    assert any("progress_regress" in r for r in bus.dropped_reasons())
    assert bus.jobs_by_id["job-a"].progress == 0.2

    # D1: stale seq dropped
    assert (
        bus.apply(
            JobEvent.updated(
                "job-a",
                state="running",
                progress=0.5,
                seq=1,
                updated_at=t0,
            )
        )
        is None
    )

    # advance ok
    p2 = bus.apply(
        JobEvent.updated(
            "job-a",
            state="running",
            progress=0.6,
            seq=3,
            updated_at=t0,
        )
    )
    assert p2 is not None and p2.progress == 0.6

    # D4: retry reset progress to 0 when attempts bump
    p3 = bus.apply(
        JobEvent.updated(
            "job-a",
            state="queued",
            progress=0.0,
            attempts=1,
            seq=4,
            updated_at=t0,
        )
    )
    assert p3 is not None and p3.progress == 0.0 and p3.attempts == 1

    # terminal
    term = bus.apply(
        JobEvent.updated(
            "job-a",
            state="succeeded",
            progress=1.0,
            attempts=1,
            seq=5,
            updated_at=t0,
        )
    )
    assert term is not None and term.terminal is True
    assert "SHOT03" in bus.job_ids_by_shot
    assert bus.job_ids_by_shot["SHOT03"] == ["job-a"]
