"""Ray control types aligned with Phase1 paper + Job field map.

Scratch stub — no Ray / Redis I/O.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Mapping


class JobKind(str, Enum):
    LLM = "llm"
    COMFY = "comfy"
    GENERIC = "generic"
    ECHO = "echo"  # Phase1 gate: no GPU; see TOIV_ECHO_JOB_CONTRACT


class JobStatus(str, Enum):
    QUEUED = "queued"
    LEASED = "leased"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class NodeStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    DRAINING = "draining"


@dataclass
class ResourceSnapshot:
    gpu_mem_free_mb: int | None = None
    gpu_uuid: list[str] = field(default_factory=list)
    comfy_ports: list[int] = field(default_factory=list)
    llm_base_url: str | None = None
    inflight: int = 0


@dataclass
class NodeInfo:
    node_id: str
    host: str
    roles: list[str] = field(default_factory=list)
    labels: dict[str, str] = field(default_factory=dict)
    resources: ResourceSnapshot = field(default_factory=ResourceSnapshot)
    status: NodeStatus = NodeStatus.OFFLINE
    last_seen: datetime | None = None


@dataclass
class JobSpec:
    job_id: str
    kind: JobKind = JobKind.GENERIC
    priority: int = 0
    requires: dict[str, str] = field(default_factory=dict)
    payload: dict[str, Any] = field(default_factory=dict)
    max_retries: int = 2
    timeout_s: float = 7200.0
    labels: dict[str, str] = field(default_factory=dict)


@dataclass
class JobState:
    status: JobStatus = JobStatus.QUEUED
    node_id: str | None = None
    attempts: int = 0
    progress: float | None = None
    error: str | None = None
    result_ref: str | None = None
    updated_at: datetime | None = None


@dataclass
class Job:
    """Flat FE/API projection (see TOIV_JOB_FIELD_MAP_20261105.md)."""

    id: str
    type: JobKind
    priority: int
    payload: dict[str, Any]
    state: JobStatus
    progress: float | None
    result_uri: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime
    labels: dict[str, str] = field(default_factory=dict)
    retryable: bool = False
    node_id: str | None = None
    attempts: int = 0
    max_retries: int = 2

    @staticmethod
    def from_spec_state(
        spec: JobSpec,
        state: JobState,
        *,
        created_at: datetime,
        retryable: bool | None = None,
    ) -> "Job":
        labels = {**spec.requires, **spec.labels}
        if retryable is None:
            retryable = (
                state.status is JobStatus.FAILED
                and state.attempts < spec.max_retries
            )
        return Job(
            id=spec.job_id,
            type=spec.kind,
            priority=spec.priority,
            payload=dict(spec.payload),
            state=state.status,
            progress=state.progress,
            result_uri=state.result_ref,
            error=state.error,
            created_at=created_at,
            updated_at=state.updated_at or created_at,
            labels=labels,
            retryable=bool(retryable),
            node_id=state.node_id,
            attempts=state.attempts,
            max_retries=spec.max_retries,
        )

    def fe_bucket(self) -> str:
        """R7 tab fold: active | done | failed."""
        if self.state in (JobStatus.QUEUED, JobStatus.LEASED, JobStatus.RUNNING):
            return "active"
        if self.state is JobStatus.FAILED:
            return "failed"
        return "done"


TRANSIENT_ERROR_MARKERS: tuple[str, ...] = (
    "lease_expired",
    "node_offline",
    "connection",
    "timeout",
    "503",
    "502",
)


def is_retryable(
    state: JobState,
    spec: JobSpec,
    *,
    error_class: str | None = None,
) -> bool:
    """Heuristic matching field-map §3.2 (no Comfy /history I/O here)."""
    if state.status is not JobStatus.FAILED:
        return False
    if state.attempts >= spec.max_retries:
        return False
    if error_class:
        low = error_class.lower()
        if any(m in low for m in ("validation", "4xx", "workflow_invalid")):
            return False
        if any(m in low for m in TRANSIENT_ERROR_MARKERS):
            return True
    # Default: allow retry until max if failed
    return True


def requires_subset(requires: Mapping[str, str], node_labels: Mapping[str, str]) -> bool:
    return all(node_labels.get(k) == v for k, v in requires.items())
