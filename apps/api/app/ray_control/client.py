"""Flag-gated thin façade for Ray control plane (scratch).

When TOIV_RAY_CONTROL_ENABLED is off (default), mutating / query methods
return DisabledResult — never touches Redis, Ray, or live Comfy.
When on, uses in-process QueueScheduler + FakeRedis.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from .actors.scheduler import QueueScheduler
from .fake_redis import FakeRedis
from .flag import is_ray_control_enabled
from .progress_bus import JobEvent
from .types import Job, JobKind, JobSpec, JobState, JobStatus


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class DisabledResult:
    """Returned when the control plane flag is off."""

    reason: str = "ray_control_disabled"
    enabled: bool = False


def is_disabled(value: Any) -> bool:
    return isinstance(value, DisabledResult)


@dataclass
class RayControlClient:
    """API-facing façade. Safe to construct at import; flag checked per call."""

    store: FakeRedis | None = None
    scheduler: QueueScheduler | None = None
    environ: dict[str, str] | None = None
    clock: Callable[[], datetime] | None = None
    # Optional ProgressBus + D-R4 journal (Cycle 35–37); None = pre-35 enqueue/retry/cancel behavior
    bus: Any | None = None
    journal: Any | None = None
    # Optional SSE/WS hub (Cycle 42); None = ProgressBus only (pre-42 behavior)
    stream_hub: Any | None = None
    _jobs: dict[str, tuple[JobSpec, JobState, datetime]] = field(
        default_factory=dict, init=False, repr=False
    )
    _last_delta: Any | None = field(default=None, init=False, repr=False)
    _last_frame: Any | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.store is None:
            object.__setattr__(self, "store", FakeRedis())
        if self.scheduler is None:
            object.__setattr__(self, "scheduler", QueueScheduler(store=self.store))
        if self.clock is None:
            object.__setattr__(self, "clock", _utcnow)

    def enabled(self) -> bool:
        return is_ray_control_enabled(self.environ)

    def enqueue(self, spec: JobSpec) -> Job | DisabledResult:
        """Admit a new job (P0 task-center).

        When ``bus`` is set, publishes ``job.enqueued`` (queued / progress 0)
        and optionally dual-writes D-R4 journal (Cycle 37). Flag off → Disabled.
        """
        if not self.enabled():
            return DisabledResult()
        assert self.scheduler is not None
        created = self.clock()  # type: ignore[misc]
        self.scheduler.enqueue(spec)  # returns job_id
        state = JobState(
            status=JobStatus.QUEUED,
            attempts=0,
            progress=0.0,
            updated_at=created,
        )
        self._jobs[spec.job_id] = (spec, state, created)
        new_job = Job.from_spec_state(spec, state, created_at=created)
        self._publish_enqueue(new_job)
        return new_job

    def get(self, job_id: str) -> Job | None | DisabledResult:
        if not self.enabled():
            return DisabledResult()
        held = self._jobs.get(job_id)
        if held is None:
            return None
        spec, state, created = held
        return Job.from_spec_state(spec, state, created_at=created)

    def cancel(self, job_id: str) -> Job | None | DisabledResult:
        """Cancel an active job (P0 task-center).

        Already-terminal (succeeded/failed/cancelled) jobs are returned
        unchanged — no bus/journal write. Missing → None. Flag off → Disabled.

        When the status actually flips to cancelled and ``bus`` is set,
        publishes ``job.updated`` (cancelled) and optionally dual-writes
        D-R4 journal (Cycle 36).
        """
        if not self.enabled():
            return DisabledResult()
        held = self._jobs.get(job_id)
        if held is None:
            return None
        spec, state, created = held
        if state.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            self._last_delta = None  # skip: this call wrote nothing
            self._last_frame = None
            return Job.from_spec_state(spec, state, created_at=created)
        assert self.scheduler is not None
        try:
            new_state = self.scheduler.mark_terminal(
                job_id,
                JobStatus.CANCELLED,
                progress=state.progress,
                error=None,
                result_ref=state.result_ref,
            )
        except KeyError:
            new_state = JobState(
                status=JobStatus.CANCELLED,
                node_id=state.node_id,
                attempts=state.attempts,
                progress=state.progress,
                updated_at=self.clock(),  # type: ignore[misc]
            )
        self._jobs[job_id] = (spec, new_state, created)
        new_job = Job.from_spec_state(spec, new_state, created_at=created)
        self._publish_cancel(new_job)
        return new_job

    def list_jobs(self, *, bucket: str | None = None) -> list[Job] | DisabledResult:
        if not self.enabled():
            return DisabledResult()
        out: list[Job] = []
        for spec, state, created in self._jobs.values():
            job = Job.from_spec_state(spec, state, created_at=created)
            if bucket is None or job.fe_bucket() == bucket:
                out.append(job)
        out.sort(key=lambda j: j.updated_at, reverse=True)
        return out

    def retry(self, job_id: str) -> Job | None | DisabledResult:
        """Re-queue a failed retryable job (P0 task-center).

        Keeps attempts (fail penalty already applied). Resets progress to 0.0
        and clears error. Non-retryable / terminal-success / active jobs are
        returned unchanged (FE keeps retry disabled). Missing → None.

        When actually requeued and ``bus`` is set, publishes ``job.updated``
        (queued / progress 0) and optionally dual-writes D-R4 journal (Cycle 35).
        Skipped / unchanged / missing / DisabledResult never touch bus or journal.
        """
        if not self.enabled():
            return DisabledResult()
        held = self._jobs.get(job_id)
        if held is None:
            return None
        spec, state, created = held
        job = Job.from_spec_state(spec, state, created_at=created)
        if not job.retryable:
            self._last_delta = None  # skip: this call wrote nothing
            self._last_frame = None
            return job
        assert self.scheduler is not None
        # Sync fail-count into scheduler meta before re-enqueue
        meta = self.scheduler._meta.setdefault(job_id, {})
        meta["attempts"] = int(state.attempts)
        meta["spec"] = spec
        meta["running"] = False
        self.scheduler.enqueue(spec)
        new_state = JobState(
            status=JobStatus.QUEUED,
            attempts=state.attempts,
            progress=0.0,
            error=None,
            result_ref=None,
            node_id=None,
            updated_at=self.clock(),  # type: ignore[misc]
        )
        self._jobs[job_id] = (spec, new_state, created)
        new_job = Job.from_spec_state(spec, new_state, created_at=created)
        self._publish_retry(new_job)
        return new_job

    def _publish_enqueue(self, job: Job) -> Any:
        """Emit job.enqueued after a successful admit (Cycle 37)."""
        if self.bus is None:
            self._last_delta = None
            self._last_frame = None
            return None
        event = JobEvent.enqueued(
            job.id,
            state=JobStatus.QUEUED.value,
            progress=0.0,
            error=None,
            retryable=False,
            labels=dict(job.labels),
            shot_id=job.labels.get("shot_id") or (job.payload or {}).get("shot_id"),
            attempts=job.attempts,
            updated_at=job.updated_at,
        )
        return self._apply_bus(event)

    def _publish_retry(self, job: Job) -> Any:
        """Emit queued JobEvent after a successful requeue (Cycle 35)."""
        if self.bus is None:
            self._last_delta = None
            self._last_frame = None
            return None
        event = JobEvent.updated(
            job.id,
            state=JobStatus.QUEUED.value,
            progress=0.0,
            error=None,
            retryable=False,
            labels=dict(job.labels),
            shot_id=job.labels.get("shot_id") or (job.payload or {}).get("shot_id"),
            attempts=job.attempts,
            updated_at=job.updated_at,
        )
        return self._apply_bus(event)

    def _publish_cancel(self, job: Job) -> Any:
        """Emit cancelled JobEvent after a successful cancel (Cycle 36)."""
        if self.bus is None:
            self._last_delta = None
            self._last_frame = None
            return None
        event = JobEvent.updated(
            job.id,
            state=JobStatus.CANCELLED.value,
            progress=float(job.progress),
            error=None,
            retryable=False,
            labels=dict(job.labels),
            shot_id=job.labels.get("shot_id") or (job.payload or {}).get("shot_id"),
            attempts=job.attempts,
            updated_at=job.updated_at,
        )
        return self._apply_bus(event)

    def _apply_bus(self, event: JobEvent) -> Any:
        """ProgressBus.apply + optional D-R4 journal + ProgressStreamHub (Cycle 35–37/42).

        Order: bus.apply → (optional journal) → (optional hub publish).
        Does not call hub.apply_bus (avoids double bus.apply). No hub → last_frame is None
        (identical to Cycle 35–37 behavior).
        """
        if self.bus is None:
            self._last_delta = None
            self._last_frame = None
            return None
        proj = self.bus.apply(event)
        delta = None
        frame = None
        if proj is not None and self.journal is not None:
            delta = self.journal.append_from_bus_apply(event, proj)
        if proj is not None and self.stream_hub is not None:
            kind = event.kind.value if hasattr(event.kind, "value") else str(event.kind)
            frame = self.stream_hub.publish_projection(
                proj, event=kind, channel="progress"
            )
            if self.bus.active_job_id == proj.id:
                self.stream_hub.publish_projection(
                    proj, event=kind, channel="toast"
                )
        self._last_delta = delta
        self._last_frame = frame
        return proj

    @property
    def last_delta(self) -> Any:
        """Most recent RayJobDelta from enqueue/retry/cancel dual-write, or None."""
        return self._last_delta

    @property
    def last_frame(self) -> Any:
        """Most recent StreamFrame from hub publish, or None."""
        return self._last_frame

    def retry_failed(self, *, limit: int = 50) -> list[Job] | DisabledResult:
        """Batch retry for Failed tab (cap limit). Order: newest first."""
        if not self.enabled():
            return DisabledResult()
        failed = self.list_jobs(bucket="failed")
        assert isinstance(failed, list)
        out: list[Job] = []
        for job in failed[: max(0, limit)]:
            if not job.retryable:
                continue
            retried = self.retry(job.id)
            if retried is not None and not is_disabled(retried):
                out.append(retried)  # type: ignore[arg-type]
        return out

    def echo(self, job_id: str, *, fail: bool = False, priority: int = 5) -> Job | DisabledResult:
        """Phase1 gate helper: enqueue an Echo job when flag is on."""
        payload: dict[str, Any] = {"fail": fail} if fail else {}
        spec = JobSpec(
            job_id=job_id,
            kind=JobKind.ECHO,
            priority=priority,
            payload=payload,
            max_retries=2,
            labels={"job_type": "echo"},
        )
        return self.enqueue(spec)

    def set_state(self, job_id: str, state: JobState) -> Job | None | DisabledResult:
        """Test / bus helper: update local projection after scheduler run."""
        if not self.enabled():
            return DisabledResult()
        held = self._jobs.get(job_id)
        if held is None:
            return None
        spec, _, created = held
        self._jobs[job_id] = (spec, state, created)
        return Job.from_spec_state(spec, state, created_at=created)


def get_client(
    *,
    environ: dict[str, str] | None = None,
    store: FakeRedis | None = None,
) -> RayControlClient:
    """Factory used by routes; always returns a client (flag checked per call)."""
    return RayControlClient(environ=environ, store=store)
