"""Comfy retry / history helpers (scratch).

AGENTS H-4: DB/job marked failed ≠ generation failed — consult /history/{pid}
before requeue. No live network; use ComfyClient with DryRunTransport or an
injectable ``request_fn`` via ``RequestFnTransport``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Mapping

from .comfy_client import (
    ComfyClient,
    ComfyEndpoint,
    ComfyPollResult,
    ComfyPromptStatus,
    DryRunTransport,
)


class ErrorClass(str, Enum):
    TRANSIENT = "transient"  # network / 5xx / lease / worker gone → retryable
    VALIDATION = "validation"  # 4xx workflow / bad graph → not retryable
    POLICY = "policy"  # policy / auth / NSFW gate → not retryable
    RECONCILE = "reconcile"  # history has outputs → do not retry; mark success
    UNKNOWN = "unknown"


DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BACKOFF_BASE_S = 1.0
DEFAULT_BACKOFF_CAP_S = 30.0

_TRANSIENT_MARKERS = (
    "timeout",
    "timed out",
    "connection",
    "connect",
    "reset",
    "refused",
    "unavailable",
    "503",
    "502",
    "504",
    "500",
    "lease_expired",
    "node_offline",
    "worker",
    "history_http_5",
)
_VALIDATION_MARKERS = (
    "validation",
    "invalid",
    "workflow",
    "400",
    "404",
    "422",
    "bad_request",
    "missing_node",
)
_POLICY_MARKERS = (
    "policy",
    "forbidden",
    "401",
    "403",
    "nsfw",
    "content_filter",
    "denied",
)


def classify_error(
    error: str | None,
    *,
    http_status: int | None = None,
) -> ErrorClass:
    """Classify an error string / HTTP status for retry decisions."""
    if http_status is not None:
        if http_status >= 500:
            return ErrorClass.TRANSIENT
        if http_status in (401, 403):
            return ErrorClass.POLICY
        if 400 <= http_status < 500:
            return ErrorClass.VALIDATION

    text = (error or "").strip().lower()
    if not text:
        return ErrorClass.UNKNOWN
    if any(m in text for m in _POLICY_MARKERS):
        return ErrorClass.POLICY
    if any(m in text for m in _VALIDATION_MARKERS):
        return ErrorClass.VALIDATION
    if any(m in text for m in _TRANSIENT_MARKERS):
        return ErrorClass.TRANSIENT
    # bare 5xx token
    if re.search(r"\b5\d\d\b", text):
        return ErrorClass.TRANSIENT
    return ErrorClass.UNKNOWN


def is_retryable_error(
    error: str | None,
    *,
    http_status: int | None = None,
    attempts: int = 0,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> bool:
    if attempts >= max_attempts:
        return False
    cls = classify_error(error, http_status=http_status)
    return cls is ErrorClass.TRANSIENT


def backoff_seconds(
    attempt: int,
    *,
    base_s: float = DEFAULT_BACKOFF_BASE_S,
    cap_s: float = DEFAULT_BACKOFF_CAP_S,
) -> float:
    """Exponential backoff: base * 2^(attempt-1), capped. attempt is 1-based."""
    n = max(1, int(attempt))
    return float(min(cap_s, base_s * (2 ** (n - 1))))


def history_has_outputs(history_payload: Mapping[str, Any] | None, prompt_id: str) -> bool:
    if not history_payload or prompt_id not in history_payload:
        return False
    entry = history_payload.get(prompt_id)
    if not isinstance(entry, dict):
        return False
    outputs = entry.get("outputs")
    if isinstance(outputs, dict) and outputs:
        return True
    st = entry.get("status") or {}
    if isinstance(st, dict) and st.get("completed") and "error" not in str(st.get("status_str") or "").lower():
        return True
    return False


def should_poll_history(
    prompt_id: str | None,
    *,
    job_marked_failed: bool = False,
    force: bool = False,
) -> bool:
    """Return True when caller must GET /history/{pid} before retry/fail.

    Rules:
    - missing prompt_id → False (nothing to poll)
    - job_marked_failed → True (AGENTS H-4 reconcile)
    - force → True
    - otherwise True while we still have a prompt_id (normal progress poll)
    """
    if not prompt_id or not str(prompt_id).strip():
        return False
    if force or job_marked_failed:
        return True
    return True


@dataclass
class RetryDecision:
    retryable: bool
    error_class: ErrorClass
    poll_history: bool
    reconcile_success: bool
    backoff_s: float
    reason: str


def decide_after_failure(
    *,
    prompt_id: str | None,
    error: str | None,
    http_status: int | None = None,
    attempts: int = 0,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    history_payload: Mapping[str, Any] | None = None,
) -> RetryDecision:
    """Combine classify + history rule into one decision."""
    poll = should_poll_history(prompt_id, job_marked_failed=True)
    if poll and prompt_id and history_has_outputs(history_payload, prompt_id):
        return RetryDecision(
            retryable=False,
            error_class=ErrorClass.RECONCILE,
            poll_history=True,
            reconcile_success=True,
            backoff_s=0.0,
            reason="history_has_outputs_reconcile_success",
        )
    cls = classify_error(error, http_status=http_status)
    retryable = cls is ErrorClass.TRANSIENT and attempts < max_attempts
    return RetryDecision(
        retryable=retryable,
        error_class=cls,
        poll_history=poll,
        reconcile_success=False,
        backoff_s=backoff_seconds(attempts + 1) if retryable else 0.0,
        reason=(
            "retry_transient"
            if retryable
            else ("max_attempts" if attempts >= max_attempts else f"non_retryable_{cls.value}")
        ),
    )


RequestFn = Callable[[str, str, bytes | None, Mapping[str, str]], tuple[int, bytes]]


class RequestFnTransport:
    """Adapt Cycle-3 style ``request_fn(method, url, body, headers)`` to HttpTransport."""

    def __init__(self, request_fn: RequestFn) -> None:
        self._fn = request_fn

    def request(
        self,
        method: str,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        timeout_s: float = 30.0,
    ) -> tuple[int, dict[str, Any] | list[Any] | str | None]:
        import json as _json

        raw_body = None if json_body is None else _json.dumps(json_body).encode("utf-8")
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        status, raw = self._fn(method.upper(), url, raw_body, headers)
        if not raw:
            return status, None
        try:
            return status, _json.loads(raw.decode("utf-8"))
        except Exception:
            return status, raw.decode("utf-8", errors="replace")


def poll_history(
    client: ComfyClient,
    prompt_id: str,
    endpoint: ComfyEndpoint,
) -> ComfyPollResult:
    """Thin wrapper — always goes through ComfyClient.poll (injectable transport)."""
    if not should_poll_history(prompt_id):
        return ComfyPollResult(
            prompt_id=prompt_id or "",
            status=ComfyPromptStatus.UNKNOWN,
            error="no_prompt_id",
            history_checked=False,
        )
    return client.poll(prompt_id, endpoint)


def client_from_request_fn(
    request_fn: RequestFn,
    *,
    base_url: str = "http://127.0.0.1:8196",
) -> ComfyClient:
    """Build a ComfyClient that never uses the default dry-run queue — uses request_fn."""
    ep = ComfyEndpoint(base_url, {"pool": "test"})
    return ComfyClient(pool=[ep], transport=RequestFnTransport(request_fn))
