"""FU2 编排层:EDL→ASR→packed→渲染→自评→下钻图 全链(真 ffmpeg,ASR 打桩)。"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_admin, get_current_user
from app.main import app
from app.models import User
from app.services import edit_job
from app.services.edit_edl import Edl, EdlRange

WORDS = [{"start": 0.2, "end": 0.6, "text": "甲"}, {"start": 1.2, "end": 1.6, "text": "乙"}]


def _mkclip(p: Path, dur: float = 2.0) -> Path:
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc2=size=320x240:rate=24:duration={dur}",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
         "-af", "volume=0.5", "-c:v", "libx264", "-preset", "ultrafast",
         "-c:a", "aac", "-shortest", str(p)],
        check=True, capture_output=True)
    return p


@pytest.fixture()
def env(tmp_path, monkeypatch):
    a = _mkclip(tmp_path / "a.mp4")
    b = _mkclip(tmp_path / "b.mp4")
    monkeypatch.setattr(edit_job, "drama_output_root", lambda: tmp_path / "out")

    async def _fake_transcribe(path, s0, s1, fb):
        return [dict(w) for w in WORDS], "stub"

    async def _fake_dur(path):
        return 2.0

    import app.services.board_film as bf
    monkeypatch.setattr(bf, "_transcribe_words", _fake_transcribe)
    monkeypatch.setattr(bf, "_probe_duration", _fake_dur)
    return a, b


def _edl(a: Path, b: Path) -> Edl:
    return Edl(sources={"a": str(a), "b": str(b)}, ranges=[
        EdlRange(source="a", start=0.8, end=1.0, beat="b1", quote="甲", reason="t"),
        EdlRange(source="b", start=1.8, end=2.0, beat="b2"),
    ])


async def test_run_edit_job_full_chain(env, tmp_path):
    a, b = env
    rec = {}
    import app.services.edit_job as ej
    ej._JOBS["j1"] = rec
    await ej.run_edit_job("j1", _edl(a, b))
    assert rec["status"] == "done", rec
    wd = tmp_path / "out" / "edit" / "j1"
    assert (wd / rec["out"]).exists()
    assert (wd / "timeline_view.png").stat().st_size > 0
    md = (wd / "takes_packed.md").read_text(encoding="utf-8")
    assert "## a" in md and "甲" in md
    assert rec["qa"]["loudness_i"] is not None or rec["qa"]["mean_db"] is not None
    assert rec["rounds"] == 1  # 自检一次过,不重渲


async def test_run_edit_job_refuses_midword(env):
    a, b = env
    import app.services.edit_job as ej
    ej._JOBS["j2"] = {}
    bad = Edl(sources={"a": str(a)}, ranges=[EdlRange(source="a", start=0.3, end=1.0)])
    await ej.run_edit_job("j2", bad)
    assert ej._JOBS["j2"]["status"] == "error"
    assert "校验不过" in ej._JOBS["j2"]["error"]


def test_routes_single_flight_and_traversal(env, monkeypatch):
    client = TestClient(app)
    admin = User(id="u1", email="a@a.com", hashed_password="x", role="admin", tenant_id="t")
    app.dependency_overrides[get_current_admin] = lambda: admin
    app.dependency_overrides[get_current_user] = lambda: admin
    try:
        monkeypatch.setattr(edit_job, "_RUNNING", True)
        a, b = env
        r = client.post("/api/admin/edit/jobs",
                        json={"edl": {"sources": {"a": str(a)},
                                      "ranges": [{"source": "a", "start": 0.8, "end": 1.0}]}})
        assert r.status_code == 409
        assert client.get("/api/admin/edit/jobs/nope").status_code == 404
        assert client.get("/api/edit/files/j1/..%2F..%2Fetc").status_code == 404
        assert client.get("/api/edit/files/j1/takes_packed.md").status_code == 404  # 无此作业
    finally:
        app.dependency_overrides.clear()
