"""检查 EmptyLTXVLatentVideo 和 SamplerCustom 的输入输出。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()

for node in ("EmptyLTXVLatentVideo", "SamplerCustom", "KSampler", "VAEDecode", "VHS_VideoCombine"):
    print(f"\n=== {node} ===")
    if node not in info:
        print("NOT FOUND")
        continue
    d = info[node]
    print("output:", d.get("output", []))
    print("output_name:", d.get("output_name", []))
    print("input:", json.dumps(d.get("input", {}), indent=2, ensure_ascii=False)[:1200])
