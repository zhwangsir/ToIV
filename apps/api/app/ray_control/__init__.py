"""ToIV Ray control plane (feature-flagged; default off).

JR-R1…R5 merge onto tip feature branch. Does not mount routes/lifespan into
``app.main`` unless a later 改码卡 wires it behind ``TOIV_RAY_CONTROL_ENABLED``.
"""

from __future__ import annotations

from .flag import RAY_CONTROL_ENV, is_enabled, is_ray_control_enabled
from .progress_bus import JobEvent, JobEventKind, JobProjection, ProgressBus
from .types import (
    Job,
    JobKind,
    JobSpec,
    JobState,
    JobStatus,
    NodeInfo,
    NodeStatus,
    ResourceSnapshot,
)

__all__ = [
    "RAY_CONTROL_ENV",
    "is_ray_control_enabled",
    "is_enabled",
    "JobKind",
    "JobStatus",
    "NodeStatus",
    "ResourceSnapshot",
    "NodeInfo",
    "JobSpec",
    "JobState",
    "Job",
    "ProgressBus",
    "JobEvent",
    "JobEventKind",
    "JobProjection",
]
