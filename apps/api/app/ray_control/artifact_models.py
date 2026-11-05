"""Job artifact records (scratch · Cycle 25).

Multi-output catalog for task-center thumbs / drawer / Sessions blur-preview.
No live object-store I/O — URI strings only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ArtifactKind(str, Enum):
    PRIMARY = "primary"  # main deliverable (video / image / text blob ref)
    THUMB = "thumb"  # 84×60 list thumb (R7)
    PREVIEW = "preview"  # larger drawer / Sessions blur source
    LOG = "log"  # short log / stderr ref
    SIDE = "side"  # sidecar (json meta, prompt dump, mask…)
    OTHER = "other"


class ArtifactRole(str, Enum):
    """Display preference when multiple of same kind exist."""

    DEFAULT = "default"
    ALT = "alt"
    FALLBACK = "fallback"


_KIND_ALIASES: dict[str, ArtifactKind] = {
    "primary": ArtifactKind.PRIMARY,
    "main": ArtifactKind.PRIMARY,
    "output": ArtifactKind.PRIMARY,
    "result": ArtifactKind.PRIMARY,
    "thumb": ArtifactKind.THUMB,
    "thumbnail": ArtifactKind.THUMB,
    "preview": ArtifactKind.PREVIEW,
    "blur": ArtifactKind.PREVIEW,
    "log": ArtifactKind.LOG,
    "logs": ArtifactKind.LOG,
    "side": ArtifactKind.SIDE,
    "sidecar": ArtifactKind.SIDE,
    "meta": ArtifactKind.SIDE,
    "other": ArtifactKind.OTHER,
}


def parse_artifact_kind(raw: str | None) -> ArtifactKind:
    if not raw:
        return ArtifactKind.OTHER
    key = str(raw).strip().lower()
    return _KIND_ALIASES.get(key, ArtifactKind.OTHER)


@dataclass
class ArtifactRecord:
    """One URI-backed artifact belonging to a job."""

    artifact_id: str
    job_id: str
    kind: ArtifactKind = ArtifactKind.OTHER
    uri: str = ""
    mime: str | None = None
    bytes_hint: int | None = None
    width: int | None = None
    height: int | None = None
    duration_ms: int | None = None
    role: ArtifactRole = ArtifactRole.DEFAULT
    labels: dict[str, str] = field(default_factory=dict)
    created_at_ms: int = 0
    sfw: bool = True

    def __post_init__(self) -> None:
        # ArtifactKind is str Enum — members are also str; prefer Enum check first.
        if isinstance(self.kind, ArtifactKind):
            pass
        elif isinstance(self.kind, str):
            self.kind = parse_artifact_kind(self.kind)
        else:
            self.kind = ArtifactKind.OTHER
        if isinstance(self.role, ArtifactRole):
            pass
        elif isinstance(self.role, str):
            r = str(self.role).strip().lower()
            self.role = (
                ArtifactRole(r)
                if r in {e.value for e in ArtifactRole}
                else ArtifactRole.DEFAULT
            )
        else:
            self.role = ArtifactRole.DEFAULT
        self.uri = (self.uri or "").strip()
        self.sfw = bool(self.sfw)
        try:
            self.created_at_ms = max(0, int(self.created_at_ms or 0))
        except (TypeError, ValueError):
            self.created_at_ms = 0
        if self.bytes_hint is not None:
            try:
                self.bytes_hint = max(0, int(self.bytes_hint))
            except (TypeError, ValueError):
                self.bytes_hint = None
        for attr in ("width", "height", "duration_ms"):
            val = getattr(self, attr)
            if val is not None:
                try:
                    setattr(self, attr, max(0, int(val)))
                except (TypeError, ValueError):
                    setattr(self, attr, None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "job_id": self.job_id,
            "kind": self.kind.value,
            "uri": self.uri,
            "mime": self.mime,
            "bytes_hint": self.bytes_hint,
            "width": self.width,
            "height": self.height,
            "duration_ms": self.duration_ms,
            "role": self.role.value,
            "labels": dict(self.labels),
            "created_at_ms": self.created_at_ms,
            "sfw": self.sfw,
        }


# R7 + Sessions geometry hints (FE owns CSS)
ARTIFACT_TOKEN_DEFAULTS: dict[str, Any] = {
    "thumb_w": 84,
    "thumb_h": 60,
    "drawer_preview_max_w": 640,
    "sessions_blur_w": 120,
    "sessions_blur_h": 68,
    "adult_geometry": "unchanged",
}
