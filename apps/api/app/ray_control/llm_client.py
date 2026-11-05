"""OpenAI-compatible LLM adapter skeleton (scratch) — D-R2.

Primary upstream pattern: Mia/spark OpenAI-compatible API (TOIV_LLM_BASE_URL).
Example default base_url: ``http://127.0.0.1:8888`` (placeholder; injectable).
Phase1/AGENTS may also document spark ``:8000/v1`` as an **alternate** label —
do not hard-cutover; callers inject the live URL when authorized.

No network I/O at import. Use ``request_fn`` for tests.
Does **not** replace existing Mia/spark processes (adapter-only).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urljoin

try:
    import httpx as _httpx
except ImportError:  # pragma: no cover
    _httpx = None  # type: ignore[assignment]

RequestFn = Callable[[str, str, bytes | None, Mapping[str, str]], tuple[int, bytes]]

# Injectable example default — NOT a live probe target for this stub.
DEFAULT_LLM_BASE_URL = "http://127.0.0.1:8888"
ALTERNATE_DOC_LABEL_8000 = "http://127.0.0.1:8000/v1"  # docs-only alternate


@dataclass
class LlmClientConfig:
    base_url: str
    api_key: str = "not-a-secret"
    timeout_s: float = 60.0
    default_model: str = "default"


class LlmClient:
    """Minimal OpenAI-compatible client: models.list + chat.completions."""

    def __init__(
        self,
        base_url: str = DEFAULT_LLM_BASE_URL,
        *,
        api_key: str = "not-a-secret",
        timeout_s: float = 60.0,
        default_model: str = "default",
        request_fn: RequestFn | None = None,
        transport: Any | None = None,
    ) -> None:
        # Accept either ``http://host:8888`` or ``.../v1``
        base = base_url.rstrip("/")
        if not base.endswith("/v1"):
            base = base + "/v1"
        self.config = LlmClientConfig(
            base_url=base + "/",
            api_key=api_key,
            timeout_s=timeout_s,
            default_model=default_model,
        )
        self._request_fn = request_fn
        self._transport = transport

    def _url(self, path: str) -> str:
        return urljoin(self.config.base_url, path.lstrip("/"))

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.config.api_key}",
        }

    def _raw(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> tuple[int, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        url = self._url(path)
        headers = self._headers()

        if self._request_fn is not None:
            status, raw = self._request_fn(method, url, data, headers)
            if not raw:
                return status, None
            return status, json.loads(raw.decode("utf-8"))

        if _httpx is not None:
            with _httpx.Client(
                timeout=self.config.timeout_s,
                transport=self._transport,
            ) as client:
                resp = client.request(method, url, content=data, headers=headers)
                if not resp.content:
                    return resp.status_code, None
                return resp.status_code, resp.json()

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.config.timeout_s) as resp:
                raw = resp.read()
                status = getattr(resp, "status", 200)
        except urllib.error.HTTPError as e:
            raw = e.read()
            status = e.code
        if not raw:
            return status, None
        return status, json.loads(raw.decode("utf-8"))

    def list_models(self) -> Any:
        """GET /v1/models"""
        status, payload = self._raw("GET", "models")
        if status >= 400:
            raise RuntimeError(f"list_models HTTP {status}: {payload!r}")
        return payload

    def chat_completions(
        self,
        messages: list[Mapping[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> Any:
        """POST /v1/chat/completions"""
        body: dict[str, Any] = {
            "model": model or self.config.default_model,
            "messages": list(messages),
        }
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if extra:
            body.update(dict(extra))
        status, payload = self._raw("POST", "chat/completions", body)
        if status >= 400:
            raise RuntimeError(f"chat_completions HTTP {status}: {payload!r}")
        return payload

    def health_shape(self) -> dict[str, Any]:
        """Return the **shape** of a health probe (no I/O).

        Callers may later GET ``models`` or a custom ``/health``; this stub
        only documents the expected JSON envelope for adapters.
        """
        return {
            "ok": None,
            "base_url": self.config.base_url,
            "upstream_role": "mia_or_spark_openai_compatible",
            "primary_port_doc": 8888,
            "alternate_port_doc": 8000,
            "probe": "GET /v1/models",
        }
