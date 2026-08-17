"""列出可用的 Sampler 节点。"""
from __future__ import annotations

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()

for name in sorted(info.keys()):
    if "sampler" in name.lower() or "scheduler" in name.lower():
        outputs = info[name].get("output", [])
        if "SAMPLER" in outputs:
            print(name, "->", outputs)
