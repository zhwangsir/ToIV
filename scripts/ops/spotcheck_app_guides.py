#!/usr/bin/env python3
"""抽检应用说明卡质量：从生成日志随机抽样，拉取 admin guide + 应用元数据并排打印供人工审阅。

用法: python3 scripts/ops/spotcheck_app_guides.py [--n 20] [--seed 42]
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parents[2] / ".regen_tmp" / "app_guide_gen_20260912.jsonl"
BASE = "http://192.168.71.47:8090"


def http(method: str, url: str, body: dict | None = None, token: str | None = None, timeout: int = 60) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return -1, {"error": str(e)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    ok_ids = [json.loads(l)["app_id"] for l in LOG_PATH.open(encoding="utf-8") if json.loads(l).get("ok")]
    sample = random.Random(args.seed).sample(ok_ids, min(args.n, len(ok_ids)))

    _, payload = http("POST", f"{BASE}/api/auth/login", {"email": "admin", "password": "admin123"}, timeout=30)
    token = payload["token"]
    _, apps = http("GET", f"{BASE}/api/apps", token=token)
    meta = {a["id"]: a for a in apps}

    for i, aid in enumerate(sample, 1):
        a = meta.get(aid, {})
        code, g = http("GET", f"{BASE}/api/admin/apps/{aid}/guide", token=token)
        nodes = (a.get("required_nodes") or [])[:8]
        print(f"===== [{i}/{len(sample)}] {aid} | {a.get('name','')} | cat={a.get('category')} | kind={a.get('output_kind')}")
        print(f"  nodes: {', '.join(nodes)}")
        if code != 200:
            print(f"  !! guide fetch {code}")
            continue
        for k in ("purpose", "when_to_use", "steps", "inputs", "outputs", "tips"):
            v = g.get(k)
            if isinstance(v, list):
                v = " / ".join(str(x) for x in v)
            print(f"  {k}: {v}")
        missing = [k for k in ("purpose", "when_to_use", "steps", "inputs", "outputs") if not g.get(k)]
        if missing:
            print(f"  !! MISSING FIELDS: {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
