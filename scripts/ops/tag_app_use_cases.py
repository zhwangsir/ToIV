#!/usr/bin/env python3
"""批量用途分类打标（use_case）。对 core 生产 API 跑，日志写 .regen_tmp/（勿 stage）。

用法: python3 scripts/ops/tag_app_use_cases.py [--base http://192.168.71.47:8090] [--concurrency 8] [--limit N] [--only id1,id2] [--include-non-public] [--log PATH]

流程: admin 登录 → GET /api/apps 取公开应用(或含非公开,--include-non-public 打 RH 长尾)→ 并发 POST /api/admin/apps/{id}/use-case/generate
→ JSONL 日志 → 汇总 ok/fail/fallback。失败重试 3 次。
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parents[2] / ".regen_tmp" / f"app_use_case_tag_{time.strftime('%Y%m%d')}.jsonl"


def http(method: str, url: str, body: dict | None = None, token: str | None = None, timeout: int = 120) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "{}")
        except Exception:
            payload = {}
        return e.code, payload
    except Exception as e:
        return -1, {"error": f"{type(e).__name__}: {e}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://192.168.71.47:8090")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="")
    ap.add_argument("--retag-stale", action="store_true",
                    help="只打 use_case 为空或 other 的公开应用(2026-09-14 重打标:分类重设计前置)")
    ap.add_argument("--include-non-public", action="store_true", help="连同非公开应用一起打(RH 长尾扩面)")
    ap.add_argument("--log", default="", help="日志路径(默认 .regen_tmp/app_use_case_tag_<日期>.jsonl)")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    log_path = Path(args.log) if args.log else LOG_PATH

    code, payload = http("POST", f"{base}/api/auth/login", {"email": "admin", "password": "admin123"}, timeout=30)
    token = payload.get("token")
    if code != 200 or not token:
        print(f"LOGIN FAIL {code} {payload}", file=sys.stderr)
        return 1

    code, apps = http("GET", f"{base}/api/apps", token=token, timeout=60)
    if code != 200 or not isinstance(apps, list):
        print(f"LIST FAIL {code}", file=sys.stderr)
        return 1
    ids = [a["id"] for a in apps if a.get("is_public") or args.include_non_public]
    if args.retag_stale:
        stale = {a["id"] for a in apps if not a.get("use_case") or a.get("use_case") == "other"}
        ids = [i for i in ids if i in stale]
    if args.only:
        wanted = set(args.only.split(","))
        ids = [i for i in ids if i in wanted]
    if args.limit:
        ids = ids[: args.limit]
    print(f"apps to tag: {len(ids)}; log -> {log_path}")

    log_path.parent.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()
    done = ok = fallback = 0
    fails: list[dict] = []
    t0 = time.time()

    def tag(aid: str) -> dict:
        last = {}
        quoted = urllib.parse.quote(aid, safe="")
        for attempt in range(3):
            code, payload = http("POST", f"{base}/api/admin/apps/{quoted}/use-case/generate", token=token, timeout=180)
            if code == 200:
                return {"app_id": aid, "ok": True, "use_case": payload.get("use_case"), "fallback": bool(payload.get("fallback"))}
            last = {"code": code, "detail": str(payload.get("detail") or payload.get("error") or payload)[:300]}
            if code in (404, 422):
                break
            time.sleep(2**attempt * 2)
        return {"app_id": aid, "ok": False, **last}

    with log_path.open("a", encoding="utf-8") as logf, ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = {ex.submit(tag, aid): aid for aid in ids}
        for fut in as_completed(futs):
            r = fut.result()
            with lock:
                done += 1
                ok += 1 if r["ok"] else 0
                fallback += 1 if r.get("fallback") else 0
                if not r["ok"]:
                    fails.append(r)
                logf.write(json.dumps(r, ensure_ascii=False) + "\n")
                logf.flush()
                if done % 50 == 0 or done == len(ids):
                    rate = done / max(time.time() - t0, 1)
                    eta = (len(ids) - done) / max(rate, 0.01) / 60
                    print(f"[{done}/{len(ids)}] ok={ok} fallback={fallback} fail={len(fails)} eta={eta:.1f}min", flush=True)

    print(f"DONE total={len(ids)} ok={ok} fallback={fallback} fail={len(fails)} elapsed={(time.time()-t0)/60:.1f}min")
    if fails:
        print("FAILED:")
        for f in fails:
            print(f"  {f['app_id']}: {f.get('code')} {f.get('detail')}")
    return 0 if not fails else 2


if __name__ == "__main__":
    sys.exit(main())
