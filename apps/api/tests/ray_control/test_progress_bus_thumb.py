"""Cycle 27: ProgressBus thumb_uri / preview_uri projection."""

from __future__ import annotations

from datetime import datetime, timezone

from app.ray_control.actors.job_router import JobRouter
from app.ray_control.progress_bus import JobEvent, ProgressBus, project_rail_row, project_toast
from app.ray_control.types import JobKind, JobSpec


def test_thumb_survives_progress_ticks():
    bus = ProgressBus(coalesce_ms=0.0)
    t0 = datetime(2026, 11, 5, 5, 20, 0, tzinfo=timezone.utc)
    bus.apply(
        JobEvent.updated(
            "j1",
            state="running",
            progress=0.1,
            thumb_uri="thumb://early",
            seq=1,
            updated_at=t0,
        )
    )
    # progress tick without thumb must not wipe
    p2 = bus.apply(
        JobEvent.updated(
            "j1",
            state="running",
            progress=0.5,
            seq=2,
            updated_at=t0,
        )
    )
    assert p2 is not None
    assert p2.thumb_uri == "thumb://early"
    assert p2.display_thumb_uri == "thumb://early"


def test_display_thumb_falls_back_to_result():
    bus = ProgressBus()
    p = bus.apply(
        JobEvent.updated(
            "j2",
            state="succeeded",
            progress=1.0,
            result_uri="result://out",
            seq=1,
        )
    )
    assert p is not None
    assert p.thumb_uri is None
    assert p.display_thumb_uri == "result://out"
    row = project_rail_row(p)
    assert row["display_thumb_uri"] == "result://out"
    assert row["tokens"]["side_w"] == 320


def test_explicit_thumb_overrides_result_display():
    bus = ProgressBus()
    p = bus.apply(
        JobEvent.updated(
            "j3",
            state="succeeded",
            progress=1.0,
            result_uri="result://big",
            thumb_uri="thumb://small",
            preview_uri="preview://mid",
            seq=1,
        )
    )
    assert p is not None
    assert p.display_thumb_uri == "thumb://small"
    assert p.preview_uri == "preview://mid"


def test_router_publishes_thumb_from_payload_and_catalog():
    router = JobRouter()
    router.submit(
        JobSpec(
            job_id="rt1",
            kind=JobKind.ECHO,
            priority=2,
            payload={"thumb_uri": "thumb://queued", "message": "hi"},
            labels={"shot_id": "SHOT01"},
        )
    )
    queued = router.bus.jobs_by_id["rt1"]  # type: ignore[union-attr]
    assert queued.thumb_uri == "thumb://queued"
    assert project_toast(router.bus) is not None  # type: ignore[arg-type]

    job = router.tick()
    assert job is not None and job.state.value == "succeeded"
    proj = router.bus.jobs_by_id["rt1"]  # type: ignore[union-attr]
    # payload thumb kept; result also set by echo
    assert proj.thumb_uri == "thumb://queued"
    assert proj.result_uri  # echo://…
    assert proj.display_thumb_uri == "thumb://queued"
    # catalog auto-attach seeded
    assert router.catalog is not None
    assert router.catalog.primary("rt1") is not None
    toast = project_toast(router.bus)  # type: ignore[arg-type]
    assert toast is not None
    assert toast["display_thumb_uri"] == "thumb://queued"
    assert toast["shot_id"] == "SHOT01"


def test_router_catalog_thumb_when_payload_omits():
    router = JobRouter()
    router.submit(
        JobSpec(
            job_id="rt2",
            kind=JobKind.ECHO,
            priority=1,
            payload={"message": "no-thumb"},
        )
    )
    job = router.tick()
    assert job is not None and job.result_uri
    proj = router.bus.jobs_by_id["rt2"]  # type: ignore[union-attr]
    # no explicit thumb → display falls back to result; catalog may seed thumb from payload only
    assert proj.display_thumb_uri == proj.result_uri
