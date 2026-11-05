"""Progress SSE/WS framing over ProgressBus (Cycle 40).

Scratch only: no live ASGI push, no tip mount. Flag default false.
Hot path stays ProgressBus; D-R4 journal remains catch-up; this layer
formats push frames for create-rail / task-center live UX.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from .progress_bus import JobEvent, JobEventKind, JobProjection, ProgressBus, project_rail_row


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class StreamFrame:
    """One push unit for SSE `data:` or WS text JSON."""

    event: str
    job_id: str
    seq: int
    state: str
    progress: float | None = None
    error: str | None = None
    retryable: bool = False
    result_uri: str | None = None
    thumb_uri: str | None = None
    preview_uri: str | None = None
    display_thumb_uri: str | None = None
    shot_id: str | None = None
    attempts: int = 0
    terminal: bool = False
    labels: dict[str, str] = field(default_factory=dict)
    updated_at: str | None = None
    channel: str = "progress"  # progress | toast | task_center

    def to_dict(self) -> dict[str, Any]:
        return {
            "event": self.event,
            "job_id": self.job_id,
            "seq": self.seq,
            "state": self.state,
            "progress": self.progress,
            "error": self.error,
            "retryable": self.retryable,
            "result_uri": self.result_uri,
            "thumb_uri": self.thumb_uri,
            "preview_uri": self.preview_uri,
            "display_thumb_uri": self.display_thumb_uri,
            "shot_id": self.shot_id,
            "attempts": self.attempts,
            "terminal": self.terminal,
            "labels": dict(self.labels),
            "updated_at": self.updated_at,
            "channel": self.channel,
        }


def frame_from_projection(
    proj: JobProjection,
    *,
    event: str | None = None,
    channel: str = "progress",
) -> StreamFrame:
    kind = event or ("job.terminal" if proj.terminal else "job.updated")
    return StreamFrame(
        event=kind,
        job_id=proj.id,
        seq=int(proj.seq or 0),
        state=proj.state,
        progress=proj.progress,
        error=proj.error,
        retryable=proj.retryable,
        result_uri=proj.result_uri,
        thumb_uri=proj.thumb_uri,
        preview_uri=proj.preview_uri,
        display_thumb_uri=proj.display_thumb_uri,
        shot_id=proj.shot_id,
        attempts=proj.attempts,
        terminal=proj.terminal,
        labels=dict(proj.labels),
        updated_at=proj.updated_at.isoformat() if proj.updated_at else None,
        channel=channel,
    )


def frame_from_event(event: JobEvent, *, channel: str = "progress") -> StreamFrame:
    kind = event.kind.value if isinstance(event.kind, JobEventKind) else str(event.kind)
    thumb = event.thumb_uri
    result = event.result_uri
    return StreamFrame(
        event=kind,
        job_id=event.job_id,
        seq=int(event.seq or 0),
        state=event.state,
        progress=event.progress,
        error=event.error,
        retryable=event.retryable,
        result_uri=result,
        thumb_uri=thumb,
        preview_uri=event.preview_uri,
        display_thumb_uri=thumb or result,
        shot_id=event.shot_id,
        attempts=event.attempts,
        terminal=event.terminal or event.state in ("succeeded", "failed", "cancelled"),
        labels=dict(event.labels),
        updated_at=event.updated_at.isoformat() if event.updated_at else None,
        channel=channel,
    )


def format_sse(frame: StreamFrame, *, include_id: bool = True) -> str:
    """Encode one SSE message (event + data [+ id])."""
    lines: list[str] = []
    if include_id and frame.seq:
        lines.append(f"id: {frame.seq}")
    lines.append(f"event: {frame.event}")
    lines.append(f"data: {json.dumps(frame.to_dict(), ensure_ascii=False, separators=(',', ':'))}")
    lines.append("")
    return "\n".join(lines) + "\n"


def format_ws_text(frame: StreamFrame) -> str:
    """Single WS text frame = JSON object (same body as SSE data)."""
    return json.dumps(frame.to_dict(), ensure_ascii=False, separators=(',', ':'))


def poll_bus_since(
    bus: ProgressBus,
    since_seq: int = 0,
    *,
    channel: str = "progress",
    limit: int = 200,
) -> list[StreamFrame]:
    """Snapshot poll: project current jobs with seq > since_seq (ordered).

    Not a full event log — for true replay use JobDeltaJournal + hub buffer.
    """
    since = int(since_seq or 0)
    lim = max(1, min(int(limit or 200), 2000))
    rows = sorted(
        (p for p in bus.jobs_by_id.values() if int(p.seq or 0) > since),
        key=lambda p: int(p.seq or 0),
    )
    return [frame_from_projection(p, channel=channel) for p in rows[:lim]]


@dataclass
class ProgressStreamHub:
    """Append-only live frame buffer + optional bus apply hook.

    FE recipe: open SSE/WS → on connect call list_since(hub) then receive live.
    Cap keeps scratch memory bounded; oldest dropped (seq still monotonic via bus).
    """

    capacity: int = 500
    clock: Callable[[], datetime] | None = None
    _frames: list[StreamFrame] = field(default_factory=list)
    _listeners: list[Callable[[StreamFrame], None]] = field(default_factory=list)
    _seq: int = 0

    def __post_init__(self) -> None:
        if self.clock is None:
            self.clock = _utcnow

    def next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def subscribe(self, listener: Callable[[StreamFrame], None]) -> Callable[[], None]:
        self._listeners.append(listener)

        def _unsub() -> None:
            try:
                self._listeners.remove(listener)
            except ValueError:
                pass

        return _unsub

    def publish(self, frame: StreamFrame) -> StreamFrame:
        seq = frame.seq if frame.seq else self.next_seq()
        if seq != frame.seq:
            frame = StreamFrame(
                event=frame.event,
                job_id=frame.job_id,
                seq=seq,
                state=frame.state,
                progress=frame.progress,
                error=frame.error,
                retryable=frame.retryable,
                result_uri=frame.result_uri,
                thumb_uri=frame.thumb_uri,
                preview_uri=frame.preview_uri,
                display_thumb_uri=frame.display_thumb_uri,
                shot_id=frame.shot_id,
                attempts=frame.attempts,
                terminal=frame.terminal,
                labels=dict(frame.labels),
                updated_at=frame.updated_at or self.clock().isoformat(),  # type: ignore[misc]
                channel=frame.channel,
            )
        else:
            self._seq = max(self._seq, seq)
        self._frames.append(frame)
        if len(self._frames) > self.capacity:
            self._frames = self._frames[-self.capacity :]
        for fn in list(self._listeners):
            fn(frame)
        return frame

    def publish_projection(
        self,
        proj: JobProjection,
        *,
        event: str | None = None,
        channel: str = "progress",
    ) -> StreamFrame:
        return self.publish(frame_from_projection(proj, event=event, channel=channel))

    def publish_event(self, event: JobEvent, *, channel: str = "progress") -> StreamFrame:
        return self.publish(frame_from_event(event, channel=channel))

    def apply_bus(
        self,
        bus: ProgressBus,
        event: JobEvent,
        *,
        channel: str = "progress",
        toast_channel: str = "toast",
    ) -> StreamFrame | None:
        """Apply to bus; on success publish progress (+ toast if focus)."""
        proj = bus.apply(event)
        if proj is None:
            return None
        frame = self.publish_projection(proj, event=event.kind.value, channel=channel)
        if bus.active_job_id == proj.id:
            self.publish_projection(proj, event=event.kind.value, channel=toast_channel)
        return frame

    def list_since(self, since_seq: int = 0, *, limit: int = 200) -> list[StreamFrame]:
        since = int(since_seq or 0)
        lim = max(1, min(int(limit or 200), 2000))
        out = [f for f in self._frames if f.seq > since]
        return out[:lim]

    def next_seq_watermark(self, since_seq: int = 0) -> int:
        frames = self.list_since(since_seq, limit=10_000)
        if not frames:
            return int(since_seq or 0)
        return max(f.seq for f in frames)

    def snapshot_payload_rows(self, since_seq: int = 0, *, limit: int = 200) -> list[dict[str, Any]]:
        return [f.to_dict() for f in self.list_since(since_seq, limit=limit)]

    def format_sse_batch(self, since_seq: int = 0, *, limit: int = 200) -> str:
        return "".join(format_sse(f) for f in self.list_since(since_seq, limit=limit))


_HUB: ProgressStreamHub | None = None


def get_stream_hub() -> ProgressStreamHub:
    global _HUB
    if _HUB is None:
        _HUB = ProgressStreamHub()
    return _HUB


def reset_stream_hub_for_tests() -> ProgressStreamHub:
    global _HUB
    _HUB = ProgressStreamHub()
    return _HUB


def rail_bundle_from_frame(frame: StreamFrame) -> dict[str, Any]:
    """Optional create-rail row shape from a stream frame (no bus required)."""
    # Build a synthetic projection-like dict for FE checks
    return {
        "id": frame.job_id,
        "state": frame.state,
        "progress": frame.progress,
        "progress_display": "shimmer" if frame.progress is None else "bar",
        "error": frame.error,
        "retryable": frame.retryable,
        "result_uri": frame.result_uri,
        "thumb_uri": frame.thumb_uri,
        "preview_uri": frame.preview_uri,
        "display_thumb_uri": frame.display_thumb_uri,
        "shot_id": frame.shot_id,
        "attempts": frame.attempts,
        "terminal": frame.terminal,
        "labels": dict(frame.labels),
        "seq": frame.seq,
        "updated_at": frame.updated_at,
        "surface": frame.channel,
        "event": frame.event,
    }


# silence unused import warning helpers for type checkers
_ = (project_rail_row,)
