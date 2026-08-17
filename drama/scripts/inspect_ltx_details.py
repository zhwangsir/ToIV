"""检查 LTXVGemmaCLIPModelLoader 和 VHS_VideoCombine 完整输入。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()

for node in ("LTXVGemmaCLIPModelLoader", "VHS_VideoCombine"):
    print(f"\n=== {node} ===")
    d = info[node]
    print(json.dumps(d.get("input", {}), indent=2, ensure_ascii=False))
