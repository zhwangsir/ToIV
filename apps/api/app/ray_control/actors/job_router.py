"""JobRouter — kind-based dispatch across Echo / ComfyPool / LlmGateway (scratch).

Dry-run only: no live Comfy, LLM sockets, or Ray cluster.
Wires QueueScheduler + ProgressBus so one tick drains the next job.
Cycle 26: optional JobArtifactCatalog auto-attach on terminal succeed/fail.
Cycle 27: ProgressBus thumb_uri / preview_uri on publish (+ catalog after attach).
Cycle 34: optional JobDeltaJournal dual-write on every ProgressBus apply
(submit / _publish / cancel) — same D-R4 hook as export toast (Cycle 33).
Cycle 41: optional ProgressStreamHub publish after bus apply (SSE/WS live frames).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ..artifact_catalog import JobArtifactCatalog
from ..fake_redis import FakeRedis
from ..progress_bus import JobEvent, JobEventKind, ProgressBus, TERMINAL_STATES
from ..ray_job_router_adapter_tick_silent import decide_emit_for_tick
from ..ray_job_router_publish_kind_split import publish_kind_for
from ..types import Job, JobKind, JobSpec, JobState, JobStatus, is_retryable
from .comfy_pool import ComfyPoolActor, ComfyPoolConfig, run_comfy_job
from .echo import EchoJobRunner, run_echo_job
from .llm_gateway import (
    DryRunLlmBackend,
    LlmGatewayActor,
    LlmGatewayConfig,
    LlmUpstream,
    run_llm_job,
)
from .scheduler import QueueScheduler


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class JobRouterEvent:
    job_id: str
    kind: JobKind
    status: JobStatus
    progress: float | None = None
    error: str | None = None
    result_uri: str | None = None
    node_id: str | None = None
    attempts: int = 0
    dry_run: bool = True


@dataclass
class JobRouterConfig:
    """Defaults keep everything local / flag-friendly."""

    max_ticks_comfy: int = 32
    max_ticks_llm: int = 16
    unknown_kind_policy: str = "fail"  # fail | echo
    auto_attach_artifacts: bool = True  # Cycle 26: seed catalog on terminal


@dataclass
class JobRouter:
    """Enqueue → dequeue → route by JobKind → publish ProgressBus events."""

    store: FakeRedis | None = None
    scheduler: QueueScheduler | None = None
    bus: ProgressBus | None = None
    config: JobRouterConfig = field(default_factory=JobRouterConfig)
    clock: Callable[[], datetime] | None = None
    # Optional injected actors / runners (tests)
    echo_runner: Callable[..., JobState] | None = None
    comfy_runner: Callable[..., Job] | None = None
    llm_runner: Callable[..., Job] | None = None
    comfy_actor: ComfyPoolActor | None = None
    llm_actor: LlmGatewayActor | None = None
    catalog: JobArtifactCatalog | None = None
    # Optional D-R4 journal (Cycle 34); None = ProgressBus only (pre-34 behavior)
    journal: Any | None = None
    # Optional SSE/WS hub (Cycle 41); None = ProgressBus only (pre-41 behavior)
    stream_hub: Any | None = None
    _created: dict[str, datetime] = field(default_factory=dict, init=False, repr=False)
    _last_delta: Any | None = field(default=None, init=False, repr=False)
    _last_frame: Any | None = field(default=None, init=False, repr=False)
    _jobs: dict[str, Job] = field(default_factory=dict, init=False, repr=False)
    _events: list[JobRouterEvent] = field(default_factory=list, init=False, repr=False)
    _last_emit_decision: Any | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.store is None:
            self.store = FakeRedis()
        if self.scheduler is None:
            self.scheduler = QueueScheduler(store=self.store)
        if self.bus is None:
            self.bus = ProgressBus(clock=self.clock or _utcnow)
        if self.clock is None:
            self.clock = _utcnow
        if self.echo_runner is None:
            self.echo_runner = run_echo_job
        if self.comfy_runner is None:
            self.comfy_runner = run_comfy_job
        if self.llm_runner is None:
            self.llm_runner = run_llm_job
        if self.catalog is None:
            # Fresh catalog per router (tests isolation); inject get_catalog() to share
            self.catalog = JobArtifactCatalog()

    def submit(self, spec: JobSpec) -> Job:
        """Enqueue on scheduler and emit job.enqueued / queued projection."""
        assert self.scheduler is not None and self.bus is not None
        created = self.clock()  # type: ignore[misc]
        self.scheduler.enqueue(spec)
        self._created[spec.job_id] = created
        job = Job.from_spec_state(
            spec,
            JobState(
                status=JobStatus.QUEUED,
                attempts=0,
                progress=0.0,
                updated_at=created,
            ),
            created_at=created,
        )
        self._jobs[spec.job_id] = job
        self._publish(job, op="submit")
        self._events.append(
            JobRouterEvent(
                job_id=spec.job_id,
                kind=spec.kind,
                status=JobStatus.QUEUED,
                progress=0.0,
            )
        )
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list_jobs(self, *, bucket: str | None = None) -> list[Job]:
        out = list(self._jobs.values())
        if bucket is not None:
            out = [j for j in out if j.fe_bucket() == bucket]
        out.sort(key=lambda j: j.updated_at, reverse=True)
        return out

    def peek_order(self) -> list[str]:
        assert self.scheduler is not None
        return self.scheduler.peek_order()

    def cancel(self, job_id: str) -> Job | None:
        assert self.scheduler is not None and self.bus is not None
        held = self._jobs.get(job_id)
        if held is None:
            return None
        if held.state in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            return held
        created = self._created.get(job_id, held.created_at)
        try:
            state = self.scheduler.mark_terminal(
                job_id,
                JobStatus.CANCELLED,
                progress=held.progress,
                error=None,
                result_ref=held.result_uri,
            )
        except KeyError:
            state = JobState(
                status=JobStatus.CANCELLED,
                node_id=held.node_id,
                attempts=held.attempts,
                progress=held.progress,
                updated_at=self.clock(),  # type: ignore[misc]
            )
        # Rebuild Job from last known type/payload
        spec = JobSpec(
            job_id=held.id,
            kind=held.type,
            priority=held.priority,
            payload=dict(held.payload),
            labels=dict(held.labels),
            max_retries=held.max_retries,
        )
        job = Job.from_spec_state(spec, state, created_at=created, retryable=False)
        self._jobs[job_id] = job
        self._publish(job, op="cancel")
        self._events.append(
            JobRouterEvent(
                job_id=job_id,
                kind=held.type,
                status=JobStatus.CANCELLED,
                progress=job.progress,
                attempts=job.attempts,
                node_id=job.node_id,
            )
        )
        return job

    def tick(self) -> Job | None:
        """Dequeue one queued job, run the matching adapter, publish terminal."""
        assert self.scheduler is not None
        spec = self.scheduler.dequeue()
        if spec is None:
            return None
        return self._dispatch(spec)

    def drain(self, *, max_jobs: int = 32) -> list[Job]:
        done: list[Job] = []
        for _ in range(max_jobs):
            job = self.tick()
            if job is None:
                break
            done.append(job)
        return done

    def route_kind(self, kind: JobKind) -> str:
        """Map kind → adapter name (for docs / FE debug)."""
        if kind is JobKind.ECHO:
            return "echo"
        if kind is JobKind.COMFY:
            return "comfy_pool"
        if kind is JobKind.LLM:
            return "llm_gateway"
        if kind is JobKind.GENERIC:
            return "echo" if self.config.unknown_kind_policy == "echo" else "fail"
        return "fail"

    def _dispatch(self, spec: JobSpec) -> Job:
        created = self._created.get(spec.job_id, self.clock())  # type: ignore[misc]
        adapter = self.route_kind(spec.kind)

        # leased / running bookkeeping on bus before work
        running = Job.from_spec_state(
            spec,
            JobState(
                status=JobStatus.RUNNING,
                attempts=1,
                progress=0.05,
                updated_at=self.clock(),  # type: ignore[misc]
            ),
            created_at=created,
        )
        self._jobs[spec.job_id] = running
        self._publish(running, op="dispatch")

        try:
            if adapter == "echo":
                state = self.echo_runner(spec, store=self.store)  # type: ignore[misc]
                job = Job.from_spec_state(spec, state, created_at=created)
            elif adapter == "comfy_pool":
                if self.comfy_actor is not None:
                    self.comfy_actor.enqueue(spec)
                    job = self.comfy_actor.run_until_terminal(
                        spec.job_id, max_ticks=self.config.max_ticks_comfy
                    )
                else:
                    job = self.comfy_runner(  # type: ignore[misc]
                        spec, max_ticks=self.config.max_ticks_comfy
                    )
            elif adapter == "llm_gateway":
                if self.llm_actor is not None:
                    self.llm_actor.enqueue(spec)
                    job = self.llm_actor.run_until_terminal(
                        spec.job_id, max_ticks=self.config.max_ticks_llm
                    )
                else:
                    job = self.llm_runner(  # type: ignore[misc]
                        spec, max_ticks=self.config.max_ticks_llm
                    )
            else:
                err = f"unsupported_job_kind:{spec.kind.value}"
                state = JobState(
                    status=JobStatus.FAILED,
                    attempts=1,
                    progress=0.0,
                    error=err,
                    updated_at=self.clock(),  # type: ignore[misc]
                )
                job = Job.from_spec_state(
                    spec,
                    state,
                    created_at=created,
                    retryable=is_retryable(state, spec, error_class="validation"),
                )
        except Exception as exc:  # noqa: BLE001 — dry-run boundary
            state = JobState(
                status=JobStatus.FAILED,
                attempts=1,
                progress=0.0,
                error=f"router_dispatch_error:{type(exc).__name__}:{exc}",
                updated_at=self.clock(),  # type: ignore[misc]
            )
            job = Job.from_spec_state(
                spec,
                state,
                created_at=created,
                retryable=is_retryable(state, spec, error_class="connection"),
            )

        # Mirror terminal into scheduler store when possible
        assert self.scheduler is not None
        try:
            self.scheduler.mark_terminal(
                spec.job_id,
                job.state,
                progress=job.progress,
                error=job.error,
                result_ref=job.result_uri,
            )
        except (KeyError, TypeError, ValueError):
            pass

        self._jobs[spec.job_id] = job
        self._publish(job, op="terminal")
        self._auto_attach(job)
        self._events.append(
            JobRouterEvent(
                job_id=spec.job_id,
                kind=spec.kind,
                status=job.state,
                progress=job.progress,
                error=job.error,
                result_uri=job.result_uri,
                node_id=job.node_id,
                attempts=job.attempts,
            )
        )
        return job

    def _uris_for_bus(self, job: Job) -> tuple[str | None, str | None, str | None]:
        """Resolve result/thumb/preview for ProgressBus (payload → catalog)."""
        payload = job.payload or {}
        result = job.result_uri
        thumb = payload.get("thumb_uri")
        preview = payload.get("preview_uri")
        if self.catalog is not None:
            cat_thumb = self.catalog.thumb(job.id)
            cat_preview = self.catalog.preview(job.id)
            cat_primary = self.catalog.primary(job.id)
            if thumb is None and cat_thumb is not None:
                thumb = cat_thumb.uri
            if preview is None and cat_preview is not None:
                preview = cat_preview.uri
            if result is None and cat_primary is not None:
                result = cat_primary.uri
        return (
            str(result) if result else None,
            str(thumb) if thumb else None,
            str(preview) if preview else None,
        )

    def _apply_bus(self, event: JobEvent) -> Any:
        """ProgressBus.apply + optional D-R4 journal + ProgressStreamHub (Cycle 34/41)."""
        assert self.bus is not None
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

    def _publish(
        self,
        job: Job,
        op: str = "dispatch",
        *,
        emit: bool | None = None,
        prior_progress: float | None = None,
        prior_state: str | None = None,
    ) -> JobEvent | None:
        """Publish ProgressBus event with JR-R1 op→kind 三分 + JR-R2 silent gate.

        op:
          submit → job.enqueued
          dispatch / adapter_tick → job.updated (unless terminal state)
          cancel / terminal → job.terminal (via updated auto-promote or TERMINAL)
        adapter_tick defaults emit=false (OP_DEFAULTS); opens only on progress/state delta.
        """
        assert self.bus is not None
        state = job.state.value if isinstance(job.state, JobStatus) else str(job.state)
        result_uri, thumb_uri, preview_uri = self._uris_for_bus(job)
        labels = dict(job.labels)
        shot_id = job.labels.get("shot_id") or (job.payload or {}).get("shot_id")

        # JR-R2: adapter_tick silent unless delta / explicit emit=True
        if op == "adapter_tick":
            decision = decide_emit_for_tick(
                prior_progress=prior_progress,
                prior_state=prior_state,
                next_progress=job.progress,
                next_state=state,
                force_emit=emit,
            )
            if not decision.emit:
                self._last_emit_decision = decision
                return None
            self._last_emit_decision = decision

        bus_kind = publish_kind_for(op, state=state)
        if bus_kind is None:
            # Unknown op → fall back to updated (auto-promotes terminal)
            bus_kind = (
                JobEventKind.TERMINAL.value
                if state in TERMINAL_STATES
                else JobEventKind.UPDATED.value
            )

        common = dict(
            state=state,
            progress=job.progress,
            error=job.error,
            retryable=job.retryable,
            result_uri=result_uri,
            thumb_uri=thumb_uri,
            preview_uri=preview_uri,
            labels=labels,
            shot_id=shot_id,
            attempts=job.attempts,
            updated_at=job.updated_at,
        )
        if bus_kind == JobEventKind.ENQUEUED.value:
            event = JobEvent.enqueued(job.id, **common)
        else:
            # JobEvent.updated auto-promotes terminal states → JobEventKind.TERMINAL
            event = JobEvent.updated(job.id, **common)
        self._apply_bus(event)
        return event

    def adapter_tick_publish(
        self,
        job: Job,
        *,
        prior_progress: float | None = None,
        prior_state: str | None = None,
        emit: bool | None = None,
    ) -> JobEvent | None:
        """JR-R2 heartbeat/tick publish — silent by default (emit_false_silent)."""
        self._jobs[job.id] = job
        return self._publish(
            job,
            op="adapter_tick",
            emit=emit,
            prior_progress=prior_progress,
            prior_state=prior_state,
        )

    @property
    def last_emit_decision(self) -> Any:
        """Most recent JR-R2 EmitDecision from adapter_tick, or None."""
        return getattr(self, "_last_emit_decision", None)

    @property
    def last_delta(self) -> Any:
        """Most recent RayJobDelta from dual-write, or None."""
        return self._last_delta

    @property
    def last_frame(self) -> Any:
        """Most recent StreamFrame from hub publish, or None."""
        return self._last_frame

    def _auto_attach(self, job: Job) -> None:
        """Attach primary/thumb/log into catalog when config allows (scratch)."""
        if not self.config.auto_attach_artifacts:
            return
        if self.catalog is None:
            return
        clock = self.clock()  # type: ignore[misc]
        try:
            ms = int(clock.timestamp() * 1000)
        except Exception:  # noqa: BLE001
            ms = 0
        self.catalog.auto_attach_terminal(job, clock_ms=ms)
        # Re-publish so ProgressBus picks catalog thumb/preview (Cycle 27)
        self._publish(job, op="terminal")

    @property
    def events(self) -> list[JobRouterEvent]:
        return list(self._events)


def run_routed_job(spec: JobSpec, **kwargs: Any) -> Job:
    """One-shot: submit + tick until this job is handled (and any prior drained)."""
    router = JobRouter(**kwargs)
    router.submit(spec)
    # Drain until our job is terminal or queue empty
    for _ in range(64):
        held = router.get(spec.job_id)
        if held is not None and held.state in (
            JobStatus.SUCCEEDED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
        ):
            return held
        nxt = router.tick()
        if nxt is None:
            break
    held = router.get(spec.job_id)
    if held is None:
        raise KeyError(spec.job_id)
    return held
