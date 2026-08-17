"""列出 ComfyUI 中所有 LTX 相关节点。"""
from __future__ import annotations

import json

import requests

url = "http://192.168.71.127:8189/object_info"
r = requests.get(url, timeout=60)
r.raise_for_status()
info = r.json()
for name in sorted(info.keys()):
    if "ltx" in name.lower():
        print(name)
