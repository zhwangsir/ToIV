"""Feature flag reader for Ray control plane.

Default: disabled. Does not touch process-wide Settings or .env files.
"""

from __future__ import annotations

import os

RAY_CONTROL_ENV = "TOIV_RAY_CONTROL_ENABLED"

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def is_ray_control_enabled(environ: dict[str, str] | None = None) -> bool:
    """Return True only when TOIV_RAY_CONTROL_ENABLED is explicitly truthy.

    Missing / empty / any other value → False (safe default).
    """
    env = environ if environ is not None else os.environ
    raw = (env.get(RAY_CONTROL_ENV) or "").strip().lower()
    return raw in _TRUTHY


def is_enabled(environ: dict[str, str] | None = None) -> bool:
    """Alias for ``is_ray_control_enabled`` (router / caller convenience)."""
    return is_ray_control_enabled(environ)

