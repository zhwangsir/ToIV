"""W8 批 D:把「缺件」翻译成可执行的解锁动作清单(按能解锁多少应用排序)。

两条杠杆:
1. **缺节点** — 复用 scan_capability_gap.py 的 NODE_PACKAGE_HINTS/suggested_package 映射,
   区分三类:①RH 云端专有(RH_*/RunningHub*,真不可本地化) ②有已知社区包(装上即解锁)
   ③无建议包(需人工认包)。特别地 `Text`/`Bool` 这类**导出原语**其实可以靠图改写解决,
   单个 `Text` 就卡住 235 个应用,是最大的一根杠杆。
2. **缺模型** — civitai `/api/v1/models?query=<stem>` 定源(命中判据:modelVersions[].files[].name
   **精确等于** basename,不用模型名模糊匹配,假阳性率高),取 sha256/许可四旗标/downloadUrl;
   再查 hf-mirror 是否有重传副本与 gated 状态。产出四态:
   civitai_anon / civitai_login_required / hf_only / not_found。
   ⚠️ hf 重传副本可能与 civitai 原版不同(改名/改精度/二次训练/社区 pruned),
   2026-10-11 W2.0 已为此付过六轮实弹排查的代价 → **sha256 校验是硬前置,不校验不许上架**。

用法:
  python3 scripts/ops/rh_gap_resolve.py --nodes-only          # 只出节点动作清单(秒级)
  python3 scripts/ops/rh_gap_resolve.py --top-models 150      # 模型侧只解 Top150(按 count_apps)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCAN_DIR = Path("tmp/gap_scan_20261013")
OUT_DIR = ROOT / "tmp" / "rh_gap_resolve_20261013"
CIVITAI = "https://civitai.red/api/v1/models"
HF = "https://hf-mirror.com/api/models"
UA = "ToIV/1.0 (+https://github.com/zhwangsir/ToIV)"

_spec = importlib.util.spec_from_file_location("gap_scan", ROOT / "scripts" / "ops" / "scan_capability_gap.py")
gap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gap)

# RH 云端专有节点(本地装不了,只能改写图绕开或放弃该应用)
RH_CLOUD = re.compile(r"^(RH_|RunningHub|RHHiddenNodes)", re.I)
# ComfyUI 导出原语(不是真节点,API 格式图里被当节点写进来;可靠图改写消解)
PRIMITIVES = {"Text", "Boolean", "Bool", "Int", "Float", "String", "PrimitiveNode", "Note", "Reroute"}


def _get_json(url: str, timeout: float = 40.0, retries: int = 3):
    """带重试的 GET。**传输错误必须与「查到了但没有」分开记**。

    2026-10-13 实测教训:hf-mirror 会间歇抛 `SSL: UNEXPECTED_EOF_WHILE_READING`,
    原版把异常直接吞成 None → 下游判成 not_found,得出「模型不可得」的错误结论
    (Top150 里 105 条 not_found 有相当部分是网络抖动)。
    4xx 是确定性答案(404=真没有,401/403=gated),不重试;传输类错误重试并标 transport_error。
    """
    last = "unknown"
    for attempt in range(retries):
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", UA)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode()), None
        except urllib.error.HTTPError as e:
            return None, f"http_{e.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
            last = f"{type(e).__name__}"[:40]
            time.sleep(1.0 + attempt * 1.5)
    return None, f"transport_error:{last}"


def resolve_nodes(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        ct = r["class_type"]
        n = r.get("count_apps") or 0
        if ct in PRIMITIVES:
            kind, action = "primitive", "图改写(把原语节点内联成上游节点的字段值),不需装任何东西"
            pkg = None
        elif RH_CLOUD.search(ct):
            kind, action = "rh_cloud", "不可本地化:改写图绕开(如 RH_Captioner→本地 Qwen3-VL:9311 / RH_Translator→本地 DSv4)或放弃该应用"
            pkg = None
        else:
            pkg = gap.suggested_package(ct)
            if pkg and "unlocalizable" not in pkg.lower():
                kind, action = "installable", f"装 {pkg} 到 worker 的 custom_nodes 后重启实例"
            else:
                kind, action = "unknown_pkg", "需人工认包(在 RH 应用详情页看节点来源,或按类名搜 GitHub)"
        out.append({"class_type": ct, "count_apps": n, "kind": kind,
                    "suggested_package": pkg, "action": action,
                    "sample_app_ids": (r.get("sample_app_ids") or [])[:3]})
    out.sort(key=lambda x: -x["count_apps"])
    return out


def resolve_model(basename: str) -> dict:
    stem = re.sub(r"\.(safetensors|ckpt|pt|pth|onnx|bin|gguf)$", "", basename, flags=re.I)
    rec: dict = {"basename": basename, "query_stem": stem}
    q = urllib.parse.quote(stem[:80])
    d, err = _get_json(f"{CIVITAI}?query={q}&limit=20&nsfw=true")
    if err or not isinstance(d, dict):
        rec["civitai"] = f"query_error:{err}"
    else:
        hit = None
        for m in d.get("items") or []:
            for v in m.get("modelVersions") or []:
                for f in v.get("files") or []:
                    if (f.get("name") or "") == basename:      # 精确 basename,不模糊匹配
                        hit = {"model_id": m.get("id"), "model_name": m.get("name"),
                               "version_id": v.get("id"), "version_name": v.get("name"),
                               "base_model": v.get("baseModel"), "nsfw": m.get("nsfw"),
                               "sha256": (f.get("hashes") or {}).get("SHA256"),
                               "bytes": int(round((f.get("sizeKB") or 0) * 1024)) or None,
                               "download_url": f.get("downloadUrl"),
                               "allow_no_credit": m.get("allowNoCredit"),
                               "allow_derivatives": m.get("allowDerivatives"),
                               "allow_commercial_use": m.get("allowCommercialUse"),
                               "creator": (m.get("creator") or {}).get("username")}
                        break
                if hit:
                    break
            if hit:
                break
        rec["civitai"] = hit or "no_exact_basename_match"
    # HF 侧:先分清「仓库 id」与「文件名」两类缺件(补救路径完全不同)
    is_repo_id = "/" in basename and not re.search(
        r"\.(safetensors|ckpt|pt|pth|onnx|bin|gguf)$", basename, flags=re.I)
    rec["kind"] = "hf_repo_id" if is_repo_id else "file"
    transport_err = str(rec.get("civitai") or "").startswith(("query_error", "transport_error"))
    if is_repo_id:
        # 例:TencentGameMate/chinese-wav2vec2-base(实测该仓 6 个文件:pytorch_model.bin 等)、
        # unsloth/Meta-Llama-3.1-8B-bnb-4bit。补救=让整仓在本地可达,不是往 models/ 丢一个文件。
        meta, merr = _get_json(f"https://hf-mirror.com/api/models/{urllib.parse.quote(basename, safe='')}")
        if merr:
            rec["hf"] = f"query_error:{merr}"
            transport_err = transport_err or merr.startswith("transport_error")
        else:
            sib = [s.get("rfilename") for s in ((meta or {}).get("siblings") or [])]
            rec["hf"] = {"repo": basename, "gated": (meta or {}).get("gated"),
                         "private": (meta or {}).get("private"),
                         "n_files": len(sib), "files": sib[:12]}
    else:
        h, herr = _get_json(f"{HF}?search={q}&limit=10")
        repos = [x.get("modelId") or x.get("id") for x in (h or [])] if isinstance(h, list) else []
        rec["hf"] = {"n": len(repos), "repos": repos[:5]}
        if herr:
            rec["hf"]["search_error"] = herr
            transport_err = transport_err or herr.startswith("transport_error")
        # HF 重传常改名 → 精确 basename 命中优先,其次规范化 stem 模糊命中(需 sha256 校验才可用)
        target = re.sub(r"[^a-z0-9]+", "", re.sub(
            r"\.(safetensors|ckpt|pt|pth|onnx|bin|gguf)$", "", basename, flags=re.I).lower())
        for repo in repos[:5]:
            tree, terr = _get_json(
                f"https://hf-mirror.com/api/models/{urllib.parse.quote(repo, safe='')}/tree/main?recursive=true")
            if terr or not isinstance(tree, list):
                rec.setdefault("hf_tree_errors", []).append(f"{repo}:{terr}")
                transport_err = transport_err or str(terr or "").startswith("transport_error")
                continue
            paths = [f.get("path") or "" for f in tree if isinstance(f, dict)]
            exact = [p for p in paths if p == basename or p.endswith("/" + basename)]
            if exact:
                rec["hf_match"] = {"repo": repo, "path": exact[0], "match": "exact"}
                break
            fuzzy = [p for p in paths
                     if re.sub(r"[^a-z0-9]+", "", re.sub(
                         r"\.(safetensors|ckpt|pt|pth|onnx|bin|gguf)$", "",
                         p.rsplit("/", 1)[-1], flags=re.I).lower()) == target]
            if fuzzy:
                rec["hf_match"] = {"repo": repo, "path": fuzzy[0], "match": "renamed",
                                   "note": "HF 重传改名;sha256 必须与 civitai 值校验后才可用(W2.0 pruned 教训)"}
                break

    civ = rec.get("civitai")
    has_civ = isinstance(civ, dict)
    if has_civ and rec.get("hf_match"):
        rec["state"] = "civitai_and_hf"              # 最优:有权威哈希又有取货渠道
    elif has_civ and civ.get("download_url"):
        rec["state"] = "civitai_hit"                 # 能否匿名下需实测(307→R2 或 401)
    elif has_civ:
        rec["state"] = "civitai_hit_no_url"
    elif rec.get("hf_match"):
        rec["state"] = "hf_renamed_no_provenance"    # 能取货但无权威哈希 → 需人工确认
    elif is_repo_id and isinstance(rec.get("hf"), dict):
        rec["state"] = "hf_repo_available"           # 仓库存在(gated 见 hf.gated)
    elif transport_err or rec.get("hf_tree_errors"):
        rec["state"] = "unresolved_transport"        # 网络抖动,不许当成「找不到」
    else:
        rec["state"] = "not_found"
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes-only", action="store_true")
    ap.add_argument("--top-models", type=int, default=150)
    ap.add_argument("--scan-dir", default=str(SCAN_DIR))
    args = ap.parse_args()

    scan = Path(args.scan_dir)
    if not scan.is_absolute():
        scan = ROOT / scan
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    nodes = json.loads((scan / "missing_nodes.json").read_text())
    resolved_nodes = resolve_nodes(nodes)
    (OUT_DIR / "node_actions.json").write_text(
        json.dumps(resolved_nodes, ensure_ascii=False, indent=1))

    import collections
    tally = collections.Counter(r["kind"] for r in resolved_nodes)
    unlock = collections.Counter()
    for r in resolved_nodes:
        unlock[r["kind"]] += r["count_apps"]
    print(f"缺节点 {len(resolved_nodes)} 类 | 分类 {dict(tally)}")
    print(f"  按可解锁应用数(有重叠,非 additive): {dict(unlock)}")
    for kind in ("primitive", "installable", "rh_cloud", "unknown_pkg"):
        top = [r for r in resolved_nodes if r["kind"] == kind][:6]
        if top:
            print(f"  [{kind}] " + " · ".join(f"{r['class_type']}({r['count_apps']})" for r in top))
    pkgs = collections.Counter()
    for r in resolved_nodes:
        if r["kind"] == "installable" and r["suggested_package"]:
            pkgs[r["suggested_package"]] += r["count_apps"]
    print(f"  装包 ROI Top10(按可解锁应用数): {pkgs.most_common(10)}")

    if args.nodes_only:
        return 0

    models = json.loads((scan / "missing_models.json").read_text())
    models.sort(key=lambda r: -(r.get("count_apps") or 0))
    todo = models[: args.top_models] if args.top_models else models
    print(f"\n缺模型 {len(models)} 种 | 本轮解 Top{len(todo)}(累计覆盖应用数 "
          f"{sum(m.get('count_apps') or 0 for m in todo)})")

    out_path = OUT_DIR / "model_resolution.jsonl"
    done: set[str] = set()
    if out_path.exists():
        for line in out_path.open():
            try:
                done.add(json.loads(line)["basename"])
            except (json.JSONDecodeError, KeyError):
                continue
    st = collections.Counter()
    t0 = time.time()
    with out_path.open("a", encoding="utf-8") as f:
        for i, m in enumerate(todo, 1):
            bn = m["basename"]
            if bn in done:
                continue
            rec = resolve_model(bn)
            rec["count_apps"] = m.get("count_apps")
            rec["sample_app_ids"] = (m.get("sample_app_ids") or [])[:3]
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            st[rec["state"]] += 1
            if i % 20 == 0:
                f.flush()
                print(f"  {i}/{len(todo)} {dict(st)} ({time.time() - t0:.0f}s)")
            time.sleep(0.25)
    print(f"模型解析完成:{dict(st)} → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
