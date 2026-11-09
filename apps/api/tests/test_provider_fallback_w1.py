"""W1 #69 Provider fallback chain — mock unit tests (draft, uncommitted).

Self-contained FakeProvider + fallback_runner. No live HTTP (.80/.84/.100),
no Redis/DB writes, does not enable TOIV_RAY_CONTROL_ENABLED, no real Comfy/LLM.

Source of truth (paper): docs/ops/TOIV_W1_QUEUE69_TESTCASES_DRAFT_20261109.md
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import pytest

# Align string labels with ray_control.comfy_retry.ErrorClass values (read-only).
try:
    from app.ray_control.comfy_retry import ErrorClass as _ErrorClass

    TRANSIENT = _ErrorClass.TRANSIENT.value  # "transient"
    VALIDATION = _ErrorClass.VALIDATION.value
except Exception:  # pragma: no cover — keep runnable even if import path shifts
    TRANSIENT = "transient"
    VALIDATION = "validation"

Outcome = Literal["ok", "fail"]


@dataclass
class FakeProvider:
    provider_id: str
    fail_sequence: list[str] = field(default_factory=list)
    success_uri: str = "s3://fake/ok"
    _call_i: int = 0

    def call(self) -> tuple[bool, str | None, str | None]:
        """Return (ok, result_uri|None, error_class|None)."""
        if self._call_i < len(self.fail_sequence):
            err = self.fail_sequence[self._call_i]
            self._call_i += 1
            return False, None, err
        self._call_i += 1
        return True, self.success_uri, None


@dataclass
class RunResult:
    status: Literal["done", "failed"]
    provider_id: str | None = None
    result_uri: str | None = None
    attempts: list[dict[str, Any]] = field(default_factory=list)
    terminal_error: list[dict[str, Any]] | None = None
    idempotency_key: str | None = None


class FallbackRunner:
    """Paper §3 state machine (mock): primary retries then optional backup."""

    def __init__(
        self,
        *,
        max_attempts_per_provider: int = 2,
        fallback_policy: str = "on_transient_only",
        call_log: list[tuple[str, int, Outcome]] | None = None,
    ) -> None:
        self.max_attempts_per_provider = max_attempts_per_provider
        self.fallback_policy = fallback_policy
        self.call_log = call_log if call_log is not None else []
        self._success_keys: set[str] = set()

    def run(self, chain: list[FakeProvider], key: str) -> RunResult:
        attempts: list[dict[str, Any]] = []
        terminal: list[dict[str, Any]] = []

        for provider in chain:
            provider_failed = False
            last_class: str | None = None
            for attempt in range(self.max_attempts_per_provider):
                ok, uri, err_class = provider.call()
                if ok:
                    self.call_log.append((provider.provider_id, attempt, "ok"))
                    if key in self._success_keys:
                        raise AssertionError(f"duplicate success for idempotency_key={key}")
                    self._success_keys.add(key)
                    return RunResult(
                        status="done",
                        provider_id=provider.provider_id,
                        result_uri=uri,
                        attempts=attempts,
                        terminal_error=None,
                        idempotency_key=key,
                    )
                self.call_log.append((provider.provider_id, attempt, "fail"))
                last_class = err_class or "unknown"
                attempts.append(
                    {
                        "provider_id": provider.provider_id,
                        "attempt": attempt,
                        "error_class": last_class,
                    }
                )
                if last_class in {VALIDATION, "policy"}:
                    provider_failed = True
                    break  # do not retry this provider
                # transient / unknown → retry until max
            else:
                provider_failed = True

            terminal.append(
                {
                    "provider_id": provider.provider_id,
                    "error_class": last_class or "unknown",
                    "message": f"{provider.provider_id} exhausted",
                }
            )

            if self.fallback_policy == "never":
                break
            if self.fallback_policy == "on_transient_only":
                # only continue chain if last failure was transient-like
                if last_class not in {TRANSIENT, "unknown", None}:
                    # validation/policy: stop chain (no blind failover)
                    break
            # else on_any_error → continue

        return RunResult(
            status="failed",
            provider_id=None,
            result_uri=None,
            attempts=attempts,
            terminal_error=terminal,
            idempotency_key=key,
        )


@pytest.fixture
def call_log() -> list[tuple[str, int, Outcome]]:
    return []


@pytest.fixture
def primary_provider() -> FakeProvider:
    return FakeProvider(provider_id="llm:primary", success_uri="s3://fake/primary-ok")


@pytest.fixture
def backup_provider() -> FakeProvider:
    return FakeProvider(provider_id="llm:backup", success_uri="s3://fake/backup-ok")


@pytest.fixture
def fallback_runner(call_log: list[tuple[str, int, Outcome]]) -> FallbackRunner:
    return FallbackRunner(
        max_attempts_per_provider=2,
        fallback_policy="on_transient_only",
        call_log=call_log,
    )


def test_case1_primary_transient_then_backup_ok(
    fallback_runner: FallbackRunner,
    primary_provider: FakeProvider,
    backup_provider: FakeProvider,
    call_log: list[tuple[str, int, Outcome]],
) -> None:
    """Case1: primary fail → backup success; no silent success from primary errors."""
    primary_provider.fail_sequence = [TRANSIENT, TRANSIENT]
    backup_provider.fail_sequence = []

    out = fallback_runner.run(
        [primary_provider, backup_provider], key="w1-fallback-case1"
    )

    assert out.status == "done"
    assert out.provider_id == backup_provider.provider_id
    assert call_log == [
        ("llm:primary", 0, "fail"),
        ("llm:primary", 1, "fail"),
        ("llm:backup", 0, "ok"),
    ]
    assert out.result_uri is not None
    assert out.result_uri.endswith("backup-ok")
    assert out.result_uri != "s3://fake/primary-ok"
    # primary errors recorded; overall not a clean no-error success
    assert len(out.attempts) == 2
    assert all(a["provider_id"] == "llm:primary" for a in out.attempts)
    assert all(a["error_class"] == TRANSIENT for a in out.attempts)
    assert out.terminal_error is None
    # idempotency: same key must not double-succeed
    with pytest.raises(AssertionError, match="duplicate success"):
        # force backup to succeed again on a second run with same key
        backup_provider.fail_sequence = []
        backup_provider._call_i = 0
        primary_provider.fail_sequence = [TRANSIENT, TRANSIENT]
        primary_provider._call_i = 0
        fallback_runner.run([primary_provider, backup_provider], key="w1-fallback-case1")


def test_case2_both_providers_fail_explicit_error(
    fallback_runner: FallbackRunner,
    primary_provider: FakeProvider,
    backup_provider: FakeProvider,
    call_log: list[tuple[str, int, Outcome]],
) -> None:
    """Case2: primary+backup fail → explicit failed; no fake done."""
    primary_provider.fail_sequence = [TRANSIENT, TRANSIENT]
    backup_provider.fail_sequence = [TRANSIENT, TRANSIENT]

    out = fallback_runner.run(
        [primary_provider, backup_provider], key="w1-fallback-case2"
    )

    assert out.status == "failed"
    assert out.result_uri is None
    assert out.provider_id is None
    assert out.terminal_error is not None
    ids = {e["provider_id"] for e in out.terminal_error}
    assert primary_provider.provider_id in ids
    assert backup_provider.provider_id in ids
    assert all(e.get("error_class") for e in out.terminal_error)
    assert all(e.get("message") for e in out.terminal_error)
    assert call_log == [
        ("llm:primary", 0, "fail"),
        ("llm:primary", 1, "fail"),
        ("llm:backup", 0, "fail"),
        ("llm:backup", 1, "fail"),
    ]
    assert out.status != "done"


def test_case2b_no_backup_configured_raises_explicit(
    call_log: list[tuple[str, int, Outcome]],
    primary_provider: FakeProvider,
) -> None:
    """Case2b: no backup in chain → explicit failed after primary exhaust (align llm no-fallback)."""
    runner = FallbackRunner(
        max_attempts_per_provider=2,
        fallback_policy="on_transient_only",
        call_log=call_log,
    )
    primary_provider.fail_sequence = [TRANSIENT, TRANSIENT]
    out = runner.run([primary_provider], key="w1-fallback-case2b")
    assert out.status == "failed"
    assert out.result_uri is None
    assert out.terminal_error is not None
    assert len(out.terminal_error) == 1
    assert out.terminal_error[0]["provider_id"] == "llm:primary"
