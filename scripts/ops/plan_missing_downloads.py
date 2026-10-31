#!/usr/bin/env python3
"""把「缺模型」fail 归因变成可执行的下载计划(只读 HF 元数据,不下权重)。

入选口径(宁缺勿错,E-12 家族:错仓权重=把应用打死):
  - ledger=ok(账本已核可,属"该下没下");或
  - hf-mirror 检索**单候选**,且该仓 tree 里 basename **唯一精确匹配**。
目标目录由引用应用的 loader 节点类推导(CheckpointLoaderSimple→checkpoints、
LoraLoader→loras、UNETLoader→diffusion_models、VAELoader→vae、CLIPLoader→clip);
推不出就跳过并记 reason,绝不猜目录(W-2:模型可见性的最终裁判是 object_info)。

用法: python3 scripts/ops/plan_missing_downloads.py <feasibility.json> <out.json>
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

UA = "Mozilla/5.0 (Macintosh) ToIV/1.0"
HF = "https://hf-mirror.com"
PG = ("PGPASSWORD=68799b59242beeccfd54963902a35006 psql -h 127.0.0.1 -U toiv -d toiv -tA -F'@@' -c")

LOADER_DIR = {
    "CheckpointLoaderSimple": "checkpoints",
    "LoraLoader": "loras",
    "LoraLoaderModelOnly": "loras",
    "UNETLoader": "diffusion_models",
    "VAELoader": "vae",
    "CLIPLoader": "clip",
    "DualCLIPLoader": "clip",
    "UpscaleModelLoader": "upscale_models",
    "ControlNetLoader": "controlnet",
    "CLIPVisionLoader": "clip_vision",
    "StyleModelLoader": "style_models",
    "GLIGENLoader": "gligen",
    "UnetLoaderGGUF": "diffusion_models",
    "UnetLoaderGGUFAdvanced": "diffusion_models",
    "CLIPLoaderGGUF": "clip",
    "DualCLIPLoaderGGUF": "clip",
}
# 兜底:类名子串规则(GGUF/Loader 变体太多,不穷举)
_LOADER_SUBSTR = (
    ("LoraLoader", "loras"),
    ("GGUF", "diffusion_models"),
    ("CLIPLoader", "clip"),
    ("VAELoader", "vae"),
    ("UpscaleModel", "upscale_models"),
    ("ControlNet", "controlnet"),
    ("UNETLoader", "diffusion_models"),
    ("CheckpointLoader", "checkpoints"),
)


def q(sql: str) -> list[list[str]]:
    r = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=30", "merlin@192.168.71.47", f'{PG} "{sql}"'],
        capture_output=True, text=True, timeout=180,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:200])
    return [l.split("@@") for l in r.stdout.strip().splitlines() if "@@" in l]


def get_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    with urllib.request.urlopen(req, timeout=timeout) as x:
        return json.load(x)


def loader_dirs_for(app_id: str, cache: dict) -> set[str]:
    if app_id not in cache:
        rows = q(
            "select required_nodes from app where id='" + app_id.replace("'", "''") + "'"
        )
        nodes = rows[0][0] if rows else ""
        dirs = {LOADER_DIR[n] for n in LOADER_DIR if n in nodes}
        if not dirs:  # 精确表没命中再走子串规则
            dirs = {d for key, d in _LOADER_SUBSTR if key in nodes}
        cache[app_id] = dirs
    return cache[app_id]


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    entries = json.load(open(src))
    ledger = {
        (i.get("basename") or "").lower(): i
        for i in json.load(open("backend/api/app/data/model_sources.json"))["items"]
    }
    cache: dict[str, set[str]] = {}
    plan, skipped = [], Counter()
    for e in entries:
        name = e["name"]
        ok_ledger = (ledger.get(name.lower()) or {}).get("status") == "ok"
        single = e.get("hf") == "hf_hit" and len(e.get("cands") or []) == 1
        if not (ok_ledger or single):
            skipped[e.get("cls") or e.get("hf") or "?"] += 1
            continue
        repo = (e.get("cands") or [None])[0] or (ledger.get(name.lower()) or {}).get("repo")
        if not repo:
            skipped["no_repo"] += 1
            continue
        try:
            tree = get_json(f"{HF}/api/models/{urllib.parse.quote(repo, safe='/')}/tree/main?recursive=true")
        except Exception as exc:  # noqa: BLE001
            skipped[f"tree_err:{type(exc).__name__}"] += 1
            continue
        hits = [f for f in tree if (f.get("path") or "").rsplit("/", 1)[-1] == name]
        if len(hits) != 1:
            skipped["basename_not_unique_in_repo"] += 1
            continue
        led_item = ledger.get(name.lower()) or {}
        rel = (led_item.get("rel_path") or "").strip()
        if rel:  # 账本 rel_path 是权威目录(下载落点),优先于 loader 类推导
            target_dir = rel.split("/")[0]
        else:
            dirs = loader_dirs_for(e.get("app") or "", cache)
            if len(dirs) != 1:
                skipped["target_dir_ambiguous"] += 1
                continue
            target_dir = next(iter(dirs))
        plan.append({
            "basename": name,
            "repo": repo,
            "path": hits[0]["path"],
            "size": hits[0].get("size"),
            "url": f"{HF}/{repo}/resolve/main/{urllib.parse.quote(hits[0]['path'])}",
            "target_dir": target_dir,
            "app": e.get("app"),
            "via": "ledger_ok" if ok_ledger else "hf_single_candidate",
        })
    plan.sort(key=lambda p: -(p.get("size") or 0))
    json.dump({"plan": plan, "skipped": dict(skipped)}, open(dst, "w"), ensure_ascii=False, indent=1)
    total_gb = sum(p.get("size") or 0 for p in plan) / 1024**3
    print(f"plan={len(plan)} skipped={dict(skipped)} total={total_gb:.1f}GiB")
    for p in plan[:12]:
        print(f"  {p['target_dir']:16s} {(p.get('size') or 0)/1024**3:8.2f}GiB {p['basename']}  <- {p['repo']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
