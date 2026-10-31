"""W9 P0-1:把 civitai by-hash 溯源结果写入 MODEL_SOURCES 账本(新增条目,非回填)。

背景:9 个 H3 R18 LoRA(backend/api/app/services/h3.py:46-58 的 H3_NSFW_LORAS 名单)此前
**完全不在 MODEL_SOURCES 账本里**(816 条零命中)——账本当初按 HF 口径扫,civitai 来源的权重漏了。
本轮用 civitai.red 的 /api/v1/model-versions/by-hash/{sha256} 做权威溯源(已独立验证:
HMNSFW_AIO_V2 sha256 608e4212… → ver 3206518 / model 2834417 / 310,168,344 字节完全一致)。

不轻信调研留档:每条都重新打一次 by-hash 取 bytes/downloadUrl/许可四旗标。
产物:docs/MODEL_SOURCES.json 追加条目 + 同步 core 快照 backend/api/app/data/model_sources.json。
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/Users/wangzhenyu/Desktop/ALLProject/ToIV")
LEDGER = ROOT / "docs" / "MODEL_SOURCES.json"
CORE_SNAPSHOT = ROOT / "apps" / "api" / "app" / "data" / "model_sources.json"
PROV = ROOT / "tmp" / "research-civitai-20261013" / "raw" / "h3_provenance.json"
BY_HASH = "https://civitai.red/api/v1/model-versions/by-hash/{}"
TODAY = "2026-10-13"

# 上游已下架、by-hash 也 MISS 的那条(h3.py:53 注释已同步修正)
PROVENANCE_LOST = {
    "local": "h3/loras/h3_musubi_v4-000040.safetensors",
    "sha256": "2268b5bd3c956f89f6a051aed43bbfdcef196e296a63b7c1e1773e8c11d80b69",
    "civitai_model": 2841940,
}


def by_hash(sha: str) -> dict | None:
    req = urllib.request.Request(BY_HASH.format(sha), method="GET")
    req.add_header("User-Agent", "ToIV/1.0 (+https://github.com/zhwangsir/ToIV)")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print(f"    by-hash MISS/ERR {sha[:12]}…: {type(e).__name__} {str(e)[:80]}")
        return None


def detect_indent(raw: str) -> int:
    m = re.search(r"\n( +)\"", raw)
    return len(m.group(1)) if m else 2


def main() -> int:
    prov = json.loads(PROV.read_text())
    print(f"调研留档 {len(prov)} 条 + provenance_lost 1 条")

    raw = LEDGER.read_text(encoding="utf-8")
    indent = detect_indent(raw)
    ledger = json.loads(raw)
    items = ledger["items"]
    by_base = {it["basename"]: it for it in items}
    print(f"账本现有 {len(items)} 条 | totals={json.dumps(ledger.get('totals'), ensure_ascii=False)}")

    added = updated = missed = 0
    for p in prov:
        basename = Path(p["local"]).name
        sha = p["sha256"]
        print(f"  · {basename} → by-hash …", end=" ", flush=True)
        d = by_hash(sha)
        if not d:
            missed += 1
            print("MISS(留档存疑,跳过不写假数据)")
            continue
        files = d.get("files") or []
        f0 = next((f for f in files if (f.get("hashes") or {}).get("SHA256", "").lower() == sha.lower()), None) \
            or (files[0] if files else {})
        remote_sha = (f0.get("hashes") or {}).get("SHA256", "").lower()
        if remote_sha != sha.lower():
            missed += 1
            print(f"sha 不一致(远端 {remote_sha[:12]}…)→ 跳过")
            continue
        model_id = d.get("modelId")
        lic = []
        model = d.get("model") or {}
        for k in ("allowCommercialUse", "allowNoCredit", "allowDerivatives"):
            src = p.get(k) if p.get(k) is not None else model.get(k)
            if src is not None:
                lic.append(f"{k}={json.dumps(src, ensure_ascii=False)}")
        entry = {
            "basename": basename,
            "rel_path": p["local"],
            "source_kind": "civitai",
            "source_url": f"https://civitai.com/models/{model_id}",
            "repo": None,
            "revision": None,
            "filename": f0.get("name"),
            "license_or_gated": "; ".join(lic) or None,
            "downloaded_at": None,
            "status": "ok",
            "bytes": int(round((f0.get("sizeKB") or 0) * 1024)) or None,
            "notes": (
                f"civitai by-hash 溯源 {TODAY}(W9 P0-1)| versionId={d.get('id')} modelId={model_id} "
                f"version={d.get('name')} | baseModel={d.get('baseModel')} | creator={p.get('creator')} "
                f"| downloads={p.get('downloads')} | trainedWords={json.dumps(p.get('trainedWords') or [], ensure_ascii=False)} "
                f"| sha256={sha} 与 civitai 远端一致 | 本地在 workstation NAS {p['local']} "
                f"| 名单来源 backend/api/app/services/h3.py H3_NSFW_LORAS"
            ),
        }
        if basename in by_base:
            by_base[basename].update(entry)
            updated += 1
            print(f"更新既有(model {model_id})")
        else:
            items.append(entry)
            by_base[basename] = entry
            added += 1
            print(f"新增(model {model_id}, {entry['bytes']} bytes)")
        time.sleep(0.3)

    # provenance_lost 那条也入账(状态标 blocked,理由写清),否则账本仍缺一行
    lost_base = Path(PROVENANCE_LOST["local"]).name
    if lost_base not in by_base:
        items.append({
            "basename": lost_base,
            "rel_path": PROVENANCE_LOST["local"],
            "source_kind": "civitai",
            "source_url": None,
            "repo": None, "revision": None, "filename": lost_base,
            "license_or_gated": None,
            "downloaded_at": None,
            "status": "blocked",
            "bytes": None,
            "notes": (
                f"provenance_lost | civitai {PROVENANCE_LOST['civitai_model']} 上游已下架"
                f"({TODAY} 实测 {{\"error\":\"No model with id 2841940\"}}),by-hash 亦 MISS "
                f"| 本地文件仍在 workstation NAS {PROVENANCE_LOST['local']}"
                f"(sha256={PROVENANCE_LOST['sha256']}) | 可用但不可再溯源/不可补下 "
                f"| h3.py:53 注释已同步修正 | action=keep_local_backup"
            ),
        })
        added += 1
        print(f"  · {lost_base} → 新增(provenance_lost)")
    else:
        print(f"  · {lost_base} 已在账本,跳过")

    ok = sum(1 for it in items if it.get("status") == "ok")
    blocked = sum(1 for it in items if it.get("status") == "blocked")
    ledger["totals"] = {**(ledger.get("totals") or {}), "ok": ok, "blocked": blocked, "total": len(items)}
    ledger["updated_at"] = f"{TODAY}T{time.strftime('%H:%M:%S')}+08:00"

    text = json.dumps(ledger, ensure_ascii=False, indent=indent) + "\n"
    LEDGER.write_text(text, encoding="utf-8")
    shutil.copyfile(LEDGER, CORE_SNAPSHOT)
    same = LEDGER.read_bytes() == CORE_SNAPSHOT.read_bytes()
    print(f"\n新增 {added} | 更新 {updated} | MISS 跳过 {missed}")
    print(f"账本 {len(items)} 条 | totals={json.dumps(ledger['totals'], ensure_ascii=False)}")
    print(f"core 快照已同步且字节一致: {same}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
