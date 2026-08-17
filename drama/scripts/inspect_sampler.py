"""检查 SamplerEulerAncestral 和 KSamplerSelect 输入。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()

for node in ("SamplerEulerAncestral", "KSamplerSelect"):
    print(f"\n=== {node} ===")
    d = info[node]
    print(json.dumps(d.get("input", {}), indent=2, ensure_ascii=False))
