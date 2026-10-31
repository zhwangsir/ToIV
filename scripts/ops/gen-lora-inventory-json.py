#!/usr/bin/env python3
"""Generate vendor/canvas/web/src/generated/lora-inventory.json from purpose/source CSVs.

Rules (settings inventory):
  available + purpose P-A/P-B + source A/B
  hide quarantined / purpose P-C / source C|D / non_lora_running
"""
from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PURPOSE = ROOT / "docs/ops/MODEL_PURPOSE_FROM_CARDS_20261025.csv"
SOURCE = ROOT / "docs/ops/MODEL_SOURCE_PURPOSE_LORA_20261025.csv"
OUT = ROOT / "vendor/canvas/web/src/generated/lora-inventory.json"

TYPE_BY_CLUSTER = {
    "accel_distill": "加速",
    "accel_generic": "加速",
    "camera_pose": "运镜",
    "edit_control": "编辑",
    "flux_family": "画风",
    "h3_family": "H3",
    "identity": "角色",
    "longcat": "运动",
    "ltx_family": "LTX",
    "nsfw_action": "NSFW",
    "opaque": "其它",
    "qwen_img": "出图",
    "slider_style": "画风",
    "wan_family": "Wan",
}


def type_tag(cluster: str) -> str:
    if cluster.startswith("catalog:"):
        return "策划卡"
    if cluster.startswith("theme_path:"):
        return "题材"
    return TYPE_BY_CLUSTER.get(cluster, "其它")


def slots_for(path_root: str, cluster: str) -> list[str]:
    """Heuristic slot affinity for settings LoRA hangers."""
    pr = path_root.lower()
    c = cluster.lower()
    slots: set[str] = set()

    if "h3" in pr or "h3" in c or c.startswith("catalog:h3"):
        slots.add("video-primary")

    if any(x in c for x in ("flux", "qwen_img", "slider", "identity")):
        slots.add("image")

    if any(
        x in c
        for x in (
            "wan",
            "ltx",
            "longcat",
            "camera",
            "theme_path",
            "accel",
            "nsfw",
            "edit",
            "catalog:wan",
            "catalog:ltx",
        )
    ):
        slots.add("video-motion")

    # NAS 主库 toiv/loras：出图引擎常无结构化列表，设置页用主库浏览
    if "toiv/loras" in pr and "h3" not in pr:
        slots.add("image")
        slots.add("video-motion")

    if "windows" in pr:
        slots.add("image")
        if "h3" not in pr:
            slots.add("video-motion")

    if not slots:
        if "h3" in pr:
            slots.add("video-primary")
        else:
            slots.update(["image", "video-motion"])

    return sorted(slots)


def main() -> None:
    with PURPOSE.open(newline="", encoding="utf-8") as f:
        purpose_rows = list(csv.DictReader(f))
    with SOURCE.open(newline="", encoding="utf-8") as f:
        source_rows = list(csv.DictReader(f))

    url_by = {r["basename"]: (r.get("url") or "").strip() for r in source_rows}
    for r in purpose_rows:
        u = (r.get("source_url") or "").strip()
        if u:
            url_by[r["basename"]] = u

    items = []
    skipped = Counter()
    for r in purpose_rows:
        if r["availability"] != "available":
            skipped["quarantined_or_unavailable"] += 1
            continue
        if r["purpose_evidence"] not in ("P-A", "P-B"):
            skipped["purpose_not_ab"] += 1
            continue
        if r["source_evidence"] not in ("A", "B"):
            skipped["source_not_ab"] += 1
            continue
        if r["cluster"] == "non_lora_running" or r["path_root"] == "service/product":
            skipped["non_lora"] += 1
            continue

        basename = r["basename"]
        purpose_zh = (r["purpose_zh"] or "").strip()
        items.append(
            {
                "id": basename,
                "label": basename.replace(".safetensors", "").replace(".pt", ""),
                "purposeZh": purpose_zh,
                "purposeGrade": r["purpose_evidence"],
                "sourceGrade": r["source_evidence"],
                "typeTag": type_tag(r["cluster"]),
                "cluster": r["cluster"],
                "pathRoot": r["path_root"],
                "sourceUrl": url_by.get(basename, ""),
                "slots": slots_for(r["path_root"], r["cluster"]),
                "nsfw": (
                    "nsfw" in r["cluster"].lower()
                    or "nsfw" in purpose_zh.lower()
                    or "r18" in purpose_zh.lower()
                ),
            }
        )

    items.sort(key=lambda x: (0 if x["purposeGrade"] == "P-A" else 1, x["typeTag"], x["label"].lower()))

    payload = {
        "generatedAt": "2026-10-25",
        "source": "docs/ops/MODEL_PURPOSE_FROM_CARDS_20261025.csv + MODEL_SOURCE_PURPOSE_LORA_20261025.csv",
        "rules": "available + purpose P-A/P-B + source A/B; hide quarantined/C/D/non_lora",
        "count": len(items),
        "skipped": dict(skipped),
        "items": items,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    slot_c: Counter[str] = Counter()
    for i in items:
        for s in i["slots"]:
            slot_c[s] += 1
    print(f"wrote {OUT} count={len(items)} bytes={OUT.stat().st_size}")
    print("skipped", dict(skipped))
    print("slots", dict(slot_c))


if __name__ == "__main__":
    main()
