"""ComfyUI HTTP client stub (Phase1 §8 / D-R3).

Signatures for submit / poll / cancel. Does **not** open sockets unless
explicitly constructed with a real transport — default is dry-run so
scratch imports never touch live Comfy ports (user-managed topology).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol
from urllib.parse import urljoin
import json
import uuid


class ComfyPromptStatus(str, Enum):
    UNKNOWN = "unknown"
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ComfyEndpoint:
    """One Comfy base URL + Ray-facing labels (docs ports, not live probe)."""

    base_url: str
    labels: Mapping[str, str] = field(default_factory=dict)
    role: str = "comfy"

    def url(self, path: str) -> str:
        base = self.base_url if self.base_url.endswith("/") else self.base_url + "/"
        return urljoin(base, path.lstrip("/"))


# Documented AGENTS ports (Phase1 §8) — configuration defaults only.
DOCUMENTED_COMFY_POOL: tuple[ComfyEndpoint, ...] = (
    ComfyEndpoint("http://127.0.0.1:8188", {"pool": "lb"}),
    ComfyEndpoint("http://127.0.0.1:8196", {"pool": "img"}),
    ComfyEndpoint("http://127.0.0.1:8197", {"pool": "longcat"}),
    ComfyEndpoint("http://127.0.0.1:8195", {"pool": "h3"}),
    ComfyEndpoint("http://127.0.0.1:8264", {"pool": "h3", "prod": "1"}),
    ComfyEndpoint("http://127.0.0.1:8199", {"pool": "wan"}),
    ComfyEndpoint("http://127.0.0.1:8262", {"pool": "upscale"}),
    ComfyEndpoint("http://127.0.0.1:8263", {"pool": "upscale"}),
)


@dataclass
class ComfySubmitResult:
    prompt_id: str
    endpoint: ComfyEndpoint
    dry_run: bool = True


@dataclass
class ComfyPollResult:
    prompt_id: str
    status: ComfyPromptStatus
    progress: float | None = None  # 0..1; None → FE shimmer
    outputs: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    # AGENTS: DB error ≠ generation failure — caller must consult /history
    history_checked: bool = False


class HttpTransport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        timeout_s: float = 30.0,
    ) -> tuple[int, dict[str, Any] | list[Any] | str | None]:
        ...


class DryRunTransport:
    """In-memory fake: no sockets. Used by default in scratch/tests."""

    def __init__(self) -> None:
        self._queued: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str]] = []

    def request(
        self,
        method: str,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        timeout_s: float = 30.0,
    ) -> tuple[int, dict[str, Any] | list[Any] | str | None]:
        self.calls.append((method.upper(), url))
        m = method.upper()
        if m == "POST" and url.rstrip("/").endswith("/prompt"):
            pid = str(uuid.uuid4())
            self._queued[pid] = {"workflow": json_body or {}, "ticks": 0}
            return 200, {"prompt_id": pid, "number": len(self._queued)}
        if m == "GET" and "/history/" in url:
            pid = url.rstrip("/").rsplit("/", 1)[-1]
            entry = self._queued.get(pid)
            if entry is None:
                return 200, {}
            entry["ticks"] += 1
            if entry["ticks"] < 2:
                return 200, {}
            return 200, {
                pid: {
                    "status": {"completed": True, "status_str": "success"},
                    "outputs": {"9": {"images": [{"filename": f"dry_{pid}.png"}]}},
                }
            }
        if m == "POST" and url.rstrip("/").endswith("/interrupt"):
            return 200, {}
        return 404, {"error": "dry_run_unknown_route"}


def pick_endpoint(
    pool: tuple[ComfyEndpoint, ...] | list[ComfyEndpoint],
    requires: Mapping[str, str] | None = None,
) -> ComfyEndpoint | None:
    """Hard-filter by requires ⊆ labels (same rule as types.requires_subset)."""
    req = dict(requires or {})
    for ep in pool:
        if all(ep.labels.get(k) == v for k, v in req.items()):
            return ep
    return None


class ComfyClient:
    """Thin Comfy wrapper: /prompt, /history/{id}, /interrupt.

    Default transport is DryRunTransport — never hits LAN unless caller
    injects a real HttpTransport (and ops 口令 allows live probe).
    """

    def __init__(
        self,
        *,
        pool: tuple[ComfyEndpoint, ...] | list[ComfyEndpoint] | None = None,
        transport: HttpTransport | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        self.pool: list[ComfyEndpoint] = list(pool if pool is not None else DOCUMENTED_COMFY_POOL)
        self.transport: HttpTransport = transport or DryRunTransport()
        self.timeout_s = timeout_s
        self._dry = isinstance(self.transport, DryRunTransport)

    def submit(
        self,
        workflow: Mapping[str, Any],
        *,
        requires: Mapping[str, str] | None = None,
        client_id: str | None = None,
    ) -> ComfySubmitResult:
        ep = pick_endpoint(self.pool, requires)
        if ep is None:
            raise LookupError(f"no Comfy endpoint matches requires={dict(requires or {})}")
        body: dict[str, Any] = {"prompt": dict(workflow)}
        if client_id:
            body["client_id"] = client_id
        status, data = self.transport.request(
            "POST",
            ep.url("/prompt"),
            json_body=body,
            timeout_s=self.timeout_s,
        )
        if status >= 400 or not isinstance(data, dict) or "prompt_id" not in data:
            raise RuntimeError(f"comfy submit failed status={status} body={data!r}")
        return ComfySubmitResult(
            prompt_id=str(data["prompt_id"]),
            endpoint=ep,
            dry_run=self._dry,
        )

    def poll(self, prompt_id: str, endpoint: ComfyEndpoint) -> ComfyPollResult:
        """Prefer /history/{pid}. Empty history ⇒ still queued/running (unknown progress)."""
        status_code, data = self.transport.request(
            "GET",
            endpoint.url(f"/history/{prompt_id}"),
            timeout_s=self.timeout_s,
        )
        if status_code >= 500:
            # AGENTS: treat transport/DB blip as unknown — do NOT mark generation failed
            return ComfyPollResult(
                prompt_id=prompt_id,
                status=ComfyPromptStatus.UNKNOWN,
                progress=None,
                error=f"history_http_{status_code}",
                history_checked=False,
            )
        if not isinstance(data, dict) or prompt_id not in data:
            return ComfyPollResult(
                prompt_id=prompt_id,
                status=ComfyPromptStatus.QUEUED,
                progress=None,
                history_checked=True,
            )
        entry = data[prompt_id]
        if not isinstance(entry, dict):
            return ComfyPollResult(
                prompt_id=prompt_id,
                status=ComfyPromptStatus.UNKNOWN,
                history_checked=True,
            )
        st = entry.get("status") or {}
        completed = bool(st.get("completed")) if isinstance(st, dict) else False
        status_str = (st.get("status_str") if isinstance(st, dict) else None) or ""
        outputs = entry.get("outputs") if isinstance(entry.get("outputs"), dict) else {}
        if completed and "error" not in status_str.lower():
            return ComfyPollResult(
                prompt_id=prompt_id,
                status=ComfyPromptStatus.SUCCEEDED,
                progress=1.0,
                outputs=dict(outputs),
                history_checked=True,
            )
        if "error" in status_str.lower() or entry.get("error"):
            return ComfyPollResult(
                prompt_id=prompt_id,
                status=ComfyPromptStatus.FAILED,
                progress=None,
                outputs=dict(outputs),
                error=str(entry.get("error") or status_str or "comfy_failed"),
                history_checked=True,
            )
        return ComfyPollResult(
            prompt_id=prompt_id,
            status=ComfyPromptStatus.RUNNING,
            progress=None,
            outputs=dict(outputs),
            history_checked=True,
        )

    def cancel(self, prompt_id: str, endpoint: ComfyEndpoint) -> None:
        # Comfy interrupt is global-to-worker; prompt_id kept for API symmetry / future queue API
        _ = prompt_id
        status, data = self.transport.request(
            "POST",
            endpoint.url("/interrupt"),
            json_body={},
            timeout_s=self.timeout_s,
        )
        if status >= 400:
            raise RuntimeError(f"comfy interrupt failed status={status} body={data!r}")


def workflow_fingerprint(workflow: Mapping[str, Any]) -> str:
    """Stable short id for logs — not a crypto hash of secrets."""
    raw = json.dumps(workflow, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return f"wf_{len(raw)}_{abs(hash(raw)) % 10_000_000:07d}"
