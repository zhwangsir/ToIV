"""P-2 BUILD_ID 门禁单测(无网络/无真实 .next)。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_id_gate import (  # noqa: E402
    BuildIdGateError,
    assert_build_id_clean,
    assert_build_id_matches_head,
    main,
    parse_build_id,
)


def test_parse_clean_sha():
    p = parse_build_id("20261020-031200-abc1234")
    assert p.stamp == "20261020-031200"
    assert p.head == "abc1234"
    assert p.dirty is False


def test_parse_dirty_suffix():
    p = parse_build_id("20261017-062022-44043682-dirty")
    assert p.head == "44043682"
    assert p.dirty is True


def test_parse_nogit():
    p = parse_build_id("20260923-101036-nogit")
    assert p.head == "nogit"
    assert p.dirty is False


def test_parse_rejects_empty_and_garbage():
    with pytest.raises(BuildIdGateError):
        parse_build_id("")
    with pytest.raises(BuildIdGateError):
        parse_build_id("not-a-build-id")
    with pytest.raises(BuildIdGateError):
        parse_build_id("20261020-abc-dirty")  # 缺时间段


def test_assert_clean_accepts_clean_rejects_dirty():
    assert assert_build_id_clean("20261020-031200-deadbee").dirty is False
    with pytest.raises(BuildIdGateError, match="-dirty"):
        assert_build_id_clean("20261020-031200-deadbee-dirty")


def test_assert_matches_head():
    assert_build_id_matches_head("20261020-031200-abc1234", "abc1234")
    with pytest.raises(BuildIdGateError, match="不一致"):
        assert_build_id_matches_head("20261020-031200-abc1234", "ffffff")
    # dirty 优先于 sha 检查
    with pytest.raises(BuildIdGateError, match="-dirty"):
        assert_build_id_matches_head("20261020-031200-abc1234-dirty", "abc1234")
    # nogit:只过 dirty 闸
    assert_build_id_matches_head("20261020-031200-nogit", "abc1234")


def test_cli_rejects_dirty_exit_1():
    code = main(["--id", "20261020-031200-abc1234-dirty"])
    assert code == 1


def test_cli_accepts_clean_exit_0():
    code = main(["--id", "20261020-031200-abc1234"])
    assert code == 0


def test_cli_file_and_require_head(tmp_path: Path):
    f = tmp_path / "BUILD_ID"
    head = subprocess.check_output(
        ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True
    ).strip()
    f.write_text(f"20261020-120000-{head}\n", encoding="utf-8")
    assert main(["--file", str(f), "--require-head", "--repo", str(ROOT)]) == 0
    f.write_text(f"20261020-120000-{head}-dirty\n", encoding="utf-8")
    assert main(["--file", str(f), "--require-head", "--repo", str(ROOT)]) == 1


def test_source_contract_next_config_appends_dirty():
    """防回归:next.config 仍用 git status 追加 -dirty(门禁才有意义)。"""
    cfg = (ROOT / "apps/web/next.config.mjs").read_text(encoding="utf-8")
    assert "-dirty" in cfg
    assert "git status --porcelain" in cfg
    assert "generateBuildId" in cfg


def test_deploy_sh_invokes_gate():
    """防回归:deploy.sh 推 web 前调用 build_id_gate(拒 dirty)。"""
    sh = (ROOT / "deploy/deploy.sh").read_text(encoding="utf-8")
    assert "build_id_gate.py" in sh
    assert "ALLOW_DIRTY_WEB" not in sh or "无 ALLOW_DIRTY" in sh
