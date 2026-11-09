"""JobRouter dry-run — routes echo/comfy/llm; no live sockets."""

from __future__ import annotations

import pytest

from app.ray_control.actors.job_router import JobRouter, JobRouterConfig, run_routed_job
from app.ray_control.progress_bus import ProgressBus
from app.ray_control.types import JobKind, JobSpec, JobStatus


def test_route_kind_map():
    r = JobRouter()
    assert r.route_kind(JobKind.ECHO) == "echo"
    assert r.route_kind(JobKind.COMFY) == "comfy_pool"
    assert r.route_kind(JobKind.LLM) == "llm_gateway"
    assert r.route_kind(JobKind.GENERIC) == "fail"
    r2 = JobRouter(config=JobRouterConfig(unknown_kind_policy="echo"))
    assert r2.route_kind(JobKind.GENERIC) == "echo"


def test_drain_mixed_kinds_publishes_bus():
    bus = ProgressBus(coalesce_ms=0.0)
    router = JobRouter(bus=bus)
    router.submit(
        JobSpec(job_id="e1", kind=JobKind.ECHO, priority=5, payload={"message": "hi"})
    )
    router.submit(
        JobSpec(
            job_id="c1",
            kind=JobKind.COMFY,
            priority=8,
            payload={"pool": "img", "workflow": {"1": {"class_type": "NoOp", "inputs": {}}}},
        )
    )
    router.submit(
        JobSpec(
            job_id="l1",
            kind=JobKind.LLM,
            priority=3,
            payload={"messages": [{"role": "user", "content": "ping"}]},
        )
    )
    # priority 8 comfy first
    assert router.peek_order()[0] == "c1"
    done = router.drain(max_jobs=8)
    assert len(done) == 3
    by_id = {j.id: j for j in done}
    assert by_id["e1"].state is JobStatus.SUCCEEDED
    assert by_id["c1"].state is JobStatus.SUCCEEDED
    assert by_id["l1"].state is JobStatus.SUCCEEDED
    assert bus.jobs_by_id["e1"].state == "succeeded"
    assert bus.jobs_by_id["c1"].progress == 1.0
    assert bus.jobs_by_id["l1"].terminal is True
    assert router.list_jobs(bucket="done")
    assert not router.list_jobs(bucket="active")


def test_cancel_before_tick():
    router = JobRouter()
    router.submit(JobSpec(job_id="cx", kind=JobKind.ECHO, priority=1, payload={}))
    cancelled = router.cancel("cx")
    assert cancelled is not None
    assert cancelled.state is JobStatus.CANCELLED
    # already terminal — tick should not resurrect (queue may still hold id;
    # dequeue after cancel: mark_terminal left meta; dequeue may still pull)
    # Ensure cancel is idempotent:
    again = router.cancel("cx")
    assert again.state is JobStatus.CANCELLED


def test_unsupported_generic_fails():
    job = run_routed_job(
        JobSpec(job_id="g1", kind=JobKind.GENERIC, priority=2, payload={})
    )
    assert job.state is JobStatus.FAILED
    assert job.error and "unsupported_job_kind" in job.error


def test_generic_echo_policy():
    router = JobRouter(config=JobRouterConfig(unknown_kind_policy="echo"))
    router.submit(JobSpec(job_id="g2", kind=JobKind.GENERIC, priority=4, payload={}))
    job = router.tick()
    assert job is not None
    assert job.state is JobStatus.SUCCEEDED


def test_run_routed_job_echo():
    job = run_routed_job(
        JobSpec(job_id="solo", kind=JobKind.ECHO, priority=6, payload={"message": "x"})
    )
    assert job.state is JobStatus.SUCCEEDED
    assert job.progress == 1.0
