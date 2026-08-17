"""检查各 GPU 显存使用情况。"""
from __future__ import annotations

import json

import requests

for port in [8189, 8190, 8191, 8192]:
    url = f"http://192.168.71.127:{port}/system_stats"
    try:
        r = requests.get(url, timeout=10)
        data = r.json()
        print(f"\n=== {url} ===")
        print(json.dumps(data, indent=2, ensure_ascii=False)[:1500])
    except Exception as e:
        print(f"{url}: {e}")
