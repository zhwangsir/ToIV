"""检查 LTX 关键节点的输入定义。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()

for node in ("LTXVGemmaCLIPModelLoader", "LtxvApiTextToVideo", "LtxvApiImageToVideo", "LTXVImgToVideo", "EmptyLTXVLatentVideo", "LTXVScheduler"):
    print(f"\n=== {node} ===")
    if node not in info:
        print("NOT FOUND")
        continue
    data = info[node]
    print(json.dumps(data.get("input", {}), indent=2, ensure_ascii=False)[:1500])
