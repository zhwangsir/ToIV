"""Deploy drain / studio gen-window 门禁单测(无真库、无 SSH)。"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy"))

from deploy_drain import (  # noqa: E402
    EXIT_BUSY,
    JobCount,
    BusySnapshot,
    collect_batch_drivers_from_pgrep,
    collect_jobs_and_smoke_from_db,
    evaluate_busy,
    format_busy_report,
    is_studio_gen_kind,
    main,
    parse_snapshot,
    probe_local,
    run_check,
)


def test_is_studio_gen_kind():
    assert is_studio_gen_kind("studio_batch_render")
    assert is_studio_gen_kind("studio_script_parse")
    assert is_studio_gen_kind("drama_shot_video_v2")
    assert is_studio_gen_kind("board_film")
    assert is_studio_gen_kind("video_upscale")
    assert not is_studio_gen_kind("txt2img")
    assert not is_studio_gen_kind("")


def test_evaluate_clear():
    assert evaluate_busy({"batch_drivers": [], "smoke_running": 0, "jobs": []}) == []


def test_evaluate_batch_driver():
    reasons = evaluate_busy({"batch_drivers": ["1234 python tmp/batch1_foo.py"], "smoke_running": 0, "jobs": []})
    assert any(r.code == "batch_driver" for r in reasons)


def test_evaluate_smoke_campaign():
    reasons = evaluate_busy({"smoke_running": 3, "jobs": []})
    assert any(r.code == "smoke_campaign" and "3" in r.detail for r in reasons)


def test_evaluate_studio_gen_window():
    reasons = evaluate_busy(
        {
            "jobs": [
                {"kind": "studio_batch_render", "status": "running", "count": 2},
                {"kind": "studio_script_parse", "status": "queued", "count": 1},
            ]
        }
    )
    assert any(r.code == "studio_gen_window" for r in reasons)
    assert "studio_batch_render" in format_busy_report(reasons)


def test_evaluate_other_active_jobs():
    reasons = evaluate_busy({"jobs": [{"kind": "txt2img", "status": "running", "count": 1}]})
    assert any(r.code == "active_jobs" for r in reasons)


def test_evaluate_ignores_done_status():
    assert evaluate_busy({"jobs": [{"kind": "studio_batch_render", "status": "done", "count": 9}]}) == []


def test_cli_snapshot_busy_exit_3():
    code = main(
        ["--snapshot-json", json.dumps({"smoke_running": 1}), "--dry-run"]
    )
    assert code == EXIT_BUSY


def test_cli_snapshot_clear_exit_0():
    code = main(["--snapshot-json", json.dumps({"smoke_running": 0, "jobs": []})])
    assert code == 0


def test_collect_pgrep_injectable():
    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="999 python tmp/batch2_x.py --limit 10\n",
            stderr="",
        )

    lines = collect_batch_drivers_from_pgrep(run=fake_run)
    assert len(lines) == 1
    assert "batch2_x" in lines[0]


class _FakeCursor:
    def __init__(self, rows_jobs, smoke):
        self._rows_jobs = rows_jobs
        self._smoke = smoke
        self._q = ""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self._q = sql

    def fetchall(self):
        if "FROM job" in self._q or "from job" in self._q.lower():
            return self._rows_jobs
        return []

    def fetchone(self):
        return (self._smoke,)


class _FakeConn:
    def __init__(self, rows_jobs, smoke):
        self._rows_jobs = rows_jobs
        self._smoke = smoke

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _FakeCursor(self._rows_jobs, self._smoke)


def test_collect_jobs_and_smoke_from_db_mock():
    def connect(_url):
        return _FakeConn(
            rows_jobs=[("studio_batch_render", "running", 2), ("txt2img", "queued", 1)],
            smoke=4,
        )

    jobs, smoke = collect_jobs_and_smoke_from_db(
        "postgresql+psycopg://u:p@localhost/toiv",
        connect=connect,
    )
    assert smoke == 4
    assert jobs[0].kind == "studio_batch_render"
    assert jobs[0].count == 2


def test_collect_rejects_sqlite():
    with pytest.raises(RuntimeError, match="SQLite"):
        collect_jobs_and_smoke_from_db("sqlite:///tmp.db", connect=lambda u: None)


def test_probe_local_fail_closed_on_db_error():
    def boom(_url):
        raise RuntimeError("boom")

    def fake_pgrep(*a, **k):
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

    snap = probe_local(
        pgrep_run=fake_pgrep,
        db_connect=boom,
        database_url="postgresql://u:p@localhost/db",
    )
    reasons = evaluate_busy(snap)
    assert any(r.code == "active_jobs" for r in reasons)
    assert any("fail-closed" in n or "探测失败" in n for n in snap.notes)


def test_deploy_sh_wires_drain():
    sh = (ROOT / "deploy/deploy.sh").read_text(encoding="utf-8")
    assert "deploy_drain.py" in sh
    assert "assert_api_drain" in sh or "deploy drain" in sh.lower() or "gen-window" in sh


def test_source_file_lists_studio_kinds():
    src = (ROOT / "deploy/deploy_drain.py").read_text(encoding="utf-8")
    assert "studio_batch_render" in src or "studio_" in src
    assert "smoke_status" in src or "smoke_running" in src
