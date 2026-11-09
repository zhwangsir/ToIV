"""Model registry record stub (P1 paper → scratch types).

SFW/NSFW marking + load status for future NodeRegistry / settings UI.
Flag-off: no live LMS/Comfy probing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ModelLoadStatus(str, Enum):
    UNKNOWN = "unknown"
    AVAILABLE = "available"  # on disk / registered
    LOADING = "loading"
    LOADED = "loaded"
    ERROR = "error"
    EVICTED = "evicted"


@dataclass
class ModelRecord:
    """Minimal model metadata for ToIV registry / settings surfaces."""

    id: str
    family: str
    quant: str | None = None
    sfw: bool = True  # False ⇒ NSFW / adult-gated visibility
    path: str | None = None  # local or NAS path (string only; no secrets)
    loaded_on: list[str] = field(default_factory=list)  # node_id list
    status: ModelLoadStatus = ModelLoadStatus.UNKNOWN
    labels: dict[str, str] = field(default_factory=dict)
    # optional extras
    modality: str | None = None  # llm | diffusion | vlm | audio | other
    source: str | None = None  # doc / MODEL_SOURCES id — not a live fetch

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "family": self.family,
            "quant": self.quant,
            "sfw": self.sfw,
            "path": self.path,
            "loaded_on": list(self.loaded_on),
            "status": self.status.value if isinstance(self.status, ModelLoadStatus) else str(self.status),
            "labels": dict(self.labels),
            "modality": self.modality,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ModelRecord":
        status_raw = data.get("status", ModelLoadStatus.UNKNOWN)
        status = (
            status_raw
            if isinstance(status_raw, ModelLoadStatus)
            else ModelLoadStatus(str(status_raw))
        )
        return cls(
            id=str(data["id"]),
            family=str(data.get("family") or ""),
            quant=data.get("quant"),
            sfw=bool(data.get("sfw", True)),
            path=data.get("path"),
            loaded_on=list(data.get("loaded_on") or []),
            status=status,
            labels=dict(data.get("labels") or {}),
            modality=data.get("modality"),
            source=data.get("source"),
        )
