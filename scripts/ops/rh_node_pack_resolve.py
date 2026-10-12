#!/usr/bin/env python3
"""W8 批D-2:把「缺的节点类名」自动认到「可安装的 ComfyUI 节点包」。

背景:rh_gap_resolve.py 只能认出它硬编码的少数包(nunchaku/kijai/...),剩下 533 个类名
(2071 应用次)全落进「需人工认包」——那是最大的一块缺口,但人工认不动。
ComfyUI-Manager 的 extension-node-map.json 就是现成的 class_type → repo 反查表,
再用 custom-node-list.json 把 repo 翻成包名/作者/安装方式,直接拿来做归因。

产出:
  node_pack_resolution.jsonl  每个缺失类名一行(候选包/状态/已装比例)
  install_plan.json           按「能解锁多少应用」排序的装包计划
  INSTALL_PLAN.md             人读版

判定口径:
  pack_resolved   唯一候选包 → 可直接装
  pack_ambiguous  多个包都声明该类名 → 需人工挑(同名冲突在社区包里很常见)
  pack_stale      候选包的类名已有一部分在舰队上 → 是装过的旧版本,该更新而非新装
  rh_cloud        RH_/RunningHub/RHHiddenNodes 前缀 → 装不了,走图改写或本地服务替身
  primitive       Text/Bool 一类导出原语 → 已由批E 内联消解,不需要装
  unresolved      Manager 清单里也没有 → 多半是 RH 私有或已下架包
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SCAN_DIR = ROOT / "tmp" / "gap_scan_20261013"
DEFAULT_OUT_DIR = ROOT / "tmp" / "rh_gap_resolve_20261013"
CACHE_DIR = ROOT / "tmp" / "cache"
UA = "ToIV/1.0 (+https://github.com/zhwangsir/ToIV)"

# raw.githubusercontent.com 在本机 DNS 被污染(见 MEMORY:Network),ghfast.top 是 AGENTS §六 P-6 记的镜像主路
_MIRROR = "https://ghfast.top/"
_BASE = "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/"
# extension-node-map.json 才是 class_type → 包 的反查表;custom-node-list.json 只有包元信息
# (无 nodenames 字段——首版误以为它有,索引出 0 类名,642 个类名全落 unresolved)
SOURCES = {
    "node_map": ("extension-node-map.json", "extension-node-map.json"),
    "pack_list": ("custom-node-list.json", "custom-node-list.json"),
}

RH_CLOUD = re.compile(r"^(RH_|RunningHub|RHHiddenNodes)", re.I)
PRIMITIVES = {"Text", "Boolean", "Bool", "Int", "Float", "String", "PrimitiveNode", "Note", "Reroute"}

_spec = importlib.util.spec_from_file_location("gap_scan", ROOT / "scripts" / "ops" / "scan_capability_gap.py")
gap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gap)

# 与 scan_capability_gap.GENERAL_POOL 同口径(那是函数局部变量,模块层取不到,故此处自备)
DEFAULT_POOL = (
    "http://192.168.71.127:8196",
    "http://192.168.71.127:8188",
    "http://192.168.71.127:8264",
    "http://192.168.71.127:8197",
    "http://192.168.71.127:8199",
)


def _now() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%dT%H:%M:%S%z")


def fetch_manager(kind: str, timeout: float = 120.0):
    """取 ComfyUI-Manager 的清单;本地缓存优先(各 2-3MB,一天内不重复拉)。"""
    fname, cache_name = SOURCES[kind]
    cache = CACHE_DIR / f"comfyui-manager-{cache_name}"
    if cache.exists() and datetime.now().timestamp() - cache.stat().st_mtime < 86400:
        try:
            return json.loads(cache.read_text())
        except json.JSONDecodeError:
            pass  # 缓存坏了就重拉,别拿半个清单当真
    last = None
    for prefix in (_MIRROR, ""):
        req = urllib.request.Request(prefix + _BASE + fname, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
            last = f"{type(e).__name__}: {e}"
            continue
        if not data:
            last = "payload empty"
            continue
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False))
        return data
    raise SystemExit(f"取 ComfyUI-Manager {fname} 失败(镜像+直连都不通):{last}")


def _norm_repo(url: str) -> str:
    """归一 repo URL 做 join 键:去 .git 尾、去尾斜杠、小写 host。"""
    u = (url or "").strip().rstrip("/")
    if u.endswith(".git"):
        u = u[:-4]
    m = re.match(r"^(https?://[^/]+)(/.*)$", u)
    return (m.group(1).lower() + m.group(2)) if m else u.lower()


def build_pack_meta(pack_list: dict) -> dict[str, dict]:
    """repo URL(归一)→ 包元信息。reference 与 files[] 都建键,因为两文件用的 URL 常不一致。"""
    meta: dict[str, dict] = {}
    for p in pack_list.get("custom_nodes") or []:
        entry = {
            "title": (p.get("title") or "").strip(),
            "author": (p.get("author") or "").strip(),
            "reference": (p.get("reference") or "").strip(),
            "install_type": (p.get("install_type") or "").strip(),
            "description": (p.get("description") or "").strip(),
            "nodename_pattern": (p.get("nodename_pattern") or "").strip(),
        }
        urls = [entry["reference"], *(p.get("files") or [])]
        for u in urls:
            if isinstance(u, str) and u.strip():
                meta.setdefault(_norm_repo(u), entry)
    return meta


def build_class_index(node_map: dict, meta: dict[str, dict]) -> tuple[dict[str, list[dict]], dict[str, list[str]], list[dict]]:
    """class_type → 候选包列表;repo → 该包全部类名(判 stale 用);另回带 nodename_pattern 包。"""
    idx: dict[str, list[dict]] = defaultdict(list)
    pack_nodes: dict[str, list[str]] = {}
    patterns: list[dict] = []
    for repo, val in node_map.items():
        # 格式:{repo_url: [[nodenames...], {"title_aux": ...}]}
        names = val[0] if isinstance(val, list) and val and isinstance(val[0], list) else []
        aux = val[1] if isinstance(val, list) and len(val) > 1 and isinstance(val[1], dict) else {}
        info = dict(meta.get(_norm_repo(repo)) or {})
        info.setdefault("title", (aux.get("title_aux") or repo.rsplit("/", 1)[-1]).strip())
        info["reference"] = info.get("reference") or repo
        info["repo"] = repo
        names = [n for n in names if isinstance(n, str) and n]
        info["n_nodes"] = len(names)
        pack_nodes[repo] = names
        for n in names:
            idx[n].append(info)
        if info.get("nodename_pattern"):
            patterns.append(info)
    return idx, pack_nodes, patterns


def match_pattern(cls: str, patterns: list[dict]) -> list[dict]:
    out = []
    for info in patterns:
        try:
            if re.search(info["nodename_pattern"], cls):
                out.append(info)
        except re.error:
            continue  # 清单里有个别坏正则,跳过而不是整轮崩
    return out


def fleet_nodes(pool: list[str]) -> tuple[set[str], dict[str, str]]:
    """舰队现有类名并集 + 各 worker 的探测错误。

    只要类名,故直接打 object_info,不走 fetch_worker_caps(那个还会逐 folder 列模型,
    这里用不上)。探测失败的 worker 必须回报:它的类名会被当成「缺失」,进而误提装包。"""
    out: set[str] = set()
    errs: dict[str, str] = {}
    for url in pool:
        base = url.rstrip("/")
        try:
            info = gap.http_json(f"{base}/object_info", timeout=180)
        except Exception as e:  # noqa: BLE001 — 单 worker 不可达不该终止整轮归因
            errs[base] = f"{type(e).__name__}: {e}"
            continue
        if isinstance(info, dict) and info:
            out |= set(info.keys())
        else:
            errs[base] = "object_info 非 dict 或为空"
    return out, errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan-dir", default=str(DEFAULT_SCAN_DIR))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    ap.add_argument("--no-live-caps", action="store_true", help="跳过舰队 object_info 探测(快,但认不出 pack_stale)")
    ap.add_argument("--top", type=int, default=30)
    args = ap.parse_args()

    scan = Path(args.scan_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    missing = json.loads((scan / "missing_nodes.json").read_text())
    if not isinstance(missing, list):
        raise SystemExit(f"{scan}/missing_nodes.json 不是列表,口径不对")

    node_map = fetch_manager("node_map")
    pack_list = fetch_manager("pack_list")
    meta = build_pack_meta(pack_list)
    idx, pack_nodes, patterns = build_class_index(node_map, meta)
    forced = os.environ.get("TOIV_WORKERS", "").strip()
    pool = [w.strip() for w in forced.split(",") if w.strip()] or list(DEFAULT_POOL)
    if args.no_live_caps:
        have, errs = set(), {}
    else:
        have, errs = fleet_nodes(pool)
    print(f"Manager:node_map {len(node_map)} repo / 反查表 {len(idx)} 类名 / "
          f"pack_list {len(meta)} URL 键 / 正则包 {len(patterns)};舰队现有类名 {len(have)}", flush=True)
    for u, e in errs.items():
        print(f"  ⚠️ worker 探测失败 {u}: {e}(其类名会被误判为缺失)", flush=True)

    rows: list[dict] = []
    # 包 → 它唯一认下的类名(带权重);歧义类名单独记,不塞进装包计划的确定收益里
    plan: dict[str, dict] = {}
    ambiguous: list[dict] = []

    for m in missing:
        cls = m.get("class_type")
        if not isinstance(cls, str) or not cls:
            continue
        weight = int(m.get("count_apps") or 0)
        row: dict = {
            "class_type": cls,
            "count_apps": weight,
            "sample_app_ids": (m.get("sample_app_ids") or [])[:3],
        }
        cands = idx.get(cls) or []
        exact = True
        if cls in PRIMITIVES:
            row["state"] = "primitive"
        elif RH_CLOUD.search(cls):
            row["state"] = "rh_cloud"
        elif not cands:
            # 精确名认不出,退到 nodename_pattern(类名动态生成的包);证据弱一档,单独标状态
            cands = match_pattern(cls, patterns)
            exact = False
            row["state"] = "unresolved" if not cands else "pack_pattern"
        if row.get("state") in ("pack_pattern", None) and cands:
            if len(cands) > 1 and exact:
                row["state"] = "pack_ambiguous"
                row["candidates"] = [{k: c.get(k) for k in ("title", "reference", "author")} for c in cands]
                ambiguous.append(row)
            else:
                c = cands[0]
                row["state"] = row.get("state") or "pack_resolved"
                row["pack"] = {k: c.get(k) for k in ("title", "reference", "author", "install_type")}
                names = pack_nodes.get(c.get("repo") or "", [])
                if have and names:
                    # 该包声明的类名里有多少已在舰队上 → 区分「没装」和「装了但版本旧」
                    known = [n for n in names if n in have]
                    row["pack_present_classes"] = len(known)
                    row["pack_total_classes"] = len(names)
                    if known:
                        row["state"] = "pack_stale"
                if row["state"] in ("pack_resolved", "pack_stale", "pack_pattern"):
                    key = c.get("reference") or c.get("title") or c.get("repo")
                    slot = plan.setdefault(key, {
                        "title": c.get("title"), "reference": c.get("reference"),
                        "author": c.get("author"), "install_type": c.get("install_type"),
                        "app_touches": 0, "classes": [], "stale_classes": [], "pattern_classes": [],
                        "pack_total_classes": len(names),
                    })
                    slot["app_touches"] += weight
                    bucket = ("stale_classes" if row["state"] == "pack_stale"
                              else "pattern_classes" if row["state"] == "pack_pattern" else "classes")
                    slot[bucket].append(cls)
        rows.append(row)

    jsonl = out_dir / "node_pack_resolution.jsonl"
    with jsonl.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    ordered = sorted(plan.values(), key=lambda p: -p["app_touches"])
    (out_dir / "install_plan.json").write_text(json.dumps({
        "generated_at": _now(),
        "manager_repos": len(node_map),
        "manager_packs": len(meta),
        "manager_class_index": len(idx),
        "manager_pattern_packs": len(patterns),
        "fleet_classes": len(have),
        "fleet_pool": pool,
        "worker_errors": errs,
        "missing_classes": len(rows),
        "plan": ordered,
        "ambiguous": ambiguous,
    }, ensure_ascii=False, indent=1))

    tally = defaultdict(lambda: [0, 0])
    for r in rows:
        tally[r["state"]][0] += 1
        tally[r["state"]][1] += r["count_apps"]

    lines = [
        "# W8 批D-2 节点包归因与装包计划",
        "",
        f"- 生成:{_now()}",
        f"- 输入:`{scan}/missing_nodes.json`({len(rows)} 个缺失类名)",
        f"- 反查表:ComfyUI-Manager `extension-node-map.json`({len(node_map)} repo / {len(idx)} 类名)"
        f" + `custom-node-list.json`({len(meta)} URL 键,含 {len(patterns)} 个正则包)",
        f"- 舰队现有类名:{len(have) if have else '未探测(--no-live-caps)'}",
        "",
    ]
    if errs:
        lines += ["⚠️ **下列 worker 探测失败,其类名会被误判为缺失,装包前必须先修复探测:**", ""]
        lines += [f"- `{u}`:{e}" for u, e in errs.items()]
        lines.append("")
    lines += [
        "## 状态分布(类名数 / 应用次)",
        "",
        "| 状态 | 类名 | 应用次 | 含义 |",
        "|---|---|---|---|",
    ]
    meaning = {
        "pack_resolved": "唯一候选包,直接装",
        "pack_stale": "包装过但版本旧,该更新",
        "pack_ambiguous": "多包同名冲突,需人工挑",
        "rh_cloud": "RH 云端专有,走图改写/本地替身",
        "primitive": "导出原语,批E 已内联消解",
        "pack_pattern": "只靠包的 nodename_pattern 正则认出,证据弱一档,装前需人工核",
        "unresolved": "Manager 清单里也没有",
    }
    for st, (n, w) in sorted(tally.items(), key=lambda kv: -kv[1][1]):
        lines.append(f"| `{st}` | {n} | {w} | {meaning.get(st, '')} |")

    lines += ["", f"## 装包计划(按可解锁应用次排序,前 {args.top})", "",
              "| # | 包 | 应用次 | 缺类名 | 旧版类名 | 正则认 | 处置 |",
              "|---|---|---|---|---|---|---|"]
    cum = 0
    for i, p in enumerate(ordered[: args.top], 1):
        cum += p["app_touches"]
        act = "更新(已装旧版)" if p["stale_classes"] and not p["classes"] else (
            "装 + 更新" if p["stale_classes"] else "新装")
        if p["pattern_classes"] and not (p["classes"] or p["stale_classes"]):
            act = "先人工核正则归因"
        shown = p["classes"] + p["stale_classes"] + p["pattern_classes"]
        cls_txt = ", ".join(f"`{c}`" for c in shown[:6]) + (" …" if len(shown) > 6 else "")
        lines.append(f"| {i} | [{p['title']}]({p['reference']}) | {p['app_touches']} | "
                     f"{len(p['classes'])} | {len(p['stale_classes'])} | "
                     f"{len(p['pattern_classes'])} | {act} |")
        lines.append(f"|   | ↳ {cls_txt} |  |  |  |  |  |")
    lines += ["", f"前 {min(args.top, len(ordered))} 个包累计覆盖 {cum} 应用次;装包计划共 {len(ordered)} 个包。", ""]

    if ambiguous:
        lines += ["## 同名冲突(需人工挑包)", "", "| 类名 | 应用次 | 候选包 |", "|---|---|---|"]
        for r in sorted(ambiguous, key=lambda x: -x["count_apps"])[:25]:
            cands = "; ".join(f"[{c.get('title') or '?'}]({c.get('reference') or ''})" for c in r["candidates"][:4])
            lines.append(f"| `{r['class_type']}` | {r['count_apps']} | {cands} |")
        lines.append("")

    unr = [r for r in rows if r["state"] == "unresolved"]
    if unr:
        lines += ["## Manager 清单里也没有的类名(前 40,按应用次)", "",
                  "| 类名 | 应用次 |", "|---|---|"]
        for r in sorted(unr, key=lambda x: -x["count_apps"])[:40]:
            lines.append(f"| `{r['class_type']}` | {r['count_apps']} |")
        lines += ["", f"共 {len(unr)} 个;多为 RH 私有包或已下架社区包,装不了。", ""]

    (out_dir / "INSTALL_PLAN.md").write_text("\n".join(lines), encoding="utf-8")

    print(f"\n状态分布(类名/应用次):")
    for st, (n, w) in sorted(tally.items(), key=lambda kv: -kv[1][1]):
        print(f"  {st:<16} {n:>4} / {w}")
    print(f"\n装包计划 {len(ordered)} 个包,前 10:")
    for p in ordered[:10]:
        print(f"  {p['app_touches']:>5}  {p['title']:<44} {p['reference']}")
    print(f"\n写出:{jsonl}\n      {out_dir/'install_plan.json'}\n      {out_dir/'INSTALL_PLAN.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
