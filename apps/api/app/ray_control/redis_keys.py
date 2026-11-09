"""Redis key helpers for toiv:ray:* (Phase1 schema v1).

No network calls — string formatting only.
"""

from __future__ import annotations

SCHEMA_VERSION = "1"
DEFAULT_NAMESPACE = "toiv:ray"


def _ns(namespace: str = DEFAULT_NAMESPACE) -> str:
    return namespace.rstrip(":")


def meta_schema(namespace: str = DEFAULT_NAMESPACE) -> str:
    return f"{_ns(namespace)}:meta:schema"


def nodes_set(namespace: str = DEFAULT_NAMESPACE) -> str:
    return f"{_ns(namespace)}:nodes"


def node_hash(node_id: str, namespace: str = DEFAULT_NAMESPACE) -> str:
    return f"{_ns(namespace)}:node:{node_id}"


def priority_queue(priority: int, namespace: str = DEFAULT_NAMESPACE) -> str:
    if priority < 0 or priority > 9:
        raise ValueError("priority must be 0..9")
    return f"{_ns(namespace)}:q:p{priority}"


def delayed_queue(namespace: str = DEFAULT_NAMESPACE) -> str:
    return f"{_ns(namespace)}:q:delayed"


def job_hash(job_id: str, namespace: str = DEFAULT_NAMESPACE) -> str:
    return f"{_ns(namespace)}:job:{job_id}"


def job_events(job_id: str, namespace: str = DEFAULT_NAMESPACE) -> str:
    """Hot-path per-job event stream (Redis). Durable catch-up → JobDeltaJournal / PG ray_job_deltas (D-R4)."""
    return f"{_ns(namespace)}:job:{job_id}:events"


# Optional future helper name: job_deltas_stream — reserved for PG dual-write mirror key;
# hot path remains job_events; Cycle 31 keeps journal in-process only.


def job_lease(job_id: str, namespace: str = DEFAULT_NAMESPACE) -> str:
    return f"{_ns(namespace)}:lease:{job_id}"


def flag_enabled(namespace: str = DEFAULT_NAMESPACE) -> str:
    """Optional runtime override key; env default remains False."""
    return f"{_ns(namespace)}:flag:enabled"


# Suggested hash field names for toiv:ray:job:{id}
JOB_HASH_FIELDS = (
    "kind",
    "priority",
    "payload_json",
    "status",
    "progress",
    "result_ref",
    "error",
    "created_at",
    "updated_at",
    "requires_json",
    "labels_json",
    "node_id",
    "attempts",
    "max_retries",
    "timeout_s",
)

NODE_HEARTBEAT_TTL_S = 45
JOB_LEASE_TTL_S = 120
JOB_HASH_TTL_AFTER_DONE_S = 7 * 24 * 3600
