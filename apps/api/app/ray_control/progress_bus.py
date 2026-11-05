"""In-process progress bus matching TOIV_CREATE_RAIL_PROGRESS_UX paper.

Scratch only: dedupe rules D1–D4, jobsById store, activeJobId focus.
Cycle 27: thumb_uri / preview_uri projection for rail + task-center rows.
Cycle 40: SSE/WS framing lives in progress_stream.py (hub over this bus).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Iterable


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class JobEventKind(str, Enum):
    ENQUEUED = "job.enqueued"
    UPDATED = "job.updated"
    TERMINAL = "job.terminal"
    REMOVED = "job.removed"


TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})
ACTIVE_STATES = frozenset({"queued", "leased", "running"})


@dataclass(frozen=True)
class JobEvent:
    kind: JobEventKind
    job_id: str
    state: str
    progress: float | None = None
    error: str | None = None
    retryable: bool = False
    result_uri: str | None = None
    thumb_uri: str | None = None
    preview_uri: str | None = None
    labels: dict[str, str] = field(default_factory=dict)
    shot_id: str | None = None
    attempts: int = 0
    updated_at: datetime | None = None
    seq: int = 0
    terminal: bool = False

    @staticmethod
    def enqueued(
        job_id: str,
        *,
        state: str = "queued",
        progress: float | None = 0.0,
        error: str | None = None,
        retryable: bool = False,
        result_uri: str | None = None,
        thumb_uri: str | None = None,
        preview_uri: str | None = None,
        labels: dict[str, str] | None = None,
        shot_id: str | None = None,
        attempts: int = 0,
        updated_at: datetime | None = None,
        seq: int = 0,
    ) -> "JobEvent":
        """Fresh queue admission (Cycle 37); event_kind stays job.enqueued."""
        return JobEvent(
            kind=JobEventKind.ENQUEUED,
            job_id=job_id,
            state=state,
            progress=progress,
            error=error,
            retryable=retryable,
            result_uri=result_uri,
            thumb_uri=thumb_uri,
            preview_uri=preview_uri,
            labels=dict(labels or {}),
            shot_id=shot_id,
            attempts=attempts,
            updated_at=updated_at or _utcnow(),
            seq=seq,
            terminal=False,
        )

    @staticmethod
    def updated(
        job_id: str,
        *,
        state: str,
        progress: float | None = None,
        error: str | None = None,
        retryable: bool = False,
        result_uri: str | None = None,
        thumb_uri: str | None = None,
        preview_uri: str | None = None,
        labels: dict[str, str] | None = None,
        shot_id: str | None = None,
        attempts: int = 0,
        updated_at: datetime | None = None,
        seq: int = 0,
    ) -> "JobEvent":
        terminal = state in TERMINAL_STATES
        kind = JobEventKind.TERMINAL if terminal else JobEventKind.UPDATED
        return JobEvent(
            kind=kind,
            job_id=job_id,
            state=state,
            progress=progress,
            error=error,
            retryable=retryable,
            result_uri=result_uri,
            thumb_uri=thumb_uri,
            preview_uri=preview_uri,
            labels=dict(labels or {}),
            shot_id=shot_id,
            attempts=attempts,
            updated_at=updated_at or _utcnow(),
            seq=seq,
            terminal=terminal,
        )


@dataclass
class JobProjection:
    id: str
    state: str
    progress: float | None = None
    error: str | None = None
    retryable: bool = False
    result_uri: str | None = None
    thumb_uri: str | None = None
    preview_uri: str | None = None
    labels: dict[str, str] = field(default_factory=dict)
    shot_id: str | None = None
    attempts: int = 0
    updated_at: datetime | None = None
    seq: int = 0
    terminal: bool = False

    @property
    def display_thumb_uri(self) -> str | None:
        """Rail / task-center thumb: explicit thumb, else primary result."""
        return self.thumb_uri or self.result_uri


@dataclass
class ProgressBus:
    """Normalize job.updated into a single store for multi-surface projection."""

    coalesce_ms: float = 100.0
    clock: Callable[[], datetime] | None = None
    jobs_by_id: dict[str, JobProjection] = field(default_factory=dict)
    job_ids_by_shot: dict[str, list[str]] = field(default_factory=dict)
    active_job_id: str | None = None
    _seq: int = 0
    _last_apply_ms: dict[str, float] = field(default_factory=dict)
    _dropped: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.clock is None:
            self.clock = _utcnow

    def next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def apply(self, event: JobEvent) -> JobProjection | None:
        """Apply with D1–D4. Returns new projection or None if dropped."""
        if event.kind is JobEventKind.REMOVED:
            self.jobs_by_id.pop(event.job_id, None)
            if self.active_job_id == event.job_id:
                self.active_job_id = None
            for shot, ids in list(self.job_ids_by_shot.items()):
                if event.job_id in ids:
                    self.job_ids_by_shot[shot] = [i for i in ids if i != event.job_id]
            return None

        existing = self.jobs_by_id.get(event.job_id)
        seq = event.seq if event.seq else self.next_seq()
        updated_at = event.updated_at or self.clock()  # type: ignore[misc]

        # D1: only apply when seq grows, or same seq with strictly newer updated_at
        if existing is not None:
            if seq < existing.seq:
                self._dropped.append(f"stale_seq:{event.job_id}")
                return None
            if seq == existing.seq:
                if existing.updated_at is not None and updated_at <= existing.updated_at:
                    self._dropped.append(f"stale_seq:{event.job_id}")
                    return None
            # D3: progress regression (unless retry reset via attempts bump)
            if (
                event.progress is not None
                and existing.progress is not None
                and event.progress < existing.progress
                and event.attempts <= existing.attempts
                and not event.terminal
            ):
                self._dropped.append(f"progress_regress:{event.job_id}")
                return None
            # D4: retry reset allowed when attempts increase
            if event.attempts > existing.attempts and event.progress == 0:
                pass  # allow

        # D2: coalesce window (record only; last event wins — caller may batch)
        now_ms = updated_at.timestamp() * 1000.0
        last = self._last_apply_ms.get(event.job_id)
        if last is not None and (now_ms - last) < self.coalesce_ms and existing is not None:
            # Still apply last-wins within window (merge), do not drop
            pass
        self._last_apply_ms[event.job_id] = now_ms

        # D4 note: when attempts bump, allow progress back to 0 (already gated above)
        # Thumb/preview: explicit event wins; else keep prior (progress ticks must not wipe)
        merged_thumb = (
            event.thumb_uri
            if event.thumb_uri is not None
            else (existing.thumb_uri if existing is not None else None)
        )
        merged_preview = (
            event.preview_uri
            if event.preview_uri is not None
            else (existing.preview_uri if existing is not None else None)
        )
        merged_result = (
            event.result_uri
            if event.result_uri is not None
            else (existing.result_uri if existing is not None else None)
        )
        proj = JobProjection(
            id=event.job_id,
            state=event.state,
            progress=event.progress,
            error=event.error,
            retryable=event.retryable,
            result_uri=merged_result,
            thumb_uri=merged_thumb,
            preview_uri=merged_preview,
            labels=dict(event.labels) if event.labels else (dict(existing.labels) if existing else {}),
            shot_id=event.shot_id if event.shot_id is not None else (existing.shot_id if existing else None),
            attempts=event.attempts,
            updated_at=updated_at,
            seq=seq,
            terminal=event.terminal or event.state in TERMINAL_STATES,
        )
        self.jobs_by_id[event.job_id] = proj
        if event.shot_id:
            ids = self.job_ids_by_shot.setdefault(event.shot_id, [])
            if event.job_id not in ids:
                ids.append(event.job_id)
        if proj.state in ACTIVE_STATES and self.active_job_id is None:
            self.active_job_id = proj.id
        if proj.terminal and self.active_job_id == proj.id:
            # keep focus until UI clears; do not auto-steal
            pass
        return proj

    def apply_many(self, events: Iterable[JobEvent]) -> list[JobProjection]:
        out: list[JobProjection] = []
        for ev in events:
            proj = self.apply(ev)
            if proj is not None:
                out.append(proj)
        return out

    def focus(self, job_id: str | None) -> None:
        self.active_job_id = job_id

    def toast_target(self) -> JobProjection | None:
        """Toast binds a single focus job (paper §5)."""
        if not self.active_job_id:
            return None
        return self.jobs_by_id.get(self.active_job_id)

    def active_jobs(self) -> list[JobProjection]:
        return [j for j in self.jobs_by_id.values() if j.state in ACTIVE_STATES]

    def dropped_reasons(self) -> list[str]:
        return list(self._dropped)


# --- Cycle 27: surface projection for create-rail / toast / task-center ---

RAIL_TOKEN_HINTS: dict[str, Any] = {
    "side_w": 320,
    "thumb_w": 64,
    "thumb_h": 36,
    "progress_h": 3,
    "toast_w": 292,
    "toast_bar_h": 4,
}


def project_rail_row(proj: JobProjection) -> dict[str, Any]:
    """Compact FE row for create-rail / toast from ProgressBus projection."""
    return {
        "id": proj.id,
        "state": proj.state,
        "progress": proj.progress,
        "progress_display": "shimmer" if proj.progress is None else "bar",
        "error": proj.error,
        "retryable": proj.retryable,
        "result_uri": proj.result_uri,
        "thumb_uri": proj.thumb_uri,
        "preview_uri": proj.preview_uri,
        "display_thumb_uri": proj.display_thumb_uri,
        "shot_id": proj.shot_id,
        "attempts": proj.attempts,
        "terminal": proj.terminal,
        "labels": dict(proj.labels),
        "seq": proj.seq,
        "updated_at": proj.updated_at.isoformat() if proj.updated_at else None,
        "tokens": dict(RAIL_TOKEN_HINTS),
    }


def project_toast(bus: ProgressBus) -> dict[str, Any] | None:
    """Toast binds activeJobId; includes display_thumb_uri when available."""
    target = bus.toast_target()
    if target is None:
        return None
    row = project_rail_row(target)
    row["surface"] = "toast"
    return row
