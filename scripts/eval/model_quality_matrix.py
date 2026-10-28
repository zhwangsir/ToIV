#!/usr/bin/env python3
"""离线生成 NSFW/SFW 模型质量矩阵(test-results/model-quality/)。

只读取本地台账与既有本地评估/证据,不联网、不下载模型、不连 GPU/付费链、不生成媒体:
  - docs/MODEL_SOURCES.json                       模型来源台账(identity/source/license)
  - test-results/freezone-r13/wan-nsfw22-ab/      NSFW-22 HIGH/LOW 与基座的真实 A/B 烟测产物
  - test-results/continue_sfw_v23_image_smoke.json  SFW 基座(Qwen-Rapid-AIO-SFW-v23)出图烟测
  - test-results/Continue_IMAGE_SFWv23_00001_.png   同上产物

矩阵口径(硬约束,校验器 enforce):
  - 单样本烟测最高只能标 `single_sample_smoke`,不得标 verified / 生产认证;
  - 真实 GPU e2e、付费链、舰队级质量恒为 `unverified`;
  - 缺证据条目显式 `unknown`/`unverified`,离线指标为 null,不编造分数;
  - 证据路径由生成时实测存在性,不得指向不存在的文件冒充证据。

用法(可重复):
  python3 scripts/eval/model_quality_matrix.py            # 生成 matrix.json + matrix.md
  python3 scripts/eval/model_quality_matrix.py --check    # 生成并自校验,违规退出码 1
  python3 -m pytest scripts/eval/test_model_quality_matrix.py -q
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEDGER_REL = "docs/MODEL_SOURCES.json"
OUT_DIR_REL = "test-results/model-quality"
SCHEMA_VERSION = "model-quality-matrix/1"

SHA_RE = re.compile(r"sha256=([0-9a-fA-F]{64})")

# 单样本/烟测之上不允许出现的状态值(枚举封闭,便于测试卡口)
QUALITY_STATUSES = {"single_sample_smoke", "unverified"}
IDENTITY_STATUSES = {"verified_offline", "recorded_unverified", "unknown"}
LICENSE_STATUSES = {"recorded", "unknown"}
PROVENANCE_STATUSES = {"recorded", "unknown"}
ALWAYS_UNVERIFIED_FIELDS = ("real_gpu_e2e", "paid_chain")

UNVERIFIED_BOUNDARIES = [
    "real_gpu_e2e: 本轮未连 GPU/Comfy worker 重跑任何生成,矩阵不含真实 GPU 端到端验收",
    "paid_chain: 未触碰任何付费/商用链路(渲染计费、商用授权核验、线上出图)",
    "fleet_quality: 既有 A/B 为单参考单 seed 3s 烟测,不代表全场景/解剖学/舰队级质量",
    "production_certification: mock 或单样本一律不得作为生产认证;矩阵内 production_certified 恒为 false",
    "license_commercial: license 字段仅转录台账记录,不构成商用授权结论(NSFW-22 记为 internal evaluation only)",
]

# 证据键 → 仓库相对路径。生成时实测存在性;仅存在的路径可支撑 verified 类状态。
EVIDENCE_PATHS = {
    "ledger": LEDGER_REL,
    "ab_report": "test-results/freezone-r13/wan-nsfw22-ab/report.json",
    "ab_input": "test-results/freezone-r13/wan-nsfw22-ab/input.png",
    "ab_a_video": "test-results/freezone-r13/wan-nsfw22-ab/a_base.mp4",
    "ab_a_frame": "test-results/freezone-r13/wan-nsfw22-ab/a_base_frame.png",
    "ab_a_contact": "test-results/freezone-r13/wan-nsfw22-ab/a_base_contact.png",
    "ab_b_video": "test-results/freezone-r13/wan-nsfw22-ab/b_nsfw22_pair.mp4",
    "ab_b_frame": "test-results/freezone-r13/wan-nsfw22-ab/b_nsfw22_pair_frame.png",
    "ab_b_contact": "test-results/freezone-r13/wan-nsfw22-ab/b_nsfw22_pair_contact.png",
    "sfw_smoke": "test-results/continue_sfw_v23_image_smoke.json",
    "sfw_image": "test-results/Continue_IMAGE_SFWv23_00001_.png",
}

EVIDENCE_KINDS = {
    "ledger": "ledger",
    "ab_report": "ab_report",
    "ab_input": "eval_input_image",
    "ab_a_video": "eval_video",
    "ab_a_frame": "eval_frame",
    "ab_a_contact": "eval_contact_sheet",
    "ab_b_video": "eval_video",
    "ab_b_frame": "eval_frame",
    "ab_b_contact": "eval_contact_sheet",
    "sfw_smoke": "image_smoke_report",
    "sfw_image": "eval_image",
}

# 矩阵范围(策展清单):至少覆盖 NSFW-22 A/B 与 SFW 基座,并含缺证据对照条目。
# identity/source/license 一律从台账查,查不到标 unknown,不编造。
SCOPE = [
    {
        "id": "nsfw22-h-e8",
        "basename": "NSFW-22-H-e8.safetensors",
        "track": "nsfw",
        "role": "wan_i2v_high_lora_concept",
        "applicability": "NSFW 适用:Wan2.2 I2V HIGH 侧概念 LoRA,触发词 nsfwsks,评估强度 0.8;SFW 不适用",
        "evidence": ["ledger", "ab_report", "ab_input", "ab_b_video", "ab_b_frame", "ab_b_contact"],
        "ab_arm": "b_nsfw22_pair",
        "sha_evidence": "ab_report",
    },
    {
        "id": "nsfw22-l-e8",
        "basename": "NSFW-22-L-e8.safetensors",
        "track": "nsfw",
        "role": "wan_i2v_low_lora_concept",
        "applicability": "NSFW 适用:Wan2.2 I2V LOW 侧概念 LoRA,触发词 nsfwsks,评估强度 0.8;SFW 不适用",
        "evidence": ["ledger", "ab_report", "ab_input", "ab_b_video", "ab_b_frame", "ab_b_contact"],
        "ab_arm": "b_nsfw22_pair",
        "sha_evidence": "ab_report",
    },
    {
        "id": "wan22-remix-i2v-high-v30",
        "basename": "wan22RemixT2VI2V_i2vHighV30.safetensors",
        "track": "sfw",
        "role": "wan_i2v_base_high_unet",
        "applicability": "SFW/通用基座:现网 I2V 默认底模 HIGH(A/B a_base 臂与 b 臂同底模);NSFW 仅在挂载 NSFW LoRA 后",
        "evidence": ["ledger", "ab_report", "ab_input", "ab_a_video", "ab_a_frame", "ab_a_contact"],
        "ab_arm": "a_base",
    },
    {
        "id": "wan22-remix-i2v-low-v30",
        "basename": "wan22RemixT2VI2V_i2vLowV30.safetensors",
        "track": "sfw",
        "role": "wan_i2v_base_low_unet",
        "applicability": "SFW/通用基座:现网 I2V 默认底模 LOW(A/B a_base 臂与 b 臂同底模);NSFW 仅在挂载 NSFW LoRA 后",
        "evidence": ["ledger", "ab_report", "ab_input", "ab_a_video", "ab_a_frame", "ab_a_contact"],
        "ab_arm": "a_base",
    },
    {
        "id": "qwen-rapid-aio-sfw-v23",
        "basename": "Qwen-Rapid-AIO-SFW-v23.safetensors",
        "track": "sfw",
        "role": "image_gate_default_ckpt",
        "applicability": "SFW 适用:出图 gate 现网默认 checkpoint(Qwen-Image Rapid AIO SFW v23);NSFW 不适用",
        "evidence": ["ledger", "sfw_smoke", "sfw_image"],
        "smoke_evidence": True,
    },
    {
        "id": "qwen-rapid-aio-sfw-v11",
        "basename": "Qwen-Rapid-AIO-SFW-v11.safetensors",
        "track": "sfw",
        "role": "image_gate_coexist_ckpt",
        "applicability": "SFW 适用:gate v23 共存候选;无本地质量评估证据",
        "evidence": ["ledger"],
    },
    {
        "id": "nsfw22-h-e8-9-blocked",
        "basename": "NSFW-22-H-e8_9.safetensors",
        "track": "nsfw",
        "role": "nsfw_community_unresolved",
        "applicability": "NSFW 社区名(台账 blocked 近似名,非已验 NSFW-22-H-e8 本体);适用性 unknown",
        "evidence": ["ledger"],
    },
    {
        "id": "qwen-rapid-aio-nsfw-v23-0-blocked",
        "basename": "Qwen-Rapid-AIO-NSFW-v23.0.safetensors",
        "track": "nsfw",
        "role": "nsfw_community_unresolved",
        "applicability": "NSFW 社区名(台账 blocked;与已入库 Qwen-Rapid-AIO-NSFW-v23 不同 basename);适用性 unknown",
        "evidence": ["ledger"],
    },
    {
        "id": "wan22-remix-nsfw-i2v-high-v21",
        "basename": "Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v2.1.safetensors",
        "track": "nsfw",
        "role": "wan_i2v_nsfw_high_unet",
        "applicability": "NSFW 适用(台账记录的 NSFW 轨 HIGH fp8);SFW 不适用;无本地质量评估证据",
        "evidence": ["ledger"],
    },
    {
        "id": "wan22-remix-nsfw-i2v-low-v21",
        "basename": "Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v2.1.safetensors",
        "track": "nsfw",
        "role": "wan_i2v_nsfw_low_unet",
        "applicability": "NSFW 适用(台账记录的 NSFW 轨 LOW fp8);SFW 不适用;无本地质量评估证据",
        "evidence": ["ledger"],
    },
]


def _now() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def _sha_from_notes(notes: str | None) -> str | None:
    if not notes:
        return None
    found = SHA_RE.findall(notes)
    return found[0].lower() if found else None


def _file_bytes(root: Path, rel: str) -> int | None:
    path = root / rel
    return path.stat().st_size if path.is_file() else None


def _load_json(root: Path, rel: str) -> dict | None:
    path = root / rel
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _ledger_index(root: Path) -> tuple[dict | None, dict[str, dict]]:
    ledger = _load_json(root, LEDGER_REL)
    if ledger is None:
        return None, {}
    by_name: dict[str, dict] = {}
    for item in ledger.get("items", []):
        name = item.get("basename")
        if name:
            by_name[name] = item
    return ledger, by_name


def _ab_arm_metrics(report: dict | None, arm_tag: str) -> tuple[dict | None, str]:
    if not report:
        return None, "ab_report missing; no metrics"
    for arm in report.get("arms", []):
        if arm.get("tag") != arm_tag:
            continue
        probe = (arm.get("probe") or {})
        streams = probe.get("streams") or [{}]
        metrics = {
            "source": EVIDENCE_PATHS["ab_report"],
            "arm": arm_tag,
            "with_nsfw22_pair": arm.get("with_nsfw22_pair"),
            "seed": report.get("seed"),
            "prompt_id": arm.get("prompt_id"),
            "elapsed_sec": arm.get("elapsed_sec"),
            "video_bytes": arm.get("bytes"),
            "width": streams[0].get("width"),
            "height": streams[0].get("height"),
            "nb_frames": streams[0].get("nb_frames"),
            "duration_sec": (probe.get("format") or {}).get("duration"),
            "review_status": (report.get("review") or {}).get("status"),
            "timing_comparable": (report.get("review") or {}).get("timing_comparable"),
        }
        return metrics, "single-reference single-seed 3s A/B smoke; not fleet/production certification"
    return None, f"arm {arm_tag} not present in ab report"


def _smoke_metrics(root: Path, smoke: dict | None) -> tuple[dict | None, str]:
    if not smoke:
        return None, "sfw smoke report missing; no metrics"
    image_rel = EVIDENCE_PATHS["sfw_image"]
    metrics = {
        "source": EVIDENCE_PATHS["sfw_smoke"],
        "kind": smoke.get("kind"),
        "ckpt": smoke.get("ckpt"),
        "seed": smoke.get("seed"),
        "status": smoke.get("status"),
        "elapsed_sec_poll": smoke.get("elapsed_sec_poll"),
        "prompt_id": smoke.get("prompt_id"),
        "image_bytes": _file_bytes(root, image_rel),
    }
    return metrics, "single-image gate smoke (1 sample); not production certification"


def build_matrix(root: Path = ROOT) -> dict:
    root = Path(root)
    ledger, by_name = _ledger_index(root)
    ab_report = _load_json(root, EVIDENCE_PATHS["ab_report"])
    sfw_smoke = _load_json(root, EVIDENCE_PATHS["sfw_smoke"])

    evidence_index = {
        key: {"path": rel, "kind": EVIDENCE_KINDS[key], "exists": (root / rel).is_file()}
        for key, rel in EVIDENCE_PATHS.items()
    }

    entries = []
    for spec in SCOPE:
        item = by_name.get(spec["basename"])
        ledger_notes = (item or {}).get("notes")
        ledger_sha = _sha_from_notes(ledger_notes)
        report_sha = None
        if ab_report:
            report_sha = (ab_report.get("weights") or {}).get(spec["basename"])
            if isinstance(report_sha, str):
                report_sha = report_sha.lower()

        sha256 = None
        sha_source = None
        sha_crosscheck = "not_applicable"
        if report_sha and ledger_sha:
            sha256 = report_sha
            sha_source = f"{EVIDENCE_PATHS['ab_report']}#weights + ledger notes"
            sha_crosscheck = "match" if report_sha == ledger_sha else "mismatch"
        elif report_sha:
            sha256 = report_sha
            sha_source = f"{EVIDENCE_PATHS['ab_report']}#weights"
        elif ledger_sha:
            sha256 = ledger_sha
            sha_source = "ledger notes"

        evidence = []
        for key in spec["evidence"]:
            meta = evidence_index[key]
            evidence.append({"key": key, "path": meta["path"], "kind": meta["kind"], "exists": meta["exists"]})
        evidence_ok = [e for e in evidence if e["exists"]]

        non_ledger_ok = [e for e in evidence_ok if e["kind"] != "ledger"]
        metrics, metrics_note = (None, "no local quality evidence; status unknown")
        metrics_status = "none"
        sample_count = 0
        if spec.get("ab_arm") and ab_report and evidence_index["ab_report"]["exists"]:
            metrics, metrics_note = _ab_arm_metrics(ab_report, spec["ab_arm"])
            if metrics:
                metrics_status = "single_sample_smoke"
                sample_count = 1
        elif spec.get("smoke_evidence") and sfw_smoke and evidence_index["sfw_smoke"]["exists"]:
            metrics, metrics_note = _smoke_metrics(root, sfw_smoke)
            if metrics:
                metrics_status = "single_sample_smoke"
                sample_count = 1

        identity_status = "unknown"
        if sha256 and sha_crosscheck == "match":
            identity_status = "verified_offline"
        elif item is not None:
            identity_status = "recorded_unverified"

        offline_quality = "single_sample_smoke" if metrics_status == "single_sample_smoke" else "unverified"
        if offline_quality == "single_sample_smoke" and not non_ledger_ok:
            offline_quality = "unverified"
            metrics = None
            metrics_status = "none"
            metrics_note = "evidence files missing at generation time; metrics dropped rather than fabricated"
            sample_count = 0

        entry = {
            "id": spec["id"],
            "track": spec["track"],
            "role": spec["role"],
            "model_identity": {
                "basename": spec["basename"],
                "rel_path": (item or {}).get("rel_path"),
                "revision": (item or {}).get("revision"),
                "sha256": sha256,
                "sha256_source": sha_source,
                "sha256_crosscheck": sha_crosscheck,
                "identity_status": identity_status,
            },
            "source": {
                "kind": (item or {}).get("source_kind"),
                "url": (item or {}).get("source_url"),
                "repo": (item or {}).get("repo"),
                "ledger_status": (item or {}).get("status"),
                "source_status": "recorded" if item is not None else "unknown",
            },
            "license": {
                "text": (item or {}).get("license_or_gated"),
                "license_status": "recorded" if (item or {}).get("license_or_gated") else "unknown",
                "note": "transcribed from ledger only; no commercial-use conclusion drawn",
            },
            "nsfw_sfw_applicability": {
                "track": spec["track"],
                "applicability": spec["applicability"],
                "applicability_status": "declared" if item is not None else "unknown",
            },
            "offline_evidence": evidence,
            "offline_metrics": {
                "status": metrics_status,
                "sample_count": sample_count,
                "metrics": metrics,
                "metrics_note": metrics_note,
            },
            "verification": {
                "identity": identity_status,
                "source_provenance": "recorded" if item is not None else "unknown",
                "license": "recorded" if (item or {}).get("license_or_gated") else "unknown",
                "offline_quality": offline_quality,
                "real_gpu_e2e": "unverified",
                "paid_chain": "unverified",
                "production_certified": False,
                "certification_note": (
                    "single-sample smoke only — NOT production certification"
                    if offline_quality == "single_sample_smoke"
                    else "no quality evidence — unverified; do not treat as certified"
                ),
            },
            "unverified_boundaries": [
                "real_gpu_e2e",
                "paid_chain",
                "fleet_wide_quality",
                "production_certification",
            ],
        }
        entries.append(entry)

    by_track: dict[str, int] = {}
    by_quality: dict[str, int] = {}
    for entry in entries:
        by_track[entry["track"]] = by_track.get(entry["track"], 0) + 1
        q = entry["verification"]["offline_quality"]
        by_quality[q] = by_quality.get(q, 0) + 1

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _now(),
        "generator": "scripts/eval/model_quality_matrix.py",
        "inputs": {
            "model_sources_ledger": LEDGER_REL,
            "eval_evidence": [
                EVIDENCE_PATHS["ab_report"],
                EVIDENCE_PATHS["sfw_smoke"],
                EVIDENCE_PATHS["sfw_image"],
            ],
            "license_governance_record": "docs/ops/WAVE2_LICENSE_GATE_R1_20261026.md",
            "model_sources_md": None,
        },
        "disclaimer": (
            "Offline, evidence-backed matrix only. Mock or single-sample results are NEVER production "
            "certification. No GPU e2e and no paid-chain verification were performed for this artifact. "
            "Missing evidence is marked unknown/unverified; no scores are invented."
        ),
        "unverified_boundaries": UNVERIFIED_BOUNDARIES,
        "evidence_index": evidence_index,
        "counts": {
            "entries": len(entries),
            "by_track": by_track,
            "by_offline_quality": by_quality,
            "production_certified": 0,
            "gpu_verified": 0,
            "paid_chain_verified": 0,
        },
        "entries": entries,
    }


def validate_matrix(matrix: dict, root: Path = ROOT) -> list[str]:
    """返回违规列表;空列表 = 通过。生成器与测试共用同一卡口。"""
    root = Path(root)
    problems: list[str] = []
    required_top = {
        "schema_version", "generated_at", "generator", "inputs", "disclaimer",
        "unverified_boundaries", "counts", "entries",
    }
    missing_top = required_top - set(matrix)
    if missing_top:
        problems.append(f"matrix missing top-level keys: {sorted(missing_top)}")
        return problems
    if matrix["schema_version"] != SCHEMA_VERSION:
        problems.append(f"schema_version {matrix['schema_version']!r} != {SCHEMA_VERSION!r}")

    required_entry_keys = {
        "id", "track", "role", "model_identity", "source", "license",
        "nsfw_sfw_applicability", "offline_evidence", "offline_metrics", "verification",
        "unverified_boundaries",
    }
    seen_ids = set()
    for entry in matrix["entries"]:
        eid = entry.get("id", "<no-id>")
        if entry.get("id") in seen_ids:
            problems.append(f"{eid}: duplicate id")
        seen_ids.add(entry.get("id"))
        missing = required_entry_keys - set(entry)
        if missing:
            problems.append(f"{eid}: missing entry keys {sorted(missing)}")
            continue

        ver = entry["verification"]
        if ver.get("production_certified") is not False:
            problems.append(f"{eid}: production_certified must be false (single-sample/mock ≠ certification)")
        for field in ALWAYS_UNVERIFIED_FIELDS:
            if ver.get(field) != "unverified":
                problems.append(f"{eid}: {field} must stay 'unverified', got {ver.get(field)!r}")
        if ver.get("offline_quality") not in QUALITY_STATUSES:
            problems.append(f"{eid}: offline_quality {ver.get('offline_quality')!r} not in {sorted(QUALITY_STATUSES)}")
        if ver.get("identity") not in IDENTITY_STATUSES:
            problems.append(f"{eid}: identity {ver.get('identity')!r} not in {sorted(IDENTITY_STATUSES)}")
        if ver.get("license") not in LICENSE_STATUSES:
            problems.append(f"{eid}: license status {ver.get('license')!r} not in {sorted(LICENSE_STATUSES)}")
        if ver.get("source_provenance") not in PROVENANCE_STATUSES:
            problems.append(f"{eid}: source_provenance {ver.get('source_provenance')!r} not in {sorted(PROVENANCE_STATUSES)}")

        om = entry["offline_metrics"]
        if om.get("status") not in {"none", "single_sample_smoke"}:
            problems.append(f"{eid}: offline_metrics.status {om.get('status')!r} invalid")
        if om.get("status") == "none" and om.get("metrics") is not None:
            problems.append(f"{eid}: offline_metrics.status=none but metrics present (fabricated scores?)")
        if om.get("status") == "single_sample_smoke":
            if om.get("sample_count", 0) < 1:
                problems.append(f"{eid}: single_sample_smoke without sample_count>=1")
            if ver.get("offline_quality") != "single_sample_smoke":
                problems.append(f"{eid}: metrics present but offline_quality not single_sample_smoke")

        # 证据路径:必须存在;且 verified_offline 身份需要非台账证据支撑
        non_ledger_existing = 0
        for ev in entry["offline_evidence"]:
            if not isinstance(ev, dict) or "path" not in ev:
                problems.append(f"{eid}: malformed evidence item {ev!r}")
                continue
            if not ev.get("exists"):
                if ver.get("offline_quality") == "single_sample_smoke":
                    problems.append(f"{eid}: claims single_sample_smoke but evidence {ev['path']} marked missing")
                continue
            if not (root / ev["path"]).is_file():
                problems.append(f"{eid}: evidence path does not exist: {ev['path']}")
            if ev.get("kind") != "ledger":
                non_ledger_existing += 1
        if ver.get("identity") == "verified_offline":
            if not entry["model_identity"].get("sha256"):
                problems.append(f"{eid}: identity verified_offline without sha256")
            if entry["model_identity"].get("sha256_crosscheck") != "match":
                problems.append(f"{eid}: identity verified_offline without sha256 crosscheck match")
            if non_ledger_existing < 1:
                problems.append(f"{eid}: identity verified_offline without non-ledger evidence")
        if ver.get("offline_quality") == "single_sample_smoke" and non_ledger_existing < 1:
            problems.append(f"{eid}: single_sample_smoke without existing non-ledger evidence")

    if matrix["counts"].get("production_certified") != 0:
        problems.append("counts.production_certified must be 0")
    return problems


def render_markdown(matrix: dict) -> str:
    lines = [
        "# NSFW/SFW 模型质量矩阵(离线可复核)",
        "",
        f"- 生成:`{matrix['generator']}` @ {matrix['generated_at']}",
        f"- schema:`{matrix['schema_version']}`",
        f"- 台账:`{matrix['inputs']['model_sources_ledger']}`",
        "",
        "> **边界**:本矩阵只汇总本地台账与既有评估产物。单样本烟测 ≠ 生产认证;真实 GPU e2e / 付费链 / 舰队级质量均 **unverified**;缺证据标 unknown,不编造分数。",
        "",
        "## 未验边界",
        "",
    ]
    for b in matrix["unverified_boundaries"]:
        lines.append(f"- {b}")
    counts = matrix["counts"]
    lines += [
        "",
        "## 计数",
        "",
        f"- entries={counts['entries']} · by_track={json.dumps(counts['by_track'], ensure_ascii=False)} · "
        f"by_offline_quality={json.dumps(counts['by_offline_quality'], ensure_ascii=False)}",
        f"- production_certified={counts['production_certified']} · gpu_verified={counts['gpu_verified']} · "
        f"paid_chain_verified={counts['paid_chain_verified']}",
        "",
        "## 矩阵",
        "",
        "| id | track | model | source | license | identity | offline evidence | offline quality | GPU | paid | production |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for e in matrix["entries"]:
        ev_n = sum(1 for x in e["offline_evidence"] if x.get("exists"))
        v = e["verification"]
        lic = e["license"]["license_status"]
        if e["license"].get("text"):
            lic = f"{lic} (transcribed)"
        lines.append(
            f"| {e['id']} | {e['track']} | `{e['model_identity']['basename']}` "
            f"| {e['source']['source_status']} ({e['source'].get('kind') or 'n/a'}) "
            f"| {lic} | {v['identity']} | {ev_n} file(s) | {v['offline_quality']} "
            f"| {v['real_gpu_e2e']} | {v['paid_chain']} | certified={str(v['production_certified']).lower()} |"
        )
    lines += ["", "## 条目明细", ""]
    for e in matrix["entries"]:
        mi = e["model_identity"]
        om = e["offline_metrics"]
        lines += [
            f"### {e['id']}",
            "",
            f"- role/track:`{e['role']}` / {e['track']}",
            f"- identity:`{mi['basename']}` · rel_path=`{mi.get('rel_path')}` · "
            f"sha256=`{mi.get('sha256')}` ({mi.get('sha256_source') or 'none'}; crosscheck={mi['sha256_crosscheck']}) · "
            f"status={mi['identity_status']}",
            f"- source:{e['source'].get('url') or 'unknown'} (status={e['source']['source_status']}, ledger={e['source'].get('ledger_status')})",
            f"- license:{e['license'].get('text') or 'unknown'} [{e['license']['license_status']}]",
            f"- NSFW/SFW:{e['nsfw_sfw_applicability']['applicability']}",
            f"- offline metrics:{om['status']} (n={om['sample_count']}) — {om['metrics_note']}",
        ]
        if om.get("metrics"):
            lines.append(f"  - metrics:`{json.dumps(om['metrics'], ensure_ascii=False)}`")
        lines.append("- evidence:")
        for ev in e["offline_evidence"]:
            flag = "OK" if ev.get("exists") else "MISSING"
            lines.append(f"  - [{flag}] `{ev['path']}` ({ev['kind']})")
        lines.append(f"- verification:identity={e['verification']['identity']} · "
                     f"offline_quality={e['verification']['offline_quality']} · "
                     f"gpu={e['verification']['real_gpu_e2e']} · paid={e['verification']['paid_chain']} · "
                     f"production_certified=false")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--check", action="store_true", help="生成后自校验,违规退出码 1")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    out_dir = Path(args.out_dir) if args.out_dir else root / OUT_DIR_REL
    out_dir.mkdir(parents=True, exist_ok=True)

    matrix = build_matrix(root)
    problems = validate_matrix(matrix, root)
    matrix["self_check"] = {"passed": not problems, "problems": problems}

    json_path = out_dir / "matrix.json"
    md_path = out_dir / "matrix.md"
    json_path.write_text(json.dumps(matrix, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(matrix), encoding="utf-8")

    summary = {
        "json": str(json_path),
        "md": str(md_path),
        "entries": matrix["counts"]["entries"],
        "by_track": matrix["counts"]["by_track"],
        "by_offline_quality": matrix["counts"]["by_offline_quality"],
        "self_check_passed": not problems,
        "problems": problems,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if (args.check and problems) else 0


if __name__ == "__main__":
    sys.exit(main())
