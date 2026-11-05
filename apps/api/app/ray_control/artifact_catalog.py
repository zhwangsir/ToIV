"""In-memory JobArtifact catalog (scratch · Cycle 25–26).

Attaches multi-output URIs to jobs; projects list-row thumb + drawer gallery.
Flag-aware payload helper lives in routes_jobs extension.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .artifact_models import (
    ARTIFACT_TOKEN_DEFAULTS,
    ArtifactKind,
    ArtifactRecord,
    ArtifactRole,
    parse_artifact_kind,
)
from .types import Job


@dataclass
class JobArtifactCatalog:
    """Per-job multi-artifact store. Scratch only — no Redis/S3."""

    _by_job: dict[str, list[ArtifactRecord]] = field(default_factory=dict, init=False)
    _by_id: dict[str, ArtifactRecord] = field(default_factory=dict, init=False)

    def clear(self) -> None:
        self._by_job.clear()
        self._by_id.clear()

    def attach(self, record: ArtifactRecord) -> ArtifactRecord:
        if not record.artifact_id or not record.job_id:
            raise ValueError("artifact_id and job_id required")
        if not record.uri:
            raise ValueError("uri required")
        existing = self._by_id.get(record.artifact_id)
        if existing is not None and existing.job_id != record.job_id:
            raise ValueError("artifact_id already bound to another job")
        bucket = self._by_job.setdefault(record.job_id, [])
        if existing is not None:
            bucket[:] = [a for a in bucket if a.artifact_id != record.artifact_id]
        bucket.append(record)
        self._by_id[record.artifact_id] = record
        return record

    def attach_many(self, records: Iterable[ArtifactRecord]) -> list[ArtifactRecord]:
        return [self.attach(r) for r in records]

    def detach(self, artifact_id: str) -> bool:
        rec = self._by_id.pop(artifact_id, None)
        if rec is None:
            return False
        bucket = self._by_job.get(rec.job_id) or []
        self._by_job[rec.job_id] = [a for a in bucket if a.artifact_id != artifact_id]
        if not self._by_job[rec.job_id]:
            self._by_job.pop(rec.job_id, None)
        return True

    def list_for_job(
        self,
        job_id: str,
        *,
        kind: ArtifactKind | str | None = None,
        sfw_only: bool = False,
    ) -> list[ArtifactRecord]:
        items = list(self._by_job.get(job_id) or [])
        if kind is not None:
            k = kind if isinstance(kind, ArtifactKind) else parse_artifact_kind(str(kind))
            items = [a for a in items if a.kind == k]
        if sfw_only:
            items = [a for a in items if a.sfw]
        items.sort(key=lambda a: (a.kind.value, a.role.value, a.created_at_ms, a.artifact_id))
        return items

    def get(self, artifact_id: str) -> ArtifactRecord | None:
        return self._by_id.get(artifact_id)

    def primary(self, job_id: str) -> ArtifactRecord | None:
        items = self.list_for_job(job_id, kind=ArtifactKind.PRIMARY)
        if items:
            return _prefer_default(items)
        # fall back: any non-log/side artifact
        all_items = [
            a
            for a in self.list_for_job(job_id)
            if a.kind not in (ArtifactKind.LOG, ArtifactKind.SIDE)
        ]
        return _prefer_default(all_items) if all_items else None

    def thumb(self, job_id: str) -> ArtifactRecord | None:
        items = self.list_for_job(job_id, kind=ArtifactKind.THUMB)
        if items:
            return _prefer_default(items)
        # preview then primary
        for k in (ArtifactKind.PREVIEW, ArtifactKind.PRIMARY):
            items = self.list_for_job(job_id, kind=k)
            if items:
                return _prefer_default(items)
        return None

    def preview(self, job_id: str) -> ArtifactRecord | None:
        items = self.list_for_job(job_id, kind=ArtifactKind.PREVIEW)
        if items:
            return _prefer_default(items)
        return self.primary(job_id)

    def seed_from_job(self, job: Job, *, clock_ms: int = 0) -> list[ArtifactRecord]:
        """Derive minimal catalog from Job.result_uri / payload thumb/preview when empty."""
        existing = self.list_for_job(job.id)
        if existing:
            return existing
        out: list[ArtifactRecord] = []
        if job.result_uri:
            out.append(
                ArtifactRecord(
                    artifact_id=f"{job.id}:primary",
                    job_id=job.id,
                    kind=ArtifactKind.PRIMARY,
                    uri=job.result_uri,
                    role=ArtifactRole.DEFAULT,
                    created_at_ms=clock_ms,
                    labels={"source": "result_uri"},
                )
            )
        payload = job.payload if isinstance(job.payload, dict) else {}
        thumb = payload.get("thumb_uri")
        if thumb and str(thumb) != (job.result_uri or ""):
            out.append(
                ArtifactRecord(
                    artifact_id=f"{job.id}:thumb",
                    job_id=job.id,
                    kind=ArtifactKind.THUMB,
                    uri=str(thumb),
                    role=ArtifactRole.DEFAULT,
                    created_at_ms=clock_ms,
                    labels={"source": "payload.thumb_uri"},
                )
            )
        preview = payload.get("preview_uri")
        if preview and str(preview) not in {(job.result_uri or ""), str(thumb or "")}:
            out.append(
                ArtifactRecord(
                    artifact_id=f"{job.id}:preview",
                    job_id=job.id,
                    kind=ArtifactKind.PREVIEW,
                    uri=str(preview),
                    role=ArtifactRole.DEFAULT,
                    created_at_ms=clock_ms,
                    labels={"source": "payload.preview_uri"},
                )
            )
        return self.attach_many(out) if out else []

    def auto_attach_terminal(self, job: Job, *, clock_ms: int = 0) -> list[ArtifactRecord]:
        """JobRouter hook: attach on SUCCEEDED / FAILED; no-op for other states.

        Succeeded → seed_from_job + optional payload.artifacts[] / log_uri / side_uri.
        Failed → attach kind=log (payload.log_uri or synthetic log://job/{id}).
        Idempotent: skips ids already present; seed no-ops when catalog non-empty.
        """
        from .types import JobStatus  # local import keeps module light for routes

        status = job.state
        if status is JobStatus.SUCCEEDED:
            attached = list(self.seed_from_job(job, clock_ms=clock_ms))
            payload = job.payload if isinstance(job.payload, dict) else {}
            # Explicit multi-artifact list from adapters (uri + optional kind)
            extra = payload.get("artifacts")
            if isinstance(extra, list):
                for i, item in enumerate(extra):
                    if not isinstance(item, dict):
                        continue
                    uri = item.get("uri") or item.get("url")
                    if not uri:
                        continue
                    aid = str(item.get("artifact_id") or f"{job.id}:extra:{i}")
                    if self.get(aid) is not None:
                        continue
                    kind = parse_artifact_kind(str(item.get("kind") or "side"))
                    attached.append(
                        self.attach(
                            ArtifactRecord(
                                artifact_id=aid,
                                job_id=job.id,
                                kind=kind,
                                uri=str(uri),
                                role=ArtifactRole.ALT if kind is ArtifactKind.SIDE else ArtifactRole.DEFAULT,
                                mime=item.get("mime"),
                                created_at_ms=clock_ms,
                                labels={"source": "payload.artifacts"},
                                sfw=bool(item.get("sfw", True)),
                            )
                        )
                    )
            for key, kind, suffix in (
                ("log_uri", ArtifactKind.LOG, "log"),
                ("side_uri", ArtifactKind.SIDE, "side"),
            ):
                uri = payload.get(key)
                if not uri:
                    continue
                aid = f"{job.id}:{suffix}"
                if self.get(aid) is not None:
                    continue
                attached.append(
                    self.attach(
                        ArtifactRecord(
                            artifact_id=aid,
                            job_id=job.id,
                            kind=kind,
                            uri=str(uri),
                            role=ArtifactRole.DEFAULT,
                            created_at_ms=clock_ms,
                            labels={"source": f"payload.{key}"},
                        )
                    )
                )
            return attached

        if status is JobStatus.FAILED:
            payload = job.payload if isinstance(job.payload, dict) else {}
            log_uri = payload.get("log_uri") or f"log://job/{job.id}"
            aid = f"{job.id}:log"
            existing = self.get(aid)
            if existing is not None:
                return [existing]
            err = (job.error or "")[:200]
            rec = ArtifactRecord(
                artifact_id=aid,
                job_id=job.id,
                kind=ArtifactKind.LOG,
                uri=str(log_uri),
                role=ArtifactRole.DEFAULT,
                created_at_ms=clock_ms,
                labels={
                    "source": "auto_attach_failed",
                    "error": err,
                },
            )
            return [self.attach(rec)]

        return []


def _prefer_default(items: list[ArtifactRecord]) -> ArtifactRecord:
    for a in items:
        if a.role == ArtifactRole.DEFAULT:
            return a
    return items[0]


def project_artifact(rec: ArtifactRecord) -> dict[str, Any]:
    return rec.to_dict()


def project_job_artifacts(
    catalog: JobArtifactCatalog,
    job_id: str,
    *,
    sfw_only: bool = False,
) -> dict[str, Any]:
    items = catalog.list_for_job(job_id, sfw_only=sfw_only)
    primary = catalog.primary(job_id)
    thumb = catalog.thumb(job_id)
    preview = catalog.preview(job_id)
    if sfw_only:
        if primary is not None and not primary.sfw:
            primary = None
        if thumb is not None and not thumb.sfw:
            thumb = None
        if preview is not None and not preview.sfw:
            preview = None
    return {
        "job_id": job_id,
        "count": len(items),
        "artifacts": [project_artifact(a) for a in items],
        "primary_uri": primary.uri if primary else None,
        "thumb_uri": thumb.uri if thumb else None,
        "preview_uri": preview.uri if preview else None,
        "kinds": sorted({a.kind.value for a in items}),
        "tokens": dict(ARTIFACT_TOKEN_DEFAULTS),
    }


# Module-level default for routes / tests
_DEFAULT = JobArtifactCatalog()


def get_catalog() -> JobArtifactCatalog:
    return _DEFAULT


def reset_catalog() -> JobArtifactCatalog:
    _DEFAULT.clear()
    return _DEFAULT
