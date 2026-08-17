"""检查指定 prompt_id 的状态。"""
from __future__ import annotations

import json
import sys

import requests

pid = sys.argv[1] if len(sys.argv) > 1 else "5d7e767f-05d5-41b2-b5b0-825d354430a9"
url = f"http://192.168.71.127:8189/history/{pid}"
r = requests.get(url, timeout=60)
print("status:", r.status_code)
try:
    data = r.json()
    entry = data.get(pid, data)
    status = entry.get("status", {})
    print("status_str:", status.get("status_str"))
    print("completed:", status.get("completed"))
    for msg in status.get("messages", []):
        print("-" * 40)
        print(json.dumps(msg, indent=2, ensure_ascii=False))
    print("outputs:", json.dumps(entry.get("outputs", {}), indent=2, ensure_ascii=False))
except Exception:
    print(r.text[:2000])
