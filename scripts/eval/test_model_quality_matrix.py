"""scripts/eval/model_quality_matrix.py 的最小卡口测试(离线)。

校验:① schema 完整与枚举封闭;② 证据路径真实存在;③ 未验项(GPU/付费链/生产认证/
单样本)绝不标 verified;④ 缺证据条目不编造分数;⑤ NSFW-22 A/B 与 SFW 基座条目在列。

运行:python3 -m pytest scripts/eval/test_model_quality_matrix.py -q
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_MODULE_PATH = ROOT / "scripts" / "eval" / "model_quality_matrix.py"

_spec = importlib.util.spec_from_file_location("model_quality_matrix", _MODULE_PATH)
mqm = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("model_quality_matrix", mqm)
_spec.loader.exec_module(mqm)


@pytest.fixture(scope="module")
def matrix() -> dict:
    return mqm.build_matrix(ROOT)


def test_schema_top_level_and_counts(matrix: dict) -> None:
    assert matrix["schema_version"] == mqm.SCHEMA_VERSION
    assert matrix["counts"]["entries"] == len(matrix["entries"]) >= 6
    assert matrix["counts"]["production_certified"] == 0
    assert matrix["counts"]["gpu_verified"] == 0
    assert matrix["counts"]["paid_chain_verified"] == 0
    assert any("GPU" in b or "gpu" in b for b in matrix["unverified_boundaries"])


def test_entry_schema_enums(matrix: dict) -> None:
    for entry in matrix["entries"]:
        ver = entry["verification"]
        assert ver["production_certified"] is False, entry["id"]
        assert ver["real_gpu_e2e"] == "unverified", entry["id"]
        assert ver["paid_chain"] == "unverified", entry["id"]
        assert ver["offline_quality"] in mqm.QUALITY_STATUSES, entry["id"]
        assert ver["identity"] in mqm.IDENTITY_STATUSES, entry["id"]
        assert ver["license"] in mqm.LICENSE_STATUSES, entry["id"]
        assert entry["track"] in {"nsfw", "sfw"}, entry["id"]
        for key in ("model_identity", "source", "license", "nsfw_sfw_applicability", "offline_evidence", "offline_metrics"):
            assert key in entry, entry["id"]


def test_evidence_paths_exist(matrix: dict) -> None:
    for entry in matrix["entries"]:
        assert entry["offline_evidence"], entry["id"]
        for ev in entry["offline_evidence"]:
            assert (ROOT / ev["path"]).is_file(), f"{entry['id']}: missing evidence {ev['path']}"
            if ev["exists"]:
                assert ev["kind"], entry["id"]


def test_unverified_never_marked_verified(matrix: dict) -> None:
    for entry in matrix["entries"]:
        ver = entry["verification"]
        for field in mqm.ALWAYS_UNVERIFIED_FIELDS:
            assert ver[field] != "verified", f"{entry['id']}.{field} must not be verified"
        assert ver["offline_quality"] != "verified", entry["id"]
        if entry["offline_metrics"]["status"] == "single_sample_smoke":
            assert entry["offline_metrics"]["sample_count"] <= 2, "单样本/烟测不得升级为批量认证"
            assert "NOT production certification" in ver["certification_note"], entry["id"]


def test_missing_evidence_entries_have_no_fabricated_scores(matrix: dict) -> None:
    ledger_only = [
        e for e in matrix["entries"]
        if all(ev["kind"] == "ledger" for ev in e["offline_evidence"])
    ]
    assert ledger_only, "应含缺证据对照条目"
    for entry in ledger_only:
        om = entry["offline_metrics"]
        assert om["status"] == "none", entry["id"]
        assert om["metrics"] is None, f"{entry['id']}: 缺证据不得有指标"
        assert entry["verification"]["offline_quality"] == "unverified", entry["id"]
        assert entry["verification"]["identity"] in {"unknown", "recorded_unverified"}, entry["id"]


def test_required_nsfw22_and_sfw_base_entries(matrix: dict) -> None:
    by_id = {e["id"]: e for e in matrix["entries"]}
    for required in ("nsfw22-h-e8", "nsfw22-l-e8", "wan22-remix-i2v-high-v30", "wan22-remix-i2v-low-v30", "qwen-rapid-aio-sfw-v23"):
        assert required in by_id, f"缺少必选条目 {required}"
    assert by_id["nsfw22-h-e8"]["track"] == "nsfw"
    assert by_id["nsfw22-l-e8"]["track"] == "nsfw"
    assert by_id["qwen-rapid-aio-sfw-v23"]["track"] == "sfw"
    # NSFW-22 对必须有 sha256 且本地双源交叉一致(报告 weights ↔ 台账 notes)
    for rid in ("nsfw22-h-e8", "nsfw22-l-e8"):
        mi = by_id[rid]["model_identity"]
        assert mi["sha256"], rid
        assert mi["sha256_crosscheck"] == "match", rid
        assert mi["identity_status"] == "verified_offline", rid


def test_validate_matrix_clean_and_flags_forgeries(matrix: dict) -> None:
    assert mqm.validate_matrix(matrix, ROOT) == []

    forged = json.loads(json.dumps(matrix))
    victim = forged["entries"][0]
    victim["verification"]["production_certified"] = True
    victim["verification"]["real_gpu_e2e"] = "verified"
    forged["counts"]["production_certified"] = 1
    problems = mqm.validate_matrix(forged, ROOT)
    assert any("production_certified" in p for p in problems)
    assert any("real_gpu_e2e" in p for p in problems)

    fabricated = json.loads(json.dumps(matrix))
    victim = fabricated["entries"][-1]
    victim["offline_metrics"]["status"] = "none"
    victim["offline_metrics"]["metrics"] = {"fake_score": 0.99}
    problems = mqm.validate_matrix(fabricated, ROOT)
    assert any("fabricated" in p for p in problems)

    ghost = json.loads(json.dumps(matrix))
    ghost["entries"][0]["offline_evidence"].append(
        {"key": "ghost", "path": "test-results/model-quality/does-not-exist.json", "kind": "ab_report", "exists": True}
    )
    problems = mqm.validate_matrix(ghost, ROOT)
    assert any("does not exist" in p for p in problems)


def test_markdown_render_reflects_matrix(matrix: dict) -> None:
    md = mqm.render_markdown(matrix)
    assert "production certification" in md or "生产认证" in md
    for entry in matrix["entries"]:
        assert entry["id"] in md
        assert entry["model_identity"]["basename"] in md
    nsfw_h = next(e for e in matrix["entries"] if e["id"] == "nsfw22-h-e8")
    assert nsfw_h["source"]["url"] in md
    assert "certified=false" in md
