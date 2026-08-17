"""列出最近 ComfyUI history 条目。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/history"
r = requests.get(url, timeout=60)
r.raise_for_status()
data = r.json()
print(f"total entries: {len(data)}")
for pid, h in list(data.items())[:10]:
    status = h.get("status", {})
    outputs = h.get("outputs", {})
    out_types = []
    for v in outputs.values():
        for k in ("videos", "gifs", "images"):
            if k in v:
                out_types.append(k)
    print(f"{pid}: status={status.get('status_str')} outputs={out_types}")
