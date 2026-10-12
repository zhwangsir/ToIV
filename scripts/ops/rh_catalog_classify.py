"""W8 批 B:对 RH 全量目录中「尚未导入」的 webapp 逐个取详情并做静态本地可部署性分类。

为什么需要:批 A 枚举出 70534 个 webapp,本地只导入了 5636 个(带 RH:{webappId} 溯源),
差集 65031。用户要求「所有能够本地部署的应用都拉取下来」,但**盲导 6.5 万条是错的**——
必须先判定哪些真能在本机队跑起来(节点齐 + 模型齐),再导入、再 smoke、再上架。

判定逻辑直接复用 scripts/ops/scan_capability_gap.py(同一套 extract/model_present/worker caps),
不另写一份,避免两套口径漂移。

产物(断点续跑,重复运行只补缺):
  tmp/rh_classify_20261013/details.jsonl     每个 webapp 的详情级原始关键字段
  tmp/rh_classify_20261013/classified.jsonl  分类结果(status/block_kind/ok_workers/缺件)
  tmp/rh_classify_20261013/summary.json      聚合

用法:
  python3 scripts/ops/rh_catalog_classify.py --limit 200      # 试点
  python3 scripts/ops/rh_catalog_classify.py                  # 全量(后台跑)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = Path(os.environ.get("TOIV_RH_CLASSIFY_OUT", str(ROOT / "tmp" / "rh_classify_20261013")))
CANDIDATES = ROOT / "tmp" / "research-rh-local-20261013" / "rh_new_candidates.jsonl"
KEY_PATH = ROOT / ".auth" / "runninghub.json"
DETAIL_URL = "https://www.runninghub.ai/api/webapp/detail"
EXPORT_URL = "https://www.runninghub.ai/api/openapi/getJsonApiFormat"
WORKERS = [w for w in os.environ.get(
    "TOIV_WORKERS",
    "http://192.168.71.127:8196,http://192.168.71.127:8188,http://192.168.71.127:8264,"
    "http://192.168.71.127:8197,http://192.168.71.127:8199",
).split(",") if w.strip()]
CONCURRENCY = int(os.environ.get("TOIV_RH_CONCURRENCY", "6"))

# 复用扫描器的判定函数(单一口径)
_spec = importlib.util.spec_from_file_location("gap_scan", ROOT / "scripts" / "ops" / "scan_capability_gap.py")
gap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gap)

_lock = threading.Lock()
_stop = False


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def post_detail(api_key: str, webapp_id: str, timeout: float = 60.0) -> dict:
    body = json.dumps({"apiKey": api_key, "webappId": webapp_id}).encode()
    req = urllib.request.Request(DETAIL_URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "ToIV/1.0 (+https://github.com/zhwangsir/ToIV)")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def export_graph(api_key: str, workflow_id: str, timeout: float = 90.0) -> tuple[dict | None, str]:
    """第二步:POST /api/openapi/getJsonApiFormat → data.prompt(Comfy API 格式图)。

    协议来源:.regen_tmp/seed_rh_accurate_20260907.py:5-6,263-270(已成功导入 5636 条的那条路)。
    注意 detail 返回的 workflowState 是**可导出门禁标志位(int)**,不是图本身;
    workflowState!=1 或 workflowId 为空 → 该应用不开放导出。
    """
    body = json.dumps({"apiKey": api_key, "workflowId": str(workflow_id)}).encode()
    req = urllib.request.Request(EXPORT_URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("User-Agent", "ToIV/1.0 (+https://github.com/zhwangsir/ToIV)")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return None, f"http_{e.code}"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        return None, f"{type(e).__name__}"[:60]
    data = payload.get("data") or {}
    graph = data.get("prompt") if isinstance(data, dict) else None
    if not graph:
        return None, f"code_{payload.get('code')}_{str(payload.get('msg'))[:40]}"
    return graph, ""


def classify_one(api_key: str, wid: str, meta: dict, worker_caps: list[dict]) -> dict:
    rec: dict = {
        "webapp_id": wid,
        "name": meta.get("name"),
        # RH 的 useCount 是字符串("999"),统一落 int,避免下游比较/排序踩类型
        "use_count": int(str(((meta.get("statisticsInfo") or {}).get("useCount") or "0")).strip() or 0),
        "publish_time": meta.get("publishTime"),
        "owner": ((meta.get("owner") or {}).get("name") if isinstance(meta.get("owner"), dict) else None),
    }
    payload = None
    for attempt in range(3):
        try:
            payload = post_detail(api_key, wid)
            break
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            rec["fetch_error"] = f"{type(e).__name__}: {e}"[:200]
            time.sleep(1.5 + attempt * 2)
    if payload is None:
        rec["status"] = "fetch_failed"
        return rec

    data = payload.get("data") or {}
    rec["code"] = payload.get("code")
    rec["instance_type"] = data.get("instanceType")
    rec["can_modify_publish_scope"] = data.get("canModifyPublishScope")
    rec["avg_running_seconds"] = data.get("avgRunningSeconds")
    wf_state = data.get("workflowState")
    wf_id = data.get("workflowId")
    rec["workflow_state"] = wf_state
    rec["n_input_nodes"] = len(data.get("inputNodes") or [])
    covers = data.get("covers") or data.get("chineseCovers") or []
    rec["cover_url"] = ((covers[0] or {}).get("url") if isinstance(covers, list) and covers
                        and isinstance(covers[0], dict) else None)
    rec["description_len"] = len(data.get("description") or "")
    rec["tags"] = [t.get("name") for t in (data.get("tags") or []) if isinstance(t, dict)][:6]

    # 门禁:workflowState 必须 ==1 且有 workflowId 才开放导出
    if wf_state != 1 or not wf_id:
        rec["status"] = "not_exportable"
        return rec

    graph_raw, why = export_graph(api_key, str(wf_id))
    if graph_raw is None:
        rec["status"] = "export_failed"
        rec["export_why"] = why
        return rec

    graph = gap.normalize_graph(graph_raw)
    if not graph:
        rec["status"] = "graph_unparsable"
        return rec
    nodes, models = gap.extract_nodes_models(graph)
    models = {m for m in models if m and isinstance(m, str)}
    rec["n_nodes"] = len(nodes)
    rec["n_models"] = len(models)

    per_worker = []
    any_ok = False
    for c in worker_caps:
        miss_n = sorted(n for n in nodes if n not in c["nodes"])
        miss_m = sorted(m for m in models if not gap.model_present(m, c))
        ok = (not miss_n) and (not miss_m)
        any_ok = any_ok or ok
        per_worker.append({"worker": c["url"], "ok": ok, "missing_nodes": miss_n[:20],
                           "missing_models": miss_m[:20]})
    miss_nodes_all = sorted(n for n in nodes if not any(n in c["nodes"] for c in worker_caps))
    miss_models_none = sorted(m for m in models if not any(gap.model_present(m, c) for c in worker_caps))
    rec["status"] = "ok" if any_ok else "blocked"
    rec["ok_workers"] = [p["worker"] for p in per_worker if p["ok"]]
    if not any_ok:
        any_nodes_ok = any(not p["missing_nodes"] for p in per_worker)
        any_models_ok = any(not p["missing_models"] for p in per_worker)
        rec["block_kind"] = ("nodes_only" if not any_nodes_ok and any_models_ok
                             else "models_only" if any_nodes_ok and not any_models_ok
                             else "both")
    else:
        rec["block_kind"] = None
    rec["missing_nodes_on_all_workers"] = miss_nodes_all[:30]
    rec["missing_models_on_no_worker"] = miss_models_none[:30]
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条(试点)")
    ap.add_argument("--min-use", type=int, default=0, help="按 useCount 下限过滤")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    api_key = json.loads(KEY_PATH.read_text())["RUNNINGHUB_API_KEY"]

    cands = [json.loads(l) for l in CANDIDATES.open()]
    if args.min_use:
        cands = [c for c in cands if ((c.get("statisticsInfo") or {}).get("useCount") or 0) >= args.min_use]
    if args.limit:
        cands = cands[: args.limit]
    log(f"候选 {len(cands)}(min_use={args.min_use}, limit={args.limit})")

    cls_path = OUT_DIR / "classified.jsonl"
    done_ids: set[str] = set()
    if cls_path.exists():
        for l in cls_path.open():
            try:
                done_ids.add(str(json.loads(l)["webapp_id"]))
            except (json.JSONDecodeError, KeyError):
                continue
    todo = [c for c in cands if str(c["id"]) not in done_ids]
    log(f"已完成 {len(done_ids)} | 本轮待处理 {len(todo)}(断点续跑)")
    if not todo:
        log("无待处理项")
        return 0

    log(f"取 worker 能力快照({len(WORKERS)} 台)…")
    worker_caps = []
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as ex:
        futs = {ex.submit(gap.fetch_worker_caps, w): w for w in WORKERS}
        for fut in as_completed(futs):
            w = futs[fut]
            try:
                caps = fut.result()
                caps["url"] = w
                worker_caps.append(caps)
                log(f"  {w}: nodes={len(caps.get('nodes') or [])} models={len(caps.get('models') or [])}")
            except Exception as e:  # noqa: BLE001
                log(f"  {w} 取能力失败:{type(e).__name__} {e}")
    if not worker_caps:
        log("无任何 worker 可达,中止")
        return 2

    t0 = time.time()
    n = 0
    tally: dict[str, int] = {}
    with cls_path.open("a", encoding="utf-8") as out:
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
            futs = {ex.submit(classify_one, api_key, str(c["id"]), c, worker_caps): c for c in todo}
            for fut in as_completed(futs):
                try:
                    rec = fut.result()
                except Exception as e:  # noqa: BLE001
                    rec = {"webapp_id": "?", "status": "exception", "error": f"{type(e).__name__}: {e}"[:200]}
                with _lock:
                    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    n += 1
                    tally[rec.get("status") or "?"] = tally.get(rec.get("status") or "?", 0) + 1
                    if n % 100 == 0:
                        out.flush()
                        rate = n / max(time.time() - t0, 1e-6)
                        eta = (len(todo) - n) / max(rate, 1e-6)
                        log(f"  {n}/{len(todo)} {rate:.1f}/s ETA {eta / 60:.1f}min | {tally}")

    summary = {
        "scanned_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "candidates": len(cands),
        "processed_this_run": n,
        "already_done": len(done_ids),
        "workers": [c["url"] for c in worker_caps],
        "status_tally": tally,
        "elapsed_sec": round(time.time() - t0, 1),
    }
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    log(f"完成 {n} 条 / {summary['elapsed_sec']}s → {cls_path}")
    log(f"状态分布:{json.dumps(tally, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
