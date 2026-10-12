#!/usr/bin/env python3
"""W9 P1-2:把 MODEL_SOURCES 里 337 条 blocked 拆成可操作的三态(实为六态)。

「blocked 337」是个不可操作的大坨:里面混着三类完全不同的东西——
① civitai 有、且有开放下载路径(可补);② civitai 有、但下载需登录/token(有 token 后可补);
③ 本地渲染产物或不可溯源的透明名(永远补不了,该从待办里摘出去)。
不拆开就永远只能对着一个数字发愁。

复用 rh_gap_resolve.resolve_model(civitai 精确 basename 匹配 + hf-mirror 递归树
exact→renamed),不重写第二套解析口径。

**read-only 默认**:只写 tmp 产物,不改 docs/MODEL_SOURCES.json。--apply 才回写,
且回写只动 source_url / license_or_gated / notes / resolution_state,
**绝不把 status 从 blocked 改成 ok**——溯源成功不等于权重已在盘上,这两件事必须分开记。

用法:
  python3 scripts/ops/model_sources_blocked_tristate.py --limit 40      # 试跑
  python3 scripts/ops/model_sources_blocked_tristate.py                 # 全量,只出报告
  python3 scripts/ops/model_sources_blocked_tristate.py --apply         # 回写 ledger(需先看过报告)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEDGER = ROOT / "docs" / "MODEL_SOURCES.json"
CORE_SNAPSHOT = ROOT / "apps" / "api" / "app" / "data" / "model_sources.json"
OUT_DIR = ROOT / "tmp" / "model_sources_tristate_20261013"

_spec = importlib.util.spec_from_file_location("rh_gap", ROOT / "scripts" / "ops" / "rh_gap_resolve.py")
gapmod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gapmod)

# 纯数字/时间戳型 stem:本地渲染产物(如 20251109-140037.safetensors),不是可下载模型,
# 拿去问 civitai 纯属浪费配额。按名形判,不轻信 notes 里已有的结论。
_OPAQUE = re.compile(r"^[\d\s_.\-+]+$")


def _now() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%dT%H:%M:%S%z")


def is_local_artifact(basename: str) -> bool:
    stem = re.sub(r"\.(safetensors|ckpt|pt|pth|onnx|bin|gguf)$", "", basename or "", flags=re.I)
    return bool(_OPAQUE.match(stem))


def hf_available(rec: dict) -> bool:
    hf = rec.get("hf")
    if not isinstance(hf, dict):
        return False
    # 实测形状:{"n": <命中数>, "repos": [...]} 或 repo_id 类;别按猜的字段名判
    if hf.get("repo_id") or hf.get("url") or hf.get("matched_path"):
        return True
    try:
        return int(hf.get("n") or 0) > 0 or bool(hf.get("repos"))
    except (TypeError, ValueError):
        return False


# resolve_model 自己已经有一套 v2 调试过的状态(含 unresolved_transport 独立态),
# 优先直接映射,别用组件重算一遍造出第二套口径。
_RAW_MAP = {
    "civitai_and_hf": "ok",
    "hf_repo_available": "ok",
    "hf_renamed_no_provenance": "hf_only_no_provenance",
    "civitai_hit": "traceable_login_required",
    "civitai_hit_no_url": "traceable_login_required",
    "unresolved_transport": "unresolved_transport",
    "not_found": "not_found",
}


def tristate(rec: dict) -> str:
    """六态。unresolved_transport 必须独立出来——v1 的教训:hf-mirror 间歇 SSL EOF 被
    except→continue 吞掉后报成 not_found,凭空造出「hf_only 39」的假结论。"""
    raw = str(rec.get("state") or "")
    civ = rec.get("civitai")
    if isinstance(civ, str) and civ.startswith(("query_error", "transport_error")):
        return "unresolved_transport"
    if raw in _RAW_MAP:
        return _RAW_MAP[raw]
    # raw 缺失或出现新值时退回组件判定(宁可归到待重试,也不要误判成 not_found 就此销案)
    civ_hit = isinstance(civ, dict)
    hf_ok = hf_available(rec)
    if civ_hit and hf_ok:
        return "ok"
    if hf_ok:
        # 有下载路径但无 civitai 溯源 → 上架前必须用 civitai sha256 校验(hf 重传常改精度/剪枝)
        return "hf_only_no_provenance"
    if civ_hit:
        return "traceable_login_required"
    return "unresolved_transport" if not raw else "not_found"


def license_flag(civ) -> str | None:
    if not isinstance(civ, dict):
        return None
    commercial = civ.get("allow_commercial_use")
    if isinstance(commercial, list):
        commercial = ",".join(str(x) for x in commercial)
    parts = [
        f"credit={'no' if civ.get('allow_no_credit') else 'yes'}",
        f"derivatives={civ.get('allow_derivatives')}",
        f"commercial={commercial}",
    ]
    return " | ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--apply", action="store_true", help="回写 ledger(默认只出报告)")
    ap.add_argument("--sleep", type=float, default=0.2)
    ap.add_argument("--retry-transport", action="store_true", help="连 unresolved_transport 一起重跑")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "tristate.jsonl"

    ledger = json.loads(LEDGER.read_text())
    items = ledger.get("items") or []
    blocked = [i for i in items if i.get("status") == "blocked" and i.get("basename")]
    print(f"ledger items={len(items)} blocked(有 basename)={len(blocked)}")

    done: dict[str, dict] = {}
    if out.exists():
        for line in out.open(encoding="utf-8"):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("state") == "unresolved_transport" and args.retry_transport:
                continue  # 显式重试时不把传输失败的旧结论当已完成
            done[r["basename"]] = r
    print(f"断点续跑:已完成 {len(done)}")

    todo = [b for b in blocked if b["basename"] not in done]
    opaque = [b for b in todo if is_local_artifact(b["basename"])]
    todo = [b for b in todo if not is_local_artifact(b["basename"])]
    if args.limit:
        todo = todo[: args.limit]
    print(f"本轮:本地产物名形 {len(opaque)} 条直接归档,待网络解析 {len(todo)} 条")

    with out.open("a", encoding="utf-8") as f:
        for b in opaque:
            rec = {"basename": b["basename"], "state": "local_output_artifact",
                   "why": "stem 为纯数字/时间戳型 → 本地渲染产物,不是可下载模型", "ts": _now()}
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            done[b["basename"]] = rec
        for i, b in enumerate(todo, 1):
            name = b["basename"]
            try:
                res = gapmod.resolve_model(name)
            except Exception as e:  # noqa: BLE001 — 单条失败不该终止整轮
                res = {"civitai": f"query_error:{type(e).__name__}"}
            civ = res.get("civitai")
            rec = {
                "basename": name,
                "state": tristate(res),
                "civitai_model_id": civ.get("model_id") if isinstance(civ, dict) else None,
                "civitai_model_name": civ.get("model_name") if isinstance(civ, dict) else None,
                "civitai_version_id": civ.get("version_id") if isinstance(civ, dict) else None,
                "sha256": civ.get("sha256") if isinstance(civ, dict) else None,
                "creator": civ.get("creator") if isinstance(civ, dict) else None,
                "nsfw": civ.get("nsfw") if isinstance(civ, dict) else None,
                "license": license_flag(civ),
                "download_url": civ.get("download_url") if isinstance(civ, dict) else None,
                "hf": res.get("hf"),
                "raw_state": res.get("state"),
                "notes_before": (b.get("notes") or "")[:160],
                "ts": _now(),
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            done[name] = rec
            if i % 25 == 0 or i == len(todo):
                f.flush()
                print(f"  {i}/{len(todo)} {Counter(r['state'] for r in done.values()).most_common()}", flush=True)
            time.sleep(args.sleep)

    tally = Counter(r["state"] for r in done.values())
    print(f"\n六态分布(累计 {len(done)} 条):")
    for k, v in tally.most_common():
        print(f"  {k:<28} {v}")

    lines = ["# W9 P1-2 blocked 三态(六态)复查报告", "",
             f"- 生成:{_now()}",
             f"- ledger blocked 总数:{len(blocked)};本轮已归类 {len(done)}",
             "", "| 状态 | 条数 | 含义与下一步 |", "|---|---|---|"]
    meaning = {
        "ok": "civitai 命中且有开放下载路径 → 可补(下载后必须用 civitai sha256 校验)",
        "traceable_login_required": "civitai 有但下载需登录/token → 有 token 后可转 ok",
        "hf_only_no_provenance": "hf 有重传但无 civitai 溯源 → **上架前必须哈希校验**(重传常改精度/剪枝)",
        "local_output_artifact": "本地渲染产物(纯数字/时间戳名) → 永远补不了,应从待办摘出",
        "not_found": "两侧都无精确 basename 命中 → 不可溯源,记 provenance_lost",
        "unresolved_transport": "网络/传输失败 → **不是 not_found**,须重试(--retry-transport)",
    }
    for k, v in tally.most_common():
        lines.append(f"| `{k}` | {v} | {meaning.get(k, '')} |")
    lines += ["", "## 可补条目(state=ok / traceable_login_required)", "",
              "| basename | 状态 | civitai | creator | nsfw | 许可 |", "|---|---|---|---|---|---|"]
    for r in sorted(done.values(), key=lambda x: (x["state"] != "ok", x["basename"])):
        if r["state"] not in ("ok", "traceable_login_required"):
            continue
        cid = r.get("civitai_model_id")
        lines.append(f"| `{r['basename']}` | {r['state']} | "
                     f"{f'[{cid}](https://civitai.com/models/{cid})' if cid else '—'} | "
                     f"{r.get('creator') or '—'} | {r.get('nsfw')} | {r.get('license') or '—'} |")
    (OUT_DIR / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n报告 → {OUT_DIR/'REPORT.md'}\n明细 → {out}")

    if not args.apply:
        print("\n(dry-run;确认后加 --apply 回写 ledger——只动 source_url/license_or_gated/notes/"
              "resolution_state,不改 status)")
        return 0

    changed = 0
    by_name = {r["basename"]: r for r in done.values()}
    for it in items:
        if it.get("status") != "blocked":
            continue
        r = by_name.get(it.get("basename") or "")
        if not r or r["state"] == "unresolved_transport":
            continue
        it["resolution_state"] = r["state"]
        if r.get("civitai_model_id"):
            it["source_url"] = f"https://civitai.com/models/{r['civitai_model_id']}"
        if r.get("license"):
            it["license_or_gated"] = r["license"]
        tag = f"p1-2 {r['state']}"
        if r.get("civitai_model_name"):
            tag += f" | {r['civitai_model_name']}"
        if r.get("sha256"):
            tag += f" | sha256={str(r['sha256'])[:16]}…"
        note = (it.get("notes") or "").strip()
        it["notes"] = f"{note} | {tag}" if note else tag
        changed += 1
    ledger["updated_at"] = _now()
    LEDGER.write_text(json.dumps(ledger, ensure_ascii=False, indent=1) + "\n")
    # core 快照必须逐字节同步(AGENTS §四:docs 不在 rsync 范围,后续更新需同步重拷)
    CORE_SNAPSHOT.write_bytes(LEDGER.read_bytes())
    print(f"已回写 {changed} 条 → {LEDGER.name},并逐字节同步 core 快照 {CORE_SNAPSHOT}")
    print("⚠️ status 一律未动:溯源成功 ≠ 权重已在盘上")
    return 0


if __name__ == "__main__":
    sys.exit(main())
