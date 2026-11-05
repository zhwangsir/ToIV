"""LlmGatewayActor — Phase1 LLM adapter (scratch, dry-run default).

Mirrors TOIV_RAY_CONTROL_PLANE_PHASE1 §2 / §7 (llm_adapter.py / LlmGatewayActor):
  enqueue(spec) -> job_id
  tick(job_id)  -> LlmGatewayEvent   # lease + one chat.completions hop
  cancel(job_id) -> JobState
  get(job_id)   -> Job | None
  chat(...)     -> direct OpenAI-shape forward (same dry-run path)

Never opens sockets unless an injected LlmClient uses a live request_fn/transport.
Default path uses DryRunLlmBackend. Live Mia/spark probe stays frozen (口令).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlparse

from ..llm_client import DEFAULT_LLM_BASE_URL, ALTERNATE_DOC_LABEL_8000, LlmClient
from ..types import Job, JobKind, JobSpec, JobState, JobStatus, is_retryable


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class LlmUpstream:
    """Named upstream. Labels drive JobSpec.requires / payload.upstream pick."""

    name: str
    base_url: str
    labels: dict[str, str] = field(default_factory=dict)


def default_upstreams() -> list[LlmUpstream]:
    """Documented primary (:8888) + alternate (:8000/v1). No live probe."""
    return [
        LlmUpstream(
            name="primary",
            base_url=DEFAULT_LLM_BASE_URL,
            labels={"role": "llm", "port": "8888", "upstream": "primary"},
        ),
        LlmUpstream(
            name="alt8000",
            base_url=ALTERNATE_DOC_LABEL_8000,
            labels={"role": "llm", "port": "8000", "upstream": "alt8000"},
        ),
    ]


class DryRunLlmBackend:
    """In-memory OpenAI-compatible responses. Zero sockets."""

    def __init__(self, *, fail_models: bool = False, fail_chat: bool = False) -> None:
        self.fail_models = fail_models
        self.fail_chat = fail_chat
        self.calls: list[tuple[str, str]] = []

    def request_fn(
        self,
        method: str,
        url: str,
        data: bytes | None,
        headers: Mapping[str, str],
    ) -> tuple[int, bytes]:
        path = urlparse(url).path.rstrip("/")
        self.calls.append((method.upper(), path))
        # Never echo Authorization into results
        if method.upper() == "GET" and path.endswith("/models"):
            if self.fail_models:
                return 503, json.dumps({"error": {"message": "dry_run_models_down"}}).encode()
            return 200, json.dumps(
                {
                    "object": "list",
                    "data": [{"id": "dry-run-model", "object": "model", "owned_by": "toiv-dry-run"}],
                }
            ).encode()
        if method.upper() == "POST" and path.endswith("/chat/completions"):
            if self.fail_chat:
                return 500, json.dumps({"error": {"message": "dry_run_chat_failed"}}).encode()
            body: dict[str, Any] = {}
            if data:
                try:
                    body = json.loads(data.decode("utf-8"))
                except json.JSONDecodeError:
                    body = {}
            model = body.get("model") or "dry-run-model"
            msgs = body.get("messages") or []
            last = ""
            if isinstance(msgs, list) and msgs:
                last_m = msgs[-1]
                if isinstance(last_m, Mapping):
                    last = str(last_m.get("content") or "")
            content = f"[dry-run] {last}" if last else "[dry-run] ok"
            return 200, json.dumps(
                {
                    "id": "chatcmpl-dry-run",
                    "object": "chat.completion",
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            ).encode()
        return 404, json.dumps({"error": {"message": f"dry_run_unknown {method} {path}"}}).encode()


def pick_upstream(
    pool: Sequence[LlmUpstream],
    requires: Mapping[str, str] | None = None,
) -> LlmUpstream | None:
    req = dict(requires or {})
    if not req:
        return pool[0] if pool else None
    for up in pool:
        labels = up.labels or {}
        if all(labels.get(k) == v for k, v in req.items()):
            return up
    # name shortcut: requires.upstream == upstream.name
    name = req.get("upstream")
    if name:
        for up in pool:
            if up.name == name:
                return up
    return None


@dataclass
class LlmGatewayConfig:
    max_inflight: int = 4
    default_upstream: str = "primary"
    # When True, first tick only leases; second tick runs chat (shimmer-friendly).
    two_phase: bool = True


@dataclass
class LlmGatewayEvent:
    job_id: str
    status: JobStatus
    progress: float | None
    message: str
    upstream: str | None = None
    model: str | None = None
    error_class: str | None = None
    dry_run: bool = True
    at: datetime = field(default_factory=_utcnow)


@dataclass
class _Lease:
    upstream: LlmUpstream
    model: str
    submitted: bool = False


class LlmGatewayActor:
    """In-process stand-in for Ray LlmGatewayActor (D-R2 adapter only)."""

    def __init__(
        self,
        *,
        pool: Sequence[LlmUpstream] | None = None,
        backend: DryRunLlmBackend | None = None,
        clients: Mapping[str, LlmClient] | None = None,
        config: LlmGatewayConfig | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.pool = list(pool) if pool is not None else default_upstreams()
        self.config = config or LlmGatewayConfig()
        self._clock = clock or _utcnow
        self._backend = backend if backend is not None else DryRunLlmBackend()
        self._clients: dict[str, LlmClient] = dict(clients or {})
        self._specs: dict[str, JobSpec] = {}
        self._states: dict[str, JobState] = {}
        self._created: dict[str, datetime] = {}
        self._leases: dict[str, _Lease] = {}
        self._events: dict[str, list[LlmGatewayEvent]] = {}
        self._inflight: int = 0
        self._dry_run = clients is None  # injected live clients ⇒ not dry-run default

    def _client_for(self, up: LlmUpstream) -> LlmClient:
        if up.name in self._clients:
            return self._clients[up.name]
        # Build dry-run client bound to this upstream's base_url
        client = LlmClient(
            base_url=up.base_url,
            request_fn=self._backend.request_fn,
            default_model="dry-run-model",
        )
        self._clients[up.name] = client
        return client

    def is_dry_run(self) -> bool:
        return self._dry_run and isinstance(self._backend, DryRunLlmBackend)

    def enqueue(self, spec: JobSpec) -> str:
        if spec.job_id in self._specs:
            raise ValueError(f"duplicate job_id={spec.job_id}")
        if spec.kind is not JobKind.LLM and spec.kind is not JobKind.GENERIC:
            raise ValueError(
                f"LlmGatewayActor expects JobKind.LLM (or GENERIC+messages), got {spec.kind}"
            )
        messages = (spec.payload or {}).get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("payload.messages must be a non-empty list")
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

    def events(self, job_id: str) -> list[LlmGatewayEvent]:
        return list(self._events.get(job_id, []))

    def _record(self, ev: LlmGatewayEvent) -> LlmGatewayEvent:
        self._events.setdefault(ev.job_id, []).append(ev)
        return ev

    def _requires_for(self, spec: JobSpec) -> dict[str, str]:
        req = dict(spec.requires or {})
        upstream = (spec.payload or {}).get("upstream")
        if isinstance(upstream, str) and upstream and "upstream" not in req:
            req["upstream"] = upstream
        if not req and self.config.default_upstream:
            req["upstream"] = self.config.default_upstream
        return req

    def chat(
        self,
        messages: list[Mapping[str, Any]],
        *,
        model: str | None = None,
        upstream: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> Any:
        """Direct OpenAI-shape forward (Phase1 LlmGatewayActor.chat)."""
        requires = {"upstream": upstream} if upstream else {"upstream": self.config.default_upstream}
        up = pick_upstream(self.pool, requires)
        if up is None:
            raise LookupError(f"no LLM upstream matches requires={requires}")
        client = self._client_for(up)
        return client.chat_completions(
            list(messages),
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            extra=extra,
        )

    def tick(self, job_id: str) -> LlmGatewayEvent:
        spec = self._specs.get(job_id)
        state = self._states.get(job_id)
        if spec is None or state is None:
            raise KeyError(job_id)

        dry = self.is_dry_run()
        now = self._clock()

        if state.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
            lease = self._leases.get(job_id)
            return self._record(
                LlmGatewayEvent(
                    job_id=job_id,
                    status=state.status,
                    progress=state.progress,
                    message="terminal",
                    upstream=lease.upstream.name if lease else None,
                    model=lease.model if lease else None,
                    dry_run=dry,
                    at=now,
                )
            )

        # Phase A: pick upstream + lease (capacity)
        if job_id not in self._leases:
            requires = self._requires_for(spec)
            up = pick_upstream(self.pool, requires)
            if up is None:
                state.status = JobStatus.FAILED
                state.error = f"no_upstream:{requires}"
                state.attempts = max(1, state.attempts)
                state.updated_at = now
                return self._record(
                    LlmGatewayEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=None,
                        message="no_upstream",
                        error_class="validation",
                        dry_run=dry,
                        at=now,
                    )
                )
            if self._inflight >= max(1, self.config.max_inflight):
                state.status = JobStatus.QUEUED
                state.updated_at = now
                return self._record(
                    LlmGatewayEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=state.progress,
                        message="waiting_capacity",
                        upstream=up.name,
                        dry_run=dry,
                        at=now,
                    )
                )
            model = str((spec.payload or {}).get("model") or "dry-run-model")
            self._leases[job_id] = _Lease(upstream=up, model=model, submitted=False)
            self._inflight += 1
            state.status = JobStatus.LEASED
            state.node_id = f"llm:{up.name}"
            state.attempts = max(1, state.attempts)
            state.progress = None  # shimmer until chat returns
            state.updated_at = now
            if self.config.two_phase:
                return self._record(
                    LlmGatewayEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=None,
                        message="leased",
                        upstream=up.name,
                        model=model,
                        dry_run=dry,
                        at=now,
                    )
                )
            # fall through to chat in same tick when two_phase=False

        lease = self._leases[job_id]
        if state.status is JobStatus.LEASED:
            state.status = JobStatus.RUNNING
            state.updated_at = now

        # Phase B: chat.completions once
        if not lease.submitted:
            lease.submitted = True
            messages = list((spec.payload or {}).get("messages") or [])
            try:
                client = self._client_for(lease.upstream)
                payload = client.chat_completions(
                    messages,
                    model=lease.model,
                    temperature=(spec.payload or {}).get("temperature"),
                    max_tokens=(spec.payload or {}).get("max_tokens"),
                )
            except Exception as exc:  # noqa: BLE001
                state.status = JobStatus.FAILED
                state.error = f"chat_failed:{exc}"
                state.progress = None
                state.updated_at = now
                self._inflight = max(0, self._inflight - 1)
                return self._record(
                    LlmGatewayEvent(
                        job_id=job_id,
                        status=state.status,
                        progress=None,
                        message="chat_failed",
                        upstream=lease.upstream.name,
                        model=lease.model,
                        error_class="upstream",
                        dry_run=dry,
                        at=now,
                    )
                )
            # Extract assistant text for result_ref (short, no secrets)
            text = ""
            try:
                choices = payload.get("choices") if isinstance(payload, dict) else None
                if choices:
                    text = str(choices[0].get("message", {}).get("content") or "")
            except Exception:  # noqa: BLE001
                text = ""
            state.status = JobStatus.SUCCEEDED
            state.progress = 1.0
            state.result_ref = text[:240] or f"llm:{lease.upstream.name}:{lease.model}"
            state.error = None
            state.updated_at = now
            self._inflight = max(0, self._inflight - 1)
            return self._record(
                LlmGatewayEvent(
                    job_id=job_id,
                    status=state.status,
                    progress=1.0,
                    message="succeeded",
                    upstream=lease.upstream.name,
                    model=lease.model,
                    dry_run=dry,
                    at=now,
                )
            )

        # Already submitted — should be terminal; defensive
        state.updated_at = now
        return self._record(
            LlmGatewayEvent(
                job_id=job_id,
                status=state.status,
                progress=state.progress,
                message="idle",
                upstream=lease.upstream.name,
                model=lease.model,
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
        if lease is not None and state.status in (JobStatus.LEASED, JobStatus.RUNNING):
            self._inflight = max(0, self._inflight - 1)
        now = self._clock()
        state.status = JobStatus.CANCELLED
        state.updated_at = now
        self._record(
            LlmGatewayEvent(
                job_id=job_id,
                status=state.status,
                progress=state.progress,
                message="cancelled",
                upstream=lease.upstream.name if lease else None,
                model=lease.model if lease else None,
                dry_run=self.is_dry_run(),
                at=now,
            )
        )
        return state

    def run_until_terminal(self, job_id: str, *, max_ticks: int = 16) -> Job:
        for _ in range(max_ticks):
            ev = self.tick(job_id)
            if ev.status in (JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED):
                break
        job = self.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return job


def run_llm_job(
    spec: JobSpec,
    *,
    pool: Sequence[LlmUpstream] | None = None,
    backend: DryRunLlmBackend | None = None,
    config: LlmGatewayConfig | None = None,
    max_ticks: int = 16,
) -> Job:
    actor = LlmGatewayActor(pool=pool, backend=backend, config=config)
    actor.enqueue(spec)
    return actor.run_until_terminal(spec.job_id, max_ticks=max_ticks)
