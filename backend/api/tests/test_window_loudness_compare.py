"""成片验收：2 秒窗响度对比（父代理 16:22）。"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from app.services.studio.ffmpeg_ops import compare_window_loudness


def _fake_volumedetect(cmd, **kwargs):
    # parse -ss
    ss = 0.0
    if "-ss" in cmd:
        ss = float(cmd[cmd.index("-ss") + 1])
    # fabricate: old quieter by path marker
    path = cmd[cmd.index("-i") + 1]
    base = -30.0 + (ss * 0.1)
    if "new" in Path(path).name:
        mean = base  # same as old within 4dB
    else:
        mean = base
    class P:
        returncode = 0
        stderr = f"mean_volume: {mean:.1f} dB\nmax_volume: -10.0 dB\n"
        stdout = ""
    return P()


def test_compare_window_loudness_pass(tmp_path):
    old = tmp_path / "old.mp4"
    new = tmp_path / "new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    with patch("app.services.studio.ffmpeg_ops.subprocess.run", side_effect=_fake_volumedetect):
        r = compare_window_loudness(old, new, starts=[0, 2, 4], max_abs_diff_db=4.0)
    assert r["ok"] is True
    assert len(r["windows"]) == 3
    assert all(w["pass"] for w in r["windows"])


def test_compare_window_loudness_fail(tmp_path):
    old = tmp_path / "old.mp4"
    new = tmp_path / "new_loud.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"x")

    def fake(cmd, **kwargs):
        path = cmd[cmd.index("-i") + 1]
        mean = -20.0 if "new" in Path(path).name else -40.0
        class P:
            returncode = 0
            stderr = f"mean_volume: {mean:.1f} dB\n"
            stdout = ""
        return P()

    with patch("app.services.studio.ffmpeg_ops.subprocess.run", side_effect=fake):
        r = compare_window_loudness(old, new, starts=[0, 2], max_abs_diff_db=4.0)
    assert r["ok"] is False
    assert abs(r["windows"][0]["diff"]) == 20.0
