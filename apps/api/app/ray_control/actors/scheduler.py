"""QueueScheduler — priority queue stub (no Ray).

Score = base_priority + aging_bonus − fail_penalty (paper formula).
Uses FakeRedis + redis_keys; optionally runs Echo jobs via run_echo_job.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from ..fake_redis import FakeRedis
from ..redis_keys import job_hash as job_hash_key
from ..redis_keys import priority_queue
from ..types import JobKind, JobSpec, JobState, JobStatus

try:
    from .echo import run_echo_job
except ImportError:  # pragma: no cover
    run_echo_job = None  # type: ignore[assignment]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ScoreWeights:
    """Tunable weights for the paper priority score."""

    aging_per_second: float = 0.001  # stub aging: +0.001 * wait_s
    fail_penalty_per_attempt: float = 0.5
    # effective score used for ordering = priority + aging - penalty


def compute_priority_score(
    priority: int,
    *,
    enqueued_at: float,
    now: float,
    attempts: int = 0,
    weights: ScoreWeights | None = None,
) -> float:
    w = weights or ScoreWeights()
    wait_s = max(0.0, now - enqueued_at)
    aging = w.aging_per_second * wait_s
    penalty = w.fail_penalty_per_attempt * max(0, attempts)
    return float(priority) + aging - penalty


class QueueScheduler:
    """Enqueue / dequeue / mark terminal; bucketed by integer priority 0..9."""

    def __init__(
        self,
        store: FakeRedis | None = None,
        *,
        namespace: str = "toiv:ray",
        weights: ScoreWeights | None = None,
        clock: Callable[[], float] | None = None,
        echo_runner: Callable[..., JobState] | None = None,
    ) -> None:
        self.store = store if store is not None else FakeRedis()
        self.namespace = namespace
        self.weights = weights or ScoreWeights()
        self._clock = clock or (lambda: _utcnow().timestamp())
        self._echo = echo_runner if echo_runner is not None else run_echo_job
        self._meta: dict[str, dict[str, Any]] = {}  # job_id -> {enqueued_at, attempts, score}

    def _write_job(self, spec: JobSpec, state: JobState, *, created_at: datetime) -> None:
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
            "node_id": state.node_id or "",
            "attempts": str(state.attempts),
            "max_retries": str(spec.max_retries),
            "timeout_s": str(spec.timeout_s),
            "score": str(self._meta.get(spec.job_id, {}).get("score", spec.priority)),
        }
        self.store.hset(key, mapping=mapping)

    def enqueue(self, spec: JobSpec) -> str:
        if spec.priority < 0 or spec.priority > 9:
            raise ValueError("priority must be 0..9")
        now = float(self._clock())
        created = _utcnow()
        attempts = int(self._meta.get(spec.job_id, {}).get("attempts", 0))
        score = compute_priority_score(
            spec.priority,
            enqueued_at=now,
            now=now,
            attempts=attempts,
            weights=self.weights,
        )
        self._meta[spec.job_id] = {
            "enqueued_at": now,
            "attempts": attempts,
            "score": score,
            "spec": spec,
        }
        state = JobState(status=JobStatus.QUEUED, attempts=attempts, progress=0.0, updated_at=created)
        self._write_job(spec, state, created_at=created)
        # FIFO within bucket; cross-bucket order by score at dequeue time
        self.store.rpush(priority_queue(spec.priority, namespace=self.namespace), spec.job_id)
        return spec.job_id

    def _refresh_scores(self) -> list[tuple[float, int, str]]:
        """Return candidates sorted by (-score, -priority, fifo index via meta time)."""
        now = float(self._clock())
        cands: list[tuple[float, int, float, str]] = []
        for p in range(9, -1, -1):
            key = priority_queue(p, namespace=self.namespace)
            for jid in self.store.lrange(key, 0, -1):
                meta = self._meta.get(jid)
                if not meta:
                    continue
                score = compute_priority_score(
                    p,
                    enqueued_at=float(meta["enqueued_at"]),
                    now=now,
                    attempts=int(meta.get("attempts", 0)),
                    weights=self.weights,
                )
                meta["score"] = score
                cands.append((score, p, float(meta["enqueued_at"]), jid))
        # higher score first; then earlier enqueue
        cands.sort(key=lambda t: (-t[0], t[2], t[3]))
        return [(s, p, j) for s, p, _, j in cands]

    def peek_order(self) -> list[str]:
        return [j for _, _, j in self._refresh_scores()]

    def dequeue(self) -> JobSpec | None:
        ordered = self._refresh_scores()
        if not ordered:
            return None
        score, priority, job_id = ordered[0]
        # remove from its bucket list
        qkey = priority_queue(priority, namespace=self.namespace)
        lst = self.store.lrange(qkey, 0, -1)
        if job_id in lst:
            lst = [x for x in lst if x != job_id]
            self.store.delete(qkey)
            if lst:
                self.store.rpush(qkey, *lst)
        meta = self._meta[job_id]
        spec: JobSpec = meta["spec"]
        meta["score"] = score
        created = _utcnow()
        state = JobState(
            status=JobStatus.RUNNING,
            attempts=int(meta.get("attempts", 0)) + 0,
            progress=0.0,
            node_id="scheduler-local",
            updated_at=created,
        )
        self._write_job(spec, state, created_at=created)
        meta["running"] = True
        return spec

    def mark_terminal(
        self,
        job_id: str,
        status: JobStatus,
        *,
        progress: float | None = 1.0,
        error: str | None = None,
        result_ref: str | None = None,
    ) -> JobState:
        meta = self._meta.get(job_id)
        if not meta:
            raise KeyError(job_id)
        spec: JobSpec = meta["spec"]
        if status is JobStatus.FAILED:
            meta["attempts"] = int(meta.get("attempts", 0)) + 1
        state = JobState(
            status=status,
            attempts=int(meta.get("attempts", 0)),
            progress=progress,
            error=error,
            result_ref=result_ref,
            node_id="scheduler-local",
            updated_at=_utcnow(),
        )
        self._write_job(spec, state, created_at=_utcnow())
        meta["running"] = False
        return state

    def run_next_echo(self, *, steps: int = 3) -> JobState | None:
        """Dequeue one job; if echo-compatible, run via run_echo_job and mark terminal."""
        spec = self.dequeue()
        if spec is None:
            return None
        if self._echo is None:
            return self.mark_terminal(spec.job_id, JobStatus.FAILED, progress=0.0, error="no_echo_runner")
        is_echo = spec.kind is JobKind.ECHO or spec.labels.get("job_type") == "echo"
        if not is_echo and spec.kind is not JobKind.GENERIC:
            return self.mark_terminal(
                spec.job_id,
                JobStatus.FAILED,
                progress=0.0,
                error="scheduler_echo_only_in_stub",
            )
        state = self._echo(spec, store=self.store, steps=steps, namespace=self.namespace)
        # mirror terminal from echo
        self._meta[spec.job_id]["attempts"] = state.attempts
        return state

    def queued_count(self) -> int:
        return sum(self.store.llen(priority_queue(p, namespace=self.namespace)) for p in range(10))
