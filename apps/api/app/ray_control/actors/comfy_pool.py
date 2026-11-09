"""ComfyPoolActor — Phase1 Comfy adapter (scratch, dry-run default).

Mirrors the eventual Ray named actor surface from
TOIV_RAY_CONTROL_PLANE_PHASE1 §2 (comfy_adapter.py / ComfyPoolActor):
  enqueue(spec) -> job_id
  tick(job_id)  -> ComfyPoolEvent   # submit once, then poll /history
  cancel(job_id) -> JobState
  get(job_id)   -> Job | None

Never opens sockets unless the injected ComfyClient uses a live transport.
Default path uses DryRunTransport. H3 / live Comfy exec stays frozen (口令).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from ..comfy_client import (
    ComfyClient,
    ComfyEndpoint,
    ComfyPromptStatus,
    ComfySubmitResult,
    DryRunTransport,
)
from ..comfy_retry import ErrorClass, classify_error, decide_after_failure
from ..types import Job, JobKind, JobSpec, JobState, JobStatus, is_retryable


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ComfyPoolConfig:
    """Pool behaviour knobs. Does not start/stop Comfy processes."""

    default_requires: dict[str, str] = field(default_factory=dict)
    max_inflight_per_endpoint: int = 2
    # When True, a FAILED poll with history outputs reconciles to SUCCEEDED (H-4).
    reconcile_on_history: bool = True


@dataclass
class ComfyPoolEvent:
    job_id: str
    status: JobStatus
    progress: float | None
    message: str
    prompt_id: str | None = None
    endpoint: str | None = None
    error_class: str | None = None
    dry_run: bool = True
    at: datetime = field(default_factory=_utcnow)


@dataclass
class _Lease:
    prompt_id: str
    endpoint: ComfyEndpoint
    submit: ComfySubmitResult
    submitted: bool = True


class ComfyPoolActor:
    """In-process stand-in for Ray ComfyPoolActor.

    Label select uses JobSpec.requires ⊆ endpoint.labels (same as pick_endpoint).
    Documented pools include pool=h3 — selection is OK; live submit needs 口令.
    """

    def __init__(
        self,
        client: ComfyClient | None = None,
        config: ComfyPoolConfig | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.client = client or ComfyClient(transport=DryRunTransport())
        self.config = config or ComfyPoolConfig()
        self._clock = clock or _utcnow
        self._specs: dict[str, JobSpec] = {}
        self._states: dict[str, JobState] = {}
        self._created: dict[str, datetime] = {}
        self._leases: dict[str, _Lease] = {}
        self._events: dict[str, list[ComfyPoolEvent]] = {}
        self._inflight: dict[str, int] = {}  # endpoint base_url → count

    def enqueue(self, spec: JobSpec) -> str:
        if spec.job_id in self._specs:
            raise ValueError(f"duplicate job_id={spec.job_id}")
        if spec.kind is not JobKind.COMFY and spec.kind is not JobKind.GENERIC:
            # Allow GENERIC as soft alias when payload has workflow; else require COMFY.
            if "workflow" not in (spec.payload or {}):
                raise ValueError(
                    f"ComfyPoolActor expects JobKind.COMFY (or GENERIC+workflow), got {spec.kind}"
                )
        workflow = (spec.payload or {}).get("workflow")
        if not isinstance(workflow, Mapping):
            raise ValueError("payload.workflow must be a mapping")
        now = self._clock()
        self._specs[spec.job_id] = spec
        self._states[spec.job_id] = JobState(
            status=JobStatus.QUEUED,
            attempts=0,
            progress=0.0,
            updated_at=now,
        )
        self._created[spec.job_id] = now
        self._events[spec.job_id] = []
        return spec.job_id

    def get(self, job_id: str) -> Job | None:
        spec = self._specs.get(job_id)
        state = self._states.get(job_id)
        created = self._created.get(job_id)
        if spec is None or state is None or created is None:
            return None
        return Job.from_spec_state(
            spec,
            state,
            created_at=created,
            retryable=is_retryable(state, spec),
        )

    def events(self, job_id: str) -> list[ComfyPoolEvent]:
        return list(self._events.get(job_id, []))

    def _record(self, ev: ComfyPoolEvent) -> ComfyPoolEvent:
        self._events.setdefault(ev.job_id, []).append(ev)
        return ev

    def _requires_for(self, spec: JobSpec) -> dict[str, str]:
        req = dict(self.config.default_requires)
        req.update(spec.requires or {})
        # Prefer payload.pool as shorthand for requires.pool (storyboard → H3 label)
        pool = (spec.payload or {}).get("pool")
        if isinstance(pool, str) and pool and "pool" not in req:
            req["pool"] = pool
        return req

    def _endpoint_key(self, ep: ComfyEndpoint) -> str:
        return ep.base_url.rstrip("/")

    def _can_lease(self, ep: ComfyEndpoint) -> bool:
        n = self._inflight.get(self._endpoint_key(ep), 0)
        return n < max(1, self.config.max_inflight_per_endpoint)

    def _bump_inflight(self, ep: ComfyEndpoint, delta: int) -> None:
        k = self._endpoint_key(ep)
        self._inflight[k] = max(0, self._inflight.get(k, 0) + delta)

    def tick(self, job_id: str) -> ComfyPoolEvent:
        spec = self._specs.get(job_id)
        state = self._states.get(job_id)
        if spec is None or state is None:
            raise KeyError(job_id)

        if state.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            lease = self._leases.get(job_id)
            return self._record(
                ComfyPoolEvent(
                    job_id=job_id,
                    status=state.status,
                    progress=state.progress,
                    message="terminal",
                    prompt_id=lease.prompt_id if lease else None,
                    endpoint=lease.endpoint.base_url if lease else None,
                    dry_run=isinstance(self.client.transport, DryRunTransport),
                    at=self._clock(),
                )
            )

        now = self._clock()
        dry = isinstance(self.client.transport, DryRunTransport)

        # Phase A: submit once
        if job_id not in self._leases:
            requires = self._requires_for(spec)
            try:
                # Capacity gate before submit (label match still inside client.submit)
                from ..comfy_client import pick_endpoint

                ep = pick_endpoint(self.client.pool, requires)
                if ep is None:
                    raise LookupError(f"no Comfy endpoint matches requires={requires}")
                if not self._can_lease(ep):
                    state.status = JobStatus.QUEUED
                    state.updated_at = now
                    return self._record(
                        ComfyPoolEvent(
                            job_id=job_id,
                            status=state.status,
                            progress=state.progress,
                            message="waiting_capacity",
                            endpoint=ep.base_url,
                            dry_run=dry,
                            at=now,
                        )
                    )
                submit = self.client.submit(
                    spec.payload["workflow"],
                    requires=requires,
                    client_id=spec.job_id,
                )
            except LookupError as exc:
                state.status = JobStatus.FAILED
                state.error = str(exc)
                state.attempts = max(1, state.attempts)
                state.updated_at = now
                return self._record(
                    ComfyPoolEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=None,
                        message="no_endpoint",
                        error_class=ErrorClass.VALIDATION.value,
                        dry_run=dry,
                        at=now,
                    )
                )
            except Exception as exc:  # noqa: BLE001 — surface as job error
                state.status = JobStatus.FAILED
                state.error = f"submit_failed:{exc}"
                state.attempts = max(1, state.attempts)
                state.updated_at = now
                cls = classify_error(str(exc))
                return self._record(
                    ComfyPoolEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=None,
                        message="submit_failed",
                        error_class=cls.value,
                        dry_run=dry,
                        at=now,
                    )
                )

            self._leases[job_id] = _Lease(
                prompt_id=submit.prompt_id,
                endpoint=submit.endpoint,
                submit=submit,
            )
            self._bump_inflight(submit.endpoint, 1)
            state.status = JobStatus.LEASED
            state.node_id = f"comfy:{submit.endpoint.labels.get('pool', 'any')}"
            state.attempts = max(1, state.attempts)
            state.progress = None  # unknown until history — FE shimmer
            state.updated_at = now
            return self._record(
                ComfyPoolEvent(
                    job_id=job_id,
                    status=state.status,
                    progress=None,
                    message="submitted",
                    prompt_id=submit.prompt_id,
                    endpoint=submit.endpoint.base_url,
                    dry_run=submit.dry_run,
                    at=now,
                )
            )

        # Phase B: poll /history
        lease = self._leases[job_id]
        if state.status is JobStatus.LEASED:
            state.status = JobStatus.RUNNING
            state.updated_at = now

        poll = self.client.poll(lease.prompt_id, lease.endpoint)
        if poll.status is ComfyPromptStatus.SUCCEEDED:
            state.status = JobStatus.SUCCEEDED
            state.progress = 1.0
            # Prefer first image filename as result_ref when present
            result_ref = None
            for _node, out in (poll.outputs or {}).items():
                if isinstance(out, dict) and out.get("images"):
                    imgs = out["images"]
                    if imgs and isinstance(imgs[0], dict) and imgs[0].get("filename"):
                        result_ref = str(imgs[0]["filename"])
                        break
            state.result_ref = result_ref or f"comfy:{lease.prompt_id}"
            state.error = None
            state.updated_at = now
            self._bump_inflight(lease.endpoint, -1)
            return self._record(
                ComfyPoolEvent(
                    job_id=job_id,
                    status=state.status,
                    progress=1.0,
                    message="succeeded",
                    prompt_id=lease.prompt_id,
                    endpoint=lease.endpoint.base_url,
                    dry_run=dry,
                    at=now,
                )
            )

        if poll.status is ComfyPromptStatus.FAILED:
            decision = decide_after_failure(
                prompt_id=lease.prompt_id,
                error=poll.error,
                attempts=state.attempts,
                max_attempts=spec.max_retries,
                history_payload={lease.prompt_id: {"outputs": poll.outputs, "status": {"completed": False, "status_str": "error"}}}
                if poll.outputs
                else None,
            )
            if self.config.reconcile_on_history and decision.reconcile_success:
                state.status = JobStatus.SUCCEEDED
                state.progress = 1.0
                state.result_ref = f"comfy:{lease.prompt_id}"
                state.error = None
                state.updated_at = now
                self._bump_inflight(lease.endpoint, -1)
                return self._record(
                    ComfyPoolEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=1.0,
                        message="reconcile_success",
                        prompt_id=lease.prompt_id,
                        endpoint=lease.endpoint.base_url,
                        error_class=ErrorClass.RECONCILE.value,
                        dry_run=dry,
                        at=now,
                    )
                )
            state.status = JobStatus.FAILED
            state.error = poll.error or "comfy_failed"
            state.progress = None
            state.updated_at = now
            self._bump_inflight(lease.endpoint, -1)
            return self._record(
                ComfyPoolEvent(
                    job_id=job_id,
                    status=state.status,
                    progress=None,
                    message="failed",
                    prompt_id=lease.prompt_id,
                    endpoint=lease.endpoint.base_url,
                    error_class=decision.error_class.value,
                    dry_run=dry,
                    at=now,
                )
            )

        # QUEUED / RUNNING / UNKNOWN → keep RUNNING, progress unknown (shimmer)
        state.status = JobStatus.RUNNING
        state.progress = poll.progress  # usually None
        state.updated_at = now
        return self._record(
            ComfyPoolEvent(
                job_id=job_id,
                status=state.status,
                progress=state.progress,
                message=f"poll_{poll.status.value}",
                prompt_id=lease.prompt_id,
                endpoint=lease.endpoint.base_url,
                dry_run=dry,
                at=now,
            )
        )

    def cancel(self, job_id: str) -> JobState:
        spec = self._specs.get(job_id)
        state = self._states.get(job_id)
        if spec is None or state is None:
            raise KeyError(job_id)
        if state.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            return state
        lease = self._leases.get(job_id)
        if lease is not None:
            try:
                self.client.cancel(lease.prompt_id, lease.endpoint)
            except Exception:  # noqa: BLE001 — best-effort interrupt
                pass
            self._bump_inflight(lease.endpoint, -1)
        now = self._clock()
        state.status = JobStatus.CANCELLED
        state.updated_at = now
        self._record(
            ComfyPoolEvent(
                job_id=job_id,
                status=state.status,
                progress=state.progress,
                message="cancelled",
                prompt_id=lease.prompt_id if lease else None,
                endpoint=lease.endpoint.base_url if lease else None,
                dry_run=isinstance(self.client.transport, DryRunTransport),
                at=now,
            )
        )
        return state

    def run_until_terminal(self, job_id: str, *, max_ticks: int = 32) -> Job:
        """Convenience for tests: tick until terminal or max_ticks."""
        for _ in range(max_ticks):
            ev = self.tick(job_id)
            if ev.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
                break
        job = self.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return job


def run_comfy_job(
    spec: JobSpec,
    *,
    client: ComfyClient | None = None,
    config: ComfyPoolConfig | None = None,
    max_ticks: int = 32,
) -> Job:
    """One-shot helper: enqueue + tick to terminal under dry-run by default."""
    actor = ComfyPoolActor(client=client, config=config)
    actor.enqueue(spec)
    return actor.run_until_terminal(spec.job_id, max_ticks=max_ticks)
