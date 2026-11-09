"""EchoJob Actor — offline fake progress for queue UX / scheduler dry-runs.

No Ray runtime import. Pure in-process state machine so FE/API can rehearse
R7 progress semantics (0..1, null shimmer, retryable) without Comfy or GPU.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ..types import Job, JobKind, JobSpec, JobState, JobStatus, is_retryable


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class EchoJobConfig:
    """How many ticks to reach succeeded; fail_at_tick forces a soft failure."""

    ticks_to_done: int = 5
    fail_at_tick: int | None = None
    progress_per_tick: float | None = None  # default = 1/ticks_to_done
    kind: JobKind = JobKind.GENERIC


@dataclass
class EchoProgressEvent:
    job_id: str
    tick: int
    progress: float | None
    status: JobStatus
    message: str
    at: datetime = field(default_factory=_utcnow)


class EchoJobActor:
    """In-process stand-in for a Ray named actor.

    Methods mirror the eventual Ray remote API surface so callers can swap later:
      enqueue(spec) -> job_id
      tick(job_id) -> EchoProgressEvent
      cancel(job_id) -> JobState
      get(job_id) -> Job | None
    """

    def __init__(
        self,
        config: EchoJobConfig | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.config = config or EchoJobConfig()
        self._clock = clock or _utcnow
        self._specs: dict[str, JobSpec] = {}
        self._states: dict[str, JobState] = {}
        self._created: dict[str, datetime] = {}
        self._ticks: dict[str, int] = {}
        self._events: dict[str, list[EchoProgressEvent]] = {}

    def enqueue(self, spec: JobSpec) -> str:
        if spec.job_id in self._specs:
            raise ValueError(f"duplicate job_id={spec.job_id}")
        now = self._clock()
        # Echo forces generic/llm/comfy all through fake ticks; preserve kind
        self._specs[spec.job_id] = spec
        self._states[spec.job_id] = JobState(
            status=JobStatus.QUEUED,
            attempts=0,
            progress=0.0,
            updated_at=now,
        )
        self._created[spec.job_id] = now
        self._ticks[spec.job_id] = 0
        self._events[spec.job_id] = []
        return spec.job_id

    def _step_progress(self, tick: int) -> float:
        if self.config.progress_per_tick is not None:
            return min(1.0, tick * self.config.progress_per_tick)
        n = max(1, self.config.ticks_to_done)
        return min(1.0, tick / n)

    def tick(self, job_id: str) -> EchoProgressEvent:
        spec = self._specs.get(job_id)
        state = self._states.get(job_id)
        if spec is None or state is None:
            raise KeyError(job_id)
        if state.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            return EchoProgressEvent(
                job_id=job_id,
                tick=self._ticks[job_id],
                progress=state.progress,
                status=state.status,
                message="terminal",
                at=self._clock(),
            )

        self._ticks[job_id] += 1
        tick = self._ticks[job_id]
        now = self._clock()

        if state.status is JobStatus.QUEUED:
            state.status = JobStatus.LEASED
            state.node_id = "echo-local"
            state.updated_at = now
        elif state.status is JobStatus.LEASED:
            state.status = JobStatus.RUNNING
            state.attempts = max(1, state.attempts)
            state.updated_at = now

        if (
            self.config.fail_at_tick is not None
            and tick >= self.config.fail_at_tick
            and state.status is JobStatus.RUNNING
        ):
            state.status = JobStatus.FAILED
            state.error = "echo_forced_failure"
            state.progress = self._step_progress(tick - 1)
            state.updated_at = now
            ev = EchoProgressEvent(
                job_id=job_id,
                tick=tick,
                progress=state.progress,
                status=state.status,
                message=state.error,
                at=now,
            )
            self._events[job_id].append(ev)
            return ev

        progress = self._step_progress(tick)
        state.progress = progress
        state.status = JobStatus.RUNNING
        state.node_id = state.node_id or "echo-local"
        state.attempts = max(1, state.attempts)
        state.updated_at = now

        if tick >= self.config.ticks_to_done:
            state.status = JobStatus.SUCCEEDED
            state.progress = 1.0
            state.result_ref = f"echo://{job_id}"
            state.error = None

        ev = EchoProgressEvent(
            job_id=job_id,
            tick=tick,
            progress=state.progress,
            status=state.status,
            message="done" if state.status is JobStatus.SUCCEEDED else "tick",
            at=now,
        )
        self._events[job_id].append(ev)
        return ev

    def cancel(self, job_id: str) -> JobState:
        state = self._states.get(job_id)
        if state is None:
            raise KeyError(job_id)
        if state.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            return state
        now = self._clock()
        state.status = JobStatus.CANCELLED
        state.updated_at = now
        self._events[job_id].append(
            EchoProgressEvent(
                job_id=job_id,
                tick=self._ticks.get(job_id, 0),
                progress=state.progress,
                status=state.status,
                message="cancelled",
                at=now,
            )
        )
        return state

    def retry(self, job_id: str) -> JobState:
        spec = self._specs[job_id]
        state = self._states[job_id]
        if not is_retryable(state, spec, error_class=state.error):
            raise RuntimeError(f"job {job_id} not retryable")
        now = self._clock()
        state.status = JobStatus.QUEUED
        state.error = None
        state.progress = 0.0
        state.result_ref = None
        state.node_id = None
        state.updated_at = now
        self._ticks[job_id] = 0
        return state

    def get(self, job_id: str) -> Job | None:
        spec = self._specs.get(job_id)
        state = self._states.get(job_id)
        created = self._created.get(job_id)
        if not spec or not state or not created:
            return None
        return Job.from_spec_state(spec, state, created_at=created)

    def events(self, job_id: str) -> list[EchoProgressEvent]:
        return list(self._events.get(job_id, []))

    def run_to_terminal(self, job_id: str, *, max_ticks: int = 64) -> Job:
        """Helper for unit/smoke: tick until terminal or max_ticks."""
        for _ in range(max_ticks):
            job = self.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.state in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
                return job
            self.tick(job_id)
        job = self.get(job_id)
        assert job is not None
        return job

    def snapshot(self) -> dict[str, Any]:
        return {
            "jobs": {jid: (self.get(jid).state.value if self.get(jid) else None) for jid in self._specs},
            "ticks": dict(self._ticks),
            "config": {
                "ticks_to_done": self.config.ticks_to_done,
                "fail_at_tick": self.config.fail_at_tick,
            },
        }


# --- Cycle-3/4 compatibility layer (append; keep routine EchoJobActor above) ---
from ..fake_redis import FakeRedis  # noqa: E402
from ..redis_keys import JOB_HASH_FIELDS, job_hash as job_hash_key  # noqa: E402
import json  # noqa: E402


class EchoJobRunner:
    """Compat wrapper: run(spec) ticks EchoJobActor to terminal + optional FakeRedis mirror."""

    def __init__(
        self,
        store: FakeRedis | None = None,
        *,
        steps: int = 5,
        step_delay_s: float = 0.0,
        node_id: str = "echo-local",
        namespace: str = "toiv:ray",
        config: EchoJobConfig | None = None,
    ) -> None:
        self.store = store if store is not None else FakeRedis()
        self.steps = max(1, steps)
        self.step_delay_s = step_delay_s  # ignored (sync ticks); kept for API compat
        self.node_id = node_id
        self.namespace = namespace
        cfg = config or EchoJobConfig(ticks_to_done=self.steps)
        cfg.ticks_to_done = self.steps
        self._actor = EchoJobActor(config=cfg)
        self._cancelled: set[str] = set()

    def cancel(self, job_id: str) -> None:
        self._cancelled.add(job_id)
        try:
            self._actor.cancel(job_id)
        except KeyError:
            pass

    def _mirror(self, spec: JobSpec, state: JobState, created_at: datetime) -> None:
        key = job_hash_key(spec.job_id, namespace=self.namespace)
        mapping = {
            "kind": spec.kind.value if isinstance(spec.kind, JobKind) else str(spec.kind),
            "priority": str(spec.priority),
            "payload_json": json.dumps(spec.payload),
            "status": state.status.value,
            "progress": "" if state.progress is None else str(state.progress),
            "result_ref": state.result_ref or "",
            "error": state.error or "",
            "created_at": created_at.isoformat(),
            "updated_at": (state.updated_at or created_at).isoformat(),
            "requires_json": json.dumps(spec.requires),
            "labels_json": json.dumps(spec.labels),
            "node_id": state.node_id or self.node_id,
            "attempts": str(state.attempts),
            "max_retries": str(spec.max_retries),
            "timeout_s": str(spec.timeout_s),
        }
        self.store.hset(key, mapping=mapping)

    def run(self, spec: JobSpec) -> JobState:
        # Prefer ECHO kind; allow GENERIC labeled echo
        if spec.kind not in (JobKind.ECHO, JobKind.GENERIC) and spec.labels.get("job_type") != "echo":
            if spec.kind is not JobKind.ECHO:
                # still allow any kind through fake ticks (routine behavior) but warn via label
                pass
        self._actor.config.ticks_to_done = self.steps
        self._actor.enqueue(spec)
        created = self._actor._created[spec.job_id]
        job = self._actor.run_to_terminal(spec.job_id, max_ticks=self.steps + 8)
        state = self._actor._states[spec.job_id]
        if spec.job_id in self._cancelled and state.status is not JobStatus.CANCELLED:
            state = self._actor.cancel(spec.job_id)
        if state.node_id is None:
            state.node_id = self.node_id
        self._mirror(spec, state, created)
        return state


def run_echo_job(spec: JobSpec, store: FakeRedis | None = None, **kwargs: Any) -> JobState:
    return EchoJobRunner(store=store, **kwargs).run(spec)

